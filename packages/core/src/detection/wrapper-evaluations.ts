/**
 * Wrapper-mediated flag evaluations for TypeScript/JavaScript (FS-072 part 2).
 *
 * The per-file detectors only see an evaluation *at the SDK call itself*:
 * `client.boolVariation('my-flag', ctx, false)`. A survey of 15 public
 * LaunchDarkly TypeScript repositories found 13 of them reach the SDK through a
 * wrapper instead — a `featureFlags.ts` helper, a Nest service, a static class,
 * a singleton — called from up to 70 places with the key at the *caller*. For
 * those repositories the per-file detectors report nothing at all, because the
 * wrapper's own call passes a parameter rather than a literal and the callers
 * never name a catalogued SDK method.
 *
 * This module closes that gap with a repository-level pass:
 *
 *   1. **Identify wrappers.** In a file that directly imports a provider SDK, a
 *      function or method that forwards one of its own parameters as the flag
 *      key of a catalogued provider method is a wrapper. The forwarded
 *      parameter's position is the wrapper's key-parameter index.
 *   2. **Chain.** A function that forwards a parameter into an already
 *      identified wrapper is itself a wrapper, for up to `maxWrapperDepth`
 *      rounds. That covers the middleware-factory shape (`requireFlag(key)`
 *      returning a handler that calls `getFlag(key, …)`).
 *   3. **Resolve callers.** Callers are found by name plus a *provable* binding:
 *      the calling file imports the wrapper (or its owning class/object) from
 *      the module that declares it — directly or through a re-export barrel — or
 *      the call is in the declaring file itself. A method call additionally has
 *      to name the imported binding in its receiver, or go through
 *      `this.<prop>` where `<prop>` is annotated with the owner type (the
 *      constructor-injection / Nest shape).
 *   4. **Resolve keys.** Literal keys, same-file `const` keys, consts imported
 *      from another module, and `OBJECT.PROPERTY` on a const object literal are
 *      reported as flags. Everything else is reported as a gap, never dropped.
 *
 * What this deliberately does **not** prove, and says so in the output:
 *
 *   - **The receiver.** There is no type checker here, so `client.variation(…)`
 *     inside an SDK-importing file is taken at the same standard the existing
 *     import-gated detectors use: the file imports the SDK and the method name
 *     is catalogued. The hosted analyzer is the thing that proves the receiver
 *     really is an `LDClient` — the `sdk-api-surface` admission gate says the
 *     same about itself.
 *   - **The call graph.** Callers are matched syntactically. Every flag this
 *     pass reports therefore carries `confidence: 'medium'`, which the lock-in
 *     summary classifies as `needs-review (weaker detection)` rather than as
 *     something the hosted planner could take to a draft PR.
 *
 * Local only: a pure function of the file contents the scan already read. No
 * account, no token, no network.
 */

import { isValidFlagKey } from './helpers.js'
import {
  isLaunchDarklyNodePackage,
  launchDarklyNodeMethod,
  LAUNCHDARKLY_NODE_EVALUATION_METHODS,
} from './launchdarkly-node-methods.js'
import { getImportPattern } from './interface.js'
import { isTsJsFile, resolveImportPath, type PathAliases } from './import-graph.js'
import { getParser } from './tree-sitter/parser-cache.js'
import { extractStringLiteral, getArgument } from './tree-sitter/query-runner.js'

import type { Node } from 'web-tree-sitter'
import type { FeatureFlag } from './feature-flag.js'
import type { FeatureFlagProvider } from './interface.js'

// ── Reported shapes ──────────────────────────────────────────────

/** A wrapper reached as a free function, or as a method on a class/object. */
export type WrapperKind = 'function' | 'method'

/** A function or method proven to forward one of its parameters to a provider SDK. */
export interface WrapperDeclaration {
  /** File that declares the wrapper. */
  filePath: string
  /** 1-based line of the declaration. */
  lineNumber: number
  kind: WrapperKind
  /** Callable name: the function name, or the method name. */
  name: string
  /** Class or object the method hangs off; null for a free function. */
  owner: string | null
  /** Zero-based position of the parameter forwarded as the flag key. */
  keyParameterIndex: number
  /** Provider string the detectors record (the SDK's import pattern). */
  provider: string
  /** The catalogued SDK method, or the wrapper, the key is forwarded to. */
  forwardsTo: string
  /** 1 when the wrapper calls the SDK itself, 2+ when it forwards into another wrapper. */
  depth: number
  /** True when another module can import it (export declaration or export list). */
  exported: boolean
  /** Call sites found whose key resolved to a literal or a proven const. */
  resolvedCallers: number
  /** Call sites found whose key only exists at runtime. */
  unresolvedCallers: number
  /** Call sites found that forward a parameter of their own, deferring the key again. */
  forwardingCallers: number
  /**
   * Set when the hosted migration refuses to rewrite this wrapper whatever its
   * callers pass (FS-069). Null means the scan makes no such claim — never that
   * the wrapper is migratable.
   */
  rewriteBlocker: WrapperRewriteBlocker | null
}

/**
 * Why the hosted migration refuses to rewrite an evaluation, independently of
 * whether the scan could name its flag. Detection and rewritability are different
 * axes: the scanner may legitimately detect more than the migrator can rewrite,
 * and it must not present the two as the same thing.
 *
 * Every reason here is a refusal the owning ticket names, restricted to what is
 * visible from source alone:
 *
 *   - `generic-variation` — FS-069 B1. A **wrapper** over a method LaunchDarkly
 *     does not type-check. Its key set can never be closed, so no flag inventory
 *     rescues it.
 *   - `unproven-served-type` — FS-075. A **static-key** call to the same untyped
 *     methods. The key set *is* closed here, so a read of the customer's
 *     LaunchDarkly project can prove it — but that read is not source, so a local
 *     scan can never prove it, and the hosted planner refuses by name until it has
 *     one.
 *   - `details-consumer` — any `*VariationDetail` form, typed or not. OpenFeature's
 *     reason and variant semantics are not the SDK's.
 *   - `second-sdk-call` — FS-069. A wrapper body reached through more than one
 *     evaluation; a wrapper is rewritten only when its body's sole SDK call is the
 *     evaluation being migrated.
 */
export type WrapperRewriteBlockerReason =
  | 'generic-variation'
  | 'unproven-served-type'
  | 'details-consumer'
  | 'second-sdk-call'

export interface WrapperRewriteBlocker {
  reason: WrapperRewriteBlockerReason
  /** The SDK method the evaluation goes through. */
  sdkMethod: string
  /** One line: what cannot be proven, and what would change the answer. */
  detail: string
}

/** Where an evaluation sits, which decides which ticket's refusal applies. */
export type EvaluationPosition = 'wrapper' | 'direct'

/**
 * The typed value methods a user can migrate to, named in every refusal message.
 * Derived from the table so the advice cannot drift from what the scanner detects —
 * the first version's message recommended `numberVariation`, which the detector did
 * not catalogue, so following the advice made the scanner stop seeing the flag.
 */
const TYPED_VALUE_METHOD_LIST = LAUNCHDARKLY_NODE_EVALUATION_METHODS.filter(
  (method) => method.returnType !== null && !method.detail,
)
  .map((method) => method.name)
  .join(', ')

/**
 * The hosted migration's refusal for one evaluation, from the method it calls and
 * where it sits. Returns null only when the scan makes **no claim** — never as a
 * statement that the evaluation is migratable.
 *
 * Scoped to the two packages the registry's Node server cell covers, because that
 * is the only cell whose stage reads as "may qualify for a hosted draft PR" and the
 * only one FS-069 and FS-075 decide. Any other provider gets no claim.
 */
export function rewriteRefusalFor(
  provider: string,
  sdkMethod: string,
  position: EvaluationPosition,
): WrapperRewriteBlocker | null {
  if (!isLaunchDarklyNodePackage(provider)) return null
  const method = launchDarklyNodeMethod(sdkMethod)
  if (method === undefined) return null
  if (method.detail) {
    return {
      reason: 'details-consumer',
      sdkMethod,
      detail:
        `${sdkMethod}() consumes the evaluation detail, and OpenFeature's reason and variant semantics are not ` +
        `LaunchDarkly's, so the hosted planner refuses a detail consumer whatever else is proven. Read the value ` +
        `instead of the detail.`,
    }
  }
  if (method.returnType !== null) return null
  if (position === 'wrapper') {
    return {
      reason: 'generic-variation',
      sdkMethod,
      detail:
        `the body evaluates with ${sdkMethod}(), which LaunchDarkly does not type-check: it returns whatever type ` +
        `the flag serves, while a typed OpenFeature accessor substitutes the default when the types differ. A ` +
        `wrapper's key set cannot be closed, so no flag inventory can prove the values equal and the hosted ` +
        `migration refuses the wrapper. Migrate the body to ${TYPED_VALUE_METHOD_LIST} first, or rewrite it by hand.`,
    }
  }
  return {
    reason: 'unproven-served-type',
    sdkMethod,
    detail:
      `${sdkMethod}() is an evaluation LaunchDarkly does not type-check, so it returns whatever type the flag ` +
      `serves while a typed OpenFeature accessor substitutes the default when the types differ. The key is static, ` +
      `so this is provable — but only from a read of your LaunchDarkly project showing every variation of the flag ` +
      `carries the default's type, which is not in the source and which no local scan can supply. Migrate the call ` +
      `to ${TYPED_VALUE_METHOD_LIST} and the proof is no longer needed.`,
  }
}

/** The `second-sdk-call` refusal, for a wrapper body reached through more than one evaluation. */
function secondSdkCallRefusal(targets: readonly string[]): WrapperRewriteBlocker {
  return {
    reason: 'second-sdk-call',
    sdkMethod: targets.join(', '),
    detail:
      `the body forwards its key into ${targets.length} evaluations (${targets.join(', ')}); a wrapper is rewritten ` +
      `only when its body's sole SDK call is the evaluation being migrated, so the hosted migration refuses it. ` +
      `Split the body into one wrapper per evaluation.`,
  }
}

/**
 * Why a call-shaped evaluation site could not be attributed to a flag name.
 * This is the refusal set: each reason is a shape the scan declines to guess
 * about, and each one is counted and sampled in the reported surface.
 */
export type EvaluationGapReason =
  | 'computed-key'
  | 'unprovable-key'
  | 'unusable-literal-key'
  | 'spread-caller'
  | 'destructured-parameter'
  | 'unnamed-wrapper'
  | 'ambiguous-client-provenance'
  | 'wrapper-without-callers'

/** One line per refusal reason, printed next to its count. */
export const EVALUATION_GAP_DETAILS: Record<EvaluationGapReason, string> = {
  'computed-key':
    'the flag key is built at runtime (a template substitution, a concatenation, a call or an index), so no key exists in the source',
  'unprovable-key':
    'the flag key is an identifier the scan cannot prove: a local variable, a re-assigned binding, or a const in a module it did not read',
  'unusable-literal-key':
    'the flag key is a literal FlagShark will not accept as a key (a URL, a path, or a string with whitespace), so the call is probably not an evaluation',
  'destructured-parameter':
    'the flag key arrives through a destructured parameter, so it has no fixed argument position to read at the callers',
  'spread-caller':
    'an argument at or before the key position is spread, so no argument position is provable (FS-069 refuses this shape for rewriting too)',
  'unnamed-wrapper':
    'the function forwarding the key has no name call sites can be bound to (an inline callback, an IIFE, or an anonymous default export)',
  'ambiguous-client-provenance':
    'a named function forwards the key, but the scan could not tie what it forwards into to a proven SDK client — the declaring file does not import the SDK itself, or the wrapper chain is longer than the scan follows (FS-069 uses this name for the same refusal)',
  'wrapper-without-callers':
    'a wrapper forwards the key to the SDK but the scan found no call site for it, so its flag keys are somewhere the scan cannot see',
}

/** What happened at one call-shaped evaluation site. */
export type EvaluationSiteStatus =
  /** A flag name was resolved here and is reported. */
  | { kind: 'accounted'; flagKey: string }
  /** The key is forwarded by an identified wrapper; the names live at its callers. */
  | { kind: 'delegated'; wrapper: string }
  /** No flag name could be attributed. */
  | { kind: 'gap'; reason: EvaluationGapReason }

/**
 * A call-shaped evaluation site counted from the parsed tree, independently of
 * whether the scan could name the flag it evaluates.
 */
export interface EvaluationSite {
  filePath: string
  /** 1-based line of the call. */
  lineNumber: number
  /** The callee: a catalogued SDK method, or an identified wrapper. */
  callee: string
  /** How the site reaches a provider: the SDK directly, or through a wrapper. */
  via: 'sdk' | 'wrapper'
  status: EvaluationSiteStatus
  /**
   * The hosted migration's refusal for this evaluation, when one applies and is not
   * already carried by a wrapper. Set on a direct SDK call; null at a wrapper body
   * or a wrapper caller, where the wrapper's own `rewriteBlocker` is the fact.
   */
  rewriteRefusal: WrapperRewriteBlocker | null
}

/**
 * FS-069's detection-coverage cross-check, kept under its own name and its own
 * semantics so the public number and the hosted one mean the same thing.
 *
 * - `callShaped` — every `<expression>.<name>(…)` in a parsed file that can see a
 *   provider package whose `<name>` is a catalogued evaluation method of a provider
 *   that file reaches. Counted from the tree, **without consulting provenance**, so
 *   the metric cannot be biased by the gap it measures, and without looking at the
 *   argument list, so it over-approximates on purpose: an unrelated
 *   `list.variation()` counts and is never accounted for, which errs toward
 *   reporting a shortfall rather than hiding a real miss.
 * - `accountedFor` — those the scan then explained: a named flag, a delegation to an
 *   identified wrapper, or a named refusal.
 *
 * A shortfall means an evaluation-shaped call was neither named nor explained.
 *
 * One deliberate widening over FS-069, which is LaunchDarkly-only: the public
 * scanner counts every provider SDK it detects, so the method-name set is the union
 * over the providers each file reaches rather than LaunchDarkly's alone.
 */
export interface EvaluationSurfaceCoverage {
  callShaped: number
  accountedFor: number
}

export interface WrapperEvaluationResult {
  /** Wrappers identified, sorted by file then line. */
  wrappers: WrapperDeclaration[]
  /**
   * Flags resolved at evaluation sites this pass could name. Includes wrapper
   * call sites and SDK call sites keyed by a const the per-file detectors
   * cannot reach (an imported const, or an `export const`). Duplicates of what
   * the per-file detectors already reported are removed by
   * `summarizeEvaluationSurface`.
   */
  flags: FeatureFlag[]
  /** Every call-shaped evaluation site, sorted by file then line. */
  sites: EvaluationSite[]
  /** TS/JS files in SDK scope the pass parsed and walked. */
  filesInScope: number
  /** FS-069's two-number cross-check over the same files. */
  evaluationSurface: EvaluationSurfaceCoverage
}

export interface WrapperEvaluationOptions {
  /** Every scanned file, keyed by absolute path, as read by the scan. */
  files: ReadonlyMap<string, string>
  /**
   * Per-file set of SDK import patterns the file reaches, directly or through
   * local imports — `ImportGraphResult.transitiveSdks`. Files absent from this
   * map reach no SDK and are not walked for evaluation sites.
   */
  transitiveSdks: ReadonlyMap<string, ReadonlySet<string>>
  /** Provider definitions of the TS/JS detectors. */
  providers: FeatureFlagProvider[]
  /** tsconfig path aliases, so `@utils/foo` caller→wrapper edges resolve. */
  aliases?: PathAliases
  /** Language label the detectors record for a file, so emitted flags match. */
  languageForFile: (filePath: string) => string
  /** Rounds of wrapper-forwards-into-wrapper chaining. Default 3. */
  maxWrapperDepth?: number
}

const DEFAULT_MAX_WRAPPER_DEPTH = 3

/** Bound on how far a re-export barrel chain is followed when binding a caller. */
const MAX_RE_EXPORT_HOPS = 4

// ── Tree helpers ─────────────────────────────────────────────────

const FUNCTION_NODES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
])

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null)
}

function* walk(node: Node): Generator<Node> {
  yield node
  for (const child of namedChildren(node)) yield* walk(child)
}

/** The innermost function-ish ancestor of `node`, or null at module scope. */
function enclosingFunction(node: Node): Node | null {
  let current = node.parent
  while (current) {
    if (FUNCTION_NODES.has(current.type)) return current
    current = current.parent
  }
  return null
}

/** True when the declaration is introduced by an `export` keyword. */
function isExportedDeclaration(node: Node): boolean {
  return node.parent?.type === 'export_statement'
}

/**
 * A receiver's identity for caller matching: `this.<prop>` keeps the property
 * (that is the constructor-injection handle), anything else reduces to its
 * leftmost identifier so `Svc.getInstance()` and `new Svc()` both read as `Svc`.
 *
 * The non-null assertions are the grammar's guarantee: a parsed
 * `member_expression` always has an object and a property, a `call_expression`
 * always has a callee, and a parenthesised/awaited/asserted expression always
 * wraps one.
 */
function receiverKey(node: Node): string | null {
  switch (node.type) {
    case 'identifier':
      return node.text
    case 'this':
      return 'this'
    case 'member_expression': {
      const object = node.childForFieldName('object')!
      return object.type === 'this'
        ? `this.${node.childForFieldName('property')!.text}`
        : receiverKey(object)
    }
    case 'subscript_expression':
      return receiverKey(node.childForFieldName('object')!)
    case 'call_expression':
      return receiverKey(node.childForFieldName('function')!)
    case 'new_expression':
      return receiverKey(node.childForFieldName('constructor')!)
    case 'await_expression':
    case 'parenthesized_expression':
    case 'non_null_expression':
      return receiverKey(namedChildren(node)[0]!)
    default:
      return null
  }
}

/** The first type name written in a type annotation (`LD.LDClient` reads as `LDClient`). */
function annotatedTypeName(annotation: Node): string | null {
  for (const node of walk(annotation)) {
    if (node.type === 'type_identifier') return node.text
  }
  return null
}

type ParameterSlot = { kind: 'identifier'; name: string } | { kind: 'pattern'; names: string[] }

/** Positional parameters of a function-ish node, in source order. */
function parameterSlots(fn: Node): ParameterSlot[] {
  const single = fn.childForFieldName('parameter')
  if (single) return [{ kind: 'identifier', name: single.text }]
  const list = fn.childForFieldName('parameters')
  /* v8 ignore next -- every function-ish node has a parameter list or a single parameter */
  if (!list) return []
  const slots: ParameterSlot[] = []
  for (const parameter of namedChildren(list)) {
    if (parameter.type !== 'required_parameter' && parameter.type !== 'optional_parameter') continue
    const pattern = parameter.childForFieldName('pattern')
    /* v8 ignore next -- a parsed parameter always carries a pattern */
    if (!pattern) continue
    if (pattern.type === 'identifier') {
      slots.push({ kind: 'identifier', name: pattern.text })
      continue
    }
    const names: string[] = []
    for (const node of walk(pattern)) {
      if (node.type === 'shorthand_property_identifier_pattern' || node.type === 'identifier') {
        names.push(node.text)
      }
    }
    slots.push({ kind: 'pattern', names })
  }
  return slots
}

/** True when `fn`'s subtree declares `name` as a variable, so it is not a parameter. */
function declaresLocal(fn: Node, name: string): boolean {
  for (const node of walk(fn)) {
    if (node.type !== 'variable_declarator') continue
    if (node.childForFieldName('name')?.text === name) return true
  }
  return false
}

/** A string literal, refusing a template that interpolates anything. */
function literalString(node: Node): string | null {
  if (
    node.type === 'template_string' &&
    namedChildren(node).some((child) => child.type === 'template_substitution')
  ) {
    return null
  }
  return extractStringLiteral(node)
}

/**
 * File-scope `const` declarators, unwrapping `export const`. The existing
 * same-file resolver (`resolveConstStringTS`) walks only direct children of the
 * program node, so an exported const is invisible to it; this pass sees both.
 */
function* fileScopeDeclarators(root: Node): Generator<Node> {
  for (const child of namedChildren(root)) {
    const declaration = child.type === 'export_statement' ? child.childForFieldName('declaration') : child
    if (!declaration || declaration.type !== 'lexical_declaration') continue
    if (declaration.children[0]?.type !== 'const') continue
    for (const declarator of namedChildren(declaration)) {
      if (declarator.type === 'variable_declarator') yield declarator
    }
  }
}

/** A file-scope `const NAME = 'literal'`, including `export const`. */
function constStringInModule(root: Node, name: string): string | null {
  for (const declarator of fileScopeDeclarators(root)) {
    if (declarator.childForFieldName('name')?.text !== name) continue
    const value = declarator.childForFieldName('value')
    if (!value) continue
    const literal = literalString(value)
    if (literal !== null) return literal
  }
  return null
}

/** A property of a file-scope `const NAME = { KEY: 'literal' }`. */
function constObjectPropertyInModule(root: Node, name: string, property: string): string | null {
  for (const declarator of fileScopeDeclarators(root)) {
    if (declarator.childForFieldName('name')?.text !== name) continue
    const value = declarator.childForFieldName('value')
    if (!value || value.type !== 'object') continue
    for (const pair of namedChildren(value)) {
      if (pair.type !== 'pair') continue
      const key = pair.childForFieldName('key')
      /* v8 ignore next -- a parsed pair always has a key */
      if (!key) continue
      const keyName = key.type === 'string' ? extractStringLiteral(key) : key.text
      if (keyName !== property) continue
      const pairValue = pair.childForFieldName('value')
      /* v8 ignore next -- a parsed pair always has a value */
      if (!pairValue) continue
      const literal = literalString(pairValue)
      if (literal !== null) return literal
    }
  }
  return null
}

// ── File facts (one tree walk per file) ──────────────────────────

interface ModuleBinding {
  /** Local name in the importing file. */
  local: string
  /** Name in the source module; `default` or `*` for those forms. */
  imported: string
  /** Resolved path of the module inside the scan set. */
  resolved: string
}

interface ReExport {
  /** Name as seen by the importer; null for `export * from`. */
  exported: string | null
  /** Name inside the source module; null for `export * from`. */
  source: string | null
  /** Resolved module path. */
  target: string
}

interface RawCall {
  /** tree-sitter node id of the call, so two independent passes can be intersected. */
  id: number
  callee: string
  receiver: Node | null
  args: Node
  lineNumber: number
}

interface FileFacts {
  bindings: ModuleBinding[]
  /** `export { a }` / `export { a as b }` without a source. */
  exportListNames: Set<string>
  reExports: ReExport[]
  /** `<prop>` → annotated type, from constructor parameter properties and class fields. */
  injectedTypes: Map<string, string>
  /** `<variable>` → constructed or annotated type, for singleton handles. */
  localInstances: Map<string, string>
  calls: RawCall[]
}

/**
 * Everything the wrapper pass needs from one file, collected in a single tree
 * walk: module bindings (ESM and `require`), export lists, re-exports,
 * dependency-injection handles, and every call expression.
 */
function collectFileFacts(
  root: Node,
  filePath: string,
  fileSet: ReadonlySet<string>,
  aliases: PathAliases | undefined,
): FileFacts {
  const facts: FileFacts = {
    bindings: [],
    exportListNames: new Set(),
    reExports: [],
    injectedTypes: new Map(),
    localInstances: new Map(),
    calls: [],
  }
  const resolve = (specifier: string): string | null => resolveImportPath(filePath, specifier, fileSet, aliases)
  const bind = (local: string, imported: string, resolved: string | null): void => {
    if (resolved !== null) facts.bindings.push({ local, imported, resolved })
  }

  for (const node of walk(root)) {
    switch (node.type) {
      case 'import_statement':
        collectImport(node, resolve, bind)
        break
      case 'export_statement':
        collectExport(node, resolve, facts)
        break
      case 'variable_declarator':
        collectDeclarator(node, resolve, bind, facts)
        break
      case 'public_field_definition':
        collectAnnotatedMember(node, facts.injectedTypes)
        break
      case 'method_definition':
        if (node.childForFieldName('name')?.text === 'constructor') {
          collectConstructorInjection(node, facts.injectedTypes)
        }
        break
      case 'call_expression':
        collectCall(node, facts.calls)
        break
      default:
        break
    }
  }
  return facts
}

type Resolver = (specifier: string) => string | null
type Binder = (local: string, imported: string, resolved: string | null) => void

function specifierOf(node: Node): string | null {
  const source = node.childForFieldName('source')
  if (!source) return null
  return extractStringLiteral(source)
}

function collectImport(node: Node, resolve: Resolver, bind: Binder): void {
  const specifier = specifierOf(node)
  /* v8 ignore next -- an import statement always carries a string source */
  if (specifier === null) return
  const resolved = resolve(specifier)
  for (const clause of namedChildren(node)) {
    if (clause.type !== 'import_clause') continue
    for (const part of namedChildren(clause)) {
      if (part.type === 'identifier') {
        bind(part.text, 'default', resolved)
      } else if (part.type === 'namespace_import') {
        const alias = namedChildren(part).find((child) => child.type === 'identifier')
        /* v8 ignore next -- `import * as x` always binds an identifier */
        if (alias) bind(alias.text, '*', resolved)
      } else if (part.type === 'named_imports') {
        for (const specifierNode of namedChildren(part)) {
          if (specifierNode.type !== 'import_specifier') continue
          const name = specifierNode.childForFieldName('name')
          /* v8 ignore next -- an import specifier always names an export */
          if (!name) continue
          bind((specifierNode.childForFieldName('alias') ?? name).text, name.text, resolved)
        }
      }
    }
  }
}

function collectExport(node: Node, resolve: Resolver, facts: FileFacts): void {
  const specifier = specifierOf(node)
  const clause = namedChildren(node).find((child) => child.type === 'export_clause')
  if (specifier === null) {
    if (!clause) return
    for (const exportSpecifier of namedChildren(clause)) {
      if (exportSpecifier.type !== 'export_specifier') continue
      const name = exportSpecifier.childForFieldName('name')
      /* v8 ignore next -- an export specifier always names a binding */
      if (!name) continue
      facts.exportListNames.add((exportSpecifier.childForFieldName('alias') ?? name).text)
    }
    return
  }
  const target = resolve(specifier)
  if (target === null) return
  if (!clause) {
    facts.reExports.push({ exported: null, source: null, target })
    return
  }
  for (const exportSpecifier of namedChildren(clause)) {
    if (exportSpecifier.type !== 'export_specifier') continue
    const name = exportSpecifier.childForFieldName('name')
    /* v8 ignore next -- an export specifier always names a binding */
    if (!name) continue
    facts.reExports.push({
      exported: (exportSpecifier.childForFieldName('alias') ?? name).text,
      source: name.text,
      target,
    })
  }
}

function collectDeclarator(node: Node, resolve: Resolver, bind: Binder, facts: FileFacts): void {
  const name = node.childForFieldName('name')
  /* v8 ignore next -- a parsed declarator always has a name */
  if (!name) return
  const value = node.childForFieldName('value')

  // Singleton handles: `const svc: Svc = …` / `const svc = new Svc()`.
  if (name.type === 'identifier') {
    const annotation = node.childForFieldName('type')
    const annotated = annotation === null ? null : annotatedTypeName(annotation)
    if (annotated !== null) {
      facts.localInstances.set(name.text, annotated)
    } else if (value?.type === 'new_expression') {
      const constructed = value.childForFieldName('constructor')
      if (constructed?.type === 'identifier') facts.localInstances.set(name.text, constructed.text)
    }
  }

  // `const x = require('m')` / `const { a: b } = require('m')`.
  if (!value || value.type !== 'call_expression') return
  if (value.childForFieldName('function')?.text !== 'require') return
  const args = value.childForFieldName('arguments')
  /* v8 ignore next -- a parsed call always has an argument list */
  if (!args) return
  const first = getArgument(args, 0)
  if (!first) return
  const specifier = extractStringLiteral(first)
  if (specifier === null) return
  const resolved = resolve(specifier)
  if (name.type === 'identifier') {
    // A CJS default import can be used as either the module namespace or the
    // exported callable, so both forms are bound.
    bind(name.text, '*', resolved)
    bind(name.text, 'default', resolved)
    return
  }
  if (name.type !== 'object_pattern') return
  for (const part of namedChildren(name)) {
    if (part.type === 'shorthand_property_identifier_pattern') {
      bind(part.text, part.text, resolved)
    } else if (part.type === 'pair_pattern') {
      const key = part.childForFieldName('key')
      const local = part.childForFieldName('value')
      /* v8 ignore next -- a parsed pair pattern always has both halves */
      if (key && local) bind(local.text, key.text, resolved)
    }
  }
}

function collectAnnotatedMember(node: Node, into: Map<string, string>): void {
  const name = node.childForFieldName('name')
  const annotation = node.childForFieldName('type')
  if (!name || !annotation) return
  const typeName = annotatedTypeName(annotation)
  if (typeName) into.set(name.text, typeName)
}

function collectConstructorInjection(node: Node, into: Map<string, string>): void {
  const parameters = node.childForFieldName('parameters')
  /* v8 ignore next -- a parsed constructor always has a parameter list */
  if (!parameters) return
  for (const parameter of namedChildren(parameters)) {
    if (parameter.type !== 'required_parameter' && parameter.type !== 'optional_parameter') continue
    const pattern = parameter.childForFieldName('pattern')
    const annotation = parameter.childForFieldName('type')
    if (!pattern || pattern.type !== 'identifier' || !annotation) continue
    const typeName = annotatedTypeName(annotation)
    if (typeName) into.set(pattern.text, typeName)
  }
}

function collectCall(node: Node, into: RawCall[]): void {
  const fn = node.childForFieldName('function')
  const args = node.childForFieldName('arguments')
  if (!fn || !args || args.type !== 'arguments') return
  const lineNumber = node.startPosition.row + 1
  if (fn.type === 'identifier') {
    into.push({ id: node.id, callee: fn.text, receiver: null, args, lineNumber })
    return
  }
  if (fn.type !== 'member_expression') return
  const property = fn.childForFieldName('property')
  const receiver = fn.childForFieldName('object')
  /* v8 ignore next -- a parsed member expression always has an object and a property */
  if (!property || !receiver) return
  if (property.type !== 'property_identifier') return
  into.push({ id: node.id, callee: property.text, receiver, args, lineNumber })
}

// ── Provider catalogue ───────────────────────────────────────────

interface SdkMethod {
  keyIndex: number
  provider: string
}

/** Catalogued flag-key-bearing methods per SDK import pattern. */
function buildSdkCatalogue(providers: FeatureFlagProvider[]): Map<string, Map<string, SdkMethod>> {
  const catalogue = new Map<string, Map<string, SdkMethod>>()
  for (const provider of providers) {
    if (!provider.enabled) continue
    const pattern = getImportPattern(provider)
    if (!pattern) continue
    let methods = catalogue.get(pattern)
    if (!methods) {
      methods = new Map()
      catalogue.set(pattern, methods)
    }
    for (const method of provider.methods) {
      if (method.flagKeyIndex < 0) continue
      if (!methods.has(method.name)) {
        methods.set(method.name, { keyIndex: method.flagKeyIndex, provider: pattern })
      }
    }
  }
  return catalogue
}

/** Every package name a provider is imported under, for the direct-import gate. */
function providerPackages(providers: FeatureFlagProvider[]): Map<string, string[]> {
  const packages = new Map<string, string[]>()
  for (const provider of providers) {
    const pattern = getImportPattern(provider)
    if (!pattern) continue
    const existing = packages.get(pattern) ?? [pattern]
    packages.set(pattern, [...new Set([...existing, ...(provider.importAliases ?? [])])])
  }
  return packages
}

// ── Analysis ─────────────────────────────────────────────────────

interface ParsedFile extends FileFacts {
  filePath: string
  root: Node
  language: string
  /** SDK import patterns the file mentions directly (the detectors' import gate). */
  directSdks: Set<string>
  /** SDK import patterns the file reaches, directly or through local imports. */
  reachableSdks: ReadonlySet<string>
}

type KeyResolution =
  | { kind: 'key'; flagKey: string }
  | { kind: 'parameter'; fn: Node; index: number }
  | { kind: 'gap'; reason: EvaluationGapReason }

interface Analyzer {
  parsed: Map<string, ParsedFile>
}

/**
 * Modules a binding's name can originate from: the module it names, plus the
 * modules a re-export barrel forwards the name from, bounded to
 * `MAX_RE_EXPORT_HOPS`.
 */
function originModules(analyzer: Analyzer, start: string, name: string): Set<string> {
  const origins = new Set<string>([start])
  let frontier: Array<{ file: string; name: string }> = [{ file: start, name }]
  for (let hop = 0; hop < MAX_RE_EXPORT_HOPS && frontier.length > 0; hop++) {
    const next: Array<{ file: string; name: string }> = []
    for (const entry of frontier) {
      const file = analyzer.parsed.get(entry.file)
      if (!file) continue
      for (const reExport of file.reExports) {
        if (reExport.exported !== null && reExport.exported !== entry.name) continue
        if (origins.has(reExport.target)) continue
        origins.add(reExport.target)
        next.push({ file: reExport.target, name: reExport.source ?? entry.name })
      }
    }
    frontier = next
  }
  return origins
}

/** A call shape in one file that reaches one wrapper. */
interface AcceptedCall {
  callee: string
  /** Receiver keys the call must use; null when the call must be a bare call. */
  receivers: Set<string> | null
  wrapper: WrapperDeclaration
}

/** Every way `wrapper` can legitimately be called from `file`. */
function acceptedCallsFor(analyzer: Analyzer, file: ParsedFile, wrapper: WrapperDeclaration): AcceptedCall[] {
  const accepted: AcceptedCall[] = []
  const sameFile = file.filePath === wrapper.filePath
  const reaches = (binding: ModuleBinding): boolean =>
    originModules(analyzer, binding.resolved, binding.imported).has(wrapper.filePath)

  if (wrapper.kind === 'function') {
    if (sameFile) accepted.push({ callee: wrapper.name, receivers: null, wrapper })
    if (wrapper.exported) {
      for (const binding of file.bindings) {
        if (!reaches(binding)) continue
        if (binding.imported === wrapper.name || binding.imported === 'default') {
          accepted.push({ callee: binding.local, receivers: null, wrapper })
        } else if (binding.imported === '*') {
          accepted.push({ callee: wrapper.name, receivers: new Set([binding.local]), wrapper })
        }
      }
    }
    return accepted
  }

  // Method wrappers: the receiver has to name a binding that reaches the
  // declaring module, directly or through a `this.<prop>` / local handle
  // annotated with the owner type.
  const handles = (owner: string): Set<string> => {
    const receivers = new Set<string>([owner])
    for (const [property, typeName] of file.injectedTypes) {
      if (typeName === owner) receivers.add(`this.${property}`)
    }
    for (const [variable, typeName] of file.localInstances) {
      if (typeName === owner) receivers.add(variable)
    }
    return receivers
  }

  if (sameFile) {
    const receivers = handles(wrapper.owner!)
    receivers.add('this')
    accepted.push({ callee: wrapper.name, receivers, wrapper })
  }
  if (wrapper.exported) {
    for (const binding of file.bindings) {
      if (!reaches(binding)) continue
      if (binding.imported !== wrapper.owner && binding.imported !== 'default' && binding.imported !== '*') continue
      accepted.push({ callee: wrapper.name, receivers: handles(binding.local), wrapper })
    }
  }
  return accepted
}

function matchesAccepted(call: RawCall, accepted: AcceptedCall): boolean {
  if (call.callee !== accepted.callee) return false
  if (accepted.receivers === null) return call.receiver === null
  if (call.receiver === null) return false
  const key = receiverKey(call.receiver)
  return key !== null && accepted.receivers.has(key)
}

/**
 * FS-069's `callShaped` side: member-form calls naming a catalogued evaluation
 * method of a provider the file reaches. No provenance, no argument inspection.
 */
function callShapedIds(file: ParsedFile, catalogue: Map<string, Map<string, SdkMethod>>): Set<number> {
  const ids = new Set<number>()
  for (const call of file.calls) {
    // FS-069 counts `<expression>.<name>(…)`; a bare call is not counted there,
    // and a destructured or aliased evaluation method is not a property access at
    // all, so the metric does not cross-check it either.
    if (call.receiver === null) continue
    for (const sdk of file.reachableSdks) {
      if (catalogue.get(sdk)?.has(call.callee)) {
        ids.add(call.id)
        break
      }
    }
  }
  return ids
}

/** The SDK method a call names, when the file reaches that SDK. */
function sdkTargetFor(
  call: RawCall,
  file: ParsedFile,
  catalogue: Map<string, Map<string, SdkMethod>>,
): SdkMethod | null {
  for (const sdk of file.reachableSdks) {
    const method = catalogue.get(sdk)?.get(call.callee)
    if (method) return method
  }
  return null
}

/** A const (or const-object property) imported from another module in the scan set. */
function importedConst(
  analyzer: Analyzer,
  file: ParsedFile,
  name: string,
  property: string | null,
): string | null {
  for (const binding of file.bindings) {
    if (binding.local !== name) continue
    // A namespace binding turns `ns.PROPERTY` into the module's exported const
    // `PROPERTY`; every other binding names the const (or const object) itself.
    const namespaced = binding.imported === '*'
    if (namespaced && property === null) continue
    const wanted = namespaced ? property! : binding.imported
    for (const origin of originModules(analyzer, binding.resolved, wanted)) {
      const module = analyzer.parsed.get(origin)
      if (!module) continue
      const value =
        namespaced || property === null
          ? constStringInModule(module.root, wanted)
          : constObjectPropertyInModule(module.root, wanted, property)
      if (value !== null) return value
    }
  }
  return null
}

/** Walk outward to the function that binds `name` as a positional parameter. */
function findParameterBinder(node: Node, name: string): KeyResolution | null {
  let fn = enclosingFunction(node)
  while (fn) {
    if (declaresLocal(fn, name)) return { kind: 'gap', reason: 'unprovable-key' }
    const slots = parameterSlots(fn)
    const index = slots.findIndex((slot) => slot.kind === 'identifier' && slot.name === name)
    if (index >= 0) return { kind: 'parameter', fn, index }
    if (slots.some((slot) => slot.kind === 'pattern' && slot.names.includes(name))) {
      return { kind: 'gap', reason: 'destructured-parameter' }
    }
    fn = enclosingFunction(fn)
  }
  return null
}

/**
 * True when an argument at or before the key position is spread, so no argument
 * position is provable. FS-069 refuses this shape for rewriting under the same
 * name; here it means the key cannot be read positionally either.
 */
function hasSpreadBeforeKey(args: Node, keyIndex: number): boolean {
  const positional = namedChildren(args).filter((child) => child.type !== 'comment')
  return positional.slice(0, keyIndex + 1).some((child) => child.type === 'spread_element')
}

/** Resolve a site's key argument to a flag name, a forwarded parameter, or a refusal. */
function resolveKeyArgument(analyzer: Analyzer, file: ParsedFile, argument: Node): KeyResolution {
  const literal = literalString(argument)
  if (literal !== null) {
    return isValidFlagKey(literal)
      ? { kind: 'key', flagKey: literal }
      : { kind: 'gap', reason: 'unusable-literal-key' }
  }

  if (argument.type === 'identifier') {
    const name = argument.text
    for (const candidate of [constStringInModule(file.root, name), importedConst(analyzer, file, name, null)]) {
      if (candidate !== null && isValidFlagKey(candidate)) return { kind: 'key', flagKey: candidate }
    }
    return findParameterBinder(argument, name) ?? { kind: 'gap', reason: 'unprovable-key' }
  }

  if (argument.type === 'member_expression') {
    const object = argument.childForFieldName('object')
    const property = argument.childForFieldName('property')
    if (object?.type === 'identifier' && property?.type === 'property_identifier') {
      const candidates = [
        constObjectPropertyInModule(file.root, object.text, property.text),
        importedConst(analyzer, file, object.text, property.text),
      ]
      for (const candidate of candidates) {
        if (candidate !== null && isValidFlagKey(candidate)) return { kind: 'key', flagKey: candidate }
      }
    }
    return { kind: 'gap', reason: 'unprovable-key' }
  }

  return { kind: 'gap', reason: 'computed-key' }
}

/** Name a forwarding function so its call sites can be bound to it. */
interface NamedWrapper {
  kind: WrapperKind
  name: string
  owner: string | null
  exported: boolean
  declaration: Node
}

function nameWrapper(fn: Node, file: ParsedFile): NamedWrapper | null {
  if (fn.type === 'function_declaration' || fn.type === 'generator_function_declaration') {
    const name = fn.childForFieldName('name')
    /* v8 ignore next -- an anonymous `export default function (…)` parses as a function expression, not a declaration */
    if (!name) return null
    return {
      kind: 'function',
      name: name.text,
      owner: null,
      exported: isExportedDeclaration(fn) || file.exportListNames.has(name.text),
      declaration: fn,
    }
  }

  if (fn.type === 'method_definition') {
    const name = fn.childForFieldName('name')
    /* v8 ignore next -- a parsed method definition always has a name */
    if (!name) return null
    const container = fn.parent
    /* v8 ignore next -- a method definition always sits in a class body or an object literal */
    if (!container) return null
    const owner =
      container.type === 'class_body' ? ownerOfClass(container, file) : ownerOfObject(container, file)
    if (!owner) return null
    return { kind: 'method', name: name.text, owner: owner.name, exported: owner.exported, declaration: fn }
  }

  // Arrow functions and function expressions are named only by what holds them.
  const parent = fn.parent
  /* v8 ignore next -- an expression always has a parent node */
  if (!parent) return null
  if (parent.type === 'variable_declarator') {
    const name = parent.childForFieldName('name')
    if (!name || name.type !== 'identifier') return null
    const declaration = parent.parent
    /* v8 ignore next -- a declarator always sits inside a declaration */
    if (!declaration) return null
    return {
      kind: 'function',
      name: name.text,
      owner: null,
      exported: isExportedDeclaration(declaration) || file.exportListNames.has(name.text),
      declaration: parent,
    }
  }
  if (parent.type === 'pair' && parent.parent?.type === 'object') {
    const key = parent.childForFieldName('key')
    /* v8 ignore next -- a parsed pair always has a key */
    if (!key) return null
    const keyName = key.type === 'string' ? extractStringLiteral(key) : key.text
    /* v8 ignore next -- a string key always yields its contents */
    if (keyName === null) return null
    const owner = ownerOfObject(parent.parent, file)
    if (!owner) return null
    return { kind: 'method', name: keyName, owner: owner.name, exported: owner.exported, declaration: parent }
  }
  return null
}

function ownerOfClass(classBody: Node, file: ParsedFile): { name: string; exported: boolean } | null {
  const declaration = classBody.parent
  /* v8 ignore next -- a class body always belongs to a class */
  if (!declaration) return null
  const name = declaration.childForFieldName('name')
  if (!name) return null
  return { name: name.text, exported: isExportedDeclaration(declaration) || file.exportListNames.has(name.text) }
}

function ownerOfObject(object: Node, file: ParsedFile): { name: string; exported: boolean } | null {
  const declarator = object.parent
  if (!declarator || declarator.type !== 'variable_declarator') return null
  const name = declarator.childForFieldName('name')
  if (!name || name.type !== 'identifier') return null
  const declaration = declarator.parent
  /* v8 ignore next -- a declarator always sits inside a declaration */
  if (!declaration) return null
  return { name: name.text, exported: isExportedDeclaration(declaration) || file.exportListNames.has(name.text) }
}

/** Every call site found for a wrapper, however its key resolved. */
export function callerCount(wrapper: WrapperDeclaration): number {
  return wrapper.resolvedCallers + wrapper.unresolvedCallers + wrapper.forwardingCallers
}

/** `Class.method()` / `helper()` — how a wrapper is named in the output. */
export function wrapperLabel(wrapper: WrapperDeclaration): string {
  return `${wrapper.owner === null ? '' : `${wrapper.owner}.`}${wrapper.name}()`
}

// ── Entry point ──────────────────────────────────────────────────

/**
 * Identify wrapper-mediated evaluations across the scanned TS/JS files and count
 * every call-shaped evaluation site the parsed trees contain.
 */
export async function analyzeWrapperEvaluations(
  options: WrapperEvaluationOptions,
): Promise<WrapperEvaluationResult> {
  const catalogue = buildSdkCatalogue(options.providers)
  const packages = providerPackages(options.providers)
  const maxDepth = options.maxWrapperDepth ?? DEFAULT_MAX_WRAPPER_DEPTH

  const fileSet = new Set<string>()
  for (const filePath of options.files.keys()) {
    if (isTsJsFile(filePath)) fileSet.add(filePath)
  }
  const inScopePaths = [...fileSet].filter((filePath) => options.transitiveSdks.has(filePath)).sort()
  if (inScopePaths.length === 0) {
    return {
      wrappers: [],
      flags: [],
      sites: [],
      filesInScope: 0,
      evaluationSurface: { callShaped: 0, accountedFor: 0 },
    }
  }

  const parser = await getParser('typescript')
  const parsed = new Map<string, ParsedFile>()
  const analyzer: Analyzer = { parsed }

  const parseFile = (filePath: string): void => {
    const content = options.files.get(filePath)!
    // parser.parse() returns a tree for any string input.
    const root = parser.parse(content)!.rootNode
    const directSdks = new Set<string>()
    for (const [pattern, names] of packages) {
      if (names.some((name) => content.includes(name))) directSdks.add(pattern)
    }
    parsed.set(filePath, {
      ...collectFileFacts(root, filePath, fileSet, options.aliases),
      filePath,
      root,
      language: options.languageForFile(filePath),
      directSdks,
      reachableSdks: options.transitiveSdks.get(filePath) ?? new Set<string>(),
    })
  }

  for (const filePath of inScopePaths) parseFile(filePath)
  // One hop further: the modules in-scope files import. Those hold the flag-key
  // consts (`export const ENABLE_X = '…'`, `export const FLAGS = { … }`) and the
  // re-export barrels a caller reaches a wrapper through. Bounded on purpose — a
  // const two unexplored hops away is reported as a gap, not guessed at.
  const oneHop = new Set<string>()
  for (const filePath of inScopePaths) {
    for (const binding of parsed.get(filePath)!.bindings) {
      if (!parsed.has(binding.resolved)) oneHop.add(binding.resolved)
    }
  }
  for (const filePath of [...oneHop].sort()) parseFile(filePath)

  const inScopeFiles = inScopePaths.map((filePath) => parsed.get(filePath)!)

  // Round 1 identifies wrappers that call the SDK; each later round identifies
  // wrappers that forward a parameter into a wrapper already found.
  const wrappers: WrapperDeclaration[] = []
  const byDeclaration = new Map<string, WrapperDeclaration>()
  // Every evaluation each declaration was reached through, so a body with more than
  // one is refused rather than silently keeping whichever path was seen first. The
  // first version deduplicated by declaration key and dropped the second path — a
  // wrapper whose body called both a typed method and an untyped one was claimed by
  // the typed call at depth 1 and never revisited, losing the refusal entirely.
  const targets = new Map<string, string[]>()
  for (let depth = 1; depth <= maxDepth; depth++) {
    let grew = false
    for (const wrapper of identifyWrappers(analyzer, inScopeFiles, catalogue, wrappers, depth)) {
      const key = `${wrapper.filePath}:${wrapper.lineNumber}:${wrapper.name}`
      const existing = byDeclaration.get(key)
      if (existing === undefined) {
        byDeclaration.set(key, wrapper)
        targets.set(key, [wrapper.forwardsTo])
        wrappers.push(wrapper)
        grew = true
        continue
      }
      const seenTargets = targets.get(key)!
      seenTargets.push(wrapper.forwardsTo)
      // FS-069 refuses a wrapper whose body holds a second SDK call whatever the
      // methods are, so this supersedes any single-path refusal already recorded.
      existing.rewriteBlocker = secondSdkCallRefusal(seenTargets)
    }
    if (!grew) break
  }

  const { sites, flags, explainedIds } = classifySites(analyzer, inScopeFiles, catalogue, wrappers)

  // The cross-check: count the evaluation-shaped calls independently of the
  // classification above, then see how many of those same nodes it explained.
  let callShaped = 0
  let accountedFor = 0
  for (const file of inScopeFiles) {
    for (const id of callShapedIds(file, catalogue)) {
      callShaped += 1
      if (explainedIds.has(id)) accountedFor += 1
    }
  }

  wrappers.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber || a.name.localeCompare(b.name),
  )
  sites.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber || a.callee.localeCompare(b.callee),
  )

  return {
    wrappers,
    flags,
    sites,
    filesInScope: inScopeFiles.length,
    evaluationSurface: { callShaped, accountedFor },
  }
}

/** One round of wrapper identification. */
function identifyWrappers(
  analyzer: Analyzer,
  inScopeFiles: ParsedFile[],
  catalogue: Map<string, Map<string, SdkMethod>>,
  known: WrapperDeclaration[],
  depth: number,
): WrapperDeclaration[] {
  const found: WrapperDeclaration[] = []
  for (const file of inScopeFiles) {
    // A depth-1 wrapper can only be declared in a file that imports the SDK
    // itself — the same gate the per-file detectors apply.
    if (depth === 1 && file.directSdks.size === 0) continue
    const accepted =
      depth === 1
        ? []
        : known
            .filter((wrapper) => wrapper.depth === depth - 1)
            .flatMap((wrapper) => acceptedCallsFor(analyzer, file, wrapper))
    for (const call of file.calls) {
      let keyIndex: number
      let provider: string
      let forwardsTo: string
      let rewriteBlocker: WrapperRewriteBlocker | null
      if (depth === 1) {
        const target = sdkTargetFor(call, file, catalogue)
        if (!target || !file.directSdks.has(target.provider)) continue
        keyIndex = target.keyIndex
        provider = target.provider
        forwardsTo = call.callee
        rewriteBlocker = rewriteRefusalFor(provider, call.callee, 'wrapper')
      } else {
        const match = accepted.find((candidate) => matchesAccepted(call, candidate))
        if (!match) continue
        keyIndex = match.wrapper.keyParameterIndex
        provider = match.wrapper.provider
        forwardsTo = wrapperLabel(match.wrapper)
        // A chained wrapper is upstream of the same body, so it inherits the
        // refusal rather than looking migratable on its own.
        rewriteBlocker = match.wrapper.rewriteBlocker
      }
      const argument = getArgument(call.args, keyIndex)
      if (!argument || argument.type !== 'identifier') continue
      const binder = findParameterBinder(argument, argument.text)
      if (!binder || binder.kind !== 'parameter') continue
      const named = nameWrapper(binder.fn, file)
      if (!named) continue
      found.push({
        filePath: file.filePath,
        lineNumber: named.declaration.startPosition.row + 1,
        kind: named.kind,
        name: named.name,
        owner: named.owner,
        keyParameterIndex: binder.index,
        provider,
        forwardsTo,
        depth,
        exported: named.exported,
        resolvedCallers: 0,
        unresolvedCallers: 0,
        forwardingCallers: 0,
        rewriteBlocker,
      })
    }
  }
  return found
}

interface PendingSite {
  file: ParsedFile
  call: RawCall
  via: 'sdk' | 'wrapper'
  provider: string
  resolution: KeyResolution
}

/** Classify every evaluation site and emit the flags the classification proved. */
function classifySites(
  analyzer: Analyzer,
  inScopeFiles: ParsedFile[],
  catalogue: Map<string, Map<string, SdkMethod>>,
  wrappers: WrapperDeclaration[],
): { sites: EvaluationSite[]; flags: FeatureFlag[]; explainedIds: Set<number> } {
  const byDeclaration = new Map<string, WrapperDeclaration>()
  for (const wrapper of wrappers) {
    byDeclaration.set(`${wrapper.filePath}:${wrapper.lineNumber}:${wrapper.name}`, wrapper)
  }

  // Pass 1: resolve each site's key, recording caller counts on the wrappers.
  const pending: PendingSite[] = []
  for (const file of inScopeFiles) {
    const accepted = wrappers.flatMap((wrapper) => acceptedCallsFor(analyzer, file, wrapper))
    for (const call of file.calls) {
      const sdkTarget = sdkTargetFor(call, file, catalogue)
      const wrapperMatch = sdkTarget ? undefined : accepted.find((candidate) => matchesAccepted(call, candidate))
      if (!sdkTarget && !wrapperMatch) continue
      const keyIndex = sdkTarget ? sdkTarget.keyIndex : wrapperMatch!.wrapper.keyParameterIndex
      const provider = sdkTarget ? sdkTarget.provider : wrapperMatch!.wrapper.provider
      // A spread at or before the key position is checked first: it makes the key
      // unreadable whether or not something happens to sit at that index.
      const spread = hasSpreadBeforeKey(call.args, keyIndex)
      const argument = getArgument(call.args, keyIndex)
      // A call with no argument at the key position is not an evaluation.
      if (!spread && !argument) continue
      const resolution: KeyResolution = spread
        ? { kind: 'gap', reason: 'spread-caller' }
        : resolveKeyArgument(analyzer, file, argument!)
      if (wrapperMatch) {
        if (resolution.kind === 'key') wrapperMatch.wrapper.resolvedCallers += 1
        else if (resolution.kind === 'gap') wrapperMatch.wrapper.unresolvedCallers += 1
        else wrapperMatch.wrapper.forwardingCallers += 1
      }
      pending.push({ file, call, via: sdkTarget ? 'sdk' : 'wrapper', provider, resolution })
    }
  }

  // Pass 2: turn resolutions into reported sites. A parameter forwarded by a
  // wrapper the scan found callers for is delegated; one whose wrapper has no
  // callers, or no name, is a gap — those flag keys are somewhere we cannot see.
  const sites: EvaluationSite[] = []
  const flags: FeatureFlag[] = []
  const explainedIds = new Set<number>(pending.map((entry) => entry.call.id))
  for (const entry of pending) {
    // A direct SDK call carries its own refusal; a wrapper body or a wrapper caller
    // defers to the wrapper's, so the same refusal is never counted twice.
    const direct = entry.via === 'sdk' && entry.resolution.kind !== 'parameter'
    const base = {
      filePath: entry.file.filePath,
      lineNumber: entry.call.lineNumber,
      callee: entry.call.callee,
      via: entry.via,
      rewriteRefusal: direct ? rewriteRefusalFor(entry.provider, entry.call.callee, 'direct') : null,
    }
    if (entry.resolution.kind === 'key') {
      sites.push({ ...base, status: { kind: 'accounted', flagKey: entry.resolution.flagKey } })
      flags.push({
        name: entry.resolution.flagKey,
        filePath: entry.file.filePath,
        lineNumber: entry.call.lineNumber,
        language: entry.file.language,
        provider: entry.provider,
        confidence: 'medium',
      })
      continue
    }
    if (entry.resolution.kind === 'gap') {
      sites.push({ ...base, status: { kind: 'gap', reason: entry.resolution.reason } })
      continue
    }
    const named = nameWrapper(entry.resolution.fn, entry.file)
    if (!named) {
      sites.push({ ...base, status: { kind: 'gap', reason: 'unnamed-wrapper' } })
      continue
    }
    const wrapper = byDeclaration.get(
      `${entry.file.filePath}:${named.declaration.startPosition.row + 1}:${named.name}`,
    )
    if (!wrapper) {
      sites.push({ ...base, status: { kind: 'gap', reason: 'ambiguous-client-provenance' } })
      continue
    }
    if (callerCount(wrapper) > 0) {
      sites.push({ ...base, status: { kind: 'delegated', wrapper: wrapperLabel(wrapper) } })
      continue
    }
    sites.push({ ...base, status: { kind: 'gap', reason: 'wrapper-without-callers' } })
  }

  return { sites, flags, explainedIds }
}
