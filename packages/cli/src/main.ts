#!/usr/bin/env node
import { runCli } from './cli.js'

/* v8 ignore start — thin process-entry shim, exercised only by the binary */
runCli(process.argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
})
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`[error] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  })
/* v8 ignore stop */
