const LaunchDarkly = require('launchdarkly-node-server-sdk')

const client = LaunchDarkly.init('sdk-key')

async function checkout(user) {
  if (await client.variation('JS_CHECKOUT_V2', user, false)) {
    return 'v2'
  }
  return 'v1'
}

module.exports = { checkout }
