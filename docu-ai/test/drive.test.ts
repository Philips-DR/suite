import { describe, expect, it } from 'vitest'
import {
  documentInfoWith,
  explainFailure,
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
function drive(file: DriveFile): DriveLike & { updates: unknown[] } {
  const updates: unknown[] = []
  return {
    updates,
    files: {
      get: () => Promise.resolve({ data: file }),
      update: (args) => {
        updates.push(args)
        return Promise.resolve({ data: { ...file, trashed: true } })
      },
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
