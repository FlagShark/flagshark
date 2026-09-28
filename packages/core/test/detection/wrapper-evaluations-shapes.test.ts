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

  it('refuses a wrapper whose body forwards the key into more than one evaluation', async () => {
    // FS-069 rewrites a wrapper only when its body's sole SDK call is the evaluation
    // being migrated. Before this, the declaration was claimed by whichever path was
    // seen first and the second path — including its refusal — was dropped.
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const client2 = init('sdk-key-2')
export function generic(key: string) {
  return client.variation(key, { key: 'anonymous' }, false)
}
export function outer(key: string, useGeneric: boolean) {
  return useGeneric ? generic(key) : client2.boolVariation(key, { key: 'anonymous' }, false)
}
`,
      'src/app.ts': `
import { outer } from './flags'
export const run = () => outer('dual-path-flag', true)
`,
    })
    expect(result.wrappers.map((wrapper) => `${wrapper.name}@${wrapper.depth}`)).toEqual([
      'generic@1',
      'outer@1',
    ])
    expect(names(result)).toEqual(['dual-path-flag'])
    const outer = result.wrappers.find((wrapper) => wrapper.name === 'outer')!
    expect(outer.rewriteBlocker).toMatchObject({ reason: 'second-sdk-call' })
    expect(outer.rewriteBlocker!.detail).toContain('boolVariation')
    expect(outer.rewriteBlocker!.detail).toContain('generic()')
  })

  it('refuses a wrapper whose body calls the same evaluation twice', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function twice(key: string, other: unknown) {
  if (other) return client.boolVariation(key, { key: 'a' }, false)
  return client.boolVariation(key, { key: 'b' }, true)
}
`,
      'src/app.ts': `
import { twice } from './flags'
export const run = () => twice('twice-flag', null)
`,
    })
    expect(result.wrappers[0].rewriteBlocker).toMatchObject({ reason: 'second-sdk-call' })
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

describe('wrapper pass — FS-069 rewrite blockers', () => {
  const body = (method: string): string => `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag(key: string, fallback: boolean) {
  return client.${method}(key, { key: 'anonymous' }, fallback)
}
`
  const caller = `
import { getFlag } from './flags'
export const run = () => getFlag('some-gate', false)
`

  it.each(['variation', 'jsonVariation'])(
    'refuses a wrapper over the untyped %s() for rewriting while still naming its flags',
    async (method) => {
      const result = await analyze({ 'src/flags.ts': body(method), 'src/app.ts': caller })
      expect(names(result)).toEqual(['some-gate'])
      expect(result.wrappers[0].rewriteBlocker).toEqual({
        reason: 'generic-variation',
        sdkMethod: method,
        detail: expect.stringContaining('LaunchDarkly does not type-check'),
      })
    },
  )

  it.each(['variationDetail', 'jsonVariationDetail', 'boolVariationDetail', 'numberVariationDetail'])(
    'refuses a wrapper over the detail consumer %s(), typed or not',
    async (method) => {
      // FS-075's precedence: `details-consumer` fires before the served-type check,
      // so a detail form is named for what it is whether or not it is type-checked.
      const result = await analyze({ 'src/flags.ts': body(method), 'src/app.ts': caller })
      expect(names(result)).toEqual(['some-gate'])
      expect(result.wrappers[0].rewriteBlocker).toMatchObject({
        reason: 'details-consumer',
        sdkMethod: method,
      })
    },
  )

  it.each(['boolVariation', 'stringVariation', 'numberVariation'])(
    'makes no rewrite claim about a wrapper over the typed %s()',
    async (method) => {
      const result = await analyze({ 'src/flags.ts': body(method), 'src/app.ts': caller })
      expect(result.wrappers[0].rewriteBlocker).toBeNull()
    },
  )

  it.each(['intVariation', 'doubleVariation'])(
    'refuses a wrapper over %s(), which is not on the Node client and is absent from the hosted mapping',
    async (method) => {
      const result = await analyze({ 'src/flags.ts': body(method), 'src/app.ts': caller })
      expect(result.wrappers[0].rewriteBlocker).toMatchObject({
        reason: 'generic-variation',
        sdkMethod: method,
      })
    },
  )

  it('refuses a direct static-key call to an untyped method with FS-075 unproven-served-type', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const legacyToggle = () => client.variation('legacy-toggle', { key: 'u1' }, 'system')
export const typed = () => client.boolVariation('typed-toggle', { key: 'u1' }, false)
`,
    })
    expect(names(result)).toEqual(['legacy-toggle', 'typed-toggle'])
    expect(result.sites.map((entry) => entry.rewriteRefusal?.reason ?? null)).toEqual([
      'unproven-served-type',
      null,
    ])
    expect(result.sites[0].rewriteRefusal!.detail).toContain('read of your LaunchDarkly project')
  })

  it('makes no rewrite claim for a LaunchDarkly package outside the Node server cell', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { initialize } from '@launchdarkly/js-client-sdk'
const client = initialize('env-key', { key: 'u1' })
export const run = () => client.variation('browser-gate', false)
`,
    })
    expect(names(result)).toEqual(['browser-gate'])
    expect(result.sites[0].rewriteRefusal).toBeNull()
  })

  it('propagates the refusal up a wrapper chain', async () => {
    const result = await analyze({
      'src/flags.ts': body('variation'),
      'src/middleware.ts': `
import { getFlag } from './flags'
export function requireFlag(key: string) {
  return async () => getFlag(key, false)
}
`,
      'src/routes.ts': `
import { requireFlag } from './middleware'
export const guard = requireFlag('chained-gate')
`,
    })
    expect(
      result.wrappers.map((entry) => [entry.name, entry.rewriteBlocker?.reason ?? null]),
    ).toEqual([
      ['getFlag', 'generic-variation'],
      ['requireFlag', 'generic-variation'],
    ])
    expect(names(result)).toEqual(['chained-gate'])
  })

  it('makes no rewrite claim for a non-LaunchDarkly provider that happens to share a method name', async () => {
    const other: FeatureFlagProvider[] = [
      {
        name: 'Other SDK',
        importPattern: 'other-flags-sdk',
        description: 'another provider',
        enabled: true,
        methods: [{ name: 'variation', flagKeyIndex: 0 }],
      },
    ]
    const result = await analyze(
      {
        'src/flags.ts': `
import { init } from 'other-flags-sdk'
const client = init('sdk-key')
export function getFlag(key: string) {
  return client.variation(key)
}
`,
        'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('other-gate')
`,
      },
      other,
    )
    expect(names(result)).toEqual(['other-gate'])
    expect(result.wrappers[0].rewriteBlocker).toBeNull()
  })
})

describe('wrapper pass — the FS-069 evaluation-surface cross-check', () => {
  it('counts evaluation-shaped member calls without provenance and reports a shortfall', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const list = ['a']
export const ok = () => client.boolVariation('named-gate', { key: 'a' }, false)
export const degenerate = () => client.boolVariation()
export const unrelated = () => list.variation()
`,
    })
    // Three member-form calls name a catalogued evaluation method. Only the first
    // has an argument at the key position, so only it is classified — the other two
    // are the shortfall the cross-check exists to expose.
    expect(result.evaluationSurface).toEqual({ callShaped: 3, accountedFor: 1 })
    expect(result.sites).toHaveLength(1)
  })

  it('does not count a destructured evaluation method, which is not a member expression', async () => {
    // FS-069 states this limit explicitly: a destructured or aliased evaluation
    // method is not a property access, so the cross-check does not see it. The
    // classifier still names the flag, so this is a denominator the metric under-
    // counts — which is why the guard has to be load-bearing on a *catalogued* name,
    // not on a wrapper name the callee filter would have rejected anyway.
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const { boolVariation } = client
export const run = () => boolVariation('destructured-gate', { key: 'a' }, false)
`,
    })
    expect(names(result)).toEqual(['destructured-gate'])
    expect(result.sites).toHaveLength(1)
    expect(result.evaluationSurface).toEqual({ callShaped: 0, accountedFor: 0 })
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
