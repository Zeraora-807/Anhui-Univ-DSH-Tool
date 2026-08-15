import os from 'node:os'
import path from 'node:path'

export interface BrokerRequest {
  id: string
  token: string
  method: string
  params?: Record<string, unknown>
}

export interface BrokerResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: {
    code?: string
    message?: string
  }
}

export function makeBrokerEndpoint(suffix: string): string {
  if (!/^[a-f0-9]{24,64}$/i.test(suffix)) {
    throw new Error('Invalid AHU broker endpoint suffix.')
  }
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dsh-ahu-academic-v2-${suffix}`
  }
  return path.join(os.tmpdir(), `dsh-ahu-academic-${suffix}.sock`)
}
