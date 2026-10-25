import { describe, expect, test, tier } from 'claude-code/testing'

import { ROOT, START, world } from './fixtures/world'

tier('user')

const RURE_TOOL = { name: 'mcp__ruflo__rure_analyze_binary', mcp: true }
const END = { durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

describe('rure offer (ADR-498)', () => {
  test('on: the module loads beside session.ts and learn, and a binary read in the project gets one offer line (#4485)', { options: { rureOffer: true } }, async ($, on) => {
    world(on, {}, { [`${ROOT}/build/app.exe`]: 'MZ' })
    on('tool.list', () => ({ value: [RURE_TOOL] as never }))
    on('tool.call', () => ({ result: 'read' }))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.session.start(START)
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/build/app.exe` })
    const result = await $.turn.complete({ answer: 'done', ...END })

    expect(result.text).toContain('done')
    expect(result.text).toContain('build/app.exe')
  })

  test('on, headless (surface null): the matchers still match, so the offer still shows', { options: { rureOffer: true } }, async ($, on) => {
    world(on, {}, { [`${ROOT}/build/app.exe`]: 'MZ' })
    on('tool.list', () => ({ value: [RURE_TOOL] as never }))
    on('tool.call', () => ({ result: 'read' }))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.session.start({ ...START, surface: null, isInteractive: false })
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/build/app.exe` })

    expect((await $.turn.complete({ answer: 'done', ...END })).text).toContain('build/app.exe')
  })

  test('off by default: no offer line', async ($, on) => {
    world(on, {}, { [`${ROOT}/build/app.exe`]: 'MZ' })
    on('tool.list', () => ({ value: [RURE_TOOL] as never }))
    on('tool.call', () => ({ result: 'read' }))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.session.start(START)
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/build/app.exe` })

    expect((await $.turn.complete({ answer: 'done', ...END })).text).toBe('done')
  })
})
