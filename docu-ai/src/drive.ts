import { google } from 'googleapis'
import type { AuthProvider } from './auth/types.js'

/**
 * What docu-ai does in Drive rather than in Docs: say what a document is, put a superseded one in the
 * Trash, and explain a refusal. `drive.file` is the only Drive scope held (auth/google.ts), so none of
 * this can see or touch a file docu-ai did not create — which is the safety property that makes a
 * "trash" operation reasonable to offer a model at all.
 *
 * The functions that do the work take a `DriveLike`, the few calls they use, so they are tested with
 * no network; `driveFor` is the one place a real client is made.
 */

const DOC_MIME = 'application/vnd.google-apps.document'

export interface DriveLike {
  files: {
    get(args: { fileId: string; fields: string }): Promise<{ data: DriveFile }>
    update(args: { fileId: string; requestBody: { trashed: boolean }; fields: string }): Promise<{ data: DriveFile }>
  }
  about: { get(args: { fields: string }): Promise<{ data: { storageQuota?: StorageQuota } }> }
}

export interface DriveFile {
  id?: string | null
  name?: string | null
  mimeType?: string | null
  createdTime?: string | null
  modifiedTime?: string | null
  trashed?: boolean | null
  webViewLink?: string | null
}

/** Bytes, as Drive sends them: decimal strings, and no `limit` at all on an unlimited plan. */
export interface StorageQuota {
  limit?: string | null
  usage?: string | null
  usageInDriveTrash?: string | null
}

export async function driveFor(auth: AuthProvider): Promise<DriveLike> {
  return google.drive({ version: 'v3', auth: await auth.client() }) as unknown as DriveLike
}

export interface DocumentInfo {
  documentId: string
  title: string
  url: string
  createdTime: string
  modifiedTime: string
  trashed: boolean
  /** One line a person can read above a yes/no prompt: what this is, when, and whose link. */
  summary: string
}

const FILE_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,trashed,webViewLink'

const stamp = (iso: string | null | undefined): string => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown')

export async function documentInfoWith(drive: DriveLike, documentId: string): Promise<DocumentInfo> {
  const { data } = await drive.files.get({ fileId: documentId, fields: FILE_FIELDS })
  if (data.mimeType !== DOC_MIME) {
    throw new Error(`${documentId} is not a Google Doc (it is ${data.mimeType ?? 'of unknown type'}).`)
  }
  const title = data.name ?? '(untitled)'
  const url = data.webViewLink ?? `https://docs.google.com/document/d/${documentId}/edit`
  return {
    documentId,
    title,
    url,
    createdTime: data.createdTime ?? '',
    modifiedTime: data.modifiedTime ?? '',
    trashed: data.trashed === true,
    summary:
      `Google Doc "${title}"${data.trashed ? ' (already in the Trash)' : ''} · created ${stamp(data.createdTime)} · ` +
      `last edited ${stamp(data.modifiedTime)} · ${url}`,
  }
}

export interface TrashResult {
  documentId: string
  title: string
  trashed: true
  restore: string
}

/**
 * Move a Google Doc to Drive's Trash — which is not deleting it: Drive keeps a trashed file for 30 days
 * and it can be restored from the Trash in the browser. Refuses anything that is not a Google Doc, and
 * anything already trashed (saying so is more useful than a second success).
 */
export async function trashDocumentWith(drive: DriveLike, documentId: string): Promise<TrashResult> {
  const info = await documentInfoWith(drive, documentId)
  if (info.trashed) throw new Error(`"${info.title}" is already in the Trash.`)
  await drive.files.update({ fileId: documentId, requestBody: { trashed: true }, fields: 'id,trashed' })
  return {
    documentId,
    title: info.title,
    trashed: true,
    restore: 'It is in Drive\'s Trash for 30 days: open Trash in Google Drive and choose "Restore".',
  }
}

export async function documentInfo(auth: AuthProvider, documentId: string): Promise<DocumentInfo> {
  return documentInfoWith(await driveFor(auth), documentId)
}

export async function trashDocument(auth: AuthProvider, documentId: string): Promise<TrashResult> {
  return trashDocumentWith(await driveFor(auth), documentId)
}

const GB = 1024 ** 3
const gb = (bytes: number): string => `${(bytes / GB).toFixed(2)} GB`

/**
 * Turn a refusal into its cause, when the cause is one Drive can tell us.
 *
 * Found live (2026-10-14): `documents.create` answered 403 "The caller does not have permission" for
 * every build, which reads as a broken login or a scope problem. The account's storage was 15.00 of
 * 15 GB, and Docs will not create a document into a full Drive. Nothing in that message says so; the
 * quota does. Only a 403 is investigated, and the original error is kept whenever the quota does not
 * explain it — this never replaces a real error with a guess.
 */
export async function explainFailure(
  error: unknown,
  readQuota: () => Promise<StorageQuota | undefined>,
): Promise<Error> {
  const original = error instanceof Error ? error : new Error(String(error))
  const status = (error as { status?: unknown; code?: unknown } | null)?.status ?? (error as { code?: unknown } | null)?.code
  if (Number(status) !== 403) return original
  let quota: StorageQuota | undefined
  try {
    quota = await readQuota()
  } catch {
    return original
  }
  const limit = Number(quota?.limit)
  const usage = Number(quota?.usage)
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(usage) || usage < limit * 0.999) return original

  const trash = Number(quota?.usageInDriveTrash)
  const inTrash = Number.isFinite(trash) && trash > 0 ? ` (${gb(trash)} of it in the Trash, which still counts until it is emptied)` : ''
  return new Error(
    `Google Drive is full: ${gb(usage)} of ${gb(limit)} used${inTrash}. Docs will not create a document ` +
      `until some space is free. Delete files or empty the Trash, then try again. ` +
      `(Google's own message was: "${original.message}")`,
    { cause: original },
  )
}

export async function explainFailureWithDrive(auth: AuthProvider, error: unknown): Promise<Error> {
  return explainFailure(error, async () => {
    const drive = await driveFor(auth)
    return (await drive.about.get({ fields: 'storageQuota' })).data.storageQuota
  })
}
