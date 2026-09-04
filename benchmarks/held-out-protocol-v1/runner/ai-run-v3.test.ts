import { expect, test } from 'bun:test'

function parseEnvelope(rawResponse: string) {
  try {
    const parsed = JSON.parse(rawResponse)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false as const, flags: [], abstentions: ['response must be an object'] }
    if (typeof (parsed as any).task_id !== 'string') return { ok: false as const, flags: [], abstentions: ['missing task_id'] }
    if (typeof (parsed as any).runner !== 'string') return { ok: false as const, flags: [], abstentions: ['missing runner'] }
    if (typeof (parsed as any).provider !== 'string') return { ok: false as const, flags: [], abstentions: ['missing provider'] }
    if (typeof (parsed as any).model !== 'string') return { ok: false as const, flags: [], abstentions: ['missing model'] }
    if (typeof (parsed as any).model_version !== 'string') return { ok: false as const, flags: [], abstentions: ['missing model_version'] }
    if (!Array.isArray((parsed as any).predicted_flags)) return { ok: false as const, flags: [], abstentions: ['missing predicted_flags'] }
    for (const flag of (parsed as any).predicted_flags) {
      if (typeof flag !== 'object' || flag === null || Array.isArray(flag)) return { ok: false as const, flags: [], abstentions: ['predicted_flags entry must be object'] }
      if (typeof flag.name !== 'string' || typeof flag.location !== 'string' || typeof flag.classification !== 'string') return { ok: false as const, flags: [], abstentions: ['predicted_flags fields invalid'] }
      if (!Array.isArray(flag.evidence_citations)) return { ok: false as const, flags: [], abstentions: ['predicted_flags evidence_citations invalid'] }
    }
    if (typeof (parsed as any).predicted_provider_state !== 'object' || (parsed as any).predicted_provider_state === null || Array.isArray((parsed as any).predicted_provider_state)) return { ok: false as const, flags: [], abstentions: ['missing predicted_provider_state'] }
    return { ok: true as const, flags: (parsed as any).predicted_flags, abstentions: Array.isArray((parsed as any).abstentions) ? (parsed as any).abstentions : [] }
  } catch {
    return { ok: false as const, flags: [], abstentions: ['non-json response'] }
  }
}

test('accepts canned valid envelope and preserves fields', () => {
  const parsed = parseEnvelope(JSON.stringify({
    task_id: 't1', runner: 'r1', provider: 'openai-codex', model: 'gpt-5.6-luna', model_version: 'gpt-5.6-luna',
    raw_response_id: 'resp_1', raw_response_api: 'openai-codex-responses', runtime_seconds: 1,
    token_usage: { input: 1, output: 2, totalTokens: 3 }, validation_commands: ['cmd'], validation_results: ['ok'],
    predicted_flags: [{ name: 'flag', location: 'a.rb:1-2', classification: 'safe', evidence_citations: ['e1'] }],
    predicted_provider_state: { task_partition: 'dev', source: 'msr-strudel-2020', source_revision: 'rev', repo_snapshot_id: 'snap', model: 'gpt-5.6-luna', provider: 'openai-codex', model_version: 'gpt-5.6-luna', prompt_hash: 'h', source_manifest: 'm', source_root: 's' },
    evidence_citations: ['e1'], abstentions: []
  }))
  expect(parsed.ok).toBe(true)
  expect(parsed.flags).toHaveLength(1)
})

test('fails closed on malformed or abstention-like envelope', () => {
  const parsed = parseEnvelope('{"task_id":"t1","runner":"r1","provider":"openai-codex","model":"gpt-5.6-luna","model_version":"gpt-5.6-luna","predicted_flags":[],"predicted_provider_state":null}')
  expect(parsed.ok).toBe(false)
  expect(parsed.flags).toEqual([])
  expect(parsed.abstentions.length).toBeGreaterThan(0)
})
