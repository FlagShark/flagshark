import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

export async function commented(user: { key: string }) {
  return client.variation(/* important: */ 'COMMENT_MID_FLAG', user, false)
}
