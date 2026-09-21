import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthProvider } from '../src/auth/types.js'
import { createDocuAiServer } from '../src/mcp/server.js'

/**
 * A real client-to-server round trip over an in-memory transport. No network, no stdio, no
 * credentials — which is the point: the door itself is testable without any of them, and the one
 * tool that genuinely needs auth (`build`) is never reached here.
 */

let dir: string

/**
 * Deliberately explodes if touched. Auth is injected into the server, so a test can prove that
 * `preview` reaches the network-free path by making any other path fail loudly.
 */
const refusingAuth: AuthProvider = {
  kind: 'test-refusing',
  client() {
    throw new Error('auth must not be used by a read-only operation')
  },
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createDocuAiServer(refusingAuth)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content
  return content.map((block) => block.text).join('\n')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docu-ai-mcp-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the MCP front door', () => {
  it('advertises exactly the three operations, and no more', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(['build', 'lint', 'preview'])
  })

  it('marks preview read-only so a caller can tell which tool is safe to run unattended', async () => {
    const client = await connect()
    const tools = (await client.listTools()).tools
    const preview = tools.find((t) => t.name === 'preview')
    const build = tools.find((t) => t.name === 'build')
    expect(preview?.annotations?.readOnlyHint).toBe(true)
    expect(build?.annotations?.readOnlyHint).toBe(false)
  })

  it('previews a folder without ever touching auth', async () => {
    await writeFile(join(dir, '01-intro.md'), '# Intro\n\nBody text.\n', 'utf8')
    await writeFile(join(dir, '02-next.md'), '# Next\n\n- one\n- two\n', 'utf8')

    const client = await connect()
    const result = await client.callTool({ name: 'preview', arguments: { dir } })

    const parsed = JSON.parse(textOf(result)) as {
      chapters: { title: string; file: string; blocks: Record<string, number> }[]
    }
    expect(parsed.chapters.map((c) => c.title)).toEqual(['Intro', 'Next'])
    expect(parsed.chapters[1]?.blocks).toMatchObject({ heading: 1, list: 1 })
  })

  it('reports a bad folder as a tool error rather than throwing the connection down', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'preview', arguments: { dir: join(dir, 'nope') } })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it('rejects an empty folder, rather than building a document with no chapters', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'preview', arguments: { dir } })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('no .md files found')
  })
})
