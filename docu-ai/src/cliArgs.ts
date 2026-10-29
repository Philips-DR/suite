import { parseArgs } from 'node:util'

/**
 * The command line's two small decisions, pure so they are tested with no Google and no process: which words
 * are options and which are arguments, and which files a document is written to.
 */

export interface CommandLine {
  positionals: string[]
  /** `--title`: what the document is called in Drive, when that should not be its first heading. */
  title?: string
  /** `--replaces`: the document this one supersedes, moved to the Trash once the new one is finished. */
  replaces?: string
}

/**
 * Split a command's words into arguments and the two options. `flags` says whether this command takes
 * options at all: a typo (`--replace`) is an error rather than an argument, and an option on a command that
 * would ignore it is an error rather than silently nothing.
 */
export function parseCommandLine(args: string[], flags: boolean): CommandLine {
  const parsed = split(args)
  const { title, replaces } = parsed.values
  if (!flags && (title !== undefined || replaces !== undefined)) {
    throw new Error('--title and --replaces belong to build, resume and letter.')
  }
  if (title !== undefined && title.trim() === '') throw new Error('--title needs a title.')
  if (replaces !== undefined && replaces.trim() === '') throw new Error('--replaces needs the id of the document to replace.')
  return { positionals: parsed.positionals, ...(title !== undefined ? { title } : {}), ...(replaces !== undefined ? { replaces } : {}) }
}

function split(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: { title: { type: 'string' }, replaces: { type: 'string' } },
    })
  } catch (error) {
    // Node's message goes on to explain how to pass a positional that starts with a dash, which is not the
    // help anyone typing `--replace` needs; its first sentence is.
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.split('. ')[0] ?? message, { cause: error })
  }
}

/**
 * The two files a finished document is written to. `cv.pdf`, `cv.docx` and `cv` all mean the pair
 * `cv.pdf` and `cv.docx`: the name is the document's, and both formats are always written, since a CV goes
 * out as whichever one the employer asks for.
 */
export function outputPair(out: string | undefined, fallbackBase: string): { pdf: string; docx: string } {
  const base = (out ?? fallbackBase).replace(/\.(pdf|docx)$/i, '')
  return { pdf: `${base}.pdf`, docx: `${base}.docx` }
}
