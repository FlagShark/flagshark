import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

// Unrelated method on an unrelated object — shouldn't match.
const db = { execute: (s: string) => s, variation: (s: string) => s }
export const x = db.execute('SELECT * FROM users')
export const y = db.variation('schema_v2')  // db is not an LD client, but our engine WILL flag this
                                              // because the engine treats any .variation call as a candidate.
                                              // Documented limitation — covered in spec §10 open question 4.
