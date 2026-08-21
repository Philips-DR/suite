import type { docs_v1 } from 'googleapis'
import type { Block, Chapter, ImageBlock } from '../plan/types.js'
import type { Theme } from '../theme/types.js'
import { pt } from './units.js'

/** Every image reference across every chapter, deduplicated — a diagram reused across chapters (or
 * within one) is only ever fetched and classified once. Recurses into blockquotes, the only Block
 * that itself nests further Blocks; a table cell's own content is Inline-only and can't contain a
 * sole-image ImageBlock at all (see plan/fromAst.ts's planParagraph). */
export function collectImageSrcs(chapters: Chapter[]): string[] {
  const seen = new Set<string>()
  const walk = (blocks: Block[]): void => {
    for (const block of blocks) {
      if (block.kind === 'image') seen.add(block.src)
      else if (block.kind === 'blockquote') walk(block.children)
    }
  }
  for (const chapter of chapters) walk(chapter.blocks)
  return [...seen]
}

/**
 * Why classification lives here, in emit/, and not plan/: every rule below is a Google Docs API
 * mechanic (insertInlineImage's own constraints), not a fact about the markdown itself — exactly the
 * kind of thing CLAUDE.md's layer boundary reserves for emit/.
 *
 * Deny-list, not allow-list, for the format check: an unusual-but-valid image URL with no visible
 * extension (common on CDNs) must not be rejected just because we can't recognise it — the byte-level
 * parseImageDimensions below is what actually proves a fetched file is real PNG/JPEG/GIF, this is
 * only a cheap pre-filter for the cases we're already sure about.
 */
const KNOWN_UNSUPPORTED_EXTENSIONS = new Set([
  'svg', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'ico',
])

// The discovery doc's own "at most 2 kB" — 2000 is a deliberately conservative reading of that.
const MAX_URI_LENGTH = 2000

export type ImageClassification =
  | { embeddable: true }
  | { embeddable: false; reason: 'local' | 'unsupported-format' | 'uri-too-long' }

/** The outcome document.ts's own I/O step resolves each distinct image src to, before compileBlocks
 * ever runs — width/height once fetched and parsed, or a settled reason it couldn't be. Includes
 * 'fetch-failed' on top of classifyImageSrc's own reasons: a src can pass every string-level check
 * and still fail to actually fetch or decode (404, timeout, not really an image despite its URL). */
export type ImageResolution =
  | { embeddable: true; width: number; height: number }
  | { embeddable: false; reason: 'local' | 'unsupported-format' | 'uri-too-long' | 'fetch-failed' }

/**
 * Local-file markdown images (`./diagram.png`, the common real case) are NOT embeddable in v1 — not
 * a gap to smooth over silently. Verified live (see plan.md's M8 note): uploading the file to the
 * user's own Drive and referencing it back does not work, tried four different documented URL forms,
 * both before and after granting public "anyone with the link" access. Only a markdown image that
 * already names a public http(s) URL can be embedded.
 *
 * Also guards against the narrow SSRF-shaped risk of fetching a URL straight out of someone's
 * document: localhost and the private/link-local IPv4 ranges are rejected outright. This is a
 * string-level check only, not DNS-resolution-time validation — proportionate for a local CLI tool
 * processing files its own user chose to convert, not a shared multi-tenant service.
 */
export function classifyImageSrc(src: string): ImageClassification {
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return { embeddable: false, reason: 'local' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { embeddable: false, reason: 'local' }
  if (isLocalHost(url.hostname)) return { embeddable: false, reason: 'local' }
  if (src.length > MAX_URI_LENGTH) return { embeddable: false, reason: 'uri-too-long' }

  const match = /\.([a-z0-9]+)$/i.exec(url.pathname)
  const ext = match?.[1]?.toLowerCase()
  if (ext !== undefined && KNOWN_UNSUPPORTED_EXTENSIONS.has(ext)) {
    return { embeddable: false, reason: 'unsupported-format' }
  }
  return { embeddable: true }
}

function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') return true
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!octets) return false
  const [a, b] = [Number(octets[1]), Number(octets[2])]
  // 127/8 (loopback), 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local — includes cloud metadata).
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/** The theme's actual usable width for an image: page width, minus margins, minus how much further
 * prose narrows via indentEnd — not just "the page," which Google's own default image sizing uses
 * (verified live: a 2048px-wide test image was capped to exactly Docs' built-in 1-inch-margin width,
 * not this theme's narrower, deliberately-configured one). */
export function imageMaxWidthPt(theme: Theme): number {
  const indentEndPt = theme.body.para.indentEndPt ?? 0
  return theme.page.widthPt - theme.page.marginLeftPt - theme.page.marginRightPt - indentEndPt
}

/**
 * Deliberately simple, not an attempt to reverse-engineer Docs' own undocumented sizing heuristic
 * (which appeared to assume embedded DPI metadata this project has no reliable way to read either):
 * one image pixel is one point, capped to the column width, never upscaled past its natural size.
 * A small icon stays small and sharp; a large screenshot is capped to the column instead of hanging
 * off the page the way Docs' own page-width-only default would for this theme's narrower column.
 */
export function computeObjectSize(
  naturalWidthPx: number,
  naturalHeightPx: number,
  maxWidthPt: number,
): docs_v1.Schema$Size {
  const widthPt = Math.min(naturalWidthPx, maxWidthPt)
  const heightPt = widthPt * (naturalHeightPx / naturalWidthPx)
  return { width: pt(widthPt), height: pt(heightPt) }
}

/**
 * An inline image occupies exactly one UTF-16 code unit at its insertion point — it does not open
 * its own paragraph the way insertTable does. Verified live (see plan.md's M8 note): inserted bare
 * via endOfSegmentLocation, it merges straight into whatever paragraph currently sits at the end of
 * the tab (the one before it, or whatever follows it next in the same batch). The leading and
 * trailing '\n' here are what give it a clean paragraph of its own — dropping either one re-creates
 * the merge. Known, accepted v1 gap: if an image is the very first or very last thing in a chapter,
 * or two images sit back to back with nothing between them, this can leave one extra blank paragraph
 * (there's nothing on the other side to "absorb" the split) — a minor cosmetic edge case, not a
 * structural bug, and not one any real corpus currently exercises.
 */
export function imageInsertRequests(
  image: ImageBlock,
  naturalWidth: number,
  naturalHeight: number,
  maxWidthPt: number,
  tabId?: string,
): docs_v1.Schema$Request[] {
  const endOfSegmentLocation: docs_v1.Schema$EndOfSegmentLocation = {}
  if (tabId !== undefined) endOfSegmentLocation.tabId = tabId
  const objectSize = computeObjectSize(naturalWidth, naturalHeight, maxWidthPt)

  return [
    { insertText: { endOfSegmentLocation: { ...endOfSegmentLocation }, text: '\n' } },
    { insertInlineImage: { endOfSegmentLocation: { ...endOfSegmentLocation }, uri: image.src, objectSize } },
    { insertText: { endOfSegmentLocation: { ...endOfSegmentLocation }, text: '\n' } },
  ]
}

/** PNG's signature is fixed; width/height sit at fixed offsets in the always-first IHDR chunk. */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || !SIGNATURE.every((b, i) => bytes[i] === b)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
}

/** GIF's signature is fixed; width/height are the two little-endian uint16s right after it. */
function gifDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined
  const sig = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!)
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

// A hard cap on marker-walking iterations. This is exactly the vulnerability class that ruled out a
// general-purpose image-dimension library for this project (image-size's own unfixed DoS advisories
// are infinite loops in its ICNS/JXL/HEIF parsers) — bounding the loop here means a malformed or
// adversarial JPEG can only ever fail fast (return undefined), never hang the build.
const MAX_JPEG_MARKERS = 500

/** JPEG has no fixed dimension offset — width/height live inside whichever SOF marker the encoder
 * used, reached by walking the marker chain from the start of the file. */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2

  for (let i = 0; i < MAX_JPEG_MARKERS && offset + 4 <= bytes.length; i++) {
    if (bytes[offset] !== 0xff) return undefined // not a marker where the chain says one should be
    const marker = bytes[offset + 1]!
    // TEM (0x01) and RSTn/SOI/EOI (0xd0-0xd9) carry no length-prefixed payload to skip.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = view.getUint16(offset + 2, false)
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      if (offset + 9 > bytes.length) return undefined
      return { height: view.getUint16(offset + 5, false), width: view.getUint16(offset + 7, false) }
    }
    if (length < 2) return undefined // malformed — a real length always includes itself
    offset += 2 + length
  }
  return undefined
}

/** Format-agnostic on purpose: checks real magic bytes, not the URL's claimed extension, so a
 * mislabeled file is caught here rather than trusted. Never throws — returns undefined for anything
 * it doesn't recognise or can't safely parse, the same "don't guess" discipline as detectLanguage. */
export function parseImageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  return pngDimensions(bytes) ?? gifDimensions(bytes) ?? jpegDimensions(bytes)
}
