import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const FLAG_NAME = 'CONST_EXTRACTED_FLAG'
const client = LaunchDarkly.init('sdk-key')

export async function extracted(user: { key: string }) {
  return client.variation(FLAG_NAME, user, false)
}
