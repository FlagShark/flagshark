/**
 * Shape guards for the wrapper pass: the odd, malformed and adversarial source
 * shapes a real repository eventually contains. Each case pins what the pass
 * does with it — almost always "refuse and say why" rather than guess.
 */
import { describe, it, expect } from 'vitest'

import { defaultTypeScriptProviders } from '../../src/detection/detectors/typescript.js'
import { buildImportGraph, isTsJsFile } from '../../src/detection/import-graph.js'
import { getImportPattern, type FeatureFlagProvider } from '../../src/detection/interface.js'
import {
  analyzeWrapperEvaluations,
  type EvaluationGapReason,
  type WrapperEvaluationResult,
} from '../../src/detection/wrapper-evaluations.js'

const ROOT = '/repo'
const SDK = '@launchdarkly/node-server-sdk'

async function analyze(
  files: Record<string, string>,
  providers: FeatureFlagProvider[] = defaultTypeScriptProviders(),
  maxWrapperDepth?: number,
): Promise<WrapperEvaluationResult> {
  const map = new Map(Object.entries(files).map(([path, content]) => [`${ROOT}/${path}`, content]))
  const seedSdkPatterns = providers
    .map((provider) => getImportPattern(provider))
    .filter((pattern) => pattern.length > 0)
  const graph = buildImportGraph(map, { seedSdkPatterns, isTsJs: isTsJsFile })
  return analyzeWrapperEvaluations({
    files: map,
    transitiveSdks: graph.transitiveSdks,
    providers,
    languageForFile: () => 'typescript',
    maxWrapperDepth,
  })
}

function names(result: WrapperEvaluationResult): string[] {
  return result.flags.map((flag) => flag.name).sort()
}

function gapReasons(result: WrapperEvaluationResult): EvaluationGapReason[] {
  return result.sites
    .filter((site) => site.status.kind === 'gap')
    .map((site) => (site.status as { reason: EvaluationGapReason }).reason)
    .sort()
}

const FLAGS_MODULE = `
import { init } from '${SDK}'
const client = init('sdk-key')
export class Flags {
  check(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
}
export function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`

describe('wrapper pass — receiver shapes', () => {
  it('unwraps await, parentheses and non-null assertions in a method receiver', async () => {
    const result = await analyze({
      'src/flags.ts': FLAGS_MODULE,
      'src/app.ts': `
import { Flags } from './flags'
const pending: Flags = new Flags()
const maybe: Flags | null = null
export async function run() {
  return [
    (await pending).check('awaited-flag'),
    maybe!.check('non-null-flag'),
  ]
}
`,
    })
    expect(names(result)).toEqual(['awaited-flag', 'non-null-flag'])
  })

  it('reduces a subscripted receiver to the handle it indexes into', async () => {
    const result = await analyze({
      'src/flags.ts': FLAGS_MODULE,
      'src/app.ts': `
import { Flags } from './flags'
const registry: Flags[] = []
export const run = () => registry[0].check('subscript-flag')
`,
    })
    expect(names(result)).toEqual(['subscript-flag'])
  })

  it('refuses a receiver that reduces to no identifier at all', async () => {
    const result = await analyze({
      'src/flags.ts': FLAGS_MODULE,
      'src/app.ts': `
import { Flags } from './flags'
export const run = () => ({ check: (key: string) => key }).check('literal-receiver-flag')
`,
    })
    expect(result.flags).toEqual([])
  })

  it('does not match a bare call against a method wrapper', async () => {
    const result = await analyze({
      'src/flags.ts': FLAGS_MODULE,
      'src/app.ts': `
import { Flags } from './flags'
declare function check(key: string): boolean
export const run = () => check('bare-call-flag')
`,
    })
    expect(result.flags).toEqual([])
  })

  it('ignores a tagged template, a computed call and a private method call', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const table = { variation: (key: string) => key }
const sql = (strings: TemplateStringsArray) => strings.raw[0]
export class Holder {
  #variation(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
  run() {
    return [sql\`variation\`, table['variation']('computed'), this.#variation('private')]
  }
}
`,
    })
    // Only the real SDK call inside `#variation` is a site; it forwards a
    // parameter of a method the scan can name, but nothing calls it by a bindable
    // name, so it is a refusal.
    expect(gapReasons(result)).toEqual(['wrapper-without-callers'])
  })
})

describe('wrapper pass — declaration shapes', () => {
  it('reads a parameter list that contains comments', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag(
  /* the key */ key: string,
  // the default
  fallback: boolean,
) {
  return client.boolVariation(key, { key: 'anonymous' }, fallback)
}
`,
      'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('commented-params-flag', false)
`,
    })
    expect(names(result)).toEqual(['commented-params-flag'])
  })

  it('refuses an anonymous default-exported function', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export default function (key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['unnamed-wrapper'])
  })

  it('refuses a function value bound by a destructuring declarator', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const { length } = (key: string) => client.boolVariation(key, { key: 'anonymous' }, false)
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['unnamed-wrapper'])
  })

  it('refuses an object literal bound by a destructuring declarator', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const { check } = {
  check(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  },
}
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['unnamed-wrapper'])
  })

  it('an export list marks a class owner and an object owner as importable', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
class Flags {
  check(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
}
const toggles = {
  on(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  },
}
export { Flags, toggles }
`,
      'src/app.ts': `
import { Flags, toggles } from './flags'
export const run = () => [new Flags().check('class-list-flag'), toggles.on('object-list-flag')]
`,
    })
    expect(names(result)).toEqual(['class-list-flag', 'object-list-flag'])
  })

  it('an export list marks an arrow const as importable', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const getFlag = (key: string) => client.boolVariation(key, { key: 'anonymous' }, false)
export { getFlag }
`,
      'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('arrow-list-flag')
`,
    })
    expect(names(result)).toEqual(['arrow-list-flag'])
  })

  it('ignores class fields and constructor parameters with no type annotation', async () => {
    const result = await analyze({
      'src/flags.ts': FLAGS_MODULE,
      'src/app.ts': `
import { Flags } from './flags'
export class Consumer {
  count = 0
  constructor(
    // no annotation, so no handle
    private readonly flags,
    /* a comment in the list */ readonly other: Flags,
  ) {}
  run() {
    return this.other.check('annotated-handle-flag')
  }
}
`,
    })
    expect(names(result)).toEqual(['annotated-handle-flag'])
  })

  it('records a wrapper once when it forwards into the SDK and into another wrapper', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function inner(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
export function outer(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false) || inner(key)
}
`,
      'src/app.ts': `
import { outer } from './flags'
export const run = () => outer('deduped-flag')
`,
    })
    expect(result.wrappers.map((wrapper) => `${wrapper.name}@${wrapper.depth}`)).toEqual([
      'inner@1',
      'outer@1',
    ])
    expect(names(result)).toEqual(['deduped-flag'])
  })

  it('sorts two wrappers declared on the same line by name', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const beta = (key: string) => client.boolVariation(key, { key: 'a' }, false), alpha = (key: string) => client.stringVariation(key, { key: 'a' }, 'off')
`,
      'src/app.ts': `
import { alpha, beta } from './flags'
export const run = () => [alpha('alpha-flag'), beta('beta-flag')]
`,
    })
    expect(result.wrappers.map((wrapper) => wrapper.name)).toEqual(['alpha', 'beta'])
    expect(result.sites.filter((site) => site.status.kind === 'accounted')).toHaveLength(2)
  })
})

describe('wrapper pass — module resolution shapes', () => {
  it('ignores a require() call the scan cannot read a specifier from', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const which = './flags'
const nothing = require()
const dynamic = require(which)
const [first] = require('./flags')
export const getFlag = (key: string) => client.boolVariation(key, { key: 'anonymous' }, false)
`,
      'src/app.ts': `
const { getFlag } = require('./flags')
export const run = () => getFlag('cjs-shorthand-flag')
`,
    })
    expect(names(result)).toEqual(['cjs-shorthand-flag'])
  })

  it('ignores a re-export whose module does not resolve in the scan set', async () => {
    const result = await analyze({
      'src/flags/client.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
      'src/flags/index.ts': `
export {
  // the wrapper
  getFlag,
} from './client'
export { missing } from './nowhere'
export type { Other } from 'some-package'
`,
      'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('unresolved-reexport-flag')
`,
    })
    expect(names(result)).toEqual(['unresolved-reexport-flag'])
  })

  it('stops at a barrel that re-exports a different name, and survives a re-export cycle', async () => {
    const result = await analyze({
      'src/flags/client.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
      'src/flags/index.ts': `
export { getFlag } from './client'
export { somethingElse } from './other'
export * from './loop'
`,
      'src/flags/loop.ts': `export * from './index'`,
      'src/flags/other.ts': `export const somethingElse = 'not-a-flag-key'`,
      'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('cyclic-barrel-flag')
`,
    })
    expect(names(result)).toEqual(['cyclic-barrel-flag'])
  })

  it('reads named imports and export clauses that contain comments', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
export {
  // the wrapper
  getFlag,
}
`,
      // The import graph's specifier regex is single-line, so the multi-line
      // import below does not put this file in SDK scope on its own; the
      // side-effect import does. The wrapper binding is read from the parsed
      // tree either way.
      'src/app.ts': `
import './flags'
import {
  // the wrapper
  getFlag,
} from './flags'
export const run = () => getFlag('commented-import-flag')
`,
    })
    expect(names(result)).toEqual(['commented-import-flag'])
  })
})

describe('wrapper pass — key-resolution shapes', () => {
  it('refuses a namespace binding used as a bare key and a const that is not a string', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const getFlag = (key: string) => client.boolVariation(key, { key: 'anonymous' }, false)
`,
      'src/keys.ts': `
export const KEYS = { A: 'key-a' }
export const NOT_A_STRING = 42
export const STRINGS = 'plain'
`,
      'src/app.ts': `
import { getFlag } from './flags'
import * as keys from './keys'
import { NOT_A_STRING, STRINGS } from './keys'
export const run = () => [
  getFlag(keys),
  getFlag(NOT_A_STRING),
  getFlag(STRINGS.length),
  getFlag(keys.KEYS.A),
  getFlag(STRINGS),
]
`,
    })
    expect(names(result)).toEqual(['plain'])
    expect(gapReasons(result)).toEqual(['unprovable-key', 'unprovable-key', 'unprovable-key', 'unprovable-key'])
  })

  it('reads a const object with a quoted key and skips non-pair members', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const base = { extra: 'x' }
const FLAGS = { ...base, method() { return 'no' }, 'quoted-key': 'quoted-flag', numeric: 1 }
export const run = () => client.boolVariation(FLAGS['quoted-key'], { key: 'a' }, false)
export const run2 = () => client.boolVariation(FLAGS.numeric, { key: 'a' }, false)
`,
    })
    // A subscripted key is not attributed (only `OBJECT.PROPERTY` is), and a
    // non-string property value is refused.
    expect(result.flags).toEqual([])
    expect(gapReasons(result)).toEqual(['computed-key', 'unprovable-key'])
  })

  it('refuses a const declared with no value at all', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const KEY;
export const run = () => client.boolVariation(KEY, { key: 'anonymous' }, false)
`,
    })
    expect(result.flags).toEqual([])
    expect(gapReasons(result)).toEqual(['unprovable-key'])
  })

  it('refuses an identifier key at module scope with nothing to bind it to', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
let key = 'reassigned'
export const value = client.boolVariation(key, { key: 'anonymous' }, false)
`,
    })
    expect(gapReasons(result)).toEqual(['unprovable-key'])
  })

  it('refuses a key whose const lives two unexplored hops away', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const getFlag = (key: string) => client.boolVariation(key, { key: 'anonymous' }, false)
`,
      'src/keys/index.ts': `export * from './deep'`,
      'src/keys/deep.ts': `export const DEEP = 'deep-flag'`,
      'src/app.ts': `
import { getFlag } from './flags'
import { DEEP } from './keys'
export const run = () => getFlag(DEEP)
`,
    })
    // `src/keys/index.ts` is one hop from `src/app.ts` and is parsed; `deep.ts` is
    // two hops and is not, so the key is a reported gap rather than a guess.
    expect(result.flags).toEqual([])
    expect(gapReasons(result)).toEqual(['unprovable-key'])
  })
})

describe('wrapper pass — provider catalogue', () => {
  it('skips a disabled provider entirely', async () => {
    const disabled: FeatureFlagProvider[] = [
      {
        name: 'Disabled SDK',
        importPattern: SDK,
        description: 'disabled',
        enabled: false,
        methods: [{ name: 'boolVariation', flagKeyIndex: 0 }],
      },
    ]
    const result = await analyze(
      {
        'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const run = () => client.boolVariation('disabled-provider-flag', { key: 'a' }, false)
`,
      },
      disabled,
    )
    expect(result.sites).toEqual([])
    expect(result.filesInScope).toBe(1)
  })
})
