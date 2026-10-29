import { describe, expect, it } from 'vitest'
import {
  documentInfoWith,
  explainFailure,
  exportDocumentWith,
  formatForPath,
  listDocumentsWith,
  trashDocumentWith,
  type DriveFile,
  type DriveLike,
  type StorageQuota,
} from '../src/drive.js'

const DOC: DriveFile = {
  id: 'abc',
  name: 'Philip Baah Afriyie',
  mimeType: 'application/vnd.google-apps.document',
  createdTime: '2026-10-14T12:03:44.000Z',
  modifiedTime: '2026-10-14T12:30:10.000Z',
  trashed: false,
  webViewLink: 'https://docs.google.com/document/d/abc/edit',
}

/** A Drive that holds one file and records what was done to it. */
function drive(file: DriveFile, allFiles?: DriveFile[]): DriveLike & { updates: unknown[] } {
  const updates: unknown[] = []
  return {
    updates,
    files: {
      get: () => Promise.resolve({ data: file }),
      list: () => Promise.resolve({ data: { files: allFiles ?? [file] } }),
      update: (args) => {
        updates.push(args)
        return Promise.resolve({ data: { ...file, trashed: true } })
      },
      export: () => Promise.resolve({ data: Buffer.from('fake-content') }),
    },
    about: { get: () => Promise.resolve({ data: {} }) },
  }
}

describe('documentInfoWith', () => {
  it('names the document in one readable line', async () => {
    const info = await documentInfoWith(drive(DOC), 'abc')
    expect(info.title).toBe('Philip Baah Afriyie')
    expect(info.summary).toBe(
      'Google Doc "Philip Baah Afriyie" · created 2026-10-14 12:03 UTC · last edited 2026-10-14 12:30 UTC · ' +
        'https://docs.google.com/document/d/abc/edit',
    )
  })

  it('says when a document is already in the Trash', async () => {
    const info = await documentInfoWith(drive({ ...DOC, trashed: true }), 'abc')
    expect(info.trashed).toBe(true)
    expect(info.summary).toContain('already in the Trash')
  })

  it('refuses a file that is not a Google Doc', async () => {
    await expect(documentInfoWith(drive({ ...DOC, mimeType: 'application/pdf' }), 'abc')).rejects.toThrow(
      /not a Google Doc \(it is application\/pdf\)/,
    )
  })
})

describe('trashDocumentWith', () => {
  it('moves a Doc to the Trash — trashed, never deleted — and says how to bring it back', async () => {
    const d = drive(DOC)
    const result = await trashDocumentWith(d, 'abc')
    expect(d.updates).toEqual([{ fileId: 'abc', requestBody: { trashed: true }, fields: 'id,trashed' }])
    expect(result).toMatchObject({ documentId: 'abc', title: 'Philip Baah Afriyie', trashed: true })
    expect(result.restore).toContain('30 days')
  })

  it('does nothing to a file that is not a Google Doc', async () => {
    const d = drive({ ...DOC, mimeType: 'application/pdf' })
    await expect(trashDocumentWith(d, 'abc')).rejects.toThrow(/not a Google Doc/)
    expect(d.updates).toEqual([])
  })

  it('reports a Doc already in the Trash instead of a second success', async () => {
    const d = drive({ ...DOC, trashed: true })
    await expect(trashDocumentWith(d, 'abc')).rejects.toThrow(/already in the Trash/)
    expect(d.updates).toEqual([])
  })
})

describe('listDocumentsWith', () => {
  it('returns documents sorted by the drive response', async () => {
    const result = await listDocumentsWith(drive(DOC))
    expect(result.documents).toHaveLength(1)
    expect(result.documents[0]).toMatchObject({ documentId: 'abc', title: 'Philip Baah Afriyie' })
  })

  it('returns an empty list when no files exist', async () => {
    const result = await listDocumentsWith(drive(DOC, []))
    expect(result.documents).toEqual([])
  })

  it('passes through nextPageToken when present', async () => {
    const d = drive(DOC)
    const origList = d.files.list
    d.files.list = (args) => origList(args).then((r) => ({ data: { ...r.data, nextPageToken: 'tok_2' } }))
    const result = await listDocumentsWith(d)
    expect(result.nextPageToken).toBe('tok_2')
  })

  it('omits nextPageToken when absent', async () => {
    const result = await listDocumentsWith(drive(DOC))
    expect(result.nextPageToken).toBeUndefined()
  })
})

/** What Google actually sent on 2026-10-14: a 403 that names nothing. */
const forbidden = Object.assign(new Error('The caller does not have permission'), { status: 403 })
const GB = 1024 ** 3

describe('explainFailure', () => {
  const quota = (usage: number, limit: number, trash?: number): (() => Promise<StorageQuota>) =>
    () => Promise.resolve({ usage: String(usage * GB), limit: String(limit * GB), usageInDriveTrash: trash === undefined ? undefined : String(trash * GB) })

  it('names a full Drive as the cause of a 403, and keeps Google’s own words', async () => {
    const error = await explainFailure(forbidden, quota(15, 15, 2.5))
    expect(error.message).toContain('Google Drive is full: 15.00 GB of 15.00 GB used')
    expect(error.message).toContain('2.50 GB of it in the Trash')
    expect(error.message).toContain('The caller does not have permission')
    expect(error.cause).toBe(forbidden)
  })

  it('leaves a 403 alone when the Drive has room — a real permission problem stays one', async () => {
    expect(await explainFailure(forbidden, quota(11.88, 15))).toBe(forbidden)
  })

  it('leaves an unlimited plan alone, which reports no limit at all', async () => {
    expect(await explainFailure(forbidden, () => Promise.resolve({ usage: String(40 * GB) }))).toBe(forbidden)
  })

  it('does not ask Drive about an error that is not a 403', async () => {
    let asked = false
    const other = Object.assign(new Error('quota exceeded'), { status: 429 })
    const result = await explainFailure(other, () => {
      asked = true
      return Promise.resolve(undefined)
    })
    expect(result).toBe(other)
    expect(asked).toBe(false)
  })

  it('reads the status from `code` too, which is where Gaxios puts it for some failures', async () => {
    const coded = Object.assign(new Error('nope'), { code: 403 })
    expect((await explainFailure(coded, quota(15, 15))).message).toContain('Google Drive is full')
  })

  it('keeps the original error when the quota itself cannot be read', async () => {
    expect(await explainFailure(forbidden, () => Promise.reject(new Error('offline')))).toBe(forbidden)
  })

  it('wraps a thrown non-error rather than losing it', async () => {
    const result = await explainFailure('boom', () => Promise.resolve(undefined))
    expect(result.message).toBe('boom')
  })
})

/** A Drive that answers an export with `data`, and records how it was asked. */
function exporting(data: unknown, file: DriveFile = DOC): DriveLike & { asked: { mimeType: string; responseType: string | undefined }[] } {
  const asked: { mimeType: string; responseType: string | undefined }[] = []
  return {
    asked,
    files: {
      get: () => Promise.resolve({ data: file }),
      list: () => Promise.resolve({ data: { files: [file] } }),
      update: () => Promise.resolve({ data: file }),
      export: (args, options) => {
        asked.push({ mimeType: args.mimeType, responseType: options?.responseType })
        return Promise.resolve({ data: data as ArrayBuffer })
      },
    },
    about: { get: () => Promise.resolve({ data: {} }) },
  }
}

const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const asArrayBuffer = (text: string): ArrayBuffer => {
  const bytes = Buffer.from(text, 'latin1')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('exportDocumentWith', () => {
  it('asks Drive for an array buffer, which is what makes Word come back as bytes', async () => {
    // Found 2026-10-24: a .docx export came back as a Blob, which was then read as a string and threw.
    const d = exporting(asArrayBuffer('PK\u0003\u0004 word'))
    await exportDocumentWith(d, 'abc', 'docx')
    expect(d.asked).toEqual([{ mimeType: WORD, responseType: 'arraybuffer' }])
  })

  it('returns a Word document as bytes, named for the document', async () => {
    const result = await exportDocumentWith(exporting(asArrayBuffer('PK\u0003\u0004 word')), 'abc', 'docx')
    expect(result.format).toBe('docx')
    expect(result.filename).toBe('Philip Baah Afriyie.docx')
    expect(result.bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('still returns a PDF', async () => {
    const d = exporting(asArrayBuffer('%PDF-1.7 pdf'))
    const result = await exportDocumentWith(d, 'abc', 'pdf')
    expect(result.filename).toBe('Philip Baah Afriyie.pdf')
    expect(d.asked[0]?.mimeType).toBe('application/pdf')
  })

  it('reads a Blob, the shape a client gives a binary type when it is not asked for an array buffer', async () => {
    const blob = new Blob([Buffer.from('PK\u0003\u0004 word', 'latin1')])
    const result = await exportDocumentWith(exporting(blob), 'abc', 'docx')
    expect(result.bytes.length).toBe(blob.size)
  })

  it('reads a Buffer as well', async () => {
    const result = await exportDocumentWith(exporting(Buffer.from('%PDF-1.4 x')), 'abc', 'pdf')
    expect(result.bytes.toString('latin1')).toBe('%PDF-1.4 x')
  })

  it('refuses a file that is not what it says, instead of handing on garbage as a CV', async () => {
    await expect(exportDocumentWith(exporting(asArrayBuffer('<html>Sign in</html>')), 'abc', 'docx')).rejects.toThrow(
      /not a Word document \(20 bytes\)/,
    )
    await expect(exportDocumentWith(exporting(asArrayBuffer('PK\u0003\u0004 a zip')), 'abc', 'pdf')).rejects.toThrow(
      /not a PDF/,
    )
  })

  it('refuses a type it cannot read, in words', async () => {
    await expect(exportDocumentWith(exporting({ some: 'object' }), 'abc', 'pdf')).rejects.toThrow(/type this tool does not know/)
  })

  it('names a title that Drive would not allow in a file name safely', async () => {
    const d = exporting(asArrayBuffer('%PDF-1.7'), { ...DOC, name: 'CV: A/B "final"' })
    expect((await exportDocumentWith(d, 'abc', 'pdf')).filename).toBe('CV_ A_B _final_.pdf')
  })
})

describe('formatForPath', () => {
  it('reads Word from .docx and PDF from .pdf, in any case', () => {
    expect(formatForPath('cv.docx')).toBe('docx')
    expect(formatForPath('out/CV.DOCX')).toBe('docx')
    expect(formatForPath('cv.pdf')).toBe('pdf')
    expect(formatForPath('/tmp/a.b/cv.PDF')).toBe('pdf')
  })

  it('keeps meaning PDF for a name with no extension, as export always did', () => {
    expect(formatForPath('cv')).toBe('pdf')
    expect(formatForPath('./some.dir/cv')).toBe('pdf')
    expect(formatForPath('abc123')).toBe('pdf')
  })

  it('refuses an extension it cannot read, rather than guess', () => {
    expect(() => formatForPath('cv.txt')).toThrow(/Cannot tell what to export for "\.txt": use a name ending in \.pdf or \.docx/)
    expect(() => formatForPath('cv.doc')).toThrow(/"\.doc"/)
  })
})
