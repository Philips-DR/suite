import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Auth } from 'googleapis'
import type { AuthProvider } from './types.js'

/**
 * `drive.file` is deliberately the narrowest scope that works: it grants access only to files this
 * app created, which covers creating documents and exporting them to PDF for verification.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
]

interface ClientSecrets {
  clientId: string
  clientSecret: string
}

export function tokenPath(): string {
  const override = process.env.DOCU_AI_TOKEN
  if (override) return override
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'docu-ai', 'token.json')
}

async function loadClientSecrets(): Promise<ClientSecrets> {
  const id = process.env.DOCU_AI_CLIENT_ID
  const secret = process.env.DOCU_AI_CLIENT_SECRET
  if (id && secret) return { clientId: id, clientSecret: secret }

  const path = process.env.DOCU_AI_CREDENTIALS ?? 'credentials.json'
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      'No OAuth client credentials found.\n' +
        '  Either set DOCU_AI_CLIENT_ID and DOCU_AI_CLIENT_SECRET,\n' +
        `  or save the OAuth client JSON from Google Cloud as ${path}\n` +
        '  (or point DOCU_AI_CREDENTIALS at it). See SETUP.md.',
    )
  }

  const parsed = JSON.parse(raw) as {
    installed?: { client_id?: string; client_secret?: string }
    web?: { client_id?: string; client_secret?: string }
  }
  const node = parsed.installed ?? parsed.web
  if (!node?.client_id || !node.client_secret) {
    throw new Error(`${path} is not a Google OAuth client JSON (no installed.client_id).`)
  }
  return { clientId: node.client_id, clientSecret: node.client_secret }
}

async function saveCredentials(creds: Auth.Credentials): Promise<void> {
  const path = tokenPath()
  await mkdir(dirname(path), { recursive: true })
  // The refresh token is a long-lived secret: keep it owner-only.
  await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 })
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Not fatal: the URL is printed for the user to open by hand.
  }
}

/**
 * Desktop OAuth: spin up a loopback listener on an ephemeral port, send the user to Google, and
 * catch the redirect. Desktop client types permit any localhost port, so nothing is hardcoded.
 */
function authorizeInteractively(secrets: ClientSecrets): Promise<Auth.OAuth2Client> {
  return new Promise<Auth.OAuth2Client>((resolve, reject) => {
    const state = randomBytes(16).toString('hex')
    const server = createServer()
    server.on('error', reject)

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        server.close()
        reject(new Error('could not bind a loopback port for the OAuth redirect'))
        return
      }

      const redirectUri = `http://localhost:${addr.port}/oauth2callback`
      const client = new Auth.OAuth2Client({
        clientId: secrets.clientId,
        clientSecret: secrets.clientSecret,
        redirectUri,
      })
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // force a refresh_token even if this client was authorised before
        scope: SCOPES,
        state,
      })

      server.on('request', (req, res) => {
        void (async () => {
          try {
            const url = new URL(req.url ?? '/', redirectUri)
            if (url.pathname !== '/oauth2callback') {
              res.writeHead(404).end()
              return
            }
            const failure = url.searchParams.get('error')
            if (failure) throw new Error(`Google returned an error: ${failure}`)
            if (url.searchParams.get('state') !== state) {
              throw new Error('OAuth state mismatch — aborting rather than trusting this callback')
            }
            const code = url.searchParams.get('code')
            if (!code) throw new Error('no authorisation code in the callback')

            const { tokens } = await client.getToken(code)
            client.setCredentials(tokens)
            await saveCredentials(tokens)

            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end('<h2>docu-ai is authorised.</h2><p>You can close this tab.</p>')
            server.close()
            resolve(client)
          } catch (err) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(String(err))
            server.close()
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })()
      })

      process.stdout.write(
        `\nOpening a browser to authorise docu-ai.\nIf it does not open, visit:\n\n  ${authUrl}\n\n`,
      )
      openBrowser(authUrl)
    })
  })
}

export class GoogleOAuthProvider implements AuthProvider {
  readonly kind = 'oauth-desktop'
  private cached: Auth.OAuth2Client | undefined

  async client(): Promise<Auth.OAuth2Client> {
    if (this.cached) return this.cached
    const secrets = await loadClientSecrets()
    const client = (await this.fromCache(secrets)) ?? (await authorizeInteractively(secrets))
    this.cached = client
    return client
  }

  private async fromCache(secrets: ClientSecrets): Promise<Auth.OAuth2Client | undefined> {
    let raw: string
    try {
      raw = await readFile(tokenPath(), 'utf8')
    } catch {
      return undefined
    }
    const creds = JSON.parse(raw) as Auth.Credentials
    if (!creds.refresh_token) return undefined // an access token alone is useless once it expires

    const client = new Auth.OAuth2Client({
      clientId: secrets.clientId,
      clientSecret: secrets.clientSecret,
    })
    client.setCredentials(creds)
    // Persist rotated access tokens. The library folds the existing refresh_token into
    // client.credentials, so writing the whole object keeps it intact.
    client.on('tokens', () => {
      void saveCredentials(client.credentials)
    })
    return client
  }
}

export async function hasCachedToken(): Promise<boolean> {
  try {
    const creds = JSON.parse(await readFile(tokenPath(), 'utf8')) as Auth.Credentials
    return Boolean(creds.refresh_token)
  } catch {
    return false
  }
}
