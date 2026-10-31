import { describe, expect, it } from 'vitest'
import type { AssistantEvent } from '../api'
import { fieldLabel, fieldsOf, pairSteps, resultText, stepTitle, stepsSummary, stepsTrouble } from './toolSteps'

const ev = (seq: number, type: AssistantEvent['type'], more: Partial<AssistantEvent> = {}): AssistantEvent => ({ seq, at: seq, type, ...more })

describe('stepTitle', () => {
  it('uses the title the tool gives itself, else its name in words', () => {
    expect(stepTitle('mail_ai__draft_new', { mail_ai__draft_new: 'Write a new draft' })).toBe('Write a new draft')
    expect(stepTitle('meet_ai__transcription_status', {})).toBe('Transcription status')
  })
})

describe('fieldsOf', () => {
  it('shows an email as the fields a person reads, every word of it', () => {
    const body = 'Checking how the approval card looks on the page. '.repeat(20)
    expect(fieldsOf({ to: 'philip@ayadata.ai', subject: 'zz-test', body })).toEqual([
      ['To', 'philip@ayadata.ai'], ['Subject', 'zz-test'], ['Body', body],
    ])
  })

  it('words a key a person can read', () => {
    expect(fieldLabel('documentId')).toBe('Document id')
    expect(fieldLabel('max_pages')).toBe('Max pages')
  })

  it('joins a short list, and keeps anything else as indented JSON', () => {
    expect(fieldsOf({ cc: ['a@example.org', 'b@example.org'], speakers: 4, force: true })).toEqual([['Cc', 'a@example.org, b@example.org'], ['Speakers', '4'], ['Force', 'true']])
    expect(fieldsOf({ attachments: [{ path: '/x/cv.docx' }] })).toEqual([['Attachments', '[\n  {\n    "path": "/x/cv.docx"\n  }\n]']])
  })
})

describe('resultText', () => {
  it('indents JSON and says when the backend cut it short', () => {
    expect(resultText('{"job":null}')).toEqual({ text: '{\n  "job": null\n}', cut: false })
    expect(resultText('x'.repeat(2000)).cut).toBe(true)
    expect(resultText('plain words')).toEqual({ text: 'plain words', cut: false })
  })
})

describe('pairSteps', () => {
  it('gives each finished call the arguments it was started with', () => {
    const steps = pairSteps([
      ev(1, 'tool_started', { tool: 'a__x', arguments: { n: 1 } }),
      ev(2, 'tool_started', { tool: 'a__x', arguments: { n: 2 } }),
      ev(3, 'tool_finished', { tool: 'a__x', outcome: 'ok', result: 'two' }),
      ev(4, 'tool_finished', { tool: 'a__x', outcome: 'ok', result: 'one' }),
    ])
    expect(steps.get(3)?.arguments).toEqual({ n: 2 })
    expect(steps.get(4)?.arguments).toEqual({ n: 1 })
  })

  it('pairs a button press with the press, even when a chat call of the same tool started after it', () => {
    const steps = pairSteps([
      ev(1, 'tool_started', { tool: 'a__x', origin: 'button', arguments: { from: 'button' } }),
      ev(2, 'tool_started', { tool: 'a__x', origin: 'chat', arguments: { from: 'chat' } }),
      ev(3, 'tool_finished', { tool: 'a__x', origin: 'button', outcome: 'ok' }),
      ev(4, 'tool_finished', { tool: 'a__x', origin: 'chat', outcome: 'ok' }),
    ])
    expect(steps.get(3)?.arguments).toEqual({ from: 'button' })
    expect(steps.get(4)?.arguments).toEqual({ from: 'chat' })
  })

  it('keeps a button press and a chat call apart, and gives a declined call no arguments', () => {
    const steps = pairSteps([
      ev(1, 'tool_started', { tool: 'a__x', origin: 'button', arguments: { from: 'button' } }),
      ev(2, 'tool_finished', { tool: 'a__x', origin: 'chat', outcome: 'declined' }),
      ev(3, 'tool_finished', { tool: 'a__x', origin: 'button', outcome: 'ok' }),
    ])
    expect(steps.get(2)).toMatchObject({ outcome: 'declined', origin: 'chat', arguments: undefined })
    expect(steps.get(3)).toMatchObject({ origin: 'button', arguments: { from: 'button' } })
  })
})

describe('stepsSummary', () => {
  it('counts the steps and says what did not go through', () => {
    const s = (outcome: string) => ({ seq: 0, tool: 't', outcome, origin: 'chat' as const })
    expect(stepsSummary([s('ok')])).toBe('1 step')
    expect(stepsSummary([s('ok'), s('declined'), s('failed')])).toBe('3 steps · 1 declined · 1 failed')
    expect(stepsTrouble([s('ok'), s('ok')])).toBe('')
  })
})
