import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

export async function multi(user: { key: string }) {
  const result = await client.variation(
    'MULTI_LINE_FLAG',
    user,
    false,
  )
  return result
}
