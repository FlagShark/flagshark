// No LaunchDarkly import — should NOT be detected even though it looks like a call.

export function fake(client: { variation: (name: string) => boolean }) {
  return client.variation('NO_IMPORT_FLAG')
}
