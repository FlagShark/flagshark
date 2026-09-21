import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  preflightNodeServerAdmission,
  rangeIncludesVersion,
  isModernNodeSdkRange,
  parseJsonc,
  HOSTED_ADMISSION_PREFLIGHTS,
  HOSTED_ADMISSION_LIMITS,
  HOSTED_SANDBOX_RUNTIME,
  NODE_SERVER_CELL_ID,
} from '../../src/migration/hosted-admission.js'

import type { AdmissionGate, AdmissionGateId, AdmissionTreeEntry, AdmissionTreeView } from '../../src/migration/hosted-admission.js'

const here = dirname(fileURLToPath(import.meta.url))

const SDK_SOURCE =
  `import { init } from '@launchdarkly/node-server-sdk'\n` +
  `const client = init('sdk-key')\n` +
  `export const on = () => client.boolVariation('checkout-v2', { kind: 'user', key: 'u' }, false)\n`

interface Spec {
  /** `null` = a file with content omitted from the view (present in the tree, unread). */
  [path: string]: string | null | { kind: AdmissionTreeEntry['kind']; size?: number } | { size: number; content?: string }
}

/** Build a view from a compact spec: strings are file contents, objects override kind/size. */
function tree(spec: Spec): AdmissionTreeView {
  const entries: AdmissionTreeEntry[] = []
  const files = new Map<string, string>()
  for (const [path, value] of Object.entries(spec)) {
    if (typeof value === 'string') {
      entries.push({ path, kind: 'file', size: Buffer.byteLength(value) })
      files.set(path, value)
    } else if (value === null) {
      entries.push({ path, kind: 'file', size: 10 })
    } else if ('kind' in value) {
      entries.push({ path, kind: value.kind, ...(value.size === undefined ? {} : { size: value.size }) })
    } else {
      entries.push({ path, kind: 'file', size: value.size })
      if (value.content !== undefined) files.set(path, value.content)
    }
  }
  return { entries, files }
}

function manifest(overrides: Record<string, unknown> = {}, remove: string[] = []): string {
  const base: Record<string, unknown> = {
    name: 'svc',
    packageManager: 'npm@10.9.8',
    scripts: { typecheck: 'tsc --noEmit', test: 'node --test' },
    dependencies: { '@launchdarkly/node-server-sdk': '^9.11.0' },
    devDependencies: { typescript: '5.9.3' },
    ...overrides,
  }
  for (const key of remove) delete base[key]
  return JSON.stringify(base)
}

const LOCK_V3 = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/typescript': { version: '5.9.3' } } })

function admissibleSpec(): Spec {
  return {
    'package.json': manifest(),
    'package-lock.json': LOCK_V3,
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
    'src/flags.ts': SDK_SOURCE,
    'README.md': '# svc',
  }
}

function gateOf(gates: AdmissionGate[], id: AdmissionGateId): AdmissionGate {
  const found = gates.find((g) => g.id === id)
  if (!found) throw new Error(`gate ${id} missing`)
  return found
}

function run(spec: Spec) {
  const result = preflightNodeServerAdmission(tree(spec))
  return { ...result, gate: (id: AdmissionGateId) => gateOf(result.gates, id) }
}

const UNKNOWN_ALWAYS: AdmissionGateId[] = ['analyzer-budget', 'transformation-blockers', 'dependency-closure', 'sandbox-validation']

describe('preflightNodeServerAdmission — invariants', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is local only: never calls fetch, and the module imports no runtime I/O', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network is forbidden')))
    vi.stubGlobal('fetch', fetchSpy)
    preflightNodeServerAdmission(tree(admissibleSpec()))
    expect(fetchSpy).not.toHaveBeenCalled()

    const source = readFileSync(resolve(here, '../../src/migration/hosted-admission.ts'), 'utf-8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gmu)].map((m) => m[1])
    expect(imports).toEqual([])
    expect(source).not.toMatch(/\b(fetch|require|process\.env|child_process|node:fs|XMLHttpRequest)\b/u)
  })

  it('an admissible tree has no refusing gate, and the unknown gates are exactly the hosted-only ones', () => {
    const result = run(admissibleSpec())
    expect(result.admissible).toBe(true)
    expect(result.gates.filter((g) => g.status === 'refuse')).toEqual([])
    expect(result.gates.filter((g) => g.status === 'unknown').map((g) => g.id)).toEqual(UNKNOWN_ALWAYS)
    expect(result.gates.map((g) => g.id)).toEqual([
      'tree-size', 'tree-paths', 'content-budget', 'single-manifest', 'package-manager-markers', 'npmrc',
      'workspaces', 'lockfile', 'npm-pin', 'dev-engines', 'dependencies', 'launchdarkly-sdk', 'typecheck',
      'test-script', 'node-runtime', 'sdk-api-surface', ...UNKNOWN_ALWAYS,
    ])
  })

  it('never promises: no gate detail says "available", and unknown is never rendered as pass', () => {
    for (const spec of [admissibleSpec(), {}]) {
      const result = run(spec)
      for (const g of result.gates) {
        expect(g.detail).not.toMatch(/\bavailable\b/iu)
        expect(['pass', 'refuse', 'unknown']).toContain(g.status)
      }
    }
    const unknown = run(admissibleSpec()).gate('analyzer-budget')
    expect(unknown.status).toBe('unknown')
    expect(unknown.detail).toContain('4 analyzer-input files locally')
    expect(run(admissibleSpec()).gate('sandbox-validation').detail).toContain('only inside the hosted sandbox')
  })

  it('is exposed by registry cell id, and the constants match the hosted collector and image', () => {
    expect(HOSTED_ADMISSION_PREFLIGHTS[NODE_SERVER_CELL_ID]).toBe(preflightNodeServerAdmission)
    expect(Object.keys(HOSTED_ADMISSION_PREFLIGHTS)).toEqual([NODE_SERVER_CELL_ID])
    expect(HOSTED_ADMISSION_LIMITS).toEqual({
      maxTreeEntries: 20_000,
      maxContentFiles: 1_900,
      maxContentBytes: 7 * 1024 * 1024,
      maxBlobBytes: 1024 * 1024,
      maxNpmLockfileBytes: 4 * 1024 * 1024,
    })
    expect(HOSTED_SANDBOX_RUNTIME).toEqual({ node: '22.23.2', npm: '10.9.8' })
    expect(Object.isFrozen(HOSTED_ADMISSION_PREFLIGHTS)).toBe(true)
  })

  it('an empty tree refuses on the manifest and reports every manifest gate as not checked', () => {
    const result = run({})
    expect(result.admissible).toBe(false)
    expect(result.gate('single-manifest')).toMatchObject({ status: 'refuse' })
    expect(result.gate('single-manifest').detail).toContain('no package.json')
    for (const id of ['workspaces', 'lockfile', 'npm-pin', 'dev-engines', 'dependencies', 'launchdarkly-sdk', 'typecheck', 'test-script', 'node-runtime'] as const) {
      expect(result.gate(id)).toEqual({ id, status: 'unknown', detail: 'not checked: requires exactly one readable package.json' })
    }
    expect(result.gate('sdk-api-surface').status).toBe('unknown')
  })
})

describe('tree gates', () => {
  it('tree-size counts blobs plus derived and explicit directories once each', () => {
    const result = run({ ...admissibleSpec(), 'src': { kind: 'directory' }, 'src/deep/x.ts': 'x' })
    expect(result.gate('tree-size')).toMatchObject({ status: 'pass' })
    // 6 blobs + directories src, src/deep = 8
    expect(result.gate('tree-size').detail).toBe("8 tree entries, within the collector's 20000")
  })

  it('tree-size refuses above 20,000 entries', () => {
    const spec = admissibleSpec()
    for (let i = 0; i < 20_000; i++) spec[`gen/${i}.txt`] = { size: 1 }
    const result = run(spec)
    expect(result.gate('tree-size').status).toBe('refuse')
    expect(result.gate('tree-size').detail).toMatch(/^20007 tree entries \(20005 files, 2 directories\)/u)
    expect(result.admissible).toBe(false)
  })

  it('tree-paths refuses symlinks, submodules and non-ASCII or unsafe paths, naming a sample', () => {
    const result = run({
      ...admissibleSpec(),
      'link': { kind: 'symlink' },
      'vendor/sub': { kind: 'submodule' },
      'docs/café.md': 'x',
      'win\\path.ts': 'x',
      'a:b.ts': 'x',
      'x/../y.ts': 'x',
      'z/./w.ts': 'x',
      ['long/' + 'a'.repeat(1030)]: 'x',
    })
    const g = result.gate('tree-paths')
    expect(g.status).toBe('refuse')
    expect(g.detail).toContain('1 symlink (`link`)')
    expect(g.detail).toContain('1 submodule (`vendor/sub`)')
    expect(g.detail).toContain('6 non-ASCII or unsafe paths (`docs/café.md`, `win\\path.ts`, `a:b.ts`, +3 more)')
    expect(g.detail).toContain('Replace symlinks with files')
  })

  it('tree-paths refuses an empty path and an empty segment', () => {
    expect(run({ ...admissibleSpec(), '': 'x' }).gate('tree-paths').status).toBe('refuse')
    expect(run({ ...admissibleSpec(), 'a//b.ts': 'x' }).gate('tree-paths').status).toBe('refuse')
    expect(run(admissibleSpec()).gate('tree-paths')).toMatchObject({ status: 'pass', detail: 'no symlinks, submodules or non-ASCII paths' })
  })

  it('content-budget is unknown when any file size is missing', () => {
    const result = run({ ...admissibleSpec(), 'unsized.ts': { kind: 'file' } })
    expect(result.gate('content-budget')).toMatchObject({ status: 'unknown' })
    expect(result.gate('content-budget').detail).toContain('not measured locally')
  })

  it('content-budget passes when every file within cap fits the text budget', () => {
    const result = run({ ...admissibleSpec(), 'logo.png': { size: 500 }, 'big.bin': { size: 2 * 1024 * 1024 } })
    expect(result.gate('content-budget').status).toBe('pass')
    // big.bin is over the 1 MiB blob cap and is carried by identity; it does not count.
    expect(result.gate('content-budget').detail).toMatch(/^6 files, 0\.0 MiB, within/u)
  })

  it('content-budget refuses when text-like files exceed the file count or byte budget', () => {
    const many = admissibleSpec()
    for (let i = 0; i < 1_900; i++) many[`fixtures/${i}.json`] = { size: 2 }
    const count = run(many).gate('content-budget')
    expect(count.status).toBe('refuse')
    expect(count.detail).toContain('1905 text-like files')
    expect(count.detail).toContain('judged by extension')

    const bytes = run({ ...admissibleSpec(), 'a.sql': { size: 1024 * 1024 }, 'b.sql': { size: 1024 * 1024 }, 'c.sql': { size: 1024 * 1024 }, 'd.sql': { size: 1024 * 1024 }, 'e.sql': { size: 1024 * 1024 }, 'f.sql': { size: 1024 * 1024 }, 'g.sql': { size: 1024 * 1024 }, 'h.sql': { size: 1 } })
    expect(bytes.gate('content-budget').status).toBe('refuse')
    expect(bytes.gate('content-budget').detail).toContain('7.0 MiB')
  })

  it('content-budget is unknown when only the extension heuristic keeps the tree inside the budget', () => {
    const spec = admissibleSpec()
    for (let i = 0; i < 1_900; i++) spec[`img/${i}.png`] = { size: 1 }
    const result = run(spec)
    expect(result.gate('content-budget').status).toBe('unknown')
    expect(result.gate('content-budget').detail).toContain('1905 files')
    expect(result.gate('content-budget').detail).toContain('5 text-like by extension')
  })

  it('content-budget applies the larger cap to npm lockfiles', () => {
    const spec = { ...admissibleSpec(), 'package-lock.json': { size: 3 * 1024 * 1024, content: LOCK_V3 } }
    expect(run(spec).gate('content-budget').detail).toMatch(/^5 files, 3\.0 MiB/u)
  })
})

describe('package layout gates', () => {
  it('single-manifest refuses two manifests and names them', () => {
    const result = run({ ...admissibleSpec(), 'packages/a/package.json': '{}' })
    expect(result.gate('single-manifest').status).toBe('refuse')
    expect(result.gate('single-manifest').detail).toContain('2 package.json files (`package.json`, `packages/a/package.json`)')
  })

  it('single-manifest is unknown when the manifest was not read, and refuses malformed or non-object JSON', () => {
    expect(run({ ...admissibleSpec(), 'package.json': null }).gate('single-manifest')).toMatchObject({ status: 'unknown', detail: '`package.json` was not read locally' })
    expect(run({ ...admissibleSpec(), 'package.json': '{ not json' }).gate('single-manifest').status).toBe('refuse')
    expect(run({ ...admissibleSpec(), 'package.json': '[1]' }).gate('single-manifest').detail).toContain('not a JSON object')
    expect(run(admissibleSpec()).gate('single-manifest')).toMatchObject({ status: 'pass', detail: 'one package.json (`package.json`)' })
  })

  it('handles a manifest in a subdirectory: lockfile, tsconfig and .nvmrc resolve beside it', () => {
    const result = run({
      'service/package.json': manifest({}, ['packageManager']),
      'service/package-lock.json': LOCK_V3,
      'service/tsconfig.json': '{}',
      'service/.nvmrc': '20\n',
      'service/src/flags.ts': SDK_SOURCE,
    })
    expect(result.admissible).toBe(true)
    expect(result.gate('lockfile').detail).toBe('`service/package-lock.json` beside package.json')
    expect(result.gate('npm-pin').detail).toContain('inferred from lockfileVersion 3 `service/package-lock.json`')
    expect(result.gate('node-runtime').detail).toContain('.nvmrc 20')
  })

  it.each([
    'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'pnpm-workspace.yml', 'bun.lock', 'bun.lockb', 'bunfig.toml',
    '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.pnp.cjs', 'deno.lock', 'deno.json', 'deno.jsonc', '.yarn/releases/yarn.cjs', 'sub/yarn.lock',
  ])('package-manager-markers refuses %s', (marker) => {
    const result = run({ ...admissibleSpec(), [marker]: { size: 1 } })
    expect(result.gate('package-manager-markers').status).toBe('refuse')
    expect(result.gate('package-manager-markers').detail).toContain(`\`${marker}\``)
    expect(result.admissible).toBe(false)
  })

  it('package-manager-markers ignores look-alikes', () => {
    const result = run({ ...admissibleSpec(), 'notyarn.lock': 'x', 'src/.yarnish': 'x', 'deno.jsonx': 'x' })
    expect(result.gate('package-manager-markers')).toMatchObject({ status: 'pass' })
  })

  it('npmrc refuses a .npmrc anywhere in the tree', () => {
    expect(run({ ...admissibleSpec(), 'sub/.npmrc': 'registry=x' }).gate('npmrc').detail).toContain('`sub/.npmrc`')
    expect(run(admissibleSpec()).gate('npmrc')).toMatchObject({ status: 'pass', detail: 'no .npmrc' })
  })

  it('workspaces refuses any workspaces key, even an empty one', () => {
    expect(run({ ...admissibleSpec(), 'package.json': manifest({ workspaces: [] }) }).gate('workspaces').status).toBe('refuse')
    expect(run(admissibleSpec()).gate('workspaces').status).toBe('pass')
  })

  it('lockfile refuses competing, missing and misplaced lockfiles', () => {
    const competing = run({ ...admissibleSpec(), 'npm-shrinkwrap.json': '{}' })
    expect(competing.gate('lockfile').detail).toContain('competing npm lockfiles (`npm-shrinkwrap.json`, `package-lock.json`)')

    // A directory named like a lockfile is not a lockfile.
    const missing = run({ ...admissibleSpec(), 'package-lock.json': { kind: 'directory' } })
    expect(missing.gate('lockfile').status).toBe('refuse')
    expect(missing.gate('lockfile').detail).toContain('npm ci')
    expect(missing.gate('npm-pin').status).toBe('pass')

    const spec = admissibleSpec()
    delete spec['package-lock.json']
    spec['sub/package-lock.json'] = LOCK_V3
    expect(run(spec).gate('lockfile').detail).toContain('`sub/package-lock.json` is not beside `package.json`')
  })

  it('lockfile accepts npm-shrinkwrap.json beside the manifest', () => {
    const spec = admissibleSpec()
    delete spec['package-lock.json']
    spec['npm-shrinkwrap.json'] = LOCK_V3
    expect(run(spec).gate('lockfile')).toMatchObject({ status: 'pass', detail: '`npm-shrinkwrap.json` beside package.json' })
  })
})

describe('npm-pin gate', () => {
  it('passes only the exact pin the sandbox runs', () => {
    expect(run(admissibleSpec()).gate('npm-pin')).toMatchObject({ status: 'pass', detail: 'packageManager npm@10.9.8 matches the sandbox' })
    const other = run({ ...admissibleSpec(), 'package.json': manifest({ packageManager: 'npm@10.9.7' }) })
    expect(other.gate('npm-pin').detail).toContain('pins npm@10.9.7; the hosted sandbox runs npm 10.9.8')
  })

  it.each(['yarn@4.18.0', 'npm@10', 'npm@^10.9.8', 'pnpm@9.0.0', 42, null, 'npm@01.2.3'])('refuses packageManager %s', (value) => {
    const result = run({ ...admissibleSpec(), 'package.json': manifest({ packageManager: value }) })
    expect(result.gate('npm-pin').status).toBe('refuse')
    expect(result.gate('npm-pin').detail).toContain(`declares packageManager ${JSON.stringify(value)}`)
    expect(result.gate('npm-pin').detail).toContain('"npm@10.9.8"')
  })

  it('infers npm from a lockfileVersion 3 package-lock.json when packageManager is absent', () => {
    const result = run({ ...admissibleSpec(), 'package.json': manifest({}, ['packageManager']) })
    expect(result.gate('npm-pin')).toMatchObject({ status: 'pass', detail: 'no packageManager; npm 10.9.8 inferred from lockfileVersion 3 `package-lock.json`' })
    expect(result.gate('dev-engines').status).toBe('pass')
  })

  it('refuses inference from a missing, non-v3, string-versioned or malformed lockfile', () => {
    const base: Spec = { ...admissibleSpec(), 'package.json': manifest({}, ['packageManager']) }
    const noLock: Spec = { ...base }
    delete noLock['package-lock.json']
    expect(run(noLock).gate('npm-pin').detail).toContain('no `package-lock.json` to infer npm from')
    expect(run({ ...base, 'package-lock.json': '{"lockfileVersion": 2}' }).gate('npm-pin').detail).toContain('lockfileVersion 2, not 3')
    expect(run({ ...base, 'package-lock.json': '{"lockfileVersion": "3"}' }).gate('npm-pin').detail).toContain('lockfileVersion "3", not 3')
    expect(run({ ...base, 'package-lock.json': 'nope' }).gate('npm-pin').detail).toContain('lockfileVersion null, not 3')
    expect(run({ ...base, 'package-lock.json': '[]' }).gate('npm-pin').detail).toContain('lockfileVersion null, not 3')
  })

  it('is unknown when the lockfile exists but was not read, and dev-engines follows', () => {
    const result = run({ ...admissibleSpec(), 'package.json': manifest({ devEngines: { packageManager: { name: 'npm' } } }, ['packageManager']), 'package-lock.json': null })
    expect(result.gate('npm-pin')).toMatchObject({ status: 'unknown' })
    expect(result.gate('dev-engines')).toMatchObject({ status: 'unknown' })
    expect(result.gate('dev-engines').detail).toContain('see npm-pin')
  })
})

describe('dev-engines gate', () => {
  const withDevEngines = (packageManager: unknown) => run({ ...admissibleSpec(), 'package.json': manifest({ devEngines: { packageManager } }) })

  it('passes when absent, when devEngines is not an object, or when every entry names npm with an including range', () => {
    expect(run(admissibleSpec()).gate('dev-engines')).toMatchObject({ status: 'pass', detail: 'no devEngines.packageManager' })
    expect(run({ ...admissibleSpec(), 'package.json': manifest({ devEngines: 'x' }) }).gate('dev-engines').status).toBe('pass')
    expect(withDevEngines({ name: 'npm' }).gate('dev-engines')).toMatchObject({ status: 'pass', detail: 'devEngines.packageManager names npm 10.9.8' })
    expect(withDevEngines([{ name: 'npm', version: '>=10 <11' }, { name: 'npm', version: ' ^10.9.0 ' }]).gate('dev-engines').status).toBe('pass')
  })

  it.each([
    [{ name: 'yarn' }],
    [{ name: 'npm', version: 11 }],
    [{ name: 'npm', version: '^11' }],
    [[]],
    [['npm']],
    [[{ name: 'npm' }, { name: 'pnpm' }]],
  ])('refuses %j', (value) => {
    const g = withDevEngines(value).gate('dev-engines')
    expect(g.status).toBe('refuse')
    expect(g.detail).toContain('does not name npm 10.9.8')
  })
})

describe('rangeIncludesVersion', () => {
  it.each([
    ['10.9.8', true], ['=10.9.8', true], ['v10.9.8', true], ['10.9.9', false],
    ['^10.9.0', true], ['^10', true], ['^11.0.0', false], ['^0.9.0', false],
    ['~10.9.0', true], ['~10.8.0', false], ['10.9.x', true], ['10.x', true], ['10.8.x', false], ['11.x', false],
    ['>=10.9.8', true], ['>10.9.8', false], ['>10.9.7', true], ['<=10.9.8', true], ['<10.9.8', false], ['<11', true],
    ['*', true], ['x', true], ['', false], ['   ', false], ['latest', false], ['^9 || ^10', true], ['^9 || ~10.8.0', false],
    ['>=10 <10.9.8', false], ['1.2.3.4', false],
  ])('%s includes 10.9.8 → %s', (range, expected) => {
    expect(rangeIncludesVersion(range, '10.9.8')).toBe(expected)
  })

  it('handles caret ranges below 1.0 and wildcard patch on a zero major', () => {
    expect(rangeIncludesVersion('^0.9.1', '0.9.5')).toBe(true)
    expect(rangeIncludesVersion('^0.9.1', '0.10.0')).toBe(false)
    expect(rangeIncludesVersion('^0.0.3', '0.0.3')).toBe(true)
    expect(rangeIncludesVersion('^0.0.3', '0.0.4')).toBe(false)
    expect(rangeIncludesVersion('0.1.x', '0.1.9')).toBe(true)
  })
})

describe('dependencies gate', () => {
  it('passes registry, git and URL specifiers across every section and skips absent sections', () => {
    const result = run({
      ...admissibleSpec(),
      'package.json': manifest({
        optionalDependencies: { fsevents: '^2.3.0', tar: 'https://example.com/tar-1.0.0.tgz', repo: 'github:owner/repo', git: 'git+https://example.com/x.git' },
        peerDependencies: { react: '>=18' },
      }),
    })
    expect(result.gate('dependencies')).toMatchObject({ status: 'pass' })
  })

  it('refuses a section that is not an object', () => {
    const result = run({ ...admissibleSpec(), 'package.json': manifest({ peerDependencies: ['react'] }) })
    expect(result.gate('dependencies').detail).toContain('`peerDependencies` is not an object')
  })

  const REFUSED_SPECIFIERS: Array<[unknown, string]> = [
    ['file:../local', 'file'], ['link:../x', 'link'], ['workspace:*', 'workspace'], ['portal:../x', 'portal'], ['patch:x', 'patch'],
    ['./vendor/x', 'relative'], ['/abs/x', 'absolute'], ['~joe/x', 'home'], ['c:\\x', 'drive'], ['x\\y', 'backslash'],
    ['./local.tgz', 'tarball path'], ['local.tar.gz', 'tarball'], [' 1.0.0', 'untrimmed'], ['', 'blank'], ['1.0\u0000', 'control'], [7, 'number'],
  ]
  it.each(REFUSED_SPECIFIERS)('refuses %s (%s)', (value) => {
    const result = run({ ...admissibleSpec(), 'package.json': manifest({ dependencies: { '@launchdarkly/node-server-sdk': '^9.0.0', bad: value } }) })
    expect(result.gate('dependencies').status).toBe('refuse')
    expect(result.gate('dependencies').detail).toContain(`dependencies.bad: ${JSON.stringify(value)}`)
  })
})

describe('launchdarkly-sdk gate', () => {
  const withDeps = (deps: Record<string, string>, section = 'dependencies') =>
    run({ ...admissibleSpec(), 'package.json': manifest({ dependencies: {}, [section]: deps }) })

  it.each(['^9.11.0', '9.13.4', '~9.10.0', '9', '9.x', '9.*', '>=9.0.0 <10.0.0', '>9 <10', '>= 9.2 < 10.0.0', '9.11.0-beta.1'])('passes %s', (range) => {
    expect(withDeps({ '@launchdarkly/node-server-sdk': range }).gate('launchdarkly-sdk').status).toBe('pass')
    expect(isModernNodeSdkRange(range)).toBe(true)
  })

  it.each(['^8.0.0', '>=9.0.0', 'latest', '9 || 10', ' 9.0.0', '9.x.1', '9.x-beta', '10.x', '', '*'])('refuses modern range %j', (range) => {
    const g = withDeps({ '@launchdarkly/node-server-sdk': range }).gate('launchdarkly-sdk')
    expect(g.status).toBe('refuse')
    expect(g.detail).toContain('wholly inside 9.x')
    expect(isModernNodeSdkRange(range)).toBe(false)
  })

  it('refuses the legacy package even beside the modern one, and a manifest without either', () => {
    const legacy = withDeps({ 'launchdarkly-node-server-sdk': '^7.0.0', '@launchdarkly/node-server-sdk': '^9.0.0' })
    expect(legacy.gate('launchdarkly-sdk').detail).toContain('legacy `launchdarkly-node-server-sdk` ^7.0.0')
    const none = withDeps({})
    expect(none.gate('launchdarkly-sdk').detail).toContain('declares no `@launchdarkly/node-server-sdk`')
  })

  it('finds the SDK declared in devDependencies or peerDependencies', () => {
    expect(withDeps({ '@launchdarkly/node-server-sdk': '^9.0.0' }, 'peerDependencies').gate('launchdarkly-sdk').status).toBe('pass')
  })
})

describe('typecheck gate', () => {
  const noScript = (extra: Record<string, unknown> = {}) => manifest({ scripts: { test: 'node --test' }, ...extra })

  it('passes a typecheck or type-check script and refuses a blank or non-string one', () => {
    expect(run(admissibleSpec()).gate('typecheck')).toMatchObject({ status: 'pass', detail: '`npm run typecheck` (tsc --noEmit)' })
    const dashed = run({ ...admissibleSpec(), 'package.json': manifest({ scripts: { 'type-check': ' tsc -p . ', test: 'x' } }) })
    expect(dashed.gate('typecheck').detail).toBe('`npm run type-check` (tsc -p .)')
    expect(run({ ...admissibleSpec(), 'package.json': manifest({ scripts: { typecheck: '  ', test: 'x' } }) }).gate('typecheck').detail).toContain('`typecheck` is blank')
    expect(run({ ...admissibleSpec(), 'package.json': manifest({ scripts: { typecheck: 1, test: 'x' } }) }).gate('typecheck').status).toBe('refuse')
  })

  it('refuses when scripts is not an object (and test-script agrees)', () => {
    const result = run({ ...admissibleSpec(), 'package.json': manifest({ scripts: 'tsc' }) })
    expect(result.gate('typecheck').detail).toContain('`scripts` is not an object')
    expect(result.gate('test-script').detail).toContain('`scripts` is not an object')
  })

  it('falls back to tsc when typescript is locked and tsconfig.json is provable', () => {
    const result = run({ ...admissibleSpec(), 'package.json': noScript() })
    expect(result.gate('typecheck')).toMatchObject({ status: 'pass', detail: 'no typecheck script; tsc fallback usable (typescript 5.9.3 locked, `tsconfig.json` program shape provable)' })
    const inDeps = run({ ...admissibleSpec(), 'package.json': noScript({ dependencies: { '@launchdarkly/node-server-sdk': '^9.0.0', typescript: '5.9.3' }, devDependencies: {} }) })
    expect(inDeps.gate('typecheck').status).toBe('pass')
  })

  it('refuses the fallback without a typescript dependency, lock pin or tsconfig.json', () => {
    const noDep = run({ ...admissibleSpec(), 'package.json': noScript({ devDependencies: {} }) })
    expect(noDep.gate('typecheck').detail).toContain('no typescript dependency for the tsc fallback')
    expect(noDep.gate('typecheck').detail).toContain('Add "typecheck": "tsc --noEmit"')

    const noLock: Spec = { ...admissibleSpec(), 'package.json': noScript() }
    delete noLock['package-lock.json']
    expect(run(noLock).gate('typecheck')).toMatchObject({ status: 'refuse' })
    expect(run(noLock).gate('typecheck').detail).toContain('no `package-lock.json` to pin the typescript')

    const noPin = run({ ...admissibleSpec(), 'package.json': noScript(), 'package-lock.json': '{"lockfileVersion":3,"packages":{}}' })
    expect(noPin.gate('typecheck').detail).toContain('does not pin node_modules/typescript')
    const loosePin = run({ ...admissibleSpec(), 'package.json': noScript(), 'package-lock.json': '{"lockfileVersion":3,"packages":{"node_modules/typescript":{"version":"5.x"}}}' })
    expect(loosePin.gate('typecheck').status).toBe('refuse')
    const notRecord = run({ ...admissibleSpec(), 'package.json': noScript(), 'package-lock.json': '{"lockfileVersion":3,"packages":{"node_modules/typescript":"5.9.3"}}' })
    expect(notRecord.gate('typecheck').status).toBe('refuse')

    const spec: Spec = { ...admissibleSpec(), 'package.json': noScript() }
    delete spec['tsconfig.json']
    expect(run(spec).gate('typecheck').detail).toContain('no `tsconfig.json` for the tsc fallback')
  })

  it('is unknown when the lockfile or a tsconfig in the chain was not read', () => {
    expect(run({ ...admissibleSpec(), 'package.json': noScript(), 'package-lock.json': null }).gate('typecheck')).toMatchObject({ status: 'unknown' })
    expect(run({ ...admissibleSpec(), 'package.json': noScript(), 'tsconfig.json': null }).gate('typecheck')).toMatchObject({ status: 'unknown' })
    const chain = run({ ...admissibleSpec(), 'package.json': noScript(), 'tsconfig.json': '{ "extends": "./tsconfig.base.json" }', 'tsconfig.base.json': null })
    expect(chain.gate('typecheck').status).toBe('unknown')
  })

  it.each([
    ['{ "references": [] }', 'solution-style config'],
    ['{ "files": ["src/a.ts"] }', 'lists files explicitly'],
    ['{ "extends": ["./a.json", "./b.json"] }', 'extends more than one config'],
    ['{ "extends": "../outside/tsconfig.json" }', 'outside the package'],
    ['{ "extends": "@tsconfig/node20/tsconfig.json" }', 'outside the package'],
    ['{ "extends": "./tsconfig.json" }', 'extends itself'],
    ['not json', 'not a JSON object'],
    ['[]', 'not a JSON object'],
  ])('refuses tsconfig %s', (content, reason) => {
    const result = run({ ...admissibleSpec(), 'package.json': noScript(), 'tsconfig.json': content })
    expect(result.gate('typecheck').status).toBe('refuse')
    expect(result.gate('typecheck').detail).toContain(reason)
  })

  it('follows an extends chain inside the package, adding .json when omitted, and refuses one that is too deep', () => {
    const ok = run({
      'svc/package.json': noScript(),
      'svc/package-lock.json': LOCK_V3,
      'svc/tsconfig.json': '// root\n{ "extends": "./config/base", }',
      'svc/config/base.json': '{ "extends": "../tsconfig.shared.json" /* up one */ }',
      'svc/tsconfig.shared.json': '{ "compilerOptions": { "strict": true, } }',
    })
    expect(ok.gate('typecheck').status).toBe('pass')

    const deep: Spec = { ...admissibleSpec(), 'package.json': noScript(), 'tsconfig.json': '{ "extends": "./t1.json" }' }
    for (let i = 1; i <= 9; i++) deep[`t${i}.json`] = `{ "extends": "./t${i + 1}.json" }`
    expect(run(deep).gate('typecheck').detail).toContain('extends too deeply')

    const escapes = run({ 'svc/package.json': noScript(), 'svc/package-lock.json': LOCK_V3, 'svc/tsconfig.json': '{ "extends": "../../x.json" }' })
    expect(escapes.gate('typecheck').detail).toContain('outside the package')
  })
})

describe('parseJsonc', () => {
  it('strips comments and trailing commas outside strings, tolerates a BOM, and returns undefined for garbage', () => {
    expect(parseJsonc('\uFEFF{ "a": "// not a comment", /* c */ "b": [1, 2,], } // tail')).toEqual({ a: '// not a comment', b: [1, 2] })
    expect(parseJsonc('{ "esc": "a\\"b" }')).toEqual({ esc: 'a"b' })
    expect(parseJsonc('{ "a": 1 } // no newline')).toEqual({ a: 1 })
    expect(parseJsonc('{ "a": 1 } /* unterminated')).toEqual({ a: 1 })
    expect(parseJsonc('{ "open": "never closed')).toBeUndefined()
    expect(parseJsonc('{ a: 1 }')).toBeUndefined()
  })
})

describe('test-script and node-runtime gates', () => {
  it('test-script requires a nonblank string script', () => {
    expect(run(admissibleSpec()).gate('test-script')).toMatchObject({ status: 'pass', detail: '`npm test` (node --test)' })
    const absent = run({ ...admissibleSpec(), 'package.json': manifest({ scripts: { typecheck: 'tsc' } }) })
    expect(absent.gate('test-script').status).toBe('refuse')
    expect(absent.gate('test-script').detail).toContain('never published')
    expect(run({ ...admissibleSpec(), 'package.json': manifest({ scripts: { typecheck: 'tsc', test: '' } }) }).gate('test-script').detail).toContain('`test` script is blank')
    expect(run({ ...admissibleSpec(), 'package.json': manifest({ scripts: { typecheck: 'tsc', test: null } }) }).gate('test-script').status).toBe('refuse')
    expect(run({ ...admissibleSpec(), 'package.json': manifest({}, ['scripts']) }).gate('test-script').status).toBe('refuse')
  })

  it('node-runtime always passes and reports what was declared as a limitation', () => {
    expect(run(admissibleSpec()).gate('node-runtime')).toMatchObject({ status: 'pass', detail: 'no .nvmrc or engines.node accepted; the hosted sandbox runs Node 22.23.2 regardless (a limitation, not a gate)' })
    const declared = run({ ...admissibleSpec(), '.nvmrc': '20.11.0\n', 'package.json': manifest({ engines: { node: '>=18' } }) })
    expect(declared.gate('node-runtime').detail).toContain('.nvmrc 20.11.0, engines.node >=18 accepted')
    expect(run({ ...admissibleSpec(), 'package.json': manifest({ engines: 'x' }) }).gate('node-runtime').status).toBe('pass')
  })
})

describe('sdk-api-surface gate', () => {
  it('is unknown without a readable source importing the SDK, ignoring non-ECMAScript files', () => {
    const spec = admissibleSpec()
    delete spec['src/flags.ts']
    spec['notes.md'] = '@launchdarkly/node-server-sdk allFlagsState('
    expect(run(spec).gate('sdk-api-surface')).toMatchObject({ status: 'unknown' })
  })

  it('refuses allFlagsState and names the files', () => {
    const result = run({ ...admissibleSpec(), 'src/all.js': `const ld = require('launchdarkly-node-server-sdk'); ld.allFlagsState (ctx)` })
    expect(result.gate('sdk-api-surface').status).toBe('refuse')
    expect(result.gate('sdk-api-surface').detail).toContain('allFlagsState() is called in `src/all.js`')
  })

  it('is unknown for ambiguous client methods and passes a clean surface', () => {
    const result = run({ ...admissibleSpec(), 'src/flags.ts': SDK_SOURCE + `client.on('ready', () => {}); analytics.track('x'); client.identify(ctx)\n` })
    expect(result.gate('sdk-api-surface').status).toBe('unknown')
    expect(result.gate('sdk-api-surface').detail).toContain('calls to identify(), on(), track() in files importing the SDK')
    expect(run(admissibleSpec()).gate('sdk-api-surface')).toMatchObject({ status: 'pass', detail: 'no allFlagsState, on/off/once, track or identify calls in the 1 file importing the SDK' })
  })
})
