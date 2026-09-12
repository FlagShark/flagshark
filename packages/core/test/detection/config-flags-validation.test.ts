import { describe, expect, it } from 'vitest'

import { detectConfigFlags } from '../../src/detection/helpers.js'

describe('detectConfigFlags key validation', () => {
  it('drops config keys that fail isValidFlagKey (over 256 characters)', () => {
    const longKey = 'a'.repeat(300)
    const content = `FLAGS = {\n  ${longKey}: true,\n  short_flag: false,\n}.freeze\n`
    const flags = detectConfigFlags('config/flags.rb', content, 'ruby')
    expect(flags.map((f) => f.name)).toEqual(['short_flag'])
    expect(flags[0]?.lineNumber).toBe(1)
    expect(flags[0]?.provider).toBe('ruby-config')
  })

  it('reports the line of each python config assignment', () => {
    const content = `import x\n\nFEATURE_FLAG_ALPHA = enabled_since("2024-01-01")\nfeatures["beta"] = api.portal.get_registry_record(\n`
    const flags = detectConfigFlags('settings.py', content, 'python')
    expect(flags.map((f) => [f.name, f.lineNumber])).toEqual([
      ['FEATURE_FLAG_ALPHA', 3],
      ['beta', 4],
    ])
  })
})
