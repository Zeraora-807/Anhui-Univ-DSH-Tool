import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { AcademicRuntime } from './runtime.ts'
import {
  makeBrokerEndpoint,
  type BrokerRequest,
  type BrokerResponse,
} from './protocol.ts'

const MAX_REQUEST_BYTES = 64 * 1024
const IDLE_EXIT_MS = 30 * 60 * 1000

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const parentPid = Number(arg('--parent-pid') ?? '0')
const storeDir = arg('--store-dir')
  ?? path.join(os.homedir(), '.dsh', 'ahu-academic')
const endpointSuffix = arg('--endpoint-suffix') ?? ''
const brokerToken = arg('--broker-token') ?? ''
if (!brokerToken) throw new Error('AHU Academic Core requires a broker capability token.')

const endpoint = makeBrokerEndpoint(endpointSuffix)
const runtime = new AcademicRuntime(storeDir)
let queue: Promise<unknown> = Promise.resolve()
let activeRequests = 0
let lastActivity = Date.now()
let shuttingDown = false

const SENSITIVE_OUTPUT_KEYS = new Set([
  'password', 'passwd', 'pwd', 'rsa', 'lt', 'execution', 'ticket', 'cookie',
  'setcookie', 'castgc', 'session', 'username', 'loginname', 'account',
  'studentid', 'studentno', 'studentnumber', 'studentcode', 'studentname',
  'stuid', 'stuno', 'sno', 'xh', 'idcard', 'identitycard', 'identitynumber',
  'mobile', 'phone', 'email',
])

function scrubForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubForModel)
  if (value === null || typeof value !== 'object') return value

  const source = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (SENSITIVE_OUTPUT_KEYS.has(normalized)) continue
    if (/^(?:student|user|account).*(?:id|no|number|code|name)$/.test(normalized)) continue
    if (normalized === 'student' || normalized === 'user' || normalized === 'person') continue
    output[key] = scrubForModel(item)
  }
  return output
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.then(() => undefined, () => undefined)
  return next
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`)
  }
  return value
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
  required = false,
): string | undefined {
  const value = params[key]
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${key} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function booleanParam(
  params: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = params[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function numberArrayParam(params: Record<string, unknown>, key: string): number[] {
  const value = params[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(
    item => typeof item !== 'number' || !Number.isFinite(item),
  )) {
    throw new Error(`${key} must be an array of numbers`)
  }
  return value as number[]
}

function validBrokerToken(candidate: string): boolean {
  const expected = Buffer.from(brokerToken, 'utf8')
  const actual = Buffer.from(candidate, 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function dispatchRaw(
  request: BrokerRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const params = request.params ?? {}

  if (request.method === 'status') return runtime.status()

  return runtime.withClient(async academic => {
    switch (request.method) {
      case 'semesters':
        return academic.getSemesters(signal)
      case 'schedule':
        return academic.getSchedule(numberParam(params, 'semesterId'), signal)
      case 'schedule.today':
        return academic.getTodaySchedule(numberParam(params, 'semesterId'), signal)
      case 'schedule.week':
        return academic.getWeekSchedule(
          numberParam(params, 'week'),
          numberParam(params, 'semesterId'),
          signal,
        )
      case 'grades':
        return academic.getGrades(numberParam(params, 'semesterId'), signal)
      case 'exams':
        return academic.getExams(booleanParam(params, 'includeFinished', true), signal)
      case 'rooms.free':
        return academic.getFreeRooms(
          stringParam(params, 'campusId', true)!,
          stringParam(params, 'buildingId', true)!,
          numberArrayParam(params, 'units'),
          stringParam(params, 'date'),
          signal,
        )
      case 'rooms.building':
        return academic.getBuildingRooms(
          stringParam(params, 'buildingId', true)!,
          signal,
        )
      default:
        throw Object.assign(new Error('Unknown AHU Academic Core method.'), {
          code: 'UNKNOWN_METHOD',
        })
    }
  }, signal)
}

async function dispatch(
  request: BrokerRequest,
  signal: AbortSignal,
): Promise<unknown> {
  return scrubForModel(await dispatchRaw(request, signal))
}

function errorResponse(id: string, error: unknown): BrokerResponse {
  const record = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : {}
  const code = typeof record.code === 'string' ? record.code : 'AHU_CORE_ERROR'
  const message = error instanceof Error
    ? error.message
    : 'AHU Academic Core request failed.'
  return { id, ok: false, error: { code, message } }
}

function writeResponse(socket: net.Socket, response: BrokerResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`)
}

if (process.platform !== 'win32' && fs.existsSync(endpoint)) fs.unlinkSync(endpoint)

const server = net.createServer(socket => {
  lastActivity = Date.now()
  activeRequests += 1
  socket.setEncoding('utf8')

  let buffer = ''
  let dispatched = false
  const controller = new AbortController()

  const finishRequest = (): void => {
    activeRequests = Math.max(0, activeRequests - 1)
    lastActivity = Date.now()
  }
  socket.once('close', finishRequest)

  socket.on('data', chunk => {
    if (dispatched) return
    buffer += chunk
    if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
      dispatched = true
      writeResponse(socket, {
        id: 'unknown',
        ok: false,
        error: { code: 'REQUEST_TOO_LARGE', message: 'Request too large.' },
      })
      return
    }

    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    dispatched = true

    let request: BrokerRequest
    try {
      request = JSON.parse(buffer.slice(0, newline)) as BrokerRequest
      if (
        request === null
        || typeof request !== 'object'
        || typeof request.id !== 'string'
        || typeof request.token !== 'string'
        || typeof request.method !== 'string'
      ) {
        throw new Error('Malformed broker request.')
      }
      if (!validBrokerToken(request.token)) {
        throw Object.assign(new Error('Unauthorized broker request.'), {
          code: 'BROKER_UNAUTHORIZED',
        })
      }
    } catch (error) {
      writeResponse(socket, errorResponse('unknown', error))
      return
    }

    void enqueue(() => dispatch(request, controller.signal))
      .then(result => writeResponse(socket, { id: request.id, ok: true, result }))
      .catch(error => writeResponse(socket, errorResponse(request.id, error)))
  })

  socket.on('close', () => controller.abort())
  socket.on('error', () => controller.abort())
})

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await new Promise<void>(resolve => server.close(() => resolve()))
  await runtime.dispose()
  if (process.platform !== 'win32' && fs.existsSync(endpoint)) {
    fs.unlinkSync(endpoint)
  }
}

const watchdog = setInterval(() => {
  if (parentPid > 0) {
    try {
      process.kill(parentPid, 0)
    } catch {
      void shutdown().finally(() => process.exit(0))
      return
    }
  }

  if (activeRequests === 0 && Date.now() - lastActivity >= IDLE_EXIT_MS) {
    void shutdown().finally(() => process.exit(0))
  }
}, 15_000)
watchdog.unref()

server.listen(endpoint)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0))
  })
}
