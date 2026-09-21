/**
 * Local hosted-admission preflight.
 *
 * `flagshark scan` classifies LaunchDarkly Node server call sites into the
 * registry's `draft-pr` cell, but the hosted planner refuses most real
 * repositories long before it plans a rewrite: tree shape, package layout,
 * package manager, scripts and SDK version all gate admission. This module
 * re-derives the gates that can be checked locally and cheaply, so the scanner
 * never prints a draft-PR promise the planner would refuse.
 *
 * Invariants (pinned by `test/migration/hosted-admission.test.ts`):
 *   - Pure. A function over an in-memory tree view: no account, no token, no
 *     network, no filesystem, no subprocess. The only runtime import is the
 *     registry snapshot's cell id.
 *   - Honest. A gate that cannot be checked locally is `unknown`, never
 *     `pass`. `admissible` means "no locally checkable gate refuses" — it is
 *     not a promise; only the hosted planner decides.
 *   - Withholding, never manufacturing. The rules mirror the hosted planner's
 *     snapshot collector, package selection and analyzer scope as of the
 *     registry revision recorded in `support-snapshot.json`. If those rules
 *     drift, the worst case here is a withheld "may qualify", never a false
 *     one.
 */

export type AdmissionGateStatus = 'pass' | 'refuse' | 'unknown'

export type AdmissionGateId =
  | 'tree-size'
  | 'tree-paths'
  | 'content-budget'
  | 'single-manifest'
  | 'package-manager-markers'
  | 'npmrc'
  | 'workspaces'
  | 'lockfile'
  | 'npm-pin'
  | 'dev-engines'
  | 'dependencies'
  | 'launchdarkly-sdk'
  | 'typecheck'
  | 'test-script'
  | 'node-runtime'
  | 'sdk-api-surface'
  | 'analyzer-budget'
  | 'transformation-blockers'
  | 'dependency-closure'
  | 'sandbox-validation'

export interface AdmissionGate {
  id: AdmissionGateId
  status: AdmissionGateStatus
  /** One line: what was found and, for a refusal, what would change the answer. */
  detail: string
}

export interface AdmissionTreeEntry {
  /** Repository-relative, `/`-separated, no leading `./`. */
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'submodule'
  /** Byte size for files; absent when the caller could not measure it. */
  size?: number
}

export interface AdmissionTreeView {
  /** Every entry the hosted collector would see (the committed tree, not the working directory's ignored files). */
  entries: readonly AdmissionTreeEntry[]
  /**
   * Contents of the small files the preflight reads — manifests, npm
   * lockfiles, `tsconfig*.json`, `.nvmrc` — plus the scanned source files.
   * A file missing from this map is reported as `unknown`, never assumed.
   */
  files: ReadonlyMap<string, string>
  /**
   * Set when enumeration was cut short (for example an unreadable directory):
   * every gate that depends on seeing the whole tree is then `unknown`. The
   * value is a short reason for the gate details.
   */
  incomplete?: string
}

export interface HostedAdmissionPreflight {
  /**
   * True when no locally checkable gate refuses. Not a promise: `unknown`
   * gates remain and only the hosted planner decides.
   */
  admissible: boolean
  gates: AdmissionGate[]
}

/** The registry cell whose admission rules this preflight mirrors. */
export const NODE_SERVER_CELL_ID = 'adopt-openfeature/launchdarkly-node-server/ecmascript/server'

/** Bounds of the hosted snapshot collector (FS-066). */
export const HOSTED_ADMISSION_LIMITS = Object.freeze({
  maxTreeEntries: 20_000,
  maxContentFiles: 1_900,
  maxContentBytes: 7 * 1024 * 1024,
  maxBlobBytes: 1024 * 1024,
  maxNpmLockfileBytes: 4 * 1024 * 1024,
})

/** Runtime of the hosted validation image; an inferred npm is always this one. */
export const HOSTED_SANDBOX_RUNTIME = Object.freeze({ node: '22.23.2', npm: '10.9.8' })

const MODERN_SDK = '@launchdarkly/node-server-sdk'
const LEGACY_SDK = 'launchdarkly-node-server-sdk'

const ECMASCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

const ANALYZER_INPUT_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  '.yarnrc',
  '.yarnrc.yml',
  '.nvmrc',
  '.npmrc',
  '.flagshark.yml',
  '.flagshark.yaml',
])

/** Extensions the collector would carry by identity (non-UTF-8), used only to bound the content budget. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.jar', '.class',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.node', '.bin',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.webm',
  '.lockb',
])

const PACKAGE_MANAGER_MARKER =
  /(?:^|\/)(?:pnpm-workspace\.ya?ml|pnpm-lock\.yaml|\.pnpmfile\.[cm]?js|yarn\.lock|\.yarnrc(?:\.yml)?|\.pnp\.[cm]?js|bun\.lockb?|bunfig\.toml|deno\.lock|deno\.jsonc?)$|(?:^|\/)\.yarn(?:\/|$)/u

const NPM_LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/u
const EXACT_NPM_PIN = /^npm@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u
const EXACT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u

/**
 * The LaunchDarkly Node client surface the hosted analyzer catalogues:
 * evaluations and lifecycle. Any other method on the client is an
 * `unmapped-api` blocker (`initialized`, `allFlagsState`, `migrationVariation`,
 * `trackMigration`, `on`, `track`, `identify`, `addListener`, …).
 */
const CATALOGUED_CLIENT_METHODS = new Set([
  'variation',
  'variationDetail',
  'boolVariation',
  'stringVariation',
  'numberVariation',
  'jsonVariation',
  'boolVariationDetail',
  'stringVariationDetail',
  'numberVariationDetail',
  'jsonVariationDetail',
  'init',
  'waitForInitialization',
  'flush',
  'close',
])

type Manifest = Record<string, unknown>

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function extension(path: string): string {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function sample(paths: string[], max = 3): string {
  const shown = paths.slice(0, max).map((p) => `\`${p}\``)
  return paths.length > max ? `${shown.join(', ')}, +${paths.length - max} more` : shown.join(', ')
}

function gate(id: AdmissionGateId, status: AdmissionGateStatus, detail: string): AdmissionGate {
  return { id, status, detail }
}

function isAnalyzerInput(path: string): boolean {
  const base = basename(path)
  return (
    ECMASCRIPT_EXTENSIONS.has(extension(path)) ||
    ANALYZER_INPUT_BASENAMES.has(base) ||
    /^tsconfig(?:\.[^/]+)?\.json$/u.test(base)
  )
}

// ── Tree gates ───────────────────────────────────────────────────

function treeSizeGate(entries: readonly AdmissionTreeEntry[]): AdmissionGate {
  const directories = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'directory') directories.add(entry.path)
    const segments = entry.path.split('/')
    for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join('/'))
  }
  const blobs = entries.filter((e) => e.kind !== 'directory').length
  const total = blobs + directories.size
  if (total > HOSTED_ADMISSION_LIMITS.maxTreeEntries) {
    return gate(
      'tree-size',
      'refuse',
      `${total} tree entries (${blobs} files, ${directories.size} directories); the hosted collector stops at ${HOSTED_ADMISSION_LIMITS.maxTreeEntries}. Move generated or vendored trees out of the repository.`,
    )
  }
  return gate('tree-size', 'pass', `${total} tree entries, within the collector's ${HOSTED_ADMISSION_LIMITS.maxTreeEntries}`)
}

/** Segments the hosted collector refuses outright, compared case-insensitively. */
const RESERVED_SEGMENTS = new Set(['.git', 'node_modules'])

/**
 * Mirrors the hosted collector's path rules: printable ASCII, no `\` or `:`,
 * no empty, `.`, `..`, `.git` or `node_modules` segments, no segment ending in
 * `.` or a space, no two paths that differ only by case, and no file that is
 * another path's ancestor.
 */
function treePathsGate(entries: readonly AdmissionTreeEntry[]): AdmissionGate {
  const symlinks: string[] = []
  const submodules: string[] = []
  const unsafe: string[] = []
  const aliased: string[] = []
  const seenLower = new Set<string>()
  const filePaths = new Set(entries.filter((e) => e.kind === 'file').map((e) => e.path))
  for (const entry of entries) {
    if (entry.kind === 'symlink') symlinks.push(entry.path)
    else if (entry.kind === 'submodule') submodules.push(entry.path)
    const path = entry.path
    const segments = path.split('/')
    if (
      path.length === 0 ||
      path.length > 1024 ||
      /[^\x20-\x7e]/u.test(path) ||
      /[\\:]/u.test(path) ||
      segments.some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          RESERVED_SEGMENTS.has(segment.toLowerCase()) ||
          segment.endsWith('.') ||
          segment.endsWith(' '),
      ) ||
      segments.slice(0, -1).some((_, i) => filePaths.has(segments.slice(0, i + 1).join('/')))
    ) {
      unsafe.push(path)
    }
    const lower = path.toLowerCase()
    if (seenLower.has(lower)) aliased.push(path)
    seenLower.add(lower)
  }
  const problems: string[] = []
  if (symlinks.length > 0) problems.push(`${plural(symlinks.length, 'symlink')} (${sample(symlinks)})`)
  if (submodules.length > 0) problems.push(`${plural(submodules.length, 'submodule')} (${sample(submodules)})`)
  if (unsafe.length > 0) problems.push(`${plural(unsafe.length, 'non-ASCII or unsafe path')} (${sample(unsafe)})`)
  if (aliased.length > 0) problems.push(`${plural(aliased.length, 'path')} differing only by case (${sample(aliased)})`)
  if (problems.length > 0) {
    return gate(
      'tree-paths',
      'refuse',
      `${problems.join('; ')}; the hosted collector admits only regular files and directories with printable-ASCII, case-unambiguous paths and no committed .git or node_modules. Replace symlinks with files, drop submodules, rename or remove the paths.`,
    )
  }
  return gate('tree-paths', 'pass', 'no symlinks, submodules, non-ASCII, reserved or case-ambiguous paths')
}

function contentBudgetGate(entries: readonly AdmissionTreeEntry[]): AdmissionGate {
  const files = entries.filter((e) => e.kind === 'file')
  if (files.some((e) => e.size === undefined)) {
    return gate('content-budget', 'unknown', 'file sizes were not measured locally; the hosted collector bounds text content by bytes')
  }
  const cap = (path: string) =>
    NPM_LOCKFILE.test(path) ? HOSTED_ADMISSION_LIMITS.maxNpmLockfileBytes : HOSTED_ADMISSION_LIMITS.maxBlobBytes
  const withinCap = files.filter((e) => e.size! <= cap(e.path))
  const textLike = withinCap.filter((e) => !BINARY_EXTENSIONS.has(extension(e.path)))
  const textBytes = textLike.reduce((n, e) => n + e.size!, 0)
  const allBytes = withinCap.reduce((n, e) => n + e.size!, 0)
  const { maxContentFiles, maxContentBytes } = HOSTED_ADMISSION_LIMITS
  const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`
  if (textLike.length > maxContentFiles || textBytes > maxContentBytes) {
    return gate(
      'content-budget',
      'refuse',
      `${textLike.length} text-like files totalling ${mib(textBytes)} (judged by extension); the hosted collector carries at most ${maxContentFiles} text files and ${mib(maxContentBytes)}. Move generated, vendored or fixture trees out of the repository.`,
    )
  }
  if (withinCap.length <= maxContentFiles && allBytes <= maxContentBytes) {
    return gate('content-budget', 'pass', `${withinCap.length} files, ${mib(allBytes)}, within the collector's ${maxContentFiles} text files and ${mib(maxContentBytes)}`)
  }
  return gate(
    'content-budget',
    'unknown',
    `${withinCap.length} files, ${mib(allBytes)} in total but ${textLike.length} text-like by extension; the hosted collector decides by bytes which count as text`,
  )
}

// ── Package layout gates ─────────────────────────────────────────

function packageManagerMarkersGate(paths: readonly string[]): AdmissionGate {
  const markers = paths.filter((p) => PACKAGE_MANAGER_MARKER.test(p))
  if (markers.length > 0) {
    return gate(
      'package-manager-markers',
      'refuse',
      `yarn, pnpm, bun or deno markers in the tree (${sample(markers)}); the hosted sandbox installs with npm only. Remove them and commit a package-lock.json.`,
    )
  }
  return gate('package-manager-markers', 'pass', 'no yarn, pnpm, bun or deno markers')
}

function npmrcGate(paths: readonly string[]): AdmissionGate {
  const found = paths.filter((p) => basename(p) === '.npmrc')
  if (found.length > 0) {
    return gate(
      'npmrc',
      'refuse',
      `.npmrc in the tree (${sample(found)}); registry and auth configuration cannot enter the credential-free sandbox. Remove it from the repository.`,
    )
  }
  return gate('npmrc', 'pass', 'no .npmrc')
}

interface SelectedManifest {
  path: string
  /** Directory prefix, `''` at the root or `dir/`. */
  prefix: string
  manifest: Manifest
}

function selectManifest(
  tree: AdmissionTreeView,
  paths: readonly string[],
): { gate: AdmissionGate; selected?: SelectedManifest } {
  const manifests = paths.filter((p) => basename(p) === 'package.json')
  if (manifests.length === 0) {
    return { gate: gate('single-manifest', 'refuse', 'no package.json in the tree; the draft-PR cell migrates exactly one npm package. Commit the package manifest.') }
  }
  if (manifests.length > 1) {
    return {
      gate: gate(
        'single-manifest',
        'refuse',
        `${manifests.length} package.json files (${sample(manifests)}); the draft-PR cell migrates exactly one npm package. Point the hosted product at a single-package repository.`,
      ),
    }
  }
  const path = manifests[0]
  const content = tree.files.get(path)
  if (content === undefined) {
    return { gate: gate('single-manifest', 'unknown', `\`${path}\` was not read locally`) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = undefined
  }
  if (!isRecord(parsed)) {
    return { gate: gate('single-manifest', 'refuse', `\`${path}\` is not a JSON object; the hosted planner refuses a malformed manifest. Fix the file.`) }
  }
  const prefix = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  return { gate: gate('single-manifest', 'pass', `one package.json (\`${path}\`)`), selected: { path, prefix, manifest: parsed } }
}

function workspacesGate(manifest: Manifest): AdmissionGate {
  if ('workspaces' in manifest) {
    return gate('workspaces', 'refuse', 'package.json declares `workspaces`; the draft-PR cell migrates a single package only. Point the hosted product at one workspace package in its own repository.')
  }
  return gate('workspaces', 'pass', 'no workspaces')
}

function lockfileGate(paths: readonly string[], selected: SelectedManifest): AdmissionGate {
  const lockfiles = paths.filter((p) => NPM_LOCKFILE.test(p)).sort()
  if (lockfiles.length > 1) {
    return gate('lockfile', 'refuse', `competing npm lockfiles (${sample(lockfiles)}); the hosted planner admits exactly one next to package.json. Keep the one beside \`${selected.path}\`.`)
  }
  if (lockfiles.length === 0) {
    return gate(
      'lockfile',
      'unknown',
      'no npm lockfile beside package.json; with a declared npm packageManager the hosted planner can supply a certified generated lock, and the dependency closure is verified only in the hosted sandbox (without a packageManager npm cannot be inferred either — see npm-pin)',
    )
  }
  const [lockfile] = lockfiles
  if (lockfile !== selected.prefix + basename(lockfile)) {
    return gate('lockfile', 'refuse', `\`${lockfile}\` is not beside \`${selected.path}\`; the hosted planner admits a lockfile only in the package directory. Move it next to package.json.`)
  }
  return gate('lockfile', 'pass', `\`${lockfile}\` beside package.json`)
}

interface NpmLock {
  lockfileVersion: unknown
  packages: Record<string, unknown> | undefined
}

function parseNpmLock(content: string): NpmLock | undefined {
  try {
    const parsed: unknown = JSON.parse(content)
    return isRecord(parsed)
      ? { lockfileVersion: parsed.lockfileVersion, packages: isRecord(parsed.packages) ? parsed.packages : undefined }
      : undefined
  } catch {
    return undefined
  }
}

function npmPinGate(
  tree: AdmissionTreeView,
  paths: readonly string[],
  selected: SelectedManifest,
): { gate: AdmissionGate; npmVersion?: string } {
  const { manifest, prefix } = selected
  const { npm } = HOSTED_SANDBOX_RUNTIME
  if ('packageManager' in manifest) {
    const declared = manifest.packageManager
    if (typeof declared !== 'string' || !EXACT_NPM_PIN.test(declared)) {
      return {
        gate: gate(
          'npm-pin',
          'refuse',
          `package.json declares packageManager ${JSON.stringify(declared)}; the hosted planner admits only an exact npm pin and its sandbox runs npm ${npm}. Set "packageManager": "npm@${npm}", or remove it and commit a lockfileVersion 3 package-lock.json.`,
        ),
      }
    }
    const version = declared.slice(4)
    if (version !== npm) {
      return {
        gate: gate(
          'npm-pin',
          'refuse',
          `package.json pins npm@${version}; the hosted sandbox runs npm ${npm} and refuses any other observed runtime. Set "packageManager": "npm@${npm}".`,
        ),
      }
    }
    return { gate: gate('npm-pin', 'pass', `packageManager npm@${version} matches the sandbox`), npmVersion: version }
  }
  const lockPath = `${prefix}package-lock.json`
  if (!paths.includes(lockPath)) {
    return {
      gate: gate(
        'npm-pin',
        'refuse',
        `package.json declares no packageManager and there is no \`${lockPath}\` to infer npm from. Set "packageManager": "npm@${npm}" or commit a lockfileVersion 3 package-lock.json.`,
      ),
    }
  }
  const content = tree.files.get(lockPath)
  if (content === undefined) {
    return { gate: gate('npm-pin', 'unknown', `\`${lockPath}\` was not read locally, so npm could not be inferred`) }
  }
  const lock = parseNpmLock(content)
  if (lock?.lockfileVersion !== 3) {
    return {
      gate: gate(
        'npm-pin',
        'refuse',
        `package.json declares no packageManager and \`${lockPath}\` is lockfileVersion ${JSON.stringify(lock?.lockfileVersion ?? null)}, not 3, so npm cannot be inferred. Regenerate the lockfile with npm >= 7 or set "packageManager": "npm@${npm}".`,
      ),
    }
  }
  return { gate: gate('npm-pin', 'pass', `no packageManager; npm ${npm} inferred from lockfileVersion 3 \`${lockPath}\``), npmVersion: npm }
}

function devEnginesGate(manifest: Manifest, npmVersion: string | undefined): AdmissionGate {
  const devEngines = isRecord(manifest.devEngines) ? manifest.devEngines.packageManager : undefined
  if (devEngines === undefined) {
    return gate('dev-engines', 'pass', 'no devEngines.packageManager')
  }
  if (npmVersion === undefined) {
    return gate('dev-engines', 'unknown', 'devEngines.packageManager is declared but the npm version is unresolved (see npm-pin)')
  }
  const entries = Array.isArray(devEngines) ? devEngines : [devEngines]
  const conflicting = entries.some(
    (entry) =>
      !isRecord(entry) ||
      entry.name !== 'npm' ||
      (entry.version !== undefined &&
        (typeof entry.version !== 'string' || !rangeIncludesVersion(entry.version.trim(), npmVersion))),
  )
  if (entries.length === 0 || conflicting) {
    return gate(
      'dev-engines',
      'refuse',
      `package.json devEngines.packageManager does not name npm ${npmVersion}; the hosted planner treats it as an explicit declaration. Name npm with a range that includes ${npmVersion}, or remove it.`,
    )
  }
  return gate('dev-engines', 'pass', `devEngines.packageManager names npm ${npmVersion}`)
}

/**
 * Conservative reading of a semver range as npm writes it in `devEngines`:
 * `||` alternatives of space-separated comparators (`>=`, `>`, `<=`, `<`,
 * `=`, `^`, `~`, bare, `x`/`*`). Anything else is "not provably included".
 */
export function rangeIncludesVersion(range: string, version: string): boolean {
  const target = version.split('.').map(Number) as [number, number, number]
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/u).filter(Boolean)
    return comparators.length > 0 && comparators.every((comparator) => comparatorIncludes(comparator, target))
  })
}

function comparatorIncludes(comparator: string, target: readonly [number, number, number]): boolean {
  if (comparator === '*' || comparator === 'x') return true
  const match = /^(>=|<=|>|<|=|\^|~)?v?(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*|x|\*))?(?:\.(0|[1-9][0-9]*|x|\*))?$/u.exec(comparator)
  if (!match) return false
  const operator = match[1] ?? ''
  const parts = [match[2], match[3], match[4]]
  const wildcardAt = parts.findIndex((part) => part === undefined || part === 'x' || part === '*')
  const lower: [number, number, number] = [
    Number(parts[0]),
    wildcardAt === 1 ? 0 : Number(parts[1]),
    wildcardAt === 1 || wildcardAt === 2 ? 0 : Number(parts[2]),
  ]
  const cmp = compareVersions(target, lower)
  switch (operator) {
    case '>':
      return cmp > 0
    case '>=':
      return cmp >= 0
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
    default:
      break
  }
  // `=`, bare, `^`, `~`, wildcards: an inclusive lower bound plus an exclusive upper bound.
  return cmp >= 0 && compareVersions(target, upperBound(operator, lower, wildcardAt)) < 0
}

/** Exclusive upper bound of a caret, tilde, wildcard or exact comparator. Narrower than semver where in doubt (`^0.x`): a wrong answer only withholds. */
function upperBound(operator: string, lower: readonly [number, number, number], wildcardAt: number): [number, number, number] {
  if (operator === '^') {
    if (lower[0] > 0) return [lower[0] + 1, 0, 0]
    if (lower[1] > 0) return [0, lower[1] + 1, 0]
    return [0, 0, lower[2] + 1]
  }
  if (wildcardAt === 1) return [lower[0] + 1, 0, 0]
  if (operator === '~' || wildcardAt === 2) return [lower[0], lower[1] + 1, 0]
  return [lower[0], lower[1], lower[2] + 1]
}

function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

function dependenciesGate(manifest: Manifest): AdmissionGate {
  const offending: string[] = []
  for (const key of DEPENDENCY_SECTIONS) {
    const section = manifest[key]
    if (section === undefined) continue
    if (!isRecord(section)) {
      return gate('dependencies', 'refuse', `package.json \`${key}\` is not an object; the hosted planner refuses a malformed manifest. Fix the section.`)
    }
    for (const [name, value] of Object.entries(section)) {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value !== value.trim() ||
        /[\x00-\x1f\x7f]/u.test(value) ||
        /^(?!https?:|git\+|github:|gitlab:|bitbucket:).*\.(?:tgz|tar\.gz)$/iu.test(value) ||
        /^(?:workspace:|(?:git\+)?file:|link:|portal:|patch:|\.|\/|~[^/]*\/|[a-z]:)|\\/iu.test(value)
      ) {
        offending.push(`${key}.${name}: ${JSON.stringify(value)}`)
      }
    }
  }
  if (offending.length > 0) {
    return gate(
      'dependencies',
      'refuse',
      `local or malformed dependency declarations (${sample(offending)}); the credential-free sandbox installs registry packages only. Publish or replace them with registry versions.`,
    )
  }
  return gate('dependencies', 'pass', 'every dependency declaration is a registry, git or URL specifier')
}

function declaredVersion(manifest: Manifest, name: string): string | undefined {
  for (const key of DEPENDENCY_SECTIONS) {
    const section = manifest[key]
    if (isRecord(section) && typeof section[name] === 'string') return section[name] as string
  }
  return undefined
}

function simpleVersionMajor(version: string): number | undefined {
  const match = version.match(
    /^[~^]?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i,
  )
  if (!match) return undefined
  const [, major, minor, patch] = match
  const minorWild = minor?.toLowerCase() === 'x' || minor === '*'
  const patchWild = patch?.toLowerCase() === 'x' || patch === '*'
  if (minorWild && patch !== undefined) return undefined
  if ((minorWild || patchWild) && /[-+]/.test(version)) return undefined
  return Number(major)
}

/** Whether a declared range lies wholly inside the modern SDK surface the hosted analyzer models (9.x). */
export function isModernNodeSdkRange(declared: string): boolean {
  if (declared.length === 0 || declared !== declared.trim() || declared.includes('||')) return false
  return (
    simpleVersionMajor(declared) === 9 ||
    /^(?:>=|>)\s*v?9(?:\.\d+){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\s+<\s*v?10(?:\.0+){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.test(declared)
  )
}

function launchDarklySdkGate(manifest: Manifest): AdmissionGate {
  const modern = declaredVersion(manifest, MODERN_SDK)
  const legacy = declaredVersion(manifest, LEGACY_SDK)
  if (legacy !== undefined) {
    // The cell does list the legacy package (>=1 <8) and the hosted preview
    // rewrites the dependency; only this local preflight does not model it.
    return gate(
      'launchdarkly-sdk',
      'unknown',
      `package.json declares the legacy \`${LEGACY_SDK}\` ${legacy}; the local preflight does not model the legacy SDK surface, so whether these call sites are admitted is decided by the hosted analyzer`,
    )
  }
  if (modern === undefined) {
    return gate(
      'launchdarkly-sdk',
      'refuse',
      `package.json declares no \`${MODERN_SDK}\`; the SDK reaches the code some other way (transitive dependency or vendored copy), which the hosted planner cannot rewrite. Declare \`${MODERN_SDK}\` 9.x directly.`,
    )
  }
  if (!isModernNodeSdkRange(modern)) {
    return gate(
      'launchdarkly-sdk',
      'refuse',
      `package.json declares \`${MODERN_SDK}\` ${JSON.stringify(modern)}; the hosted analyzer models only ranges wholly inside 9.x (for example ^9.0.0). Narrow the range.`,
    )
  }
  return gate('launchdarkly-sdk', 'pass', `\`${MODERN_SDK}\` ${modern} is inside the modelled 9.x surface`)
}

function scriptsOf(manifest: Manifest): Record<string, unknown> | undefined {
  const scripts = manifest.scripts ?? {}
  return isRecord(scripts) ? scripts : undefined
}

function typecheckGate(tree: AdmissionTreeView, regularPaths: ReadonlySet<string>, selected: SelectedManifest): AdmissionGate {
  const { manifest, prefix } = selected
  const scripts = scriptsOf(manifest)
  if (scripts === undefined) {
    return gate('typecheck', 'refuse', 'package.json `scripts` is not an object; the hosted planner refuses a malformed manifest. Fix the section.')
  }
  const name = (['typecheck', 'type-check'] as const).find((candidate) => candidate in scripts)
  if (name !== undefined) {
    const script = scripts[name]
    if (typeof script !== 'string' || !script.trim()) {
      return gate('typecheck', 'refuse', `package.json script \`${name}\` is blank; the hosted planner runs it and cannot treat an empty script as a type check. Make it run your type checker (for example tsc --noEmit).`)
    }
    return gate('typecheck', 'pass', `\`npm run ${name}\` (${script.trim()})`)
  }
  const remedy = 'Add "typecheck": "tsc --noEmit" to package.json scripts.'
  const declared = [manifest.dependencies, manifest.devDependencies].some(
    (section) => isRecord(section) && typeof section.typescript === 'string',
  )
  if (!declared) {
    return gate('typecheck', 'refuse', `no typecheck or type-check script and no typescript dependency for the tsc fallback. ${remedy}`)
  }
  const lockPath = `${prefix}package-lock.json`
  if (!regularPaths.has(lockPath)) {
    return gate(
      'typecheck',
      'unknown',
      `no typecheck script and no \`${lockPath}\` locally to pin the typescript the tsc fallback would run; the hosted planner may supply a certified generated lock, so this is decided there. ${remedy.replace(/\.$/u, '')} to make it provable locally.`,
    )
  }
  const lockContent = tree.files.get(lockPath)
  if (lockContent === undefined) {
    return gate('typecheck', 'unknown', `no typecheck script; the tsc fallback needs the typescript version pinned in \`${lockPath}\`, which was not read locally`)
  }
  const locked = parseNpmLock(lockContent)?.packages?.['node_modules/typescript']
  const version = isRecord(locked) ? locked.version : undefined
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    return gate('typecheck', 'refuse', `no typecheck script and \`${lockPath}\` does not pin node_modules/typescript to an exact version for the tsc fallback. ${remedy}`)
  }
  const tsconfigPath = `${prefix}tsconfig.json`
  if (!regularPaths.has(tsconfigPath)) {
    return gate('typecheck', 'refuse', `no typecheck script and no \`${tsconfigPath}\` for the tsc fallback. ${remedy}`)
  }
  const shape = tsconfigProgramShapeRefusal(tree.files, tsconfigPath, prefix)
  if (shape === 'unread') {
    return gate('typecheck', 'unknown', `no typecheck script; the tsc fallback's tsconfig chain from \`${tsconfigPath}\` was not fully read locally`)
  }
  if (shape !== undefined) {
    return gate('typecheck', 'refuse', `no typecheck script and ${shape} ${remedy}`)
  }
  return gate('typecheck', 'pass', `no typecheck script; tsc fallback usable (typescript ${version} locked, \`${tsconfigPath}\` program shape provable)`)
}

/**
 * Shape rules for a `tsconfig.json` the hosted tsc fallback may compile: no
 * solution-style `references`, no explicit `files`, and an `extends` chain
 * that stays inside the package. Returns `'unread'` when a config in the
 * chain is absent from the tree view (unknown, not a refusal).
 */
function tsconfigProgramShapeRefusal(files: ReadonlyMap<string, string>, tsconfigPath: string, prefix: string): string | undefined {
  const seen = new Set<string>()
  let path = tsconfigPath
  for (let depth = 0; depth < 8; depth += 1) {
    if (seen.has(path)) return `\`${path}\` extends itself; the checked program cannot be proven.`
    seen.add(path)
    const content = files.get(path)
    if (content === undefined) return 'unread'
    const parsed = parseJsonc(content)
    if (!isRecord(parsed)) return `\`${path}\` is not a JSON object; the tsc fallback cannot read it.`
    if ('references' in parsed) return `\`${path}\` is a solution-style config (references); the checked program cannot be proven.`
    if ('files' in parsed) return `\`${path}\` lists files explicitly; the checked program cannot be proven from include globs.`
    if (!('extends' in parsed)) return undefined
    if (typeof parsed.extends !== 'string') return `\`${path}\` extends more than one config; the checked program cannot be proven.`
    const resolved = resolveRelative(path, parsed.extends)
    if (resolved === undefined || !resolved.startsWith(prefix)) {
      return `\`${path}\` extends ${parsed.extends}, which is outside the package; the checked program cannot be proven.`
    }
    path = resolved
  }
  return `\`${tsconfigPath}\` extends too deeply; the checked program cannot be proven.`
}

/** `./x` or `../x` from the config's directory, kept inside the tree; anything else is refused. */
function resolveRelative(from: string, target: string): string | undefined {
  if (!target.startsWith('./') && !target.startsWith('../')) return undefined
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : []
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (base.length === 0) return undefined
      base.pop()
      continue
    }
    base.push(segment)
  }
  const joined = base.join('/')
  return joined.endsWith('.json') ? joined : `${joined}.json`
}

/** tsconfig.json is JSON with comments and trailing commas; strip both outside strings. */
export function parseJsonc(text: string): unknown {
  let output = ''
  let index = text.startsWith('\uFEFF') ? 1 : 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      output += text.slice(index, end + 1)
      index = end + 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }
    output += char
    index += 1
  }
  try {
    return JSON.parse(output.replace(/,(\s*[}\]])/gu, '$1'))
  } catch {
    return undefined
  }
}

function testScriptGate(manifest: Manifest): AdmissionGate {
  const scripts = scriptsOf(manifest)
  if (scripts === undefined) {
    return gate('test-script', 'refuse', 'package.json `scripts` is not an object; the hosted planner refuses a malformed manifest. Fix the section.')
  }
  if (!('test' in scripts)) {
    return gate(
      'test-script',
      'refuse',
      'package.json has no `test` script; a preview whose test suite never ran cannot count as passing, so it is never published. Add a "test" script that runs your suite.',
    )
  }
  const script = scripts.test
  if (typeof script !== 'string' || !script.trim()) {
    return gate('test-script', 'refuse', 'package.json `test` script is blank; the hosted planner runs it and cannot treat an empty script as a passing suite. Make it run your tests.')
  }
  return gate('test-script', 'pass', `\`npm test\` (${script.trim()})`)
}

function nodeRuntimeGate(tree: AdmissionTreeView, selected: SelectedManifest): AdmissionGate {
  const nvmrc = tree.files.get(`${selected.prefix}.nvmrc`)?.trim()
  const engines = isRecord(selected.manifest.engines) ? selected.manifest.engines.node : undefined
  const declared = [
    nvmrc !== undefined ? `.nvmrc ${nvmrc}` : undefined,
    typeof engines === 'string' ? `engines.node ${engines}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return gate(
    'node-runtime',
    'pass',
    `${declared.length > 0 ? declared.join(', ') : 'no .nvmrc or engines.node'} accepted; the hosted sandbox runs Node ${HOSTED_SANDBOX_RUNTIME.node} regardless (a limitation, not a gate)`,
  )
}

// ── Source gates ─────────────────────────────────────────────────

function sdkApiSurfaceGate(tree: AdmissionTreeView): AdmissionGate {
  const sdkFiles = [...tree.files]
    .filter(([path, content]) => ECMASCRIPT_EXTENSIONS.has(extension(path)) && (content.includes(MODERN_SDK) || content.includes(LEGACY_SDK)))
  if (sdkFiles.length === 0) {
    return gate('sdk-api-surface', 'unknown', 'no source file importing the LaunchDarkly Node SDK was read locally')
  }
  const allFlagsState = sdkFiles.filter(([, content]) => /\ballFlagsState\s*\(/u.test(content)).map(([path]) => path)
  if (allFlagsState.length > 0) {
    return gate(
      'sdk-api-surface',
      'refuse',
      `allFlagsState() is called in ${sample(allFlagsState)}; the hosted planner has no OpenFeature mapping for it (unmapped-api). Replace it with per-flag evaluations.`,
    )
  }
  // Every member call in the SDK-importing files: the receiver cannot be
  // resolved locally, so any non-catalogued method might be on the client.
  const uncatalogued = new Set<string>()
  const catalogued = new Set<string>()
  for (const [, content] of sdkFiles) {
    for (const match of content.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/gu)) {
      ;(CATALOGUED_CLIENT_METHODS.has(match[1]) ? catalogued : uncatalogued).add(match[1])
    }
  }
  if (uncatalogued.size > 0) {
    const names = [...uncatalogued].sort()
    return gate(
      'sdk-api-surface',
      'unknown',
      `${plural(names.length, 'method')} outside the catalogued client surface called in the ${plural(sdkFiles.length, 'file')} importing the SDK (${sample(names.map((m) => `${m}()`), 6)}); any of them on the LaunchDarkly client is an unmapped-api refusal, and only the hosted analyzer can prove the receiver`,
    )
  }
  return gate(
    'sdk-api-surface',
    'pass',
    `only catalogued client methods (${[...catalogued].sort().map((m) => `${m}()`).join(', ') || 'none'}) are called in the ${plural(sdkFiles.length, 'file')} importing the SDK; the receiver proof itself still requires the hosted analyzer`,
  )
}

// ── Assembly ─────────────────────────────────────────────────────

const NOT_CHECKED = 'not checked: requires exactly one readable package.json'

/** First occurrence of each path wins; later index stages of the same path are dropped. */
function dedupePaths(entries: readonly AdmissionTreeEntry[]): AdmissionTreeEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.path)) return false
    seen.add(entry.path)
    return true
  })
}

/**
 * Preflight for the LaunchDarkly Node server `draft-pr` cell. Gate order is
 * the order the hosted pipeline refuses in: collector, package selection,
 * scripts, then what only the hosted analyzer and sandbox can decide.
 */
export function preflightNodeServerAdmission(tree: AdmissionTreeView): HostedAdmissionPreflight {
  // Merge-conflict stages list one path several times in the index; the
  // committed tree the hosted collector reads has each path once.
  const entries = dedupePaths(tree.entries)
  const paths = entries.map((e) => e.path)
  // Manifests and lockfiles are regular files; markers match any entry kind (a `.yarn/` directory is a marker too).
  const filePaths = entries.filter((e) => e.kind === 'file').map((e) => e.path)
  const regularPaths = new Set(filePaths)
  const gates: AdmissionGate[] = []

  if (tree.incomplete !== undefined) {
    // Nothing that depends on seeing the whole tree can be decided: a second
    // manifest or a marker could sit in the part that was not enumerated.
    const detail = `tree enumeration incomplete (${tree.incomplete}); the hosted collector reads the committed tree in full`
    for (const id of ['tree-size', 'tree-paths', 'content-budget', 'single-manifest', 'package-manager-markers', 'npmrc'] as const) {
      gates.push(gate(id, 'unknown', detail))
    }
  } else {
    gates.push(treeSizeGate(entries), treePathsGate(entries), contentBudgetGate(entries))
  }

  const manifest = tree.incomplete === undefined ? selectManifest(tree, filePaths) : { gate: undefined, selected: undefined }
  if (manifest.gate !== undefined) gates.push(manifest.gate, packageManagerMarkersGate(paths), npmrcGate(paths))

  const selected = manifest.selected
  if (selected === undefined) {
    for (const id of ['workspaces', 'lockfile', 'npm-pin', 'dev-engines', 'dependencies', 'launchdarkly-sdk', 'typecheck', 'test-script', 'node-runtime'] as const) {
      gates.push(gate(id, 'unknown', NOT_CHECKED))
    }
  } else {
    const npmPin = npmPinGate(tree, filePaths, selected)
    gates.push(
      workspacesGate(selected.manifest),
      lockfileGate(filePaths, selected),
      npmPin.gate,
      devEnginesGate(selected.manifest, npmPin.npmVersion),
      dependenciesGate(selected.manifest),
      launchDarklySdkGate(selected.manifest),
      typecheckGate(tree, regularPaths, selected),
      testScriptGate(selected.manifest),
      nodeRuntimeGate(tree, selected),
    )
  }

  gates.push(sdkApiSurfaceGate(tree))

  const analyzerInputs = paths.filter((p) => regularPaths.has(p) && isAnalyzerInput(p)).length
  gates.push(
    gate('analyzer-budget', 'unknown', `${plural(analyzerInputs, 'analyzer-input file')} locally (ECMAScript sources, manifests, tsconfig*); the token and work budgets are measured only by the hosted analyzer`),
    gate('transformation-blockers', 'unknown', 'provider setup, client escape, unmapped client APIs, default-value types and wrapper-forwarded (dynamic) flag keys are proven only by the hosted analyzer'),
    gate('dependency-closure', 'unknown', 'the certified dependency closure is verified only inside the hosted sandbox'),
    gate('sandbox-validation', 'unknown', 'npm ci, the type check and the test suite run only inside the hosted sandbox'),
  )

  return { admissible: !gates.some((g) => g.status === 'refuse'), gates }
}

/** Local preflights by registry cell id. A cell absent here has no local preflight; its wording stays "may qualify". */
export const HOSTED_ADMISSION_PREFLIGHTS: Readonly<Record<string, (tree: AdmissionTreeView) => HostedAdmissionPreflight>> = Object.freeze({
  [NODE_SERVER_CELL_ID]: preflightNodeServerAdmission,
})
