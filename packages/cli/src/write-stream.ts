/**
 * Resolve only when Node has accepted and flushed the chunk through the
 * writable's callback. This makes runCli's completion meaningful even when
 * stdout is a backpressured pipe.
 */
export function writeStream(
  stream: NodeJS.WritableStream,
  chunk: string | Uint8Array,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      // A Node writable may invoke the write callback with an error immediately
      // before emitting `error`; keep the one-shot listener through this turn.
      queueMicrotask(() => stream.removeListener('error', onError))
      if (error) reject(error)
      else resolve()
    }
    const onError = (error: Error) => finish(error)
    stream.once('error', onError)
    try {
      stream.write(chunk, finish)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
