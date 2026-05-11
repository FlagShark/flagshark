import type { Language } from '../interface.js'

import { loadQueryText } from './query-runner.js'

export function buildMethodCallQuery(lang: Language): string {
  // Today: just return the static query for the language.
  // Future: synthesize per-method-set queries when we want predicate filtering inside the .scm.
  return loadQueryText(lang)
}
