import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

// TODO: enable client.variation('FAKE_IN_COMMENT', user, false) for next release
export const noop = () => null
