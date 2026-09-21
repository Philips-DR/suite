import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { GoogleOAuthProvider } from '../auth/google.js'
import type { AuthProvider } from '../auth/types.js'
import { buildDocument, lintDocument, previewFolder } from '../operations.js'

/**
 * docu-ai's second front door: the same operations the CLI exposes, reachable by a model.
 *
 * Both doors sit directly on `operations.ts`; neither wraps the other. A model calling `build` and
 * a person typing `npm start -- build` run identical code and differ only in how the result is
 * formatted — JSON here, prose there.
 *
 * `zod` is a direct dependency on purpose, pinned to the range the MCP SDK itself resolves so npm
 * dedupes to ONE copy. This is the same hazard CLAUDE.md records for google-auth-library: two
 * copies of a schema library yield two nominally distinct types, and `registerTool` then rejects
 * a schema built with the wrong one. Check `npm ls zod` shows a single deduped entry before
 * bumping either package.
 */

const VERSION = '0.0.1'

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

function failed(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
  }
}

/**
 * Auth comes in, exactly as it does for every other caller of `operations.ts`. The server does not
 * resolve credentials, which is what lets a test drive it with a stub and a future service account
 * drop in without touching this file.
 */
export function createDocuAiServer(auth: AuthProvider): McpServer {
  const server = new McpServer({ name: 'docu-ai', version: VERSION })

  server.registerTool(
    'preview',
    {
      title: 'Preview a markdown folder',
      description:
        'Parse and plan a folder of markdown files and report the structure that would be built: ' +
        'one chapter per file, with a tally of block kinds. Touches no network and creates nothing, ' +
        'so it is the safe way to check a folder before spending a build on it.',
      inputSchema: {
        dir: z.string().describe('Path to a folder of .md files. One file becomes one chapter.'),
      },
      // No network, no document, nothing to undo. This is the approval surface.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ dir }) => {
      try {
        return ok(await previewFolder(dir))
      } catch (error) {
        return failed(error)
      }
    },
  )

  server.registerTool(
    'build',
    {
      title: 'Build a Google Doc from a markdown folder',
      description:
        'Compile a folder of markdown into a real Google Doc: one tab per chapter, a cover with a ' +
        'clickable table of contents, real Docs styling, and no markdown residue. Returns the ' +
        'document id and URL, a paragraph count, and the residue lint findings. Creates a document ' +
        "in the user's Drive and spends write quota — run preview first.",
      inputSchema: {
        dir: z.string().describe('Path to a folder of .md files.'),
        title: z
          .string()
          .optional()
          .describe("The document title, shown on the cover. Defaults to the folder's name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ dir, title }) => {
      try {
        return ok(await buildDocument(auth, { dir, title }))
      } catch (error) {
        return failed(error)
      }
    },
  )

  server.registerTool(
    'lint',
    {
      title: 'Check a built document for markdown residue',
      description:
        'Read an already-built Google Doc back and assert no literal markdown survived in it — no ' +
        'asterisk pairs, backticks or table pipes in prose, and no line starting with an ' +
        'unconverted heading or list marker. Code-styled runs are exempt, because real code ' +
        'legitimately contains all of them.',
      inputSchema: {
        documentId: z.string().describe('The Google Docs document id, as returned by build.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ documentId }) => {
      try {
        return ok(await lintDocument(auth, documentId))
      } catch (error) {
        return failed(error)
      }
    },
  )

  return server
}

async function main(): Promise<void> {
  // The one place this entry point reaches for the environment, and named so it is visible.
  const server = createDocuAiServer(GoogleOAuthProvider.fromEnvironment())
  await server.connect(new StdioServerTransport())
}

// stdout is the MCP transport here: anything written to it that is not a protocol message corrupts
// the stream, so errors go to stderr and nowhere else.
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
