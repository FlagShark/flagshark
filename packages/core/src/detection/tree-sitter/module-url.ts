import { pathToFileURL } from 'node:url'

/**
 * @internal Resolve the URL of the current module, working under both ESM
 * (`import.meta.url` defined) and CJS (`__filename` defined, e.g. esbuild's
 * ESM->CJS output which stubs `import.meta` to `{}`).
 *
 * Returns `undefined` when neither base is available -- typically a non-Node
 * bundle target (edge runtime, browser). Callers should map that to an
 * actionable error pointing at whatever environment-variable escape hatch
 * they expose (`FLAGSHARK_WASM_DIR` for grammars, etc.).
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

/**
 * @internal As `tryGetModuleUrl` but throws a caller-provided error when
 * neither base is available. Splitting the throw out of inline call-site code
 * makes the failure path unit-testable without having to mock `import.meta`
 * or `__filename` -- both of which are deeply baked into the JS runtime and
 * effectively impossible to stub in a vitest ESM context.
 */
export function getModuleUrl(
  metaUrl: unknown,
  filename: unknown,
  errorFactory: () => Error,
): string {
  const url = tryGetModuleUrl(metaUrl, filename)
  if (!url) throw errorFactory()
  return url
}
