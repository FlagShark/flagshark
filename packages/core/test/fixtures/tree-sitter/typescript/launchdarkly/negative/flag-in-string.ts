import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

export function error() {
  throw new Error("client.variation('FAKE_IN_STRING', user, false) is disabled")
}
