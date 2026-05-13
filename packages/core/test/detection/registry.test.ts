import { describe, it, expect, beforeEach } from 'vitest'

import {
  LanguageRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
} from '../../src/detection/registry.js'
import { JavaDetector } from '../../src/detection/detectors/java.js'
import { GoDetector } from '../../src/detection/detectors/go.js'

describe('LanguageRegistry', () => {
  it('register + getDetector roundtrip', () => {
    const reg = new LanguageRegistry()
    const java = new JavaDetector()
    reg.register(java)
    expect(reg.getDetector('java')).toBe(java)
  })

  it('throws when registering the same language twice', () => {
    const reg = new LanguageRegistry()
    reg.register(new JavaDetector())
    expect(() => reg.register(new JavaDetector())).toThrow(/already registered/)
  })

  it('getDetector returns undefined for unregistered language', () => {
    const reg = new LanguageRegistry()
    expect(reg.getDetector('go')).toBeUndefined()
  })

  it('getDetectorForFile returns the matching detector by extension', () => {
    const reg = new LanguageRegistry()
    const go = new GoDetector()
    reg.register(go)
    expect(reg.getDetectorForFile('main.go')).toBe(go)
  })

  it('getDetectorForFile returns undefined when no detector matches', () => {
    const reg = new LanguageRegistry()
    reg.register(new GoDetector())
    expect(reg.getDetectorForFile('foo.unknownext')).toBeUndefined()
  })

  it('detectInFile returns null when no detector matches', () => {
    const reg = new LanguageRegistry()
    expect(reg.detectInFile('foo.unknown', 'x')).toBeNull()
  })

  it('detectInFile delegates to the detector when one matches', () => {
    const reg = new LanguageRegistry()
    reg.register(new JavaDetector())
    const out = reg.detectInFile('Foo.java', '')
    expect(out).toEqual([])
  })

  it('getSupportedLanguages returns registered languages', () => {
    const reg = new LanguageRegistry()
    reg.register(new GoDetector())
    reg.register(new JavaDetector())
    const langs = reg.getSupportedLanguages().sort()
    expect(langs).toEqual(['go', 'java'])
  })

  it('getSupportedExtensions returns deduplicated extensions', () => {
    const reg = new LanguageRegistry()
    reg.register(new GoDetector())
    expect(reg.getSupportedExtensions()).toContain('.go')
  })
})

describe('getDefaultRegistry / resetDefaultRegistry', () => {
  beforeEach(() => resetDefaultRegistry())

  it('returns the same instance across calls until reset', () => {
    const a = getDefaultRegistry()
    const b = getDefaultRegistry()
    expect(a).toBe(b)
  })

  it('returns a fresh instance after reset', () => {
    const a = getDefaultRegistry()
    resetDefaultRegistry()
    const b = getDefaultRegistry()
    expect(a).not.toBe(b)
  })
})
