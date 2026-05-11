import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

export async function checkout(user: { key: string }) {
  if (await client.variation('CHECKOUT_V2', user, false)) {
    return 'v2'
  }
  return 'v1'
}
