/**
 * GitHub Action entry point. Sets WASM/queries env paths before importing
 * core, then delegates to run().
 */

declare const __dirname: string
import { join } from 'node:path'
process.env.FLAGSHARK_WASM_DIR = join(__dirname, 'grammars')
process.env.FLAGSHARK_QUERIES_DIR = join(__dirname, 'queries')

import * as core from '@actions/core'
import * as github from '@actions/github'
import { run } from './run.js'

/* v8 ignore start — thin process-entry shim, exercised by the action runner */
run({ core, github, cwd: process.cwd() })
/* v8 ignore stop */
