import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  protectForCurrentWindowsUser,
  unprotectForCurrentWindowsUser,
} from './dpapi.ts'

export interface AhuCredentials {
  username: string
  password: string
}

interface StoredCredentials {
  version: 1
  username: string
  password: string
}

const MAGIC = Buffer.from('DSH-AHU-DPAPI-V1\0', 'utf8')

function validCredential(value: unknown): value is StoredCredentials {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.version === 1
    && typeof record.username === 'string'
    && record.username.trim().length > 0
    && typeof record.password === 'string'
    && record.password.length > 0
}

export class CredentialStore {
  readonly filePath: string

  constructor(storeDir: string) {
    this.filePath = path.join(storeDir, 'credentials.dpapi')
  }

  async hasSavedCredentials(): Promise<boolean> {
    try {
      await fs.access(this.filePath)
      return true
    } catch {
      return false
    }
  }

  async load(): Promise<AhuCredentials | undefined> {
    let file: Buffer
    try {
      file = await fs.readFile(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }

    if (file.length <= MAGIC.length || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Saved AHU credential file has an unknown format.')
    }

    const encrypted = file.subarray(MAGIC.length)
    const plaintext = await unprotectForCurrentWindowsUser(encrypted)
    try {
      const decoded = JSON.parse(plaintext.toString('utf8')) as unknown
      if (!validCredential(decoded)) {
        throw new Error('Saved AHU credential payload is invalid.')
      }
      return {
        username: decoded.username,
        password: decoded.password,
      }
    } finally {
      plaintext.fill(0)
    }
  }

  async save(credentials: AhuCredentials): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('Saving AHU credentials is supported only on Windows.')
    }

    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })

    const plaintext = Buffer.from(JSON.stringify({
      version: 1,
      username: credentials.username,
      password: credentials.password,
    } satisfies StoredCredentials), 'utf8')

    const encrypted = await protectForCurrentWindowsUser(plaintext)
    const file = Buffer.concat([MAGIC, encrypted])
    const temp = `${this.filePath}.${randomUUID()}.tmp`

    try {
      await fs.writeFile(temp, file, { mode: 0o600, flag: 'wx' })
      await fs.rename(temp, this.filePath)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true })
  }
}

export function eraseCredentials(credentials: AhuCredentials | undefined): void {
  if (credentials === undefined) return
  credentials.username = ''
  credentials.password = ''
}
