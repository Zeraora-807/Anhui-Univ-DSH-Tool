import * as http from 'node:http'
import * as https from 'node:https'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

export interface HttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
  url: string
}

interface StoredCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  expiresAt?: number
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>()

  clear(): void {
    this.cookies.clear()
  }

  deleteForHost(host: string): void {
    for (const [key, cookie] of this.cookies) {
      if (domainMatches(host, cookie.domain)) this.cookies.delete(key)
    }
  }

  get(name: string, host?: string): string | undefined {
    const now = Date.now()
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(key)
        continue
      }
      if (cookie.name !== name) continue
      if (host !== undefined && !domainMatches(host, cookie.domain)) continue
      return cookie.value
    }
    return undefined
  }

  header(url: URL): string | undefined {
    const now = Date.now()
    const matches: StoredCookie[] = []

    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(key)
        continue
      }
      if (!domainMatches(url.hostname, cookie.domain)) continue
      if (!url.pathname.startsWith(cookie.path)) continue
      if (cookie.secure && url.protocol !== 'https:') continue
      matches.push(cookie)
    }

    if (matches.length === 0) return undefined
    return matches.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }

  store(url: URL, setCookieHeaders: string[] | undefined): void {
    if (!setCookieHeaders) return

    for (const header of setCookieHeaders) {
      const parts = header.split(';').map(part => part.trim())
      const first = parts.shift()
      if (!first) continue

      const separator = first.indexOf('=')
      if (separator <= 0) continue

      const name = first.slice(0, separator).trim()
      const value = first.slice(separator + 1)
      let domain = url.hostname.toLowerCase()
      let path = '/'
      let secure = false
      let expiresAt: number | undefined
      let maxAge: number | undefined

      for (const attribute of parts) {
        const eq = attribute.indexOf('=')
        const key = (eq >= 0 ? attribute.slice(0, eq) : attribute).trim().toLowerCase()
        const rawValue = eq >= 0 ? attribute.slice(eq + 1).trim() : ''
        if (key === 'domain' && rawValue) domain = rawValue.replace(/^\./, '').toLowerCase()
        else if (key === 'path' && rawValue) path = rawValue
        else if (key === 'secure') secure = true
        else if (key === 'expires' && rawValue) {
          const parsed = Date.parse(rawValue)
          if (!Number.isNaN(parsed)) expiresAt = parsed
        } else if (key === 'max-age' && rawValue) {
          const parsed = Number(rawValue)
          if (Number.isFinite(parsed)) maxAge = parsed
        }
      }

      if (maxAge !== undefined) expiresAt = Date.now() + maxAge * 1000
      const storageKey = `${domain}|${path}|${name}`

      if (value === '' || maxAge === 0 || (expiresAt !== undefined && expiresAt <= Date.now())) {
        this.cookies.delete(storageKey)
      } else {
        this.cookies.set(storageKey, { name, value, domain, path, secure, expiresAt })
      }
    }
  }
}

function domainMatches(host: string, domain: string): boolean {
  const normalizedHost = host.toLowerCase()
  const normalizedDomain = domain.toLowerCase().replace(/^\./, '')
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`)
}

function abortError(): Error {
  const error = new Error('Request aborted')
  error.name = 'AbortError'
  return error
}

export interface RequestOptions {
  method?: string
  headers?: OutgoingHttpHeaders
  body?: string | Buffer
  signal?: AbortSignal
  followRedirects?: boolean
  maxRedirects?: number
}

export class HttpClient {
  readonly jar = new CookieJar()
  private readonly insecureCampusHosts: Set<string>

  constructor(insecureCampusHosts = new Set<string>()) {
    this.insecureCampusHosts = insecureCampusHosts
  }

  async request(input: string | URL, options: RequestOptions = {}): Promise<HttpResponse> {
    const follow = options.followRedirects ?? false
    const maxRedirects = options.maxRedirects ?? 10
    let currentUrl = typeof input === 'string' ? new URL(input) : new URL(input.toString())
    let method = (options.method ?? 'GET').toUpperCase()
    let body = options.body
    let headers = { ...(options.headers ?? {}) }

    for (let redirectCount = 0; ; redirectCount++) {
      const response = await this.requestOnce(currentUrl, {
        method,
        headers,
        body,
        signal: options.signal,
      })

      if (!follow || !isRedirect(response.status) || !response.headers.location) return response
      if (redirectCount >= maxRedirects) throw new Error(`Too many redirects while requesting ${input}`)

      currentUrl = new URL(response.headers.location, currentUrl)
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        headers = { ...headers }
        deleteHeader(headers, 'content-type')
        deleteHeader(headers, 'content-length')
      }
    }
  }

  private requestOnce(url: URL, options: RequestOptions): Promise<HttpResponse> {
    if (options.signal?.aborted) return Promise.reject(abortError())

    return new Promise<HttpResponse>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http
      const headers: OutgoingHttpHeaders = {
        'Accept-Encoding': 'identity',
        ...options.headers,
      }
      const cookieHeader = this.jar.header(url)
      if (cookieHeader && !hasHeader(headers, 'cookie')) headers.Cookie = cookieHeader

      const request = transport.request(url, {
        method: options.method ?? 'GET',
        headers,
        ...(url.protocol === 'https:' ? {
          rejectUnauthorized: !this.insecureCampusHosts.has(url.hostname.toLowerCase()),
        } : {}),
      }, response => {
        this.jar.store(url, response.headers['set-cookie'])
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on('end', () => {
          cleanupAbort()
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            url: url.toString(),
          })
        })
      })

      const onAbort = (): void => {
        request.destroy(abortError())
      }
      const cleanupAbort = (): void => options.signal?.removeEventListener('abort', onAbort)
      options.signal?.addEventListener('abort', onAbort, { once: true })

      request.on('error', error => {
        cleanupAbort()
        reject(error)
      })

      if (options.body !== undefined) request.write(options.body)
      request.end()
    })
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function hasHeader(headers: OutgoingHttpHeaders, name: string): boolean {
  const target = name.toLowerCase()
  return Object.keys(headers).some(key => key.toLowerCase() === target)
}

function deleteHeader(headers: OutgoingHttpHeaders, name: string): void {
  const target = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) delete headers[key]
  }
}
