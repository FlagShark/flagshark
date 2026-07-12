/** GitHub Action process entrypoint for the private migration assessment. */
import * as core from '@actions/core'
import * as github from '@actions/github'

import { runAssessmentAction } from './assess-run.js'

/* v8 ignore start — thin process-entry shim, exercised by the Action runner */
void runAssessmentAction({ core, github, cwd: process.cwd() })
/* v8 ignore stop */
