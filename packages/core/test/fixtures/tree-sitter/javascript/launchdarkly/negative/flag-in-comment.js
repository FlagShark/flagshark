const LaunchDarkly = require('launchdarkly-node-server-sdk')

const client = LaunchDarkly.init('sdk-key')

// client.variation('JS_FAKE_IN_COMMENT', user, false) — old approach
module.exports = client
