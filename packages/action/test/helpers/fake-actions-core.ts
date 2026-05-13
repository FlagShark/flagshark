/**
 * Hand-rolled fake of the @actions/core surface used by run(). Captures
 * inputs, outputs, summary content, and failure state for assertions.
 */

export interface SummaryTableCell { data: string; header?: boolean }
export type SummaryTableRow = Array<string | SummaryTableCell>

export interface FakeCoreState {
  inputs: Record<string, string>
  outputs: Record<string, string>
  warnings: string[]
  infos: string[]
  debugs: string[]
  errors: string[]
  failed: string | null
  summaryBlocks: Array<{ kind: 'heading' | 'raw' | 'table'; content: unknown }>
}

export interface FakeCore {
  state: FakeCoreState
  api: {
    getInput: (name: string) => string
    setOutput: (name: string, value: string) => void
    setFailed: (msg: string) => void
    info: (msg: string) => void
    warning: (msg: string) => void
    debug: (msg: string) => void
    error: (msg: string) => void
    summary: {
      addHeading: (text: string, level?: number) => FakeCore['api']['summary']
      addRaw: (raw: string) => FakeCore['api']['summary']
      addTable: (rows: SummaryTableRow[]) => FakeCore['api']['summary']
      write: () => Promise<void>
    }
  }
}

export function makeFakeCore(inputs: Record<string, string> = {}): FakeCore {
  const state: FakeCoreState = {
    inputs,
    outputs: {},
    warnings: [],
    infos: [],
    debugs: [],
    errors: [],
    failed: null,
    summaryBlocks: [],
  }

  const summary = {
    addHeading(text: string, _level?: number) { state.summaryBlocks.push({ kind: 'heading', content: text }); return summary },
    addRaw(raw: string) { state.summaryBlocks.push({ kind: 'raw', content: raw }); return summary },
    addTable(rows: SummaryTableRow[]) { state.summaryBlocks.push({ kind: 'table', content: rows }); return summary },
    async write() { /* no-op for tests */ },
  }

  return {
    state,
    api: {
      getInput: (name) => state.inputs[name] ?? '',
      setOutput: (name, value) => { state.outputs[name] = value },
      setFailed: (msg) => { state.failed = msg },
      info: (msg) => { state.infos.push(msg) },
      warning: (msg) => { state.warnings.push(msg) },
      debug: (msg) => { state.debugs.push(msg) },
      error: (msg) => { state.errors.push(msg) },
      summary,
    },
  }
}

/** Returns the entire summary content concatenated, for substring matching. */
export function summaryText(core: FakeCore): string {
  return core.state.summaryBlocks
    .map((b) => {
      if (b.kind === 'heading') return `# ${b.content as string}`
      if (b.kind === 'raw') return b.content as string
      const rows = b.content as SummaryTableRow[]
      return rows.map((row) =>
        row.map((cell) => typeof cell === 'string' ? cell : cell.data).join(' | '),
      ).join('\n')
    })
    .join('\n')
}
