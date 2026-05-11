const LaunchDarkly = require('launchdarkly-node-server-sdk')

const client = LaunchDarkly.init('sdk-key')

async function multi(user) {
  return await client.variation(
    'JS_MULTI_LINE',
    user,
    false,
  )
}
