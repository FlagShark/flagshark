/**
 * The one public restatement of the LaunchDarkly Node server SDK's evaluation
 * surface, and of which of those methods the hosted product can rewrite.
 *
 * It mirrors the private `LD_TO_OPENFEATURE_TS` table (`openfeature-mapping.ts`),
 * which FS-075 makes the single source of truth on the hosted side: a method's
 * `returnType` is the OpenFeature value type the mapping gives it, and **a method
 * with no return type is untyped** — LaunchDarkly does not type-check it. FS-069
 * (wrappers) and FS-075 (static keys) both derive "untyped" from that one bit
 * rather than naming methods, so a method added to the catalogue cannot slip past
 * either side.
 *
 * Before this table the public repository held three inconsistent restatements:
 * the detector's own provider list (7 names, missing five real methods and
 * carrying two that are not on the Node client at all), part 1's
 * `CATALOGUED_CLIENT_METHODS`, and a hardcoded four-name untyped set. Everything
 * now derives from here, which is what makes the coverage metric's denominator and
 * the rewrite decision agree.
 *
 * **This is a hand-maintained copy, not a generated snapshot.** The private table
 * is 10 rows of pure data and projects through the same mechanism as the hosted
 * support registry (`support-snapshot.json` + `scripts/sync-support-snapshot.ts`),
 * so a generated, drift-tested snapshot is the right end state; it is a named
 * follow-up, not something this module pretends to be. The test beside it asserts
 * the untyped set by name so a future edit cannot silently shrink it.
 */

/** The OpenFeature value type the hosted mapping gives a method, or null when it has none. */
export type LaunchDarklyValueType = 'boolean' | 'string' | 'number' | null

export interface LaunchDarklyEvaluationMethod {
  /** Method name as called on the client. */
  name: string
  /**
   * The OpenFeature value type the hosted mapping gives this method. `null` marks
   * it **untyped**: LaunchDarkly resolves the value as served with no type
   * checker, so a typed OpenFeature accessor can substitute the default and change
   * the observable value.
   */
  returnType: LaunchDarklyValueType
  /** True for a `*Detail` form, which consumes the evaluation detail rather than the value. */
  detail: boolean
  /** Zero-based index of the flag key argument. */
  flagKeyIndex: number
  /** Example call, carried through to the detector's provider definition. */
  example: string
  /**
   * False for a name the public detector has catalogued since before FS-069 that is
   * **not** on the Node server client. Detection keeps them — a call to one is still
   * flag-shaped and worth surfacing — but they are absent from the hosted mapping,
   * so they are untyped there and the hosted product cannot rewrite them.
   */
  onNodeClient: boolean
}

/**
 * The Node server SDK's evaluation methods. The first ten rows are
 * `LD_TO_OPENFEATURE_TS` in order; the last two are the detector's historical
 * extras (`intVariation`/`doubleVariation` are the Java, Kotlin and PHP SDKs'
 * names, and the private table documents their exclusion explicitly).
 */
export const LAUNCHDARKLY_NODE_EVALUATION_METHODS: readonly LaunchDarklyEvaluationMethod[] = Object.freeze([
  { name: 'boolVariation', returnType: 'boolean', detail: false, flagKeyIndex: 0, onNodeClient: true, example: 'client.boolVariation("flag-key", context, false)' },
  { name: 'stringVariation', returnType: 'string', detail: false, flagKeyIndex: 0, onNodeClient: true, example: 'client.stringVariation("flag-key", context, "default")' },
  { name: 'numberVariation', returnType: 'number', detail: false, flagKeyIndex: 0, onNodeClient: true, example: 'client.numberVariation("flag-key", context, 0)' },
  { name: 'jsonVariation', returnType: null, detail: false, flagKeyIndex: 0, onNodeClient: true, example: 'client.jsonVariation("flag-key", context, {})' },
  { name: 'variation', returnType: null, detail: false, flagKeyIndex: 0, onNodeClient: true, example: 'client.variation("flag-key", context, defaultValue)' },
  { name: 'boolVariationDetail', returnType: 'boolean', detail: true, flagKeyIndex: 0, onNodeClient: true, example: 'client.boolVariationDetail("flag-key", context, false)' },
  { name: 'stringVariationDetail', returnType: 'string', detail: true, flagKeyIndex: 0, onNodeClient: true, example: 'client.stringVariationDetail("flag-key", context, "default")' },
  { name: 'numberVariationDetail', returnType: 'number', detail: true, flagKeyIndex: 0, onNodeClient: true, example: 'client.numberVariationDetail("flag-key", context, 0)' },
  { name: 'jsonVariationDetail', returnType: null, detail: true, flagKeyIndex: 0, onNodeClient: true, example: 'client.jsonVariationDetail("flag-key", context, {})' },
  { name: 'variationDetail', returnType: null, detail: true, flagKeyIndex: 0, onNodeClient: true, example: 'client.variationDetail("flag-key", context, defaultValue)' },
  { name: 'intVariation', returnType: null, detail: false, flagKeyIndex: 0, onNodeClient: false, example: 'client.intVariation("flag-key", context, 0)' },
  { name: 'doubleVariation', returnType: null, detail: false, flagKeyIndex: 0, onNodeClient: false, example: 'client.doubleVariation("flag-key", context, 0.0)' },
])

/** Lifecycle methods on the client that are catalogued but never evaluate a flag. */
export const LAUNCHDARKLY_NODE_LIFECYCLE_METHODS: readonly string[] = Object.freeze([
  'init',
  'waitForInitialization',
  'flush',
  'close',
])

const BY_NAME = new Map(LAUNCHDARKLY_NODE_EVALUATION_METHODS.map((method) => [method.name, method]))

/** The two packages the hosted registry's Node server cell covers. */
export const LAUNCHDARKLY_NODE_PACKAGES: readonly string[] = Object.freeze([
  '@launchdarkly/node-server-sdk',
  'launchdarkly-node-server-sdk',
])

/** True when a provider string names one of those packages. */
export function isLaunchDarklyNodePackage(provider: string): boolean {
  return LAUNCHDARKLY_NODE_PACKAGES.includes(provider)
}

/** The evaluation method by name, or undefined when the name is not catalogued. */
export function launchDarklyNodeMethod(name: string): LaunchDarklyEvaluationMethod | undefined {
  return BY_NAME.get(name)
}

/**
 * Every method LaunchDarkly does **not** type-check: `returnType === null`. This is
 * the set FS-069 refuses inside a wrapper and FS-075 refuses at a static key
 * without a platform flag inventory. Derived, never listed.
 */
export const LAUNCHDARKLY_UNTYPED_METHOD_NAMES: readonly string[] = Object.freeze(
  LAUNCHDARKLY_NODE_EVALUATION_METHODS.filter((method) => method.returnType === null).map((method) => method.name),
)

/** Every `*Detail` form: the hosted planner refuses a detail consumer, inventory or not. */
export const LAUNCHDARKLY_DETAIL_METHOD_NAMES: readonly string[] = Object.freeze(
  LAUNCHDARKLY_NODE_EVALUATION_METHODS.filter((method) => method.detail).map((method) => method.name),
)

/** The client surface part 1's `sdk-api-surface` gate treats as catalogued. */
export const LAUNCHDARKLY_NODE_CLIENT_METHODS: readonly string[] = Object.freeze([
  ...LAUNCHDARKLY_NODE_EVALUATION_METHODS.filter((method) => method.onNodeClient).map((method) => method.name),
  ...LAUNCHDARKLY_NODE_LIFECYCLE_METHODS,
])
