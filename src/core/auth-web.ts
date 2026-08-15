import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { openLocalAuthorizationPage } from './browser.ts'
import type { AhuCredentials } from './credential-store.ts'

const HOST = '127.0.0.1'
const PORT = 3090
const MAX_BODY_BYTES = 32 * 1024

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function page(token: string, error?: string): string {
  const errorBlock = error === undefined
    ? ''
    : `<div class="error">${escapeHtml(error)}</div>`

  return `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>AHU Academic Authorization</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui,-apple-system,"Segoe UI",sans-serif; }

      * { box-sizing: border-box; }

      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f6f8; color: #17191c; }

      .card { width: min(92vw, 430px); background: white; border: 1px solid #e3e5e8; border-radius: 18px; padding: 28px; box-shadow: 0 14px 50px rgba(0,0,0,.08); }
      h1 { margin: 0 0 8px; font-size: 23px; }

      p { margin: 0 0 22px; color: #626971; line-height: 1.6; font-size: 14px; }

      label { display: block; margin: 14px 0 7px; font-size: 13px; font-weight: 650; }

      input { width: 100%; padding: 12px 13px; border: 1px solid #d8dbe0; border-radius: 11px; font: inherit; background: white; color: #17191c; outline: none; }

      input:focus { border-color: #7b8593; box-shadow: 0 0 0 3px rgba(90,100,115,.12); }

      button { width: 100%; margin-top: 20px; border: 0; border-radius: 11px; padding: 12px 14px; font: inherit; font-weight: 700; cursor: pointer; background: #17191c; color: white; }

      .hint { margin-top: 16px; padding-top: 16px; border-top: 1px solid #eceef1; font-size: 12px; color: #7b828a; line-height: 1.55; }

      .error { margin: 12px 0 6px; padding: 10px 12px; border-radius: 10px; background: #fff0f0; color: #9f2020; font-size: 13px; }

      @media (prefers-color-scheme: dark) {

        body { background: #111315; color: #f1f3f5; }

        .card { background: #1a1d20; border-color: #2b3035; box-shadow: none; }

        p,.hint { color: #aab0b7; }

        input { background: #141719; color: #f1f3f5; border-color: #343a40; }

        button { background: #f1f3f5; color: #17191c; }

        .hint { border-color: #2b3035; }

        .error { background: #3a1d1d; color: #ffb0b0; }

      }
    </style>
  </head>

  <body>
    <main class="card">
      <h1>Anhui Univ. Authorization</h1>
      ${errorBlock}
      <form method="post" action="/authorize" autocomplete="off">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <label for="username">Student ID</label>
        <input id="username" name="username" type="text" inputmode="text" autocomplete="off" required autofocus>
        <label for="password">Authentication Password</label>
        <input id="password" name="password" type="password" autocomplete="new-password" required>
        <button type="submit">Login</button>
      </form>
      <div class="hint">Confirm URL address is beginning with <strong>http://127.0.0.1:3090/</strong></div>
    </main>
  </body>
  </html>`
}

function successPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorization complete</title>
  <style>
    body { font-family: system-ui,-apple-system,"Segoe UI",sans-serif; margin: 0; min-height: 100vh; display:grid; place-items:center; background:#f5f6f8; color:#17191c; }
    main { width:min(90vw,420px); background:white; border:1px solid #e3e5e8; border-radius:18px; padding:30px; text-align:center; }
    h1 { font-size:22px; margin:0 0 10px; } p { color:#626971; line-height:1.6; margin:0; }
  </style>
</head>
<body><main><h1>Authorization Success!</h1><p>You can turn off this page and go back to DSH.</p></main></body>
</html>`
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  )
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  setSecurityHeaders(response)
  response.statusCode = status
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(html)
}

function sameToken(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(request: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(new Error('Authorization form is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}


export class LocalAuthorizationWeb {
  async obtain<T>(
    validate: (credentials: AhuCredentials) => Promise<T>,
  ): Promise<{ credentials: AhuCredentials; value: T }> {

    const token = randomBytes(32).toString('base64url')
    const authUrl = `http://${HOST}:${PORT}/authorize?token=${encodeURIComponent(token)}`

    return await new Promise<{ credentials: AhuCredentials; value: T }>((resolve, reject) => {
      let settled = false
      let submitting = false

      const server = http.createServer((request, response) => {
        void (async () => {
          const host = request.headers.host
          if (host !== `${HOST}:${PORT}`) {
            response.statusCode = 400
            response.end('Bad Host')
            return
          }

          const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
          if (request.method === 'GET' && url.pathname === '/') {
            setSecurityHeaders(response)
            response.statusCode = 302
            response.setHeader('Location', `/authorize?token=${encodeURIComponent(token)}`)
            response.end()
            return
          }

          if (request.method === 'GET' && url.pathname === '/authorize') {
            const supplied = url.searchParams.get('token') ?? ''
            if (!sameToken(token, supplied)) {
              sendHtml(
                response,
                403,
                page(token, '这个授权链接已经失效。请直接访问 http://127.0.0.1:3090/ 获取当前授权页。'),
              )
              return
            }
            sendHtml(response, 200, page(token))
            return
          }

          if (request.method === 'POST' && url.pathname === '/authorize') {
            const origin = request.headers.origin
            if (origin !== undefined && origin !== 'null' && origin !== `http://${HOST}:${PORT}`) {
              sendHtml(
                response,
                403,
                page(
                  token,
                  `安全检查失败：Origin 不匹配（${origin}）。请从 http://${HOST}:${PORT}/ 重新进入授权页。`,
                ),
              )
              return
            }
            if (submitting) {
              sendHtml(response, 409, page(token, '正在验证上一份登录信息，请稍候。'))
              return
            }

            let body: string
            try {
              body = await readBody(request)
            } catch (error) {
              sendHtml(response, 413, page(token, error instanceof Error ? error.message : '提交内容过大。'))
              return
            }

            const form = new URLSearchParams(body)
            const suppliedToken = form.get('token') ?? ''
            if (!sameToken(token, suppliedToken)) {
              sendHtml(
                response,
                403,
                page(
                  token,
                  '安全检查失败：授权 token 无效或已过期。请重新打开 http://127.0.0.1:3090/ 再登录。',
                ),
              )
              return
            }

            const credentials: AhuCredentials = {
              username: (form.get('username') ?? '').trim(),
              password: form.get('password') ?? '',
            }
            if (!credentials.username || !credentials.password) {
              sendHtml(response, 400, page(token, '学号和密码不能为空。'))
              return
            }

            submitting = true
            try {
              const value = await validate(credentials)
              sendHtml(response, 200, successPage())
              finish(undefined, { credentials, value })
            } catch (error) {
              credentials.username = ''
              credentials.password = ''
              submitting = false
              const message = error instanceof Error ? error.message : '认证失败，请重试。'
              sendHtml(response, 401, page(token, message))
            }
            return
          }

          response.statusCode = 404
          response.end('Not Found')
        })().catch(error => {
          if (!response.headersSent) sendHtml(response, 500, page(token, '本地授权服务发生错误。'))
          if (!settled) finish(error instanceof Error ? error : new Error('Local authorization failed.'))
        })
      })

      const cleanup = (): void => {
        server.close()
      }

      const finish = (
        error?: Error,
        result?: { credentials: AhuCredentials; value: T },
      ): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== undefined) reject(error)
        else resolve(result!)
      }

      server.once('error', error => {
        const nodeError = error as NodeJS.ErrnoException
        if (nodeError.code === 'EADDRINUSE') {
          finish(new Error('AHU authorization cannot start because 127.0.0.1:3090 is already in use.'))
        } else {
          finish(error)
        }
      })

      server.listen(PORT, HOST, () => {
        // Browser opening is convenience only. Even if Windows refuses to open
        // it automatically, http://127.0.0.1:3090/ remains a valid fallback.
        void openLocalAuthorizationPage(authUrl).catch(() => undefined)
      })
    })
  }
}
