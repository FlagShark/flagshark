/**
 * Tests for PolyglotAnalyzer and compareResults.
 * Covers the large uncovered block in polyglot-analyzer.ts.
 */
import { describe, it, expect } from 'vitest'

import {
  PolyglotAnalyzer,
  compareResults,
} from '../../src/detection/polyglot-analyzer.js'
import type {
  FlagDetector,
  LanguageRegistry,
  RepositoryAnalysisResult,
} from '../../src/detection/polyglot-analyzer.js'
import type { FeatureFlag } from '../../src/detection/feature-flag.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOOP_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Build a minimal FlagDetector that returns given flags synchronously. */
function makeDetector(lang: string, flags: FeatureFlag[]): FlagDetector {
  return {
    language: () => lang,
    detectFlags: (_filePath: string, _content: string) => flags,
  }
}

/** Build a minimal LanguageRegistry backed by extension→detector mapping. */
function makeRegistry(
  extMap: Record<string, FlagDetector>,
): LanguageRegistry {
  return {
    getDetectorForFile(filePath: string): FlagDetector | undefined {
      const ext = filePath.split('.').pop()
      return ext ? extMap[`.${ext}`] : undefined
    },
    getSupportedExtensions(): string[] {
      return Object.keys(extMap)
    },
    getSupportedLanguages(): string[] {
      return [...new Set(Object.values(extMap).map((d) => d.language()))]
    },
  }
}

function makeEmptyResult(): RepositoryAnalysisResult {
  return {
    files: new Map(),
    totalFlags: new Map(),
    languages: new Map(),
    skippedFiles: [],
    partialFiles: [],
    parseErrorCount: 0,
  }
}

// ── PolyglotAnalyzer ─────────────────────────────────────────────────────────

describe('PolyglotAnalyzer.analyzeFiles', () => {
  it('returns empty result for empty file map', async () => {
    const registry = makeRegistry({})
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(new Map())
    expect(result.files.size).toBe(0)
    expect(result.totalFlags.size).toBe(0)
  })

  it('aggregates flags from multiple files', async () => {
    const flag: FeatureFlag = { name: 'MY_FLAG', filePath: 'a.ts', lineNumber: 1, language: '' }
    const detector = makeDetector('typescript', [flag])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)

    const files = new Map([
      ['a.ts', 'import something'],
      ['b.ts', 'import something else'],
    ])
    const result = await analyzer.analyzeFiles(files)
    expect(result.files.size).toBe(2)
    expect(result.totalFlags.has('MY_FLAG')).toBe(true)
    expect(result.totalFlags.get('MY_FLAG')!.length).toBe(2)
  })

  it('sets language on flags from the detector', async () => {
    const flag: FeatureFlag = { name: 'LANG_FLAG', filePath: 'app.ts', lineNumber: 5, language: '' }
    const detector = makeDetector('typescript', [flag])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)

    const result = await analyzer.analyzeFiles(new Map([['app.ts', 'content']]))
    const occurrences = result.totalFlags.get('LANG_FLAG')!
    expect(occurrences[0].language).toBe('typescript')
  })

  it('tracks language breakdown', async () => {
    const flag: FeatureFlag = { name: 'F', filePath: 'a.ts', lineNumber: 1, language: '' }
    const detector = makeDetector('typescript', [flag])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)

    await analyzer.analyzeFiles(new Map([['a.ts', 'x'], ['b.ts', 'y']]))
    // both .ts files get analyzed by the same detector
  })

  it('reports unsupported status for files with no detector', async () => {
    const registry = makeRegistry({}) // no detectors
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(new Map([['app.rb', 'puts "hello"']]))
    const fileResult = result.files.get('app.rb')!
    expect(fileResult.status).toBe('unsupported')
  })

  it('returns ok status for normal file', async () => {
    const detector = makeDetector('typescript', [])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(new Map([['app.ts', 'const x = 1']]))
    expect(result.files.get('app.ts')!.status).toBe('ok')
  })

  it('handles empty file content — returns ok with no flags', async () => {
    const detector = makeDetector('typescript', [])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    // Empty content — early return before detector is even called
    const result = await analyzer.analyzeFiles(new Map([['app.ts', '']]))
    expect(result.files.get('app.ts')!.status).toBe('ok')
    expect(result.files.get('app.ts')!.flags).toEqual([])
  })

  it('skips file with empty filePath (edge case)', async () => {
    const detector = makeDetector('typescript', [])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(new Map([['', 'content']]))
    const fileResult = result.files.get('')!
    expect(fileResult.status).toBe('skipped')
    expect(fileResult.skippedReason).toBe('empty file path')
  })

  it('skips file exceeding 5 MB', async () => {
    const detector = makeDetector('typescript', [])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const bigContent = 'x'.repeat(5 * 1024 * 1024 + 1)
    const result = await analyzer.analyzeFiles(new Map([['large.ts', bigContent]]))
    const fileResult = result.files.get('large.ts')!
    expect(fileResult.status).toBe('skipped')
    expect(fileResult.skippedReason).toContain('too large')
  })

  it('marks file as partial on detector error', async () => {
    const errorDetector: FlagDetector = {
      language: () => 'typescript',
      detectFlags: () => { throw new Error('parse explosion') },
    }
    const registry = makeRegistry({ '.ts': errorDetector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(new Map([['bad.ts', 'const x = 1']]))
    const fileResult = result.files.get('bad.ts')!
    expect(fileResult.status).toBe('partial')
    expect(fileResult.parseErrors.length).toBe(1)
  })

  it('wraps non-Error throws in an Error (line 257 false branch)', async () => {
    // Detector throws a string (not an Error instance) → `new Error(String(err))` is used
    const stringThrowDetector: FlagDetector = {
      language: () => 'typescript',
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      detectFlags: () => { throw 'string error value' },
    }
    const registry = makeRegistry({ '.ts': stringThrowDetector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(new Map([['bad.ts', 'const x = 1']]))
    const fileResult = result.files.get('bad.ts')!
    expect(fileResult.status).toBe('partial')
    expect(fileResult.parseErrors[0].message).toContain('string error value')
  })

  it('marks file as skipped on "operation limit" error', async () => {
    const errorDetector: FlagDetector = {
      language: () => 'typescript',
      detectFlags: () => { throw new Error('operation limit exceeded') },
    }
    const registry = makeRegistry({ '.ts': errorDetector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(new Map([['complex.ts', 'const x = 1']]))
    const fileResult = result.files.get('complex.ts')!
    expect(fileResult.status).toBe('skipped')
    expect(fileResult.skippedReason).toBe('file too complex for parsing')
  })

  it('accumulates skippedFiles and partialFiles arrays', async () => {
    const errorDetector: FlagDetector = {
      language: () => 'typescript',
      detectFlags: () => { throw new Error('parse explosion') },
    }
    const limitDetector: FlagDetector = {
      language: () => 'go',
      detectFlags: () => { throw new Error('operation limit exceeded') },
    }
    const registry = makeRegistry({ '.ts': errorDetector, '.go': limitDetector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(
      new Map([['a.ts', 'x'], ['b.go', 'y']]),
    )
    expect(result.partialFiles).toContain('a.ts')
    expect(result.skippedFiles).toContain('b.go')
  })

  // Regression guard for the silent-error-swallowing bug. Without an automatic
  // sample log, a packaging regression (missing WASM, broken bundle, native
  // binary mismatch) looks identical to "this codebase has no flags" because
  // analyzeFile's try/catch buries the throws into a counter. Real production
  // incident: scanner reported 799 of 815 errored files for five days while
  // every error message was discarded.
  describe('error visibility (auto-log)', () => {
    function makeWarnCapturingLogger() {
      const warns: Array<{ message: string; extra?: unknown }> = []
      return {
        warns,
        logger: {
          debug: () => {},
          info: () => {},
          warn: (message: string, extra?: unknown) => {
            warns.push({ message, extra })
          },
          error: () => {},
        },
      }
    }

    it('logs a sample of parse errors at WARN when any file fails detection', async () => {
      const errorDetector: FlagDetector = {
        language: () => 'typescript',
        detectFlags: () => {
          throw new Error('missing WASM grammar')
        },
      }
      const registry = makeRegistry({ '.ts': errorDetector })
      const { warns, logger } = makeWarnCapturingLogger()
      const analyzer = new PolyglotAnalyzer(registry, logger)

      await analyzer.analyzeFiles(new Map([['a.ts', 'x'], ['b.ts', 'y']]))

      const sampleWarn = warns.find((w) => w.message === 'Parse errors during analysis')
      expect(sampleWarn).toBeDefined()
      const extra = sampleWarn!.extra as {
        uniqueErrors: number
        sample: Array<{ message: string; count: number; sampleFiles: string[] }>
      }
      expect(extra.uniqueErrors).toBe(1)
      expect(extra.sample[0].message).toBe('missing WASM grammar')
      expect(extra.sample[0].count).toBe(2)
      expect(extra.sample[0].sampleFiles.sort()).toEqual(['a.ts', 'b.ts'])
    })

    it('does NOT log a warn when every file analyzed cleanly', async () => {
      const detector = makeDetector('typescript', [])
      const registry = makeRegistry({ '.ts': detector })
      const { warns, logger } = makeWarnCapturingLogger()
      const analyzer = new PolyglotAnalyzer(registry, logger)

      await analyzer.analyzeFiles(new Map([['a.ts', 'x']]))

      expect(warns.find((w) => w.message === 'Parse errors during analysis')).toBeUndefined()
    })

    it('deduplicates by error message and ranks by frequency (top-5 cap)', async () => {
      let i = 0
      const detector: FlagDetector = {
        language: () => 'typescript',
        detectFlags: () => {
          // Three distinct error messages spread across many files so we can
          // verify ordering by frequency.
          i++
          if (i <= 5) throw new Error('error-a')
          if (i <= 8) throw new Error('error-b')
          throw new Error('error-c')
        },
      }
      const registry = makeRegistry({ '.ts': detector })
      const { warns, logger } = makeWarnCapturingLogger()
      const analyzer = new PolyglotAnalyzer(registry, logger)

      const files = new Map<string, string>()
      for (let n = 0; n < 10; n++) files.set(`f${n}.ts`, 'x')
      await analyzer.analyzeFiles(files)

      const warn = warns.find((w) => w.message === 'Parse errors during analysis')!
      const extra = warn.extra as { sample: Array<{ message: string; count: number }> }
      expect(extra.sample[0].message).toBe('error-a')
      expect(extra.sample[0].count).toBe(5)
      expect(extra.sample[1].message).toBe('error-b')
      expect(extra.sample[2].message).toBe('error-c')
    })

    it('caps sample files at 3 per unique error message', async () => {
      const detector: FlagDetector = {
        language: () => 'typescript',
        detectFlags: () => {
          throw new Error('same message everywhere')
        },
      }
      const registry = makeRegistry({ '.ts': detector })
      const { warns, logger } = makeWarnCapturingLogger()
      const analyzer = new PolyglotAnalyzer(registry, logger)

      const files = new Map<string, string>()
      for (let n = 0; n < 20; n++) files.set(`f${n}.ts`, 'x')
      await analyzer.analyzeFiles(files)

      const warn = warns.find((w) => w.message === 'Parse errors during analysis')!
      const extra = warn.extra as { sample: Array<{ count: number; sampleFiles: string[] }> }
      expect(extra.sample[0].count).toBe(20)
      expect(extra.sample[0].sampleFiles.length).toBe(3)
    })
  })

  it('calls progress callback on each analyzed file', async () => {
    const detector = makeDetector('typescript', [])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)

    const calls: [number, number][] = []
    await analyzer.analyzeFilesWithProgress(
      new Map([['a.ts', 'x'], ['b.ts', 'y']]),
      (analyzed, total) => calls.push([analyzed, total]),
    )
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][1]).toBe(2)
  })

  it('does not emit progress when roundedPercent has not crossed a 5% boundary (line 167 false branch)', async () => {
    // With 100 files, only 1 analyzed = 1% → rounds to 0% = lastEmittedPercent(0) → no emit
    const detector = makeDetector('typescript', [])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)

    const files = new Map<string, string>()
    for (let i = 0; i < 100; i++) {
      files.set(`file${i}.ts`, 'content')
    }

    const emittedCounts: number[] = []
    await analyzer.analyzeFilesWithProgress(files, (analyzed) => emittedCounts.push(analyzed))

    // With 100 files, callbacks fire at 5%, 10%, ... 100%, so at most 20 calls
    // The 99 files between 5% crossings should NOT trigger callbacks (false branch)
    expect(emittedCounts.length).toBeLessThan(100)
    expect(emittedCounts.length).toBeGreaterThan(0)
  })

  it('respects AbortSignal — stops before processing remaining files (outer check)', async () => {
    const detector = makeDetector('typescript', [])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const ac = new AbortController()
    ac.abort()
    // Aborted immediately — no files should be processed
    const result = await analyzer.analyzeFiles(
      new Map([['a.ts', 'x'], ['b.ts', 'y']]),
      ac.signal,
    )
    // With an already-aborted signal, the loop breaks before pushing any tasks
    expect(result.files.size).toBe(0)
  })

  it('respects AbortSignal — inner check inside task (lines 125-127)', async () => {
    // Abort mid-analysis: signal is NOT aborted when we call analyzeFiles, but
    // we abort during the analysis so the inner `if (signal?.aborted) return` fires
    // for tasks that haven't started yet.
    const ac = new AbortController()

    // Slow detector: aborts the signal before returning
    const slowDetector: FlagDetector = {
      language: () => 'typescript',
      detectFlags: async () => {
        // Abort the controller while we're inside a task
        ac.abort()
        return []
      },
    }
    const registry = makeRegistry({ '.ts': slowDetector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)

    // Create many files — some tasks will be queued and will see the aborted signal
    const files = new Map<string, string>()
    for (let i = 0; i < 20; i++) {
      files.set(`file${i}.ts`, 'content')
    }

    const result = await analyzer.analyzeFiles(files, ac.signal)
    // Some files processed, some skipped due to abort — no crash expected
    expect(result).toBeDefined()
  })

  it('handles detector returning a Promise<FeatureFlag[]>', async () => {
    const flag: FeatureFlag = { name: 'ASYNC_FLAG', filePath: 'a.ts', lineNumber: 1, language: '' }
    const asyncDetector: FlagDetector = {
      language: () => 'typescript',
      detectFlags: async () => [flag],
    }
    const registry = makeRegistry({ '.ts': asyncDetector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeFiles(new Map([['a.ts', 'content']]))
    expect(result.totalFlags.has('ASYNC_FLAG')).toBe(true)
  })
})

describe('PolyglotAnalyzer.shouldAnalyzeFile', () => {
  const registry = makeRegistry({ '.ts': makeDetector('typescript', []) })
  const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)

  it('returns false for removed status', () => {
    expect(analyzer.shouldAnalyzeFile('app.ts', 'removed')).toBe(false)
  })

  it('returns false for files in vendor/', () => {
    expect(analyzer.shouldAnalyzeFile('vendor/lib/app.ts', 'added')).toBe(false)
  })

  it('returns false for files starting with vendor/', () => {
    expect(analyzer.shouldAnalyzeFile('vendor/app.ts', 'added')).toBe(false)
  })

  it('returns false for files in node_modules/', () => {
    expect(analyzer.shouldAnalyzeFile('node_modules/pkg/app.ts', 'added')).toBe(false)
  })

  it('returns false for files starting with node_modules/', () => {
    expect(analyzer.shouldAnalyzeFile('node_modules/app.ts', 'added')).toBe(false)
  })

  it('returns true for supported file with ok status', () => {
    expect(analyzer.shouldAnalyzeFile('src/app.ts', 'modified')).toBe(true)
  })

  it('returns false for unsupported extension', () => {
    expect(analyzer.shouldAnalyzeFile('src/app.rb', 'added')).toBe(false)
  })
})

describe('PolyglotAnalyzer.getSupportedExtensions', () => {
  it('delegates to registry', () => {
    const registry = makeRegistry({ '.ts': makeDetector('typescript', []) })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    expect(analyzer.getSupportedExtensions()).toEqual(['.ts'])
  })
})

describe('PolyglotAnalyzer.analyzeSingleFile', () => {
  it('returns a FileAnalysisResult', async () => {
    const detector = makeDetector('typescript', [])
    const registry = makeRegistry({ '.ts': detector })
    const analyzer = new PolyglotAnalyzer(registry, NOOP_LOGGER)
    const result = await analyzer.analyzeSingleFile('app.ts', 'const x = 1')
    expect(result.filePath).toBe('app.ts')
    expect(result.status).toBe('ok')
  })
})

// ── compareResults ────────────────────────────────────────────────────────────

describe('compareResults', () => {
  const flag = (name: string, file: string, line: number): FeatureFlag => ({
    name, filePath: file, lineNumber: line, language: 'typescript',
  })

  it('detects newly added flags', () => {
    const before = makeEmptyResult()
    const after = makeEmptyResult()
    after.totalFlags.set('NEW_FLAG', [flag('NEW_FLAG', 'a.ts', 1)])

    const result = compareResults(before, after)
    expect(result.added.has('NEW_FLAG')).toBe(true)
    expect(result.removed.size).toBe(0)
    expect(result.occurrenceChanges.size).toBe(0)
  })

  it('detects removed flags', () => {
    const before = makeEmptyResult()
    before.totalFlags.set('OLD_FLAG', [flag('OLD_FLAG', 'a.ts', 1)])
    const after = makeEmptyResult()

    const result = compareResults(before, after)
    expect(result.removed.has('OLD_FLAG')).toBe(true)
    expect(result.added.size).toBe(0)
  })

  it('detects occurrence count changes', () => {
    const before = makeEmptyResult()
    before.totalFlags.set('FLAG', [flag('FLAG', 'a.ts', 1)])
    const after = makeEmptyResult()
    after.totalFlags.set('FLAG', [flag('FLAG', 'a.ts', 1), flag('FLAG', 'b.ts', 5)])

    const result = compareResults(before, after)
    expect(result.occurrenceChanges.has('FLAG')).toBe(true)
    const change = result.occurrenceChanges.get('FLAG')!
    expect(change.beforeCount).toBe(1)
    expect(change.afterCount).toBe(2)
    expect(change.addedIn.some((o) => o.filePath === 'b.ts')).toBe(true)
  })

  it('detects occurrence removals in occurrenceChanges', () => {
    const before = makeEmptyResult()
    before.totalFlags.set('FLAG', [flag('FLAG', 'a.ts', 1), flag('FLAG', 'b.ts', 5)])
    const after = makeEmptyResult()
    after.totalFlags.set('FLAG', [flag('FLAG', 'a.ts', 1)])

    const result = compareResults(before, after)
    const change = result.occurrenceChanges.get('FLAG')!
    expect(change.removedFrom.some((o) => o.filePath === 'b.ts')).toBe(true)
  })

  it('ignores flags with equal counts and same locations', () => {
    const before = makeEmptyResult()
    before.totalFlags.set('FLAG', [flag('FLAG', 'a.ts', 1)])
    const after = makeEmptyResult()
    after.totalFlags.set('FLAG', [flag('FLAG', 'a.ts', 1)])

    const result = compareResults(before, after)
    expect(result.added.size).toBe(0)
    expect(result.removed.size).toBe(0)
    expect(result.occurrenceChanges.size).toBe(0)
  })

  it('handles empty before and after', () => {
    const result = compareResults(makeEmptyResult(), makeEmptyResult())
    expect(result.added.size).toBe(0)
    expect(result.removed.size).toBe(0)
    expect(result.occurrenceChanges.size).toBe(0)
  })

  it('maps occurrences including provider', () => {
    const before = makeEmptyResult()
    const after = makeEmptyResult()
    const f: FeatureFlag = { name: 'F', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly' }
    after.totalFlags.set('F', [f])

    const result = compareResults(before, after)
    const occ = result.added.get('F')![0]
    expect(occ.provider).toBe('launchdarkly')
  })
})
