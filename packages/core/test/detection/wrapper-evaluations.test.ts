import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { defaultTypeScriptProviders } from '../../src/detection/detectors/typescript.js'
import { buildImportGraph, isTsJsFile, type PathAliases } from '../../src/detection/import-graph.js'
import { getImportPattern } from '../../src/detection/interface.js'
import {
  analyzeWrapperEvaluations,
  wrapperLabel,
  EVALUATION_GAP_DETAILS,
  type EvaluationGapReason,
  type WrapperEvaluationResult,
} from '../../src/detection/wrapper-evaluations.js'

const ROOT = '/repo'
const SDK = '@launchdarkly/node-server-sdk'

interface AnalyzeOptions {
  aliases?: PathAliases
  maxWrapperDepth?: number
}

/**
 * Runs the wrapper pass over an in-memory repository. Paths in the assertions
 * below are repository-relative; the analyzer itself sees absolute paths, the
 * same as `scanRepo`.
 */
async function analyze(
  files: Record<string, string>,
  options: AnalyzeOptions = {},
): Promise<WrapperEvaluationResult> {
  const map = new Map(Object.entries(files).map(([path, content]) => [`${ROOT}/${path}`, content]))
  const providers = defaultTypeScriptProviders()
  const seedSdkPatterns = providers
    .map((provider) => getImportPattern(provider))
    .filter((pattern) => pattern.length > 0)
  const graph = buildImportGraph(map, { seedSdkPatterns, isTsJs: isTsJsFile, aliases: options.aliases })
  return analyzeWrapperEvaluations({
    files: map,
    transitiveSdks: graph.transitiveSdks,
    providers,
    aliases: options.aliases,
    languageForFile: () => 'typescript',
    maxWrapperDepth: options.maxWrapperDepth,
  })
}

/** `path:line` for a flag, relative to the fake repository root. */
function flagAt(result: WrapperEvaluationResult): string[] {
  return result.flags
    .map((flag) => `${flag.name} ${flag.filePath.slice(ROOT.length + 1)}:${flag.lineNumber}`)
    .sort()
}

function wrapperSummaries(result: WrapperEvaluationResult): string[] {
  return result.wrappers.map(
    (wrapper) =>
      `${wrapperLabel(wrapper)} ${wrapper.filePath.slice(ROOT.length + 1)}:${wrapper.lineNumber} ` +
      `arg=${wrapper.keyParameterIndex} depth=${wrapper.depth} exported=${wrapper.exported} ` +
      `callers=${wrapper.resolvedCallers}/${wrapper.unresolvedCallers}/${wrapper.forwardingCallers}`,
  )
}

function gapReasons(result: WrapperEvaluationResult): EvaluationGapReason[] {
  return result.sites
    .filter((site) => site.status.kind === 'gap')
    .map((site) => (site.status as { kind: 'gap'; reason: EvaluationGapReason }).reason)
    .sort()
}

// ── The shapes the survey found ──────────────────────────────────

describe('analyzeWrapperEvaluations — wrapper shapes', () => {
  it('plain function wrapper: identifies it, finds its callers, lists their literal keys', async () => {
    const result = await analyze({
      'src/featureFlags.ts': `
import * as LaunchDarkly from '${SDK}'
let ldClient: LaunchDarkly.LDClient | null = null
export async function getFlag(flagKey: string, context: unknown, defaultValue: boolean) {
  return ldClient!.variation(flagKey, context, defaultValue)
}
`,
      'src/routes.ts': `
import { getFlag } from './featureFlags'
export async function handler(ctx: unknown) {
  const a = await getFlag('checkout-v2', ctx, false)
  const b = await getFlag('new-nav', ctx, false)
  return a && b
}
`,
    })

    expect(wrapperSummaries(result)).toEqual([
      'getFlag() src/featureFlags.ts:4 arg=0 depth=1 exported=true callers=2/0/0',
    ])
    expect(flagAt(result)).toEqual(['checkout-v2 src/routes.ts:4', 'new-nav src/routes.ts:5'])
    // The wrapper's own SDK call is delegated, not a shortfall: the keys live at
    // the callers, which are counted separately.
    expect(result.sites.map((site) => site.status.kind)).toEqual(['delegated', 'accounted', 'accounted'])
    expect(result.sites[0]).toMatchObject({ callee: 'variation', via: 'sdk' })
    expect(result.sites[1]).toMatchObject({ callee: 'getFlag', via: 'wrapper' })
  })

  it('class-method wrapper over a constructor-injected client, called through the Nest DI handle', async () => {
    const result = await analyze({
      'src/launchdarkly.service.ts': `
import type { LDClient } from '${SDK}'
export class LaunchDarklyService {
  constructor(private readonly client: LDClient) {}
  async getBooleanValue(key: string, fallback: boolean) {
    return this.client.boolVariation(key, { key: 'anonymous' }, fallback)
  }
}
`,
      'src/orders.service.ts': `
import { LaunchDarklyService } from './launchdarkly.service'
export class OrdersService {
  constructor(private readonly flags: LaunchDarklyService) {}
  async place() {
    if (await this.flags.getBooleanValue('orders-v2', false)) return 'v2'
    return 'v1'
  }
}
`,
    })

    expect(wrapperSummaries(result)).toEqual([
      'LaunchDarklyService.getBooleanValue() src/launchdarkly.service.ts:5 arg=0 depth=1 exported=true callers=1/0/0',
    ])
    expect(flagAt(result)).toEqual(['orders-v2 src/orders.service.ts:6'])
  })

  it('static-class wrapper reached as Class.method()', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export class Flags {
  static async enabled(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
}
`,
      'src/app.ts': `
import { Flags } from './flags'
export const run = async () => Flags.enabled('static-flag')
`,
    })

    expect(wrapperSummaries(result)).toEqual([
      'Flags.enabled() src/flags.ts:5 arg=0 depth=1 exported=true callers=1/0/0',
    ])
    expect(flagAt(result)).toEqual(['static-flag src/app.ts:3'])
  })

  it('singleton wrappers: an exported object literal, a default-exported instance, and a local handle', async () => {
    const result = await analyze({
      'src/singleton.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const flags = {
  isEnabled(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  },
  'variant': (key: string) => client.stringVariation(key, { key: 'anonymous' }, 'off'),
}
export default class Toggles {
  check(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
}
`,
      'src/consumer.ts': `
import Toggles, { flags } from './singleton'
const toggles = new Toggles()
export function run() {
  return [
    flags.isEnabled('object-flag'),
    flags.variant('variant-flag'),
    toggles.check('instance-flag'),
  ]
}
`,
    })

    expect(wrapperSummaries(result)).toEqual([
      'flags.isEnabled() src/singleton.ts:5 arg=0 depth=1 exported=true callers=1/0/0',
      'flags.variant() src/singleton.ts:8 arg=0 depth=1 exported=true callers=1/0/0',
      'Toggles.check() src/singleton.ts:11 arg=0 depth=1 exported=true callers=1/0/0',
    ])
    expect(flagAt(result)).toEqual([
      'instance-flag src/consumer.ts:8',
      'object-flag src/consumer.ts:6',
      'variant-flag src/consumer.ts:7',
    ])
  })

  it('singleton reached through getInstance() on a default-imported class', async () => {
    const result = await analyze({
      'app/service/launchDarkly-service.ts': `
const LaunchDarkly = require('${SDK}')
const ldClient = LaunchDarkly.init('sdk-key')
export default class LaunchDarklyService {
  private static instance: LaunchDarklyService
  public static getInstance(): LaunchDarklyService {
    return LaunchDarklyService.instance
  }
  async getVariation(req: unknown, flag: string, defaultReturn: boolean) {
    return ldClient.variation(flag, { kind: 'user', key: 'anonymous' }, defaultReturn)
  }
}
`,
      'app/controllers/task-list.ts': `
import LaunchDarklyService from '../service/launchDarkly-service'
import { FEATURE_FLAGS } from '../data/constants'
export async function getTaskList(req: unknown) {
  const a = await LaunchDarklyService.getInstance().getVariation(req, FEATURE_FLAGS.CARD_PAYMENTS, false)
  const b = await LaunchDarklyService.getInstance().getVariation(req, 'online-card-payments-feature', false)
  return a && b
}
`,
      'app/data/constants.ts': `
export const FEATURE_FLAGS = {
  CARD_PAYMENTS: 'online-card-payments-feature',
}
`,
    })

    expect(wrapperSummaries(result)).toEqual([
      'LaunchDarklyService.getVariation() app/service/launchDarkly-service.ts:9 arg=1 depth=1 exported=true callers=2/0/0',
    ])
    expect(flagAt(result)).toEqual([
      'online-card-payments-feature app/controllers/task-list.ts:5',
      'online-card-payments-feature app/controllers/task-list.ts:6',
    ])
  })

  it('a generator wrapper is named the same way a function declaration is', async () => {
    const result = await analyze({
      'src/gen.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function* evaluate(key: string) {
  yield client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
      'src/use.ts': `
import { evaluate } from './gen'
export const it = () => evaluate('generator-flag')
`,
    })
    expect(wrapperSummaries(result)).toEqual([
      'evaluate() src/gen.ts:4 arg=0 depth=1 exported=true callers=1/0/0',
    ])
    expect(flagAt(result)).toEqual(['generator-flag src/use.ts:3'])
  })

  it('a single-parameter arrow wrapper with no parentheses is still positional', async () => {
    const result = await analyze({
      'src/short.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const on = key => client.boolVariation(key, { key: 'anonymous' }, false)
`,
      'src/use.ts': `
import { on } from './short'
export const run = () => on('short-flag')
`,
    })
    expect(wrapperSummaries(result)).toEqual(['on() src/short.ts:4 arg=0 depth=1 exported=true callers=1/0/0'])
    expect(flagAt(result)).toEqual(['short-flag src/use.ts:3'])
  })

  it('an optional parameter still binds the key position', async () => {
    const result = await analyze({
      'src/opt.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function evaluate(key?: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
      'src/use.ts': `
import { evaluate } from './opt'
export const run = () => evaluate('optional-flag')
`,
    })
    expect(wrapperSummaries(result)).toEqual([
      'evaluate() src/opt.ts:4 arg=0 depth=1 exported=true callers=1/0/0',
    ])
    expect(flagAt(result)).toEqual(['optional-flag src/use.ts:3'])
  })
})

// ── Caller binding ───────────────────────────────────────────────

describe('analyzeWrapperEvaluations — caller binding', () => {
  it('binds a caller that imports the wrapper through a re-export barrel', async () => {
    const result = await analyze({
      'src/flags/client.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
      'src/flags/index.ts': `export { getFlag } from './client'`,
      'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('barrel-flag')
`,
    })
    expect(flagAt(result)).toEqual(['barrel-flag src/app.ts:3'])
  })

  it('binds a caller through a star re-export barrel', async () => {
    const result = await analyze({
      'src/flags/client.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
      'src/flags/index.ts': `export * from './client'`,
      'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('star-barrel-flag')
`,
    })
    expect(flagAt(result)).toEqual(['star-barrel-flag src/app.ts:3'])
  })

  it('binds a namespace import and an aliased named import', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
      'src/namespace.ts': `
import * as ff from './flags'
export const run = () => ff.getFlag('namespace-flag')
`,
      'src/aliased.ts': `
import { getFlag as evaluate } from './flags'
export const run = () => evaluate('aliased-flag')
`,
      'src/cjs.ts': `
const flags = require('./flags')
const { getFlag: check } = require('./flags')
export const run = () => [flags.getFlag('cjs-namespace-flag'), check('cjs-named-flag')]
`,
    })
    expect(flagAt(result)).toEqual([
      'aliased-flag src/aliased.ts:3',
      'cjs-named-flag src/cjs.ts:4',
      'cjs-namespace-flag src/cjs.ts:4',
      'namespace-flag src/namespace.ts:3',
    ])
  })

  it('binds a caller through a tsconfig path alias', async () => {
    const aliases: PathAliases = { baseUrl: ROOT, paths: new Map([['@utils/*', ['src/utils/*']]]) }
    const result = await analyze(
      {
        'src/utils/getFlag.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const getFlag = (req: unknown, key: string) =>
  client.boolVariation(key, { key: 'anonymous' }, false)
`,
        'src/routes/home.ts': `
import { getFlag } from '@utils/getFlag'
export const run = (req: unknown) => getFlag(req, 'aliased-path-flag')
`,
      },
      { aliases },
    )
    expect(flagAt(result)).toEqual(['aliased-path-flag src/routes/home.ts:3'])
  })

  it('an unexported wrapper is bound inside its own file and nowhere else', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
export const local = () => getFlag('same-file-flag')
`,
      'src/other.ts': `
import './flags'
declare const getFlag: (key: string) => boolean
export const run = () => getFlag('not-bound-flag')
`,
    })
    expect(wrapperSummaries(result)).toEqual([
      'getFlag() src/flags.ts:4 arg=0 depth=1 exported=false callers=1/0/0',
    ])
    expect(flagAt(result)).toEqual(['same-file-flag src/flags.ts:7'])
  })

  it('an `export { … }` list makes a wrapper importable', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
export { getFlag }
`,
      'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('export-list-flag')
`,
    })
    expect(result.wrappers[0].exported).toBe(true)
    expect(flagAt(result)).toEqual(['export-list-flag src/app.ts:3'])
  })

  it('a method call on an unrelated receiver is not attributed to the wrapper', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export class Flags {
  check(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
}
`,
      'src/app.ts': `
import { Flags } from './flags'
const unrelated = { check: (key: string) => key.length > 0 }
export const run = () => unrelated.check('not-a-flag')
export const real = () => new Flags().check('real-flag')
`,
    })
    expect(flagAt(result)).toEqual(['real-flag src/app.ts:5'])
  })

  it('a method wrapper is reachable through an annotated local handle and through `this`', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export class Flags {
  check(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
  both() {
    return this.check('this-flag')
  }
}
`,
      'src/app.ts': `
import { Flags } from './flags'
import { makeFlags } from './factory'
const handle: Flags = makeFlags()
export const run = () => handle.check('annotated-handle-flag')
`,
      'src/factory.ts': `export const makeFlags = () => ({}) as never`,
    })
    expect(flagAt(result)).toEqual([
      'annotated-handle-flag src/app.ts:5',
      'this-flag src/flags.ts:9',
    ])
  })
})

// ── Key resolution ───────────────────────────────────────────────

describe('analyzeWrapperEvaluations — key resolution at the callers', () => {
  it('resolves literal, same-file const, imported const, and const-object keys', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const getFlag = (req: unknown, key: string) =>
  client.boolVariation(key, { key: 'anonymous' }, false)
`,
      'src/keys.ts': `
export const RELEASE = 'release-1.3-enabled'
export const GROUPS = { PCQ: 'cui-pcq-enabled' }
`,
      'src/app.ts': `
import { getFlag } from './flags'
import { RELEASE, GROUPS } from './keys'
import * as keys from './keys'
const LOCAL = 'local-const-flag'
export async function run(req: unknown) {
  return [
    await getFlag(req, 'literal-flag'),
    await getFlag(req, LOCAL),
    await getFlag(req, RELEASE),
    await getFlag(req, GROUPS.PCQ),
    await getFlag(req, keys.RELEASE),
    await getFlag(req, \`template-flag\`),
  ]
}
`,
    })
    expect(flagAt(result).map((entry) => entry.split(' ')[0]).sort()).toEqual([
      'cui-pcq-enabled',
      'literal-flag',
      'local-const-flag',
      'release-1.3-enabled',
      'release-1.3-enabled',
      'template-flag',
    ])
    expect(result.wrappers[0]).toMatchObject({ resolvedCallers: 6, unresolvedCallers: 0 })
  })

  it('resolves an `export const` at an SDK call site the per-file detectors cannot reach', async () => {
    // `resolveConstStringTS` only walks direct children of the program node, so
    // an exported const is invisible to it; this pass reads both forms and the
    // duplicate against the per-file detector is dropped downstream.
    const result = await analyze({
      'src/direct.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const EXPORTED_KEY = 'exported-const-flag'
export const run = () => client.boolVariation(EXPORTED_KEY, { key: 'anonymous' }, false)
`,
    })
    expect(flagAt(result)).toEqual(['exported-const-flag src/direct.ts:5'])
    expect(result.wrappers).toEqual([])
  })

  it('reports a caller with a computed key as unresolved rather than dropping it', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const getFlag = (key: string) => client.boolVariation(key, { key: 'anonymous' }, false)
`,
      'src/app.ts': `
import { getFlag } from './flags'
export function run(prefix: string, which: string) {
  return [
    getFlag(\`\${prefix}-enabled\`),
    getFlag(prefix + '-enabled'),
    getFlag(which),
    getFlag('http://not-a-key'),
  ]
}
`,
    })
    const getFlag = result.wrappers.find((wrapper) => wrapper.name === 'getFlag')!
    expect(getFlag).toMatchObject({ resolvedCallers: 0, unresolvedCallers: 3, forwardingCallers: 1 })
    // `which` is a parameter of `run`, which makes `run` a chained wrapper of its
    // own; with no callers it is a refusal, not a silent drop.
    expect(result.wrappers.map((wrapper) => wrapper.name)).toEqual(['run', 'getFlag'])
    expect(gapReasons(result)).toEqual([
      'computed-key',
      'computed-key',
      'unusable-literal-key',
      'wrapper-without-callers',
    ])
    expect(result.flags).toEqual([])
  })
})

// ── Chaining ─────────────────────────────────────────────────────

describe('analyzeWrapperEvaluations — wrapper chains', () => {
  const middleware = {
    'src/lib/featureFlags.ts': `
import * as LaunchDarkly from '${SDK}'
let ldClient: LaunchDarkly.LDClient | null = null
export async function getFlag(flagKey: string, context: unknown, defaultValue: boolean) {
  return ldClient!.variation(flagKey, context, defaultValue)
}
`,
    'src/middleware/featureFlag.ts': `
import { getFlag } from '../lib/featureFlags'
export function requireFlag(flagKey: string, defaultValue = false) {
  return async (req: unknown) => {
    const enabled = await getFlag(flagKey, { key: 'anonymous' }, defaultValue)
    return enabled
  }
}
`,
    'src/routes/payments.ts': `
import { requireFlag } from '../middleware/featureFlag'
export const guard = requireFlag('enable-stripe-checkout', true)
`,
  }

  it('identifies a middleware factory that forwards its parameter into another wrapper', async () => {
    const result = await analyze(middleware)
    expect(wrapperSummaries(result)).toEqual([
      'getFlag() src/lib/featureFlags.ts:4 arg=0 depth=1 exported=true callers=0/0/1',
      'requireFlag() src/middleware/featureFlag.ts:3 arg=0 depth=2 exported=true callers=1/0/0',
    ])
    expect(flagAt(result)).toEqual(['enable-stripe-checkout src/routes/payments.ts:3'])
    expect(result.wrappers[1].forwardsTo).toBe('getFlag()')
  })

  it('refuses the chain when depth is capped at one round', async () => {
    const result = await analyze(middleware, { maxWrapperDepth: 1 })
    expect(result.wrappers.map((wrapper) => wrapper.name)).toEqual(['getFlag'])
    expect(result.flags).toEqual([])
    // `getFlag` still has a caller — the middleware — so its own SDK call is
    // delegated; the middleware call is the refusal, named for what could not be
    // proven rather than silently dropped.
    expect(result.sites.map((site) => site.status)).toEqual([
      { kind: 'delegated', wrapper: 'getFlag()' },
      { kind: 'gap', reason: 'unproven-wrapper' },
    ])
  })
})

// ── The refusal set ──────────────────────────────────────────────

describe('analyzeWrapperEvaluations — refusals', () => {
  it('refuses a destructured key parameter', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag({ key }: { key: string }) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['destructured-parameter'])
  })

  it('refuses a forwarding function with no name to bind callers to', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
const keys = ['a']
export const results = keys.map(function (key) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
})
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['unnamed-wrapper'])
  })

  it('refuses a method on an anonymous default-exported class', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export default class {
  check(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
}
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['unnamed-wrapper'])
  })

  it('refuses a method on an object that is not held by a named const', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function make() {
  return {
    check(key: string) {
      return client.boolVariation(key, { key: 'anonymous' }, false)
    },
    variant: (key: string) => client.stringVariation(key, { key: 'anonymous' }, 'off'),
  }
}
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['unnamed-wrapper', 'unnamed-wrapper'])
  })

  it('refuses a key that is a local variable rather than a parameter', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function pick(legalrep: boolean) {
  const key = legalrep ? 'lr-enabled' : 'citizen-enabled'
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['unprovable-key'])
  })

  it('refuses a key transformed on the way into the SDK', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function prefixed(key: string) {
  return client.boolVariation('team-' + key, { key: 'anonymous' }, false)
}
export function member(keys: { a: string }) {
  return client.boolVariation(keys.a, { key: 'anonymous' }, false)
}
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['computed-key', 'unprovable-key'])
  })

  it('refuses an identified wrapper for which no call site was found', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
    })
    expect(result.wrappers).toEqual([
      expect.objectContaining({
        name: 'getFlag',
        resolvedCallers: 0,
        unresolvedCallers: 0,
        forwardingCallers: 0,
      }),
    ])
    expect(gapReasons(result)).toEqual(['wrapper-without-callers'])
    expect(result.flags).toEqual([])
  })

  it('every refusal reason carries a one-line explanation', () => {
    for (const [reason, detail] of Object.entries(EVALUATION_GAP_DETAILS)) {
      expect(detail.length, reason).toBeGreaterThan(20)
    }
  })
})

// ── Scope and shape guards ───────────────────────────────────────

describe('analyzeWrapperEvaluations — scope', () => {
  it('returns an empty result when no TS/JS file reaches a flag SDK', async () => {
    const result = await analyze({
      'src/app.ts': `export const run = () => 'no flags here'`,
      'README.md': '# not a source file',
    })
    expect(result).toEqual({ wrappers: [], flags: [], sites: [], filesInScope: 0 })
  })

  it('a wrapper must live in a file that imports the SDK itself', async () => {
    // `consumer.ts` reaches the SDK through `client.ts`, but declaring a wrapper
    // there would mean guessing that `anything.variation(…)` is the LD client.
    const result = await analyze({
      'src/client.ts': `
import { init } from '${SDK}'
export const client = init('sdk-key')
`,
      'src/consumer.ts': `
import { client } from './client'
export function getFlag(key: string) {
  return client.boolVariation(key, { key: 'anonymous' }, false)
}
`,
    })
    expect(result.wrappers).toEqual([])
    expect(gapReasons(result)).toEqual(['unproven-wrapper'])
  })

  it('a call with no argument at the key position is not an evaluation site', async () => {
    const result = await analyze({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const run = () => client.variation()
`,
    })
    expect(result.sites).toEqual([])
  })

  it('never touches the network', async () => {
    const fetchSpy = vi.fn()
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      await analyze({
        'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key')
export const getFlag = (key: string) => client.boolVariation(key, { key: 'anonymous' }, false)
`,
        'src/app.ts': `
import { getFlag } from './flags'
export const run = () => getFlag('offline-flag')
`,
      })
    } finally {
      globalThis.fetch = original
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// Guard against a stray global fetch leaking between suites.
let originalFetch: typeof globalThis.fetch
beforeEach(() => {
  originalFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})
