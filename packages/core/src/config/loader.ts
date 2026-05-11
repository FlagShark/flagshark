import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parse as parseYaml, YAMLParseError } from 'yaml'

import { FlagsharkConfigSchema, type FlagsharkConfig } from './schema.js'

const FILENAMES = ['.flagshark.yml', '.flagshark.yaml']

export interface LoadedConfig {
  config: FlagsharkConfig
  path: string
}

export async function loadConfigFile(startDir: string): Promise<LoadedConfig | null> {
  const home = homedir()
  let dir = resolve(startDir)

  for (;;) {
    for (const name of FILENAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) {
        return readAndValidate(candidate)
      }
    }
    const parent = dirname(dir)
    if (parent === dir || dir === home || dir === '/') return null
    dir = parent
  }
}

function readAndValidate(path: string): LoadedConfig {
  const raw = readFileSync(path, 'utf-8')

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new Error(`Invalid YAML in ${path}: ${err.message}`)
    }
    throw err
  }

  if (parsed == null || typeof parsed !== 'object') {
    return { config: FlagsharkConfigSchema.parse({}), path }
  }

  const result = FlagsharkConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid .flagshark.yml at ${path}: ${issues}`)
  }
  return { config: result.data, path }
}
