import { describe, expect, it } from 'vitest'
import { outputPair, parseCommandLine } from '../src/cliArgs.js'

describe('parseCommandLine', () => {
  it('leaves plain arguments alone', () => {
    expect(parseCommandLine(['cv-folder', 'out.pdf'], true)).toEqual({ positionals: ['cv-folder', 'out.pdf'] })
  })

  it('takes --title and --replaces from anywhere among the arguments', () => {
    expect(parseCommandLine(['--title', 'Cover letter', 'folder', '--replaces', '1AbC', 'out'], true)).toEqual({
      positionals: ['folder', 'out'], title: 'Cover letter', replaces: '1AbC',
    })
  })

  it('takes the --title=value form too', () => {
    expect(parseCommandLine(['folder', '--title=Dad — notes'], true).title).toBe('Dad — notes')
  })

  it('refuses a misspelt option instead of treating it as an argument', () => {
    expect(() => parseCommandLine(['folder', '--replace', '1AbC'], true)).toThrow(/Unknown option '--replace'/)
  })

  it('refuses an option on a command that would ignore it', () => {
    expect(() => parseCommandLine(['1AbC', '--replaces', '2XyZ'], false)).toThrow(/belong to build, resume and letter/)
    expect(() => parseCommandLine(['1AbC', '--title', 'x'], false)).toThrow(/belong to build, resume and letter/)
  })

  it('refuses an option with nothing after it', () => {
    expect(() => parseCommandLine(['folder', '--title'], true)).toThrow(/--title/)
    expect(() => parseCommandLine(['folder', '--title', '  '], true)).toThrow(/--title needs a title/)
    expect(() => parseCommandLine(['folder', '--replaces', ''], true)).toThrow(/--replaces needs the id/)
  })
})

describe('outputPair', () => {
  it('writes the PDF and the Word file together, whichever extension was named', () => {
    const both = { pdf: 'cv.pdf', docx: 'cv.docx' }
    expect(outputPair('cv.pdf', 'resume')).toEqual(both)
    expect(outputPair('cv.docx', 'resume')).toEqual(both)
    expect(outputPair('cv.PDF', 'resume')).toEqual(both)
    expect(outputPair('cv', 'resume')).toEqual(both)
  })

  it('falls back to the command name', () => {
    expect(outputPair(undefined, 'letter')).toEqual({ pdf: 'letter.pdf', docx: 'letter.docx' })
  })

  it('keeps the folder and any other dots in the name', () => {
    expect(outputPair('out/final.v2/cv.final.pdf', 'resume')).toEqual({ pdf: 'out/final.v2/cv.final.pdf', docx: 'out/final.v2/cv.final.docx' })
  })
})
