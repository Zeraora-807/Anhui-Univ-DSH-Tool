import { AhuAcademicClient, InvalidCredentialsError } from './client.ts'
import {
  CredentialStore,
  eraseCredentials,
  type AhuCredentials,
} from './credential-store.ts'
import { LocalAuthorizationWeb } from './auth-web.ts'

export interface AuthorizationRequired {
  authorizationRequired: true
  authorizationUrl: 'http://127.0.0.1:3090/'
  message: string
}

const AUTH_REQUIRED: AuthorizationRequired = {
  authorizationRequired: true,
  authorizationUrl: 'http://127.0.0.1:3090/',
  message:
    'AHU login is waiting in the local browser. Complete authorization at '
    + 'http://127.0.0.1:3090/. Do not retry automatically; wait for the user '
    + 'to finish login and send a new message, then retry the AHU request.',
}

export class AcademicRuntime {
  private readonly store: CredentialStore
  private readonly authorization = new LocalAuthorizationWeb()

  private credentials?: AhuCredentials
  private client?: AhuAcademicClient

  private savedLoadPromise?: Promise<AhuAcademicClient | undefined>
  private browserAuthorizationPromise?: Promise<void>
  private lastAuthorizationError?: string

  constructor(storeDir: string) {
    this.store = new CredentialStore(storeDir)
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      service: 'ahu-academic-core',
      ready: true,
      authenticated: this.client !== undefined
        && (await this.client.status()).authenticated === true,
      savedCredentials: await this.store.hasSavedCredentials(),
      authorizationPending: this.browserAuthorizationPromise !== undefined,
      lastAuthorizationError: this.lastAuthorizationError,
      credentialStorage: process.platform === 'win32'
        ? 'windows-dpapi-current-user'
        : 'unsupported-on-this-platform',
      authUi: 'http://127.0.0.1:3090/',
    }
  }

  async withClient<T>(
    work: (client: AhuAcademicClient) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T | AuthorizationRequired> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = await this.ensureReadyOrStartAuthorization(signal)
      if (client === undefined) return AUTH_REQUIRED

      try {
        return await work(client)
      } catch (error) {
        if (!(error instanceof InvalidCredentialsError) || attempt > 0) throw error
        await this.invalidateCredentials()
      }
    }
    throw new Error('AHU authorization failed.')
  }

  async dispose(): Promise<void> {
    eraseCredentials(this.credentials)
    this.credentials = undefined
    this.client = undefined
  }

  private async ensureReadyOrStartAuthorization(
    signal: AbortSignal,
  ): Promise<AhuAcademicClient | undefined> {
    if (this.client !== undefined) return this.client

    // A browser login is already running in the isolated Core. Never await it
    // inside a Tool call, because the Web client may cancel long user-paced
    // calls after roughly 30 seconds.
    if (this.browserAuthorizationPromise !== undefined) return undefined

    const savedClient = await this.loadSavedCredentials(signal)
    if (savedClient !== undefined) return savedClient

    this.startBrowserAuthorization()
    return undefined
  }

  private async loadSavedCredentials(
    signal: AbortSignal,
  ): Promise<AhuAcademicClient | undefined> {
    if (this.savedLoadPromise !== undefined) return this.savedLoadPromise

    const promise = this.tryLoadSavedCredentials(signal)
    this.savedLoadPromise = promise
    try {
      return await promise
    } finally {
      if (this.savedLoadPromise === promise) this.savedLoadPromise = undefined
    }
  }

  private async tryLoadSavedCredentials(
    signal: AbortSignal,
  ): Promise<AhuAcademicClient | undefined> {
    let saved: AhuCredentials | undefined
    try {
      saved = await this.store.load()
    } catch {
      await this.store.clear().catch(() => {})
      return undefined
    }

    if (saved === undefined) return undefined

    const candidate = this.makeClient(saved)
    try {
      await candidate.authenticate(signal)
      this.credentials = saved
      this.client = candidate
      this.lastAuthorizationError = undefined
      return candidate
    } catch (error) {
      eraseCredentials(saved)
      if (error instanceof InvalidCredentialsError) {
        await this.store.clear()
        return undefined
      }
      throw error
    }
  }

  private startBrowserAuthorization(): void {
    if (this.browserAuthorizationPromise !== undefined) return

    this.lastAuthorizationError = undefined

    const promise = this.authorization.obtain(async credentials => {
      // Deliberately independent from the Tool call's AbortSignal. The local
      // Core owns this user-paced login flow.
      const candidate = this.makeClient(credentials)
      await candidate.authenticate()
      await this.store.save(credentials)
      return candidate
    }).then(({ credentials, value }) => {
      this.credentials = credentials
      this.client = value
      this.lastAuthorizationError = undefined
    }).catch(error => {
      this.lastAuthorizationError =
        error instanceof Error ? error.message : String(error)
    }).finally(() => {
      if (this.browserAuthorizationPromise === promise) {
        this.browserAuthorizationPromise = undefined
      }
    })

    this.browserAuthorizationPromise = promise
  }

  private makeClient(credentials: AhuCredentials): AhuAcademicClient {
    return new AhuAcademicClient({
      resolveCredentials: async () => credentials,
    })
  }

  private async invalidateCredentials(): Promise<void> {
    eraseCredentials(this.credentials)
    this.credentials = undefined
    this.client = undefined
    await this.store.clear()
  }
}
