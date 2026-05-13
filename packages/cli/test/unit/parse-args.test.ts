import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../src/cli.js'

function args(...flags: string[]) {
  return parseArgs(['node', 'cli', ...flags])
}

describe('parseArgs', () => {
  it('defaults', () => {
    const a = args()
    expect(a.format).toBe('text')
    expect(a.json).toBe(false)
    expect(a.diff).toBe(null)
    expect(a.threshold).toBeUndefined()
    expect(a.verbose).toBe(false)
    expect(a.help).toBe(false)
    expect(a.version).toBe(false)
  })

  it('--json sets format to json and json flag true', () => {
    const a = args('--json')
    expect(a.json).toBe(true)
    expect(a.format).toBe('json')
  })

  it.each([
    ['text'], ['json'], ['markdown'], ['csv'], ['sarif'],
  ])('--format %s', (fmt) => {
    expect(args('--format', fmt).format).toBe(fmt)
  })

  it('--format=json supports equals form', () => {
    expect(args('--format=json').format).toBe('json')
  })

  it('--format bogus throws', () => {
    expect(() => args('--format', 'bogus')).toThrow(/--format must be one of/)
  })

  it('--output captures path', () => {
    expect(args('--output', '/tmp/out.json').output).toBe('/tmp/out.json')
  })

  it('-o is an alias for --output', () => {
    expect(args('-o', '/tmp/out.json').output).toBe('/tmp/out.json')
  })

  it('--diff captures ref', () => {
    expect(args('--diff', 'HEAD~1').diff).toBe('HEAD~1')
  })

  it('--diff without value throws', () => {
    expect(() => args('--diff')).toThrow(/--diff requires/)
  })

  it('--threshold accepts positive integer', () => {
    expect(args('--threshold', '12').threshold).toBe(12)
  })

  it('--threshold rejects zero', () => {
    expect(() => args('--threshold', '0')).toThrow(/positive integer/)
  })

  it('--threshold rejects non-numeric', () => {
    expect(() => args('--threshold', 'abc')).toThrow(/positive integer/)
  })

  it('--verbose', () => {
    expect(args('--verbose').verbose).toBe(true)
  })

  it('--help and -h', () => {
    expect(args('--help').help).toBe(true)
    expect(args('-h').help).toBe(true)
  })

  it('--version and -v', () => {
    expect(args('--version').version).toBe(true)
    expect(args('-v').version).toBe(true)
  })

  it('--engine accepts regex|tree-sitter', () => {
    expect(args('--engine', 'regex').engine).toBe('regex')
    expect(args('--engine', 'tree-sitter').engine).toBe('tree-sitter')
  })

  it('--engine bogus throws', () => {
    expect(() => args('--engine', 'bogus')).toThrow(/--engine must be/)
  })

  it('--config requires path', () => {
    expect(args('--config', './x.yml').configPath).toBe('./x.yml')
    expect(() => args('--config')).toThrow(/--config requires/)
  })

  it('--no-config, --no-ignore-file, --show-excluded', () => {
    const a = args('--no-config', '--no-ignore-file', '--show-excluded')
    expect(a.noConfig).toBe(true)
    expect(a.noIgnoreFile).toBe(true)
    expect(a.showExcluded).toBe(true)
  })

  it('scan subcommand is a no-op', () => {
    expect(args('scan').format).toBe('text')
  })

  it('unknown flag throws', () => {
    expect(() => args('--bogus')).toThrow(/Unknown option/)
  })
})

describe('parseArgs — platform integration flags', () => {
  function args(...flags: string[]) {
    return parseArgs(['node', 'cli', ...flags])
  }

  it('--no-cache sets noCache true', () => {
    expect(args('--no-cache').noCache).toBe(true)
  })

  it('--no-cache is false by default', () => {
    expect(args().noCache).toBeFalsy()
  })

  it('--fail-on-error true is the default', () => {
    expect(args().failOnError).toBe(true)
  })

  it('--no-fail-on-error sets failOnError false', () => {
    expect(args('--no-fail-on-error').failOnError).toBe(false)
  })

  it('--fail-on-error explicitly sets failOnError true', () => {
    expect(args('--fail-on-error').failOnError).toBe(true)
  })
})
