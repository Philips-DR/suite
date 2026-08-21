import { describe, expect, it } from 'vitest'
import {
  classifyImageSrc,
  collectImageSrcs,
  computeObjectSize,
  imageInsertRequests,
  imageMaxWidthPt,
  parseImageDimensions,
  type ImageResolution,
} from '../src/emit/image.js'
import { plain, type Block, type Chapter, type ImageBlock } from '../src/plan/types.js'
import { technical } from '../src/theme/presets/technical.js'

describe('classifyImageSrc', () => {
  it('accepts a plain remote http(s) URL', () => {
    expect(classifyImageSrc('https://example.com/diagram.png')).toEqual({ embeddable: true })
    expect(classifyImageSrc('http://example.com/diagram.jpg')).toEqual({ embeddable: true })
  })

  it('accepts a URL with no recognisable extension — the byte-level parse is the real check', () => {
    expect(classifyImageSrc('https://example.com/image?id=42')).toEqual({ embeddable: true })
  })

  it('rejects a local relative path — no scheme means no public host', () => {
    expect(classifyImageSrc('./diagram.png')).toEqual({ embeddable: false, reason: 'local' })
    expect(classifyImageSrc('diagram.png')).toEqual({ embeddable: false, reason: 'local' })
    expect(classifyImageSrc('../assets/diagram.png')).toEqual({ embeddable: false, reason: 'local' })
  })

  it('rejects a non-http(s) scheme', () => {
    expect(classifyImageSrc('file:///etc/passwd')).toEqual({ embeddable: false, reason: 'local' })
    expect(classifyImageSrc('ftp://example.com/x.png')).toEqual({ embeddable: false, reason: 'local' })
  })

  it('rejects localhost and private/link-local IPv4 ranges', () => {
    expect(classifyImageSrc('http://localhost/x.png')).toEqual({ embeddable: false, reason: 'local' })
    expect(classifyImageSrc('http://127.0.0.1/x.png')).toEqual({ embeddable: false, reason: 'local' })
    expect(classifyImageSrc('http://10.0.0.5/x.png')).toEqual({ embeddable: false, reason: 'local' })
    expect(classifyImageSrc('http://172.20.1.1/x.png')).toEqual({ embeddable: false, reason: 'local' })
    expect(classifyImageSrc('http://192.168.1.1/x.png')).toEqual({ embeddable: false, reason: 'local' })
    // 169.254/16 link-local — includes cloud metadata endpoints (e.g. 169.254.169.254).
    expect(classifyImageSrc('http://169.254.169.254/x.png')).toEqual({ embeddable: false, reason: 'local' })
  })

  it('does not mistake a public IP with a similar prefix for a private one', () => {
    expect(classifyImageSrc('http://172.15.1.1/x.png')).toEqual({ embeddable: true })
    expect(classifyImageSrc('http://172.32.1.1/x.png')).toEqual({ embeddable: true })
  })

  it('rejects a known-unsupported extension (Docs embeds only PNG/JPEG/GIF)', () => {
    expect(classifyImageSrc('https://example.com/diagram.svg')).toEqual({
      embeddable: false,
      reason: 'unsupported-format',
    })
    expect(classifyImageSrc('https://example.com/diagram.webp')).toEqual({
      embeddable: false,
      reason: 'unsupported-format',
    })
  })

  it('rejects a URI over the discovery doc’s length limit', () => {
    const long = `https://example.com/${'a'.repeat(2000)}.png`
    expect(classifyImageSrc(long)).toEqual({ embeddable: false, reason: 'uri-too-long' })
  })
})

describe('imageMaxWidthPt', () => {
  it('subtracts margins and indentEnd from the page width, not just the margins', () => {
    // technical: 612 page width, 54+54 margins, 72 indentEnd on body -> 612-54-54-72 = 432.
    expect(imageMaxWidthPt(technical)).toBe(432)
  })
})

describe('computeObjectSize', () => {
  it('renders a small image at its natural size — one pixel, one point, no upscaling', () => {
    const size = computeObjectSize(300, 150, 432)
    expect(size.width?.magnitude).toBe(300)
    expect(size.height?.magnitude).toBe(150)
    expect(size.width?.unit).toBe('PT')
  })

  it('caps a large image to the column width, preserving aspect ratio', () => {
    const size = computeObjectSize(2048, 1536, 432)
    expect(size.width?.magnitude).toBe(432)
    expect(size.height?.magnitude).toBeCloseTo(324, 5) // 1536/2048 * 432
  })
})

describe('imageInsertRequests', () => {
  const image: ImageBlock = { kind: 'image', src: 'https://example.com/x.png', alt: 'x', title: undefined }

  it('flanks the image with a leading and trailing newline, all via endOfSegmentLocation', () => {
    const requests = imageInsertRequests(image, 300, 150, 432, 't.chapter')
    expect(requests).toHaveLength(3)
    expect(requests[0]).toEqual({
      insertText: { endOfSegmentLocation: { tabId: 't.chapter' }, text: '\n' },
    })
    expect(requests[1]?.insertInlineImage?.uri).toBe('https://example.com/x.png')
    expect(requests[1]?.insertInlineImage?.endOfSegmentLocation).toEqual({ tabId: 't.chapter' })
    expect(requests[2]).toEqual({
      insertText: { endOfSegmentLocation: { tabId: 't.chapter' }, text: '\n' },
    })
  })

  it('includes an objectSize scaled to the given column width', () => {
    const requests = imageInsertRequests(image, 2048, 1536, 432)
    expect(requests[1]?.insertInlineImage?.objectSize?.width).toEqual({ magnitude: 432, unit: 'PT' })
  })

  it('omits tabId from endOfSegmentLocation when none is given', () => {
    const requests = imageInsertRequests(image, 300, 150, 432)
    expect(requests[0]?.insertText?.endOfSegmentLocation).toEqual({})
  })
})

describe('collectImageSrcs', () => {
  function chapter(blocks: Block[]): Chapter {
    return { title: 't', sourceFile: 'c.md', blocks }
  }

  it('collects an image block’s src', () => {
    const image: ImageBlock = { kind: 'image', src: 'https://example.com/a.png', alt: '', title: undefined }
    expect(collectImageSrcs([chapter([image])])).toEqual(['https://example.com/a.png'])
  })

  it('deduplicates the same src reused across chapters', () => {
    const image: ImageBlock = { kind: 'image', src: 'https://example.com/a.png', alt: '', title: undefined }
    expect(collectImageSrcs([chapter([image]), chapter([image])])).toEqual(['https://example.com/a.png'])
  })

  it('recurses into blockquotes to find a nested image', () => {
    const image: ImageBlock = { kind: 'image', src: 'https://example.com/nested.png', alt: '', title: undefined }
    const quoted: Block = { kind: 'blockquote', children: [image] }
    expect(collectImageSrcs([chapter([quoted])])).toEqual(['https://example.com/nested.png'])
  })

  it('returns nothing for a chapter with no images', () => {
    expect(collectImageSrcs([chapter([{ kind: 'paragraph', children: plain('hi') }])])).toEqual([])
  })
})

describe('parseImageDimensions', () => {
  it('reads width/height from a real PNG', () => {
    // A genuine 4x4 red PNG (the exact bytes used to live-verify this feature).
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGP8z8CASYwaSSUAAJlYAf9DcbFXAAAAAElFTkSuQmCC'
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    expect(parseImageDimensions(bytes)).toEqual({ width: 4, height: 4 })
  })

  it('reads width/height from a hand-built GIF header', () => {
    const bytes = new Uint8Array(10)
    bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)), 0)
    new DataView(bytes.buffer).setUint16(6, 320, true)
    new DataView(bytes.buffer).setUint16(8, 240, true)
    expect(parseImageDimensions(bytes)).toEqual({ width: 320, height: 240 })
  })

  it('reads width/height from a hand-built JPEG SOF0 marker, walking past an earlier marker first', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // a 2-byte APP0 payload to walk past
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x90, 0x02, 0x80, 0x01, 0x00, 0x00, // SOF0: height=400, width=640
    ])
    expect(parseImageDimensions(bytes)).toEqual({ width: 640, height: 400 })
  })

  it('returns undefined for bytes that are none of the three formats, never throwing', () => {
    expect(parseImageDimensions(new Uint8Array([0, 1, 2, 3]))).toBeUndefined()
    expect(parseImageDimensions(new Uint8Array(0))).toBeUndefined()
  })

  it('returns undefined for a truncated JPEG rather than reading past the buffer', () => {
    expect(parseImageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xc0]))).toBeUndefined()
  })

  it('does not loop forever on a JPEG with a malformed (too-short) marker length', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xff])
    expect(parseImageDimensions(bytes)).toBeUndefined()
  })
})

// A representative sample of what emit/document.ts's own resolveImages() produces per src, exercised
// here only as a type-shape sanity check — the actual fetch+classify flow is I/O and covered by
// test/live.build.test.ts instead.
describe('ImageResolution shape', () => {
  it('embeddable carries width/height; non-embeddable carries a reason', () => {
    const ok: ImageResolution = { embeddable: true, width: 10, height: 10 }
    const fail: ImageResolution = { embeddable: false, reason: 'fetch-failed' }
    expect(ok.embeddable).toBe(true)
    expect(fail.embeddable).toBe(false)
  })
})
