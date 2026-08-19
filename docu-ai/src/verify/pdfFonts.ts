import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { google } from 'googleapis'
import type { AuthProvider } from '../auth/types.js'

const run = promisify(execFile)

/**
 * The only honest font check. Docs substitutes Arial for unknown fonts at render time while the API
 * keeps reporting the name we asked for, so the readback cannot see the failure — the PDF can.
 */
export async function exportPdf(
  auth: AuthProvider,
  documentId: string,
  outPath: string,
): Promise<string> {
  const drive = google.drive({ version: 'v3', auth: await auth.client() })
  const res = await drive.files.export(
    { fileId: documentId, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' },
  )
  await writeFile(outPath, Buffer.from(res.data as unknown as ArrayBuffer))
  return outPath
}

/** Font names as embedded in the PDF, with subset prefixes ("ABCDEF+Lora") stripped. */
export async function pdfFontNames(pdfPath: string): Promise<string[]> {
  let stdout: string
  try {
    const result = await run('pdffonts', [pdfPath])
    stdout = result.stdout
  } catch (err) {
    throw new Error(
      `could not run pdffonts (poppler-utils). Font verification needs it: ${String(err)}`,
    )
  }

  const names = stdout
    .split('\n')
    .slice(2) // "name type encoding ..." header plus its rule
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name.length > 0)
    .map((name) => (name.includes('+') ? name.slice(name.indexOf('+') + 1) : name))

  return [...new Set(names)]
}

function normalise(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export interface FontVerdict {
  requested: string
  applied: boolean
  matchedAs: string | undefined
}

/**
 * A font counts as applied only if something resembling its name is embedded. Arial is treated as a
 * match for nothing but itself, since Arial is precisely what a failed font looks like.
 */
export function verdictFor(requested: string, embedded: string[]): FontVerdict {
  const target = normalise(requested)
  const matched = embedded.find((name) => {
    const candidate = normalise(name)
    return candidate.includes(target) || target.includes(candidate)
  })
  return { requested, applied: matched !== undefined, matchedAs: matched }
}
