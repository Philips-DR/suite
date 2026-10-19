import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The web app is its own program. It calls the backend directly -- no proxy -- and the backend
// allows the origins it is told. Both listen on 127.0.0.1 unless told otherwise, which only the
// container setup does (WEB_HOST), publishing the port to 127.0.0.1 and to a private Tailscale
// network, never to the world.
//
// Which names may reach this server, and which port the backend is on for them, come from the
// environment at serve time, not from the build: a build that knew its host's name could not be the
// same image on a laptop and on a server.

const csv = (value: string | undefined) =>
  (value ?? '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])
// Exact names only, as in the backend: ASSISTANT_HOSTS is shared with it.
const ALLOWED_HOSTS = new Set([...LOCAL_HOSTS, ...csv(process.env.ASSISTANT_HOSTS)])
const BIND_HOST = process.env.WEB_HOST || '127.0.0.1'
// The port the backend answers on when this page was opened by any name but localhost; the browser
// takes the host from the address bar. Written into the page, so the same dist serves any host.
const REMOTE_API_PORT = (process.env.ASSISTANT_REMOTE_API_PORT ?? '').replace(/\D/g, '')
// A full URL when the API is on a different host entirely (ngrok gives each tunnel its own hostname).
const REMOTE_API_URL = process.env.ASSISTANT_REMOTE_API_URL ?? ''
// Off, the page carries no token at all. For when signing in replaces it (a Google login).
const INJECT_TOKEN = (process.env.WEB_INJECT_TOKEN ?? '1') !== '0'

/**
 * Hand the page the backend's token as it is served, so nobody has to paste it.
 *
 * ./start makes one random token per launch and gives it to both programs; this server puts
 * it in a <meta> tag on every page load. Only at serve time, never at build: a token baked
 * into dist/ would outlive the launch it belongs to and sit in a file.
 *
 * Other websites cannot read this page (the same-origin policy), and a DNS-rebinding page --
 * a hostile name pointed at 127.0.0.1 -- still says its own name in Host. Vite refuses such a
 * Host too, but this checks it again itself rather than trust the order the two run in: this
 * is the one response that carries the token.
 */
function injectToken(): Plugin {
  const token = INJECT_TOKEN ? (process.env.ASSISTANT_TOKEN ?? '') : ''
  const meta = () =>
    `<meta name="assistant-token" content="${token.replace(/[^A-Za-z0-9_-]/g, '')}">` +
    (REMOTE_API_URL ? `<meta name="assistant-api-url" content="${REMOTE_API_URL.replace(/"/g, '')}">` : '') +
    (REMOTE_API_PORT ? `<meta name="assistant-api-port" content="${REMOTE_API_PORT}">` : '')
  const allowed = (host: string | undefined) =>
    ALLOWED_HOSTS.has((host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase())

  return {
    name: 'inject-assistant-token',
    // Development server: the page is transformed per request, so this is serve time.
    transformIndexHtml(html, ctx) {
      return token && ctx.server ? html.replace('</head>', `${meta()}</head>`) : html
    },
    // `vite preview` serves dist/ as files and never runs transformIndexHtml, so the page
    // itself is answered here, ahead of the static files.
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]
        if (!token || (path !== '/' && path !== '/index.html')) return next()
        if (!allowed(req.headers.host)) {
          res.statusCode = 403
          return res.end('forbidden host')
        }
        const html = await readFile(resolve(server.config.root, server.config.build.outDir, 'index.html'), 'utf8')
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store') // a cached page would carry a dead token
        res.end(html.replace('</head>', `${meta()}</head>`))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), injectToken()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },   // npm run dev
  // allowedHosts is Vite's own Host check; the plugin above checks again for the page that carries the token.
  preview: { host: BIND_HOST, port: 8751, strictPort: true, allowedHosts: [...ALLOWED_HOSTS] },  // npm run serve
})
