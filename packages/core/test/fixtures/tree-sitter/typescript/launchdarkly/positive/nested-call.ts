import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

export async function nested(user: { key: string }) {
  if (await client.boolVariation('NESTED_FLAG', user, false)) {
    console.log('on')
  }
}
