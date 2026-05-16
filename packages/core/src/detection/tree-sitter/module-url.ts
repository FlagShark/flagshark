import { pathToFileURL } from 'node:url'

/**
 * @internal Resolve the URL of the current module, working under both ESM
 * (`import.meta.url` defined) and CJS (`__filename` defined, e.g. esbuild's
 * ESM->CJS output which stubs `import.meta` to `{}`).
 *
 * Returns `undefined` when neither base is available -- typically a non-Node
 * bundle target (edge runtime, browser). Callers should map that to an
 * actionable error pointing at whatever environment-variable escape hatch
 * they expose (`FLAGSHARK_WASM_DIR` for grammars, `FLAGSHARK_QUERIES_DIR` for
 * queries, etc.).
 *
 * Centralised here so the runtime-shape selection has one definition. Earlier
 * versions of the package duplicated this logic across parser-cache and
 * query-runner; the duplicate hid an entire copy of the same bug, which is
 * how the post-1.3.x scan regression went undiagnosed.
 */
export function tryGetModuleUrl(
  metaUrl: unknown,
  filename: unknown,
): string | undefined {
  if (typeof metaUrl === 'string' && metaUrl.length > 0) return metaUrl
  if (typeof filename === 'string' && filename.length > 0) {
    return pathToFileURL(filename).href
  }
  return undefined
}
