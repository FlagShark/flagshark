import { describe, it, expect } from 'vitest'

import { summarizeLockIn, LOCK_IN_LABELS, LOCK_IN_CLASSIFICATIONS } from '../../src/migration/lock-in.js'
import { NODE_SERVER_CELL_ID } from '../../src/migration/hosted-admission.js'
import { loadSupportSnapshot, SUPPORT_SNAPSHOT } from '../../src/migration/support-snapshot.js'

import type { FeatureFlag } from '../../src/detection/feature-flag.js'
import type { FeatureFlagProvider } from '../../src/detection/interface.js'
import type { AdmissionTreeView } from '../../src/migration/hosted-admission.js'
import type { SupportCell, SupportStage } from '../../src/migration/support-snapshot.js'

function provider(name: string, importPattern?: string, importAliases?: string[]): FeatureFlagProvider {
  return { name, importPattern, importAliases, enabled: true, methods: [] }
}

const PROVIDERS: FeatureFlagProvider[] = [
  provider('LaunchDarkly Node Server SDK', '@launchdarkly/node-server-sdk'),
  provider('LaunchDarkly Legacy Node SDK', 'launchdarkly-node-server-sdk'),
  provider('LaunchDarkly Go SDK', 'github.com/launchdarkly/go-server-sdk'),
  provider('LaunchDarkly Python SDK', 'ldclient'),
  provider('LaunchDarkly Ruby SDK', 'launchdarkly-server-sdk'),
  provider('LaunchDarkly Rust SDK', 'launchdarkly_server_sdk'),
  provider('LaunchDarkly React SDK', '@launchdarkly/react-client-sdk', ['launchdarkly-react-client-sdk', '@launchdarkly/react-sdk']),
  provider('PostHog', 'posthog-js'),
  provider('OpenFeature JavaScript SDK', '@openfeature/server-sdk', ['@openfeature/web-sdk']),
  provider('OpenFeature Python SDK', 'openfeature'),
  provider('OpenFeature Java SDK', 'dev.openfeature'),
  provider('Custom Feature Flags'),
]

function flag(
  name: string,
  providerString: string,
  language = 'typescript',
  confidence?: 'high' | 'medium' | 'low',
  lineNumber = 1,
): FeatureFlag {
  const f: FeatureFlag = { name, filePath: `src/${name}.ts`, lineNumber, language, provider: providerString }
  if (confidence) f.confidence = confidence
  return f
}

function cell(
  id: string,
  version: number,
  packages: string[],
  dialects: string[],
  highestStage: SupportStage,
): SupportCell {
  return {
    id,
    version,
    source: {
      provider: 'launchdarkly',
      sdk: { id, packages: packages.map((name) => ({ name, versionRange: '*' })) },
      language: { id: 'lang', dialects },
      runtimeFlavour: 'server',
    },
    openFeatureTarget: { standard: 'openfeature', sdkPackage: '@openfeature/server-sdk', runtimeFlavour: 'server' },
    capabilities: [highestStage],
    highestStage,
    limitations: [],
  }
}

function snapshot(cells: SupportCell[]) {
  return loadSupportSnapshot({
    schemaVersion: 1,
    generatedFrom: 'test',
    generatedAt: '2026-09-09',
    sourceRevision: 'deadbeef',
    sourceKind: 'test',
    cells,
  })
}

describe('summarizeLockIn — classification per occurrence', () => {
  it('draft-pr when the cell reaches verification or draft-pr', () => {
    const snap = snapshot([
      cell('ld/node', 1, ['@launchdarkly/node-server-sdk'], ['typescript'], 'verification'),
      cell('ld/legacy', 1, ['launchdarkly-node-server-sdk'], ['typescript'], 'draft-pr'),
    ])
    const summary = summarizeLockIn(
      [flag('a', '@launchdarkly/node-server-sdk'), flag('b', 'launchdarkly-node-server-sdk')],
      PROVIDERS,
      snap,
    )
    expect(summary.totals['draft-pr']).toBe(2)
    expect(summary.providers.map((p) => p.classification)).toEqual(['draft-pr', 'draft-pr'])
  })

  it('preview when the cell stops at preview', () => {
    const snap = snapshot([cell('ld/go', 1, ['github.com/launchdarkly/go-server-sdk'], ['go'], 'preview')])
    const summary = summarizeLockIn([flag('a', 'github.com/launchdarkly/go-server-sdk', 'go')], PROVIDERS, snap)
    expect(summary.totals.preview).toBe(1)
    expect(summary.providers[0]).toMatchObject({
      provider: 'LaunchDarkly Go SDK',
      classification: 'preview',
      cell: { id: 'ld/go', version: 1, highestStage: 'preview' },
    })
  })

  it('assessment when the cell stops at assessment or inventory', () => {
    const snap = snapshot([
      cell('ld/py', 1, ['ldclient'], ['python'], 'assessment'),
      cell('ld/rb', 1, ['launchdarkly-server-sdk'], ['ruby'], 'inventory'),
    ])
    const summary = summarizeLockIn(
      [flag('a', 'ldclient', 'python'), flag('b', 'launchdarkly-server-sdk', 'ruby')],
      PROVIDERS,
      snap,
    )
    expect(summary.totals.assessment).toBe(2)
  })

  it('detection-only when no cell matches the package', () => {
    const summary = summarizeLockIn([flag('a', 'posthog-js')], PROVIDERS, snapshot([]))
    expect(summary.totals['detection-only']).toBe(1)
    expect(summary.providers[0]).toMatchObject({
      provider: 'PostHog',
      packages: ['posthog-js'],
      cell: null,
      classification: 'detection-only',
    })
  })

  it('detection-only when the package matches but the dialect does not', () => {
    // Ruby, Python and Rust cells all name a `launchdarkly-server-sdk`
    // package; only the dialect separates them from the Ruby detector.
    const snap = snapshot([cell('ld/py', 1, ['launchdarkly-server-sdk'], ['python'], 'preview')])
    const summary = summarizeLockIn([flag('a', 'launchdarkly-server-sdk', 'ruby')], PROVIDERS, snap)
    expect(summary.totals['detection-only']).toBe(1)
    expect(summary.providers[0].cell).toBeNull()
  })

  it('matches a cell through an import alias', () => {
    const snap = snapshot([cell('ld/react', 1, ['@launchdarkly/react-sdk'], ['typescript'], 'assessment')])
    const summary = summarizeLockIn([flag('a', '@launchdarkly/react-client-sdk')], PROVIDERS, snap)
    expect(summary.providers[0].classification).toBe('assessment')
    expect(summary.providers[0].packages).toEqual([
      '@launchdarkly/react-client-sdk',
      'launchdarkly-react-client-sdk',
      '@launchdarkly/react-sdk',
    ])
  })

  it('takes the highest-version cell when several match', () => {
    const snap = snapshot([
      cell('ld/node', 3, ['@launchdarkly/node-server-sdk'], ['typescript'], 'preview'),
      cell('ld/node', 1, ['@launchdarkly/node-server-sdk'], ['typescript'], 'assessment'),
      cell('ld/node', 2, ['@launchdarkly/node-server-sdk'], ['typescript'], 'verification'),
    ])
    const summary = summarizeLockIn([flag('a', '@launchdarkly/node-server-sdk')], PROVIDERS, snap)
    expect(summary.providers[0].cell).toEqual({ id: 'ld/node', version: 3, highestStage: 'preview' })
    expect(summary.providers[0].classification).toBe('preview')
  })

  it('classifies the OpenFeature SDK family as already-openfeature, never lock-in', () => {
    const snap = snapshot([cell('of', 1, ['@openfeature/server-sdk'], ['typescript'], 'verification')])
    const summary = summarizeLockIn(
      [
        flag('a', '@openfeature/server-sdk'),
        flag('b', 'openfeature', 'python'),
        flag('c', 'dev.openfeature', 'java'),
      ],
      PROVIDERS,
      snap,
    )
    expect(summary.totals['already-openfeature']).toBe(3)
    for (const row of summary.providers) {
      expect(row.classification).toBe('already-openfeature')
      expect(row.cell).toBeNull()
    }
  })

  it('needs-review for medium or low confidence inside a cell', () => {
    const snap = snapshot([cell('ld/node', 2, ['@launchdarkly/node-server-sdk'], ['typescript'], 'verification')])
    const summary = summarizeLockIn(
      [
        flag('a', '@launchdarkly/node-server-sdk', 'typescript', 'medium'),
        flag('b', '@launchdarkly/node-server-sdk', 'typescript', 'low'),
      ],
      PROVIDERS,
      snap,
    )
    expect(summary.totals['needs-review']).toBe(2)
    expect(summary.totals['draft-pr']).toBe(0)
    expect(summary.providers[0]).toMatchObject({ classification: 'needs-review', needsReview: 2 })
  })

  it('a mixed row keeps the cell classification and counts the weaker detections', () => {
    const snap = snapshot([cell('ld/node', 2, ['@launchdarkly/node-server-sdk'], ['typescript'], 'verification')])
    const summary = summarizeLockIn(
      [
        flag('a', '@launchdarkly/node-server-sdk'),
        flag('b', '@launchdarkly/node-server-sdk', 'typescript', 'medium'),
      ],
      PROVIDERS,
      snap,
    )
    expect(summary.totals).toMatchObject({ 'draft-pr': 1, 'needs-review': 1 })
    expect(summary.providers[0]).toMatchObject({ classification: 'draft-pr', needsReview: 1, callSites: 2 })
  })

  it('weak detections outside every cell are detection-only (nothing a review could unlock)', () => {
    const summary = summarizeLockIn(
      [flag('a', 'posthog-js', 'typescript', 'medium'), flag('b', 'Custom struct-field detector', 'go', 'low')],
      PROVIDERS,
      snapshot([]),
    )
    expect(summary.totals['detection-only']).toBe(2)
    expect(summary.totals['needs-review']).toBe(0)
    // Config-file custom detectors are not registry providers: raw string, no packages.
    expect(summary.providers.find((p) => p.provider === 'Custom struct-field detector')).toMatchObject({
      packages: [],
      cell: null,
      classification: 'detection-only',
      needsReview: 1,
    })
  })

  it('resolves providers recorded by display name (no import pattern) and unknown strings', () => {
    const summary = summarizeLockIn(
      [flag('a', 'Custom Feature Flags'), flag('b', 'python-config', 'python'), { name: 'c', filePath: 'x', lineNumber: 1, language: 'go' }],
      PROVIDERS,
      snapshot([]),
    )
    expect(summary.providers.map((p) => p.provider).sort()).toEqual(['Custom Feature Flags', 'python-config', 'unknown'])
    expect(summary.totals['detection-only']).toBe(3)
  })
})

describe('summarizeLockIn — totals, counts and ordering', () => {
  it('counts call sites and unique flags overall and per provider, sorted by call sites desc then name', () => {
    const snap = snapshot([cell('ld/node', 2, ['@launchdarkly/node-server-sdk'], ['typescript', 'javascript'], 'verification')])
    const summary = summarizeLockIn(
      [
        flag('shared', '@launchdarkly/node-server-sdk', 'typescript', undefined, 1),
        flag('shared', '@launchdarkly/node-server-sdk', 'javascript', undefined, 2),
        flag('other', '@launchdarkly/node-server-sdk', 'typescript', undefined, 3),
        flag('shared', 'posthog-js'),
        flag('z', 'Custom Feature Flags'),
      ],
      PROVIDERS,
      snap,
    )
    expect(summary.schemaVersion).toBe(1)
    expect(summary.registry).toEqual({ sourceRevision: 'deadbeef', generatedAt: '2026-09-09' })
    expect(summary.callSites).toBe(5)
    expect(summary.uniqueFlags).toBe(3)
    expect(summary.totals).toEqual({
      'already-openfeature': 0,
      'needs-review': 0,
      'draft-pr': 3,
      'draft-pr-refused': 0,
      preview: 0,
      assessment: 0,
      'detection-only': 2,
    })
    expect(summary.providers.map((p) => [p.provider, p.callSites, p.uniqueFlags])).toEqual([
      ['LaunchDarkly Node Server SDK', 3, 2],
      ['Custom Feature Flags', 1, 1],
      ['PostHog', 1, 1],
    ])
    expect(summary.providers[0].languages).toEqual(['javascript', 'typescript'])
    const sum = Object.values(summary.totals).reduce((a, b) => a + b, 0)
    expect(sum).toBe(summary.callSites)
  })

  it('returns an empty summary for no flags', () => {
    const summary = summarizeLockIn([], PROVIDERS)
    expect(summary.callSites).toBe(0)
    expect(summary.uniqueFlags).toBe(0)
    expect(summary.providers).toEqual([])
    expect(Object.values(summary.totals).every((n) => n === 0)).toBe(true)
    expect(summary.registry.sourceRevision).toBe(SUPPORT_SNAPSHOT.sourceRevision)
  })

  it('tolerates the same provider definition registered by several detectors (first wins)', () => {
    const summary = summarizeLockIn(
      [flag('a', '@launchdarkly/node-server-sdk')],
      [...PROVIDERS, ...PROVIDERS],
      snapshot([]),
    )
    expect(summary.providers).toHaveLength(1)
    expect(summary.providers[0].provider).toBe('LaunchDarkly Node Server SDK')
  })

  it('uses the copied hosted snapshot by default', () => {
    const summary = summarizeLockIn([flag('a', '@launchdarkly/node-server-sdk')], PROVIDERS)
    expect(summary.providers[0].cell).toEqual({
      id: 'adopt-openfeature/launchdarkly-node-server/ecmascript/server',
      version: 2,
      highestStage: 'verification',
    })
    expect(summary.providers[0].classification).toBe('draft-pr')
  })
})

describe('LOCK_IN_LABELS', () => {
  it('covers every classification and never promises automation or speed', () => {
    for (const c of LOCK_IN_CLASSIFICATIONS) {
      expect(LOCK_IN_LABELS[c]).toBeTruthy()
      expect(LOCK_IN_LABELS[c]).not.toMatch(/automat|minute/i)
    }
    expect(LOCK_IN_LABELS['draft-pr']).toBe('may qualify for a hosted draft PR — the hosted planner decides')
    expect(LOCK_IN_LABELS['draft-pr-refused']).toBe('hosted draft PR refused by the local preflight — see gates')
    expect(LOCK_IN_LABELS.preview).toBe('preview only')
    expect(LOCK_IN_LABELS.assessment).toBe('assessment only')
    expect(LOCK_IN_LABELS['detection-only']).toBe('detection only (no migration cell)')
    expect(LOCK_IN_LABELS['needs-review']).toBe('needs review (weaker detection)')
  })

  it('never says "available": only the hosted planner decides a draft PR', () => {
    for (const c of LOCK_IN_CLASSIFICATIONS) expect(LOCK_IN_LABELS[c]).not.toMatch(/available/i)
    expect(LOCK_IN_CLASSIFICATIONS).toEqual(['draft-pr', 'draft-pr-refused', 'preview', 'assessment', 'needs-review', 'detection-only', 'already-openfeature'])
  })
})

describe('summarizeLockIn — hosted-admission preflight', () => {
  const REFUSING_TREE: AdmissionTreeView = {
    entries: [{ path: 'package.json', kind: 'file', size: 2 }],
    files: new Map([['package.json', '{}']]),
  }
  const ADMISSIBLE_TREE: AdmissionTreeView = {
    entries: [
      { path: 'package.json', kind: 'file', size: 1 },
      { path: 'package-lock.json', kind: 'file', size: 1 },
      { path: 'tsconfig.json', kind: 'file', size: 1 },
      { path: 'src/flags.ts', kind: 'file', size: 1 },
    ],
    files: new Map([
      ['package.json', JSON.stringify({ packageManager: 'npm@10.9.8', scripts: { typecheck: 'tsc --noEmit', test: 'node --test' }, dependencies: { '@launchdarkly/node-server-sdk': '^9.11.0' } })],
      ['package-lock.json', '{"lockfileVersion":3}'],
      ['tsconfig.json', '{}'],
      ['src/flags.ts', `import { init } from '@launchdarkly/node-server-sdk'\ninit('k').boolVariation('x', ctx, false)\n`],
    ]),
  }
  const CELL = SUPPORT_SNAPSHOT.cells.find((c) => c.id === NODE_SERVER_CELL_ID && c.version === 2)!

  it('turns draft-pr into draft-pr-refused when the local preflight refuses, and carries the gates', () => {
    const summary = summarizeLockIn(
      [flag('a', '@launchdarkly/node-server-sdk'), flag('b', 'launchdarkly-node-server-sdk', 'javascript')],
      PROVIDERS,
      SUPPORT_SNAPSHOT,
      REFUSING_TREE,
    )
    expect(summary.totals).toMatchObject({ 'draft-pr': 0, 'draft-pr-refused': 2 })
    expect(summary.providers.map((p) => p.classification)).toEqual(['draft-pr-refused', 'draft-pr-refused'])
    // Two providers share one cell: the preflight ran once.
    expect(summary.hostedAdmission).toHaveLength(1)
    expect(summary.hostedAdmission[0].cell).toEqual({ id: CELL.id, version: CELL.version, highestStage: CELL.highestStage })
    expect(summary.hostedAdmission[0].preflight.admissible).toBe(false)
    expect(summary.hostedAdmission[0].preflight.gates.filter((g) => g.status === 'refuse').map((g) => g.id)).toEqual([
      'npm-pin', 'launchdarkly-sdk', 'typecheck', 'test-script',
    ])
  })

  it('keeps draft-pr ("may qualify") when no local gate refuses, still reporting the unknown gates', () => {
    const summary = summarizeLockIn([flag('a', '@launchdarkly/node-server-sdk')], PROVIDERS, SUPPORT_SNAPSHOT, ADMISSIBLE_TREE)
    expect(summary.providers[0].classification).toBe('draft-pr')
    expect(summary.totals['draft-pr']).toBe(1)
    expect(summary.hostedAdmission[0].preflight.admissible).toBe(true)
    expect(summary.hostedAdmission[0].preflight.gates.some((g) => g.status === 'unknown')).toBe(true)
  })

  it('without a tree view nothing is checked: draft-pr stays and no preflight is reported', () => {
    const summary = summarizeLockIn([flag('a', '@launchdarkly/node-server-sdk')], PROVIDERS, SUPPORT_SNAPSHOT)
    expect(summary.providers[0].classification).toBe('draft-pr')
    expect(summary.hostedAdmission).toEqual([])
  })

  it('a draft-pr cell with no local preflight stays draft-pr even with a refusing tree', () => {
    const snap = snapshot([cell('ld/other', 1, ['@launchdarkly/node-server-sdk'], ['typescript'], 'draft-pr')])
    const summary = summarizeLockIn([flag('a', '@launchdarkly/node-server-sdk'), flag('b', '@launchdarkly/node-server-sdk')], PROVIDERS, snap, REFUSING_TREE)
    expect(summary.providers[0].classification).toBe('draft-pr')
    expect(summary.hostedAdmission).toEqual([])
  })

  it('weaker detections inside a refused cell are still needs-review, and preview cells are untouched', () => {
    const snap = snapshot([CELL, cell('ld/go', 1, ['github.com/launchdarkly/go-server-sdk'], ['go'], 'preview')])
    const summary = summarizeLockIn(
      [flag('a', '@launchdarkly/node-server-sdk', 'typescript', 'medium'), flag('b', 'github.com/launchdarkly/go-server-sdk', 'go')],
      PROVIDERS,
      snap,
      REFUSING_TREE,
    )
    expect(summary.totals).toMatchObject({ 'needs-review': 1, preview: 1, 'draft-pr-refused': 0 })
    expect(summary.hostedAdmission).toEqual([])
  })
})
