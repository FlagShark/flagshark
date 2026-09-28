/**
 * The method table is a hand-maintained copy of the hosted product's
 * `LD_TO_OPENFEATURE_TS`, and three things in this repository derive from it: the
 * detector's provider catalogue, part 1's catalogued client surface, and the
 * rewrite decision. These tests pin the sets **by name** so a future edit cannot
 * silently shrink them — which is exactly how the first version shipped a
 * four-name untyped set with one entry that was dead code, and a detector
 * catalogue missing five real methods.
 */
import { describe, it, expect } from 'vitest'

import { defaultTypeScriptProviders } from '../../src/detection/detectors/typescript.js'
import {
  isLaunchDarklyNodePackage,
  launchDarklyNodeMethod,
  LAUNCHDARKLY_DETAIL_METHOD_NAMES,
  LAUNCHDARKLY_NODE_CLIENT_METHODS,
  LAUNCHDARKLY_NODE_EVALUATION_METHODS,
  LAUNCHDARKLY_NODE_PACKAGES,
  LAUNCHDARKLY_UNTYPED_METHOD_NAMES,
} from '../../src/detection/launchdarkly-node-methods.js'
import { rewriteRefusalFor } from '../../src/detection/wrapper-evaluations.js'

const NODE_SDK = '@launchdarkly/node-server-sdk'

describe('the LaunchDarkly Node method table', () => {
  it('is exactly the ten rows of the hosted mapping plus the two the detector has always carried', () => {
    expect(LAUNCHDARKLY_NODE_EVALUATION_METHODS.map((method) => method.name)).toEqual([
      'boolVariation',
      'stringVariation',
      'numberVariation',
      'jsonVariation',
      'variation',
      'boolVariationDetail',
      'stringVariationDetail',
      'numberVariationDetail',
      'jsonVariationDetail',
      'variationDetail',
      'intVariation',
      'doubleVariation',
    ])
    expect(
      LAUNCHDARKLY_NODE_EVALUATION_METHODS.filter((method) => !method.onNodeClient).map((method) => method.name),
    ).toEqual(['intVariation', 'doubleVariation'])
  })

  it('pins the untyped set by name', () => {
    // FS-075 asserts the same set on the hosted side. The four Node-client entries
    // are the ones both tickets refuse; `intVariation`/`doubleVariation` are untyped
    // here because they are absent from the hosted mapping entirely.
    expect([...LAUNCHDARKLY_UNTYPED_METHOD_NAMES]).toEqual([
      'jsonVariation',
      'variation',
      'jsonVariationDetail',
      'variationDetail',
      'intVariation',
      'doubleVariation',
    ])
    expect(
      LAUNCHDARKLY_UNTYPED_METHOD_NAMES.filter((name) => launchDarklyNodeMethod(name)!.onNodeClient),
    ).toEqual(['jsonVariation', 'variation', 'jsonVariationDetail', 'variationDetail'])
  })

  it('pins the typed set and the detail set by name', () => {
    expect(
      LAUNCHDARKLY_NODE_EVALUATION_METHODS.filter((method) => method.returnType !== null).map(
        (method) => `${method.name}:${method.returnType}`,
      ),
    ).toEqual([
      'boolVariation:boolean',
      'stringVariation:string',
      'numberVariation:number',
      'boolVariationDetail:boolean',
      'stringVariationDetail:string',
      'numberVariationDetail:number',
    ])
    expect([...LAUNCHDARKLY_DETAIL_METHOD_NAMES]).toEqual([
      'boolVariationDetail',
      'stringVariationDetail',
      'numberVariationDetail',
      'jsonVariationDetail',
      'variationDetail',
    ])
  })

  it('pins the catalogued client surface part 1 gates on', () => {
    expect([...LAUNCHDARKLY_NODE_CLIENT_METHODS].sort()).toEqual([
      'boolVariation',
      'boolVariationDetail',
      'close',
      'flush',
      'init',
      'jsonVariation',
      'jsonVariationDetail',
      'numberVariation',
      'numberVariationDetail',
      'stringVariation',
      'stringVariationDetail',
      'variation',
      'variationDetail',
      'waitForInitialization',
    ])
    // The two names that are not on the Node client stay out of the catalogued
    // surface, so `sdk-api-surface` keeps reporting them as uncatalogued.
    expect(LAUNCHDARKLY_NODE_CLIENT_METHODS).not.toContain('intVariation')
    expect(LAUNCHDARKLY_NODE_CLIENT_METHODS).not.toContain('doubleVariation')
  })

  it('is what the detector advertises for the Node server SDK', () => {
    const provider = defaultTypeScriptProviders().find((entry) => entry.name === 'LaunchDarkly Node Server SDK')!
    expect(provider.methods.map((method) => method.name)).toEqual(
      LAUNCHDARKLY_NODE_EVALUATION_METHODS.map((method) => method.name),
    )
    expect(provider.methods.every((method) => method.flagKeyIndex === 0)).toBe(true)
    expect(provider.methods.every((method) => (method.examples ?? []).length === 1)).toBe(true)
  })

  it('names the two packages the hosted Node server cell covers, and nothing else', () => {
    expect([...LAUNCHDARKLY_NODE_PACKAGES]).toEqual([
      '@launchdarkly/node-server-sdk',
      'launchdarkly-node-server-sdk',
    ])
    expect(isLaunchDarklyNodePackage('@launchdarkly/node-server-sdk')).toBe(true)
    expect(isLaunchDarklyNodePackage('launchdarkly-node-server-sdk')).toBe(true)
    expect(isLaunchDarklyNodePackage('@launchdarkly/js-client-sdk')).toBe(false)
    expect(isLaunchDarklyNodePackage('@launchdarkly/react-sdk')).toBe(false)
  })

  it('returns undefined for a name outside the table', () => {
    expect(launchDarklyNodeMethod('allFlagsState')).toBeUndefined()
  })
})

describe('rewriteRefusalFor — the full method × position matrix', () => {
  const reason = (method: string, position: 'wrapper' | 'direct'): string | null =>
    rewriteRefusalFor(NODE_SDK, method, position)?.reason ?? null

  it('decides every catalogued method in both positions', () => {
    expect(
      LAUNCHDARKLY_NODE_EVALUATION_METHODS.map(
        (method) => `${method.name} wrapper=${reason(method.name, 'wrapper')} direct=${reason(method.name, 'direct')}`,
      ),
    ).toEqual([
      'boolVariation wrapper=null direct=null',
      'stringVariation wrapper=null direct=null',
      'numberVariation wrapper=null direct=null',
      'jsonVariation wrapper=generic-variation direct=unproven-served-type',
      'variation wrapper=generic-variation direct=unproven-served-type',
      'boolVariationDetail wrapper=details-consumer direct=details-consumer',
      'stringVariationDetail wrapper=details-consumer direct=details-consumer',
      'numberVariationDetail wrapper=details-consumer direct=details-consumer',
      'jsonVariationDetail wrapper=details-consumer direct=details-consumer',
      'variationDetail wrapper=details-consumer direct=details-consumer',
      'intVariation wrapper=generic-variation direct=unproven-served-type',
      'doubleVariation wrapper=generic-variation direct=unproven-served-type',
    ])
  })

  it('makes no claim about a method outside the table or a provider outside the cell', () => {
    expect(rewriteRefusalFor(NODE_SDK, 'allFlagsState', 'direct')).toBeNull()
    expect(rewriteRefusalFor('@launchdarkly/js-client-sdk', 'variation', 'direct')).toBeNull()
    expect(rewriteRefusalFor('posthog-node', 'isFeatureEnabled', 'wrapper')).toBeNull()
  })

  it('covers the legacy Node package, which shares the hosted cell', () => {
    expect(rewriteRefusalFor('launchdarkly-node-server-sdk', 'variation', 'wrapper')?.reason).toBe(
      'generic-variation',
    )
  })
})
