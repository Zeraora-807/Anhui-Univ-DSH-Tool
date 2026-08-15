import { spawn, type ChildProcess } from 'node:child_process'
import crypto, { randomBytes } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeBrokerEndpoint, type BrokerResponse } from './core/protocol.ts'

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

class CoreUnavailableError extends Error {
  constructor() {
    super('AHU Academic Core is not running.')
    this.name = 'CoreUnavailableError'
  }
}

function abortError(): Error {
  const error = new Error('AHU tool call aborted.')
  error.name = 'AbortError'
  return error
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    function done(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function minimalCoreEnvironment(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export class AhuCoreBridge {
  private readonly brokerToken = randomBytes(32).toString('base64url')
  private readonly endpointSuffix = randomBytes(16).toString('hex')
  private readonly endpoint = makeBrokerEndpoint(this.endpointSuffix)
  private child?: ChildProcess
  private startPromise?: Promise<void>

  async call(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    await this.ensureRunning(signal)
    return this.request(method, params, signal)
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill()
    }
  }

  private async ensureRunning(signal: AbortSignal): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('AHU Academic persistent authorization currently requires Windows.')
    }

    if (
      this.child !== undefined
      && this.child.exitCode === null
      && this.child.signalCode === null
    ) {
      try {
        await this.request('status', {}, signal)
        return
      } catch (error) {
        if (!(error instanceof CoreUnavailableError)) throw error
      }
    }

    if (this.startPromise !== undefined) return this.startPromise
    const promise = this.startCore(signal)
    this.startPromise = promise
    try {
      await promise
    } finally {
      if (this.startPromise === promise) this.startPromise = undefined
    }
  }

  private async startCore(signal: AbortSignal): Promise<void> {
    const sourceRuntime = import.meta.url.endsWith('/src/bridge.ts')
      || import.meta.url.endsWith('\\src\\bridge.ts')
    const coreEntry = fileURLToPath(new URL(
      sourceRuntime ? './core/server.ts' : './core/server.js',
      import.meta.url,
    ))
    const packageRoot = fileURLToPath(new URL('..', import.meta.url))
    const dshHome = process.env.DSH_HOME?.trim()
      || path.join(os.homedir(), '.dsh')
    const storeDir = path.join(dshHome, 'ahu-academic')

    const child = spawn(
      process.execPath,
      [
        ...(sourceRuntime ? ['--import', 'tsx/esm'] : []),
        coreEntry,
        '--parent-pid',
        String(process.pid),
        '--store-dir',
        storeDir,
        '--endpoint-suffix',
        this.endpointSuffix,
        '--broker-token',
        this.brokerToken,
      ],
      {
        cwd: packageRoot,
        env: minimalCoreEnvironment(),
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    this.child = child

    child.once('exit', () => {
      if (this.child === child) this.child = undefined
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        child.removeListener('spawn', onSpawn)
        reject(new Error(`Failed to start AHU Academic Core: ${error.message}`))
      }
      const onSpawn = () => {
        child.removeListener('error', onError)
        resolve()
      }
      child.once('error', onError)
      child.once('spawn', onSpawn)
    })

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (signal.aborted) throw abortError()
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('AHU Academic Core exited during startup.')
      }
      try {
        await this.request('status', {}, signal)
        return
      } catch (error) {
        if (!(error instanceof CoreUnavailableError)) throw error
      }
      await delay(100, signal)
    }
    throw new Error('Timed out while starting AHU Academic Core.')
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) return Promise.reject(abortError())

    const id = crypto.randomUUID()
    const payload = `${JSON.stringify({ id, token: this.brokerToken, method, params })}\n`

    return new Promise<unknown>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint)
      socket.setEncoding('utf8')
      let buffer = ''
      let settled = false

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
        socket.removeAllListeners()
        if (!socket.destroyed) socket.destroy()
      }
      const succeed = (value: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => fail(abortError())
      signal.addEventListener('abort', onAbort, { once: true })

      socket.once('connect', () => socket.write(payload))
      socket.on('data', chunk => {
        buffer += chunk
        if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
          fail(new Error('AHU Academic Core response exceeded the size limit.'))
          return
        }
        const newline = buffer.indexOf('\n')
        if (newline < 0) return

        let response: BrokerResponse
        try {
          response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse
        } catch {
          fail(new Error('AHU Academic Core returned malformed IPC data.'))
          return
        }

        if (response.id !== id) {
          fail(new Error('AHU Academic Core returned a mismatched response.'))
          return
        }
        if (!response.ok) {
          const code = response.error?.code ?? 'AHU_CORE_ERROR'
          const message = response.error?.message ?? 'AHU Academic Core request failed.'
          const error = new Error(`${code}: ${message}`)
          Object.assign(error, { code })
          fail(error)
          return
        }
        succeed(response.result)
      })

      socket.once('error', error => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE') {
          fail(new CoreUnavailableError())
          return
        }
        fail(new Error(`AHU Academic Core IPC connection failed: ${error.message}`))
      })
    })
  }
}
