#!/usr/bin/env node
import { runCli } from './cli.js'
import { writeStream } from './write-stream.js'

/* v8 ignore start — thin process-entry shim, exercised only by the binary */
runCli(process.argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
})
  .then((code) => {
    process.exitCode = code
  })
  .catch(async (err: unknown) => {
    const message = `[error] ${err instanceof Error ? err.message : String(err)}\n`
    process.exitCode = 2
    await writeStream(process.stderr, message).catch(() => undefined)
  })
/* v8 ignore stop */
