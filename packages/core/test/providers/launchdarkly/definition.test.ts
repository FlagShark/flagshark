import { describe, it, expect, vi, beforeEach } from 'vitest'
import { launchdarklyDefinition } from '../../../src/providers/launchdarkly/definition.js'
import * as clientModule from '../../../src/providers/launchdarkly/client.js'

describe('launchdarklyDefinition', () => {
  it('has correct metadata', () => {
    expect(launchdarklyDefinition.name).toBe('launchdarkly')
    expect(launchdarklyDefinition.displayName).toBe('LaunchDarkly')
    expect(launchdarklyDefinition.defaultTokenEnv).toBe('LAUNCHDARKLY_API_TOKEN')
  })

  it('configSchema validates a minimal valid config', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({
      project: 'my-project', environment: 'production',
    })
    expect(r.success).toBe(true)
  })

  it('configSchema rejects config missing project', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({ environment: 'production' })
    expect(r.success).toBe(false)
  })

  it('configSchema rejects config missing environment', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({ project: 'p' })
    expect(r.success).toBe(false)
  })

  it('configSchema accepts api_base override', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({
      project: 'p', environment: 'e', api_base: 'https://ld.example.com',
    })
    expect(r.success).toBe(true)
  })

  it('configSchema rejects non-URL api_base', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({
      project: 'p', environment: 'e', api_base: 'not-a-url',
    })
    expect(r.success).toBe(false)
  })

  it('configSchema accepts token_env override', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({
      project: 'p', environment: 'e', token_env: 'MY_LD_TOKEN',
    })
    expect(r.success).toBe(true)
  })

  it('createClient returns a PlatformClient with name + displayName', () => {
    const client = launchdarklyDefinition.createClient(
      { project: 'p', environment: 'e' },
      'tok',
    )
    expect(client.name).toBe('launchdarkly')
    expect(client.displayName).toBe('LaunchDarkly')
    expect(typeof client.listFlags).toBe('function')
  })

  it('createClient.listFlags delegates to fetchAllFlags with correct args', async () => {
    const spy = vi.spyOn(clientModule, 'fetchAllFlags').mockResolvedValueOnce([])
    const client = launchdarklyDefinition.createClient(
      { project: 'my-proj', environment: 'prod', api_base: 'https://ld.example.com' },
      'my-token',
    )
    const controller = new AbortController()
    await client.listFlags({ signal: controller.signal })
    expect(spy).toHaveBeenCalledWith(
      { project: 'my-proj', environment: 'prod', token: 'my-token' },
      { apiBase: 'https://ld.example.com', signal: controller.signal },
    )
    spy.mockRestore()
  })
})
