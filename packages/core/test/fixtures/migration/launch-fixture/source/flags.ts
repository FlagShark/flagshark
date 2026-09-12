import * as ld from '@launchdarkly/node-server-sdk'

const CHECKOUT_KEY = 'checkout-v2'
const client = ld.init('fixture-offline-no-credentials', { offline: true, sendEvents: false })

export async function initialize(): Promise<void> {
  await client.waitForInitialization()
}

export async function checkout(): Promise<string> {
  if (
    await client.boolVariation(CHECKOUT_KEY, { key: 'customer-1', custom: { plan: 'pro' } }, false)
  ) {
    return 'new-checkout'
  }
  return 'classic-checkout'
}

export async function search(): Promise<string> {
  if (
    await client.boolVariation(
      'search-v2',
      { key: 'customer-2', custom: { plan: 'starter' } },
      true,
    )
  ) {
    return 'new-search'
  }
  return 'classic-search'
}

export async function emergencyStop(): Promise<boolean> {
  return await client.boolVariation('emergency-stop', { key: 'operator-1' }, false)
}

export async function shutdown(): Promise<void> {
  await client.close()
}
