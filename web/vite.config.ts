import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The web app is its own program. It calls the backend directly at VITE_API_URL (default
// http://127.0.0.1:8750) -- no proxy -- and the backend allows these two origins. Both
// listen on 127.0.0.1 only, like the backend: nothing here is for another machine.

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])

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
  const token = process.env.ASSISTANT_TOKEN ?? ''
  const meta = () => `<meta name="assistant-token" content="${token.replace(/[^A-Za-z0-9_-]/g, '')}">`
  const local = (host: string | undefined) => LOCAL_HOSTS.has((host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''))

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
        if (!local(req.headers.host)) {
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
  preview: { host: '127.0.0.1', port: 8751, strictPort: true },  // npm run serve
})
