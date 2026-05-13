import { describe, it, expect } from 'vitest'
import { makeFakeCore, summaryText } from './fake-actions-core.js'

describe('fake-actions-core', () => {
  it('captures inputs and outputs', () => {
    const core = makeFakeCore({ scan: 'full', threshold: '6' })
    expect(core.api.getInput('scan')).toBe('full')
    expect(core.api.getInput('missing')).toBe('')
    core.api.setOutput('health-score', '92')
    expect(core.state.outputs['health-score']).toBe('92')
  })

  it('captures warnings, infos, failures', () => {
    const core = makeFakeCore()
    core.api.warning('w')
    core.api.info('i')
    core.api.setFailed('boom')
    expect(core.state.warnings).toEqual(['w'])
    expect(core.state.infos).toEqual(['i'])
    expect(core.state.failed).toBe('boom')
  })

  it('summaryText concatenates blocks', () => {
    const core = makeFakeCore()
    core.api.summary.addHeading('h').addRaw('r').addTable([['a', 'b']])
    expect(summaryText(core)).toContain('# h')
    expect(summaryText(core)).toContain('r')
    expect(summaryText(core)).toContain('a | b')
  })
})
