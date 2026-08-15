interface BlobInput {
  cbData: number
  pbData: Buffer
}

interface BlobOutput {
  cbData?: number
  pbData?: bigint | null
}

type CryptProtectData = (
  input: BlobInput,
  description: string | null,
  entropy: null,
  reserved: null,
  prompt: null,
  flags: number,
  output: BlobOutput,
) => number

type CryptUnprotectData = (
  input: BlobInput,
  description: null,
  entropy: null,
  reserved: null,
  prompt: null,
  flags: number,
  output: BlobOutput,
) => number

interface DpapiBindings {
  readonly cryptProtectData: CryptProtectData
  readonly cryptUnprotectData: CryptUnprotectData
  readonly localFree: (memory: bigint) => bigint | null
  readonly getLastError: () => number
  readonly view: (pointer: bigint, length: number) => ArrayBuffer
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1
let cached: DpapiBindings | undefined

async function bindings(): Promise<DpapiBindings> {
  if (process.platform !== 'win32') {
    throw new Error('Persistent AHU credential storage requires Windows DPAPI.')
  }
  if (cached !== undefined) return cached

  const koffi = (await import('koffi')).default
  koffi.struct('DSH_AHU_DATA_BLOB', {
    cbData: 'uint32_t',
    pbData: 'void *',
  })

  const crypt32 = koffi.load('crypt32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  cached = {
    cryptProtectData: crypt32.func(
      'int __stdcall CryptProtectData(DSH_AHU_DATA_BLOB *input, const char16_t *description, DSH_AHU_DATA_BLOB *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ DSH_AHU_DATA_BLOB *output)',
    ) as unknown as CryptProtectData,
    cryptUnprotectData: crypt32.func(
      'int __stdcall CryptUnprotectData(DSH_AHU_DATA_BLOB *input, void *description, DSH_AHU_DATA_BLOB *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ DSH_AHU_DATA_BLOB *output)',
    ) as unknown as CryptUnprotectData,
    localFree: kernel32.func(
      'void * __stdcall LocalFree(void *memory)',
    ) as unknown as (memory: bigint) => bigint | null,
    getLastError: kernel32.func(
      'uint32_t __stdcall GetLastError()',
    ) as unknown as () => number,
    view: (pointer, length) => koffi.view(pointer, length),
  }
  return cached
}

function outputBytes(api: DpapiBindings, output: BlobOutput): Buffer {
  const pointer = output.pbData
  const length = output.cbData
  if (pointer === undefined || pointer === null || length === undefined || length <= 0) {
    throw new Error('Windows DPAPI returned an empty data blob.')
  }

  try {
    const external = api.view(pointer, length)
    const nativeBytes = new Uint8Array(external)
    const copy = Buffer.from(nativeBytes)
    nativeBytes.fill(0)
    return copy
  } finally {
    api.localFree(pointer)
  }
}

function dpapiError(operation: string, code: number): Error {
  return new Error(`${operation} failed with Win32 error ${code}.`)
}

export async function protectForCurrentWindowsUser(plaintext: Buffer): Promise<Buffer> {
  const api = await bindings()
  const output: BlobOutput = {}
  const input: BlobInput = { cbData: plaintext.length, pbData: plaintext }

  try {
    const ok = api.cryptProtectData(
      input,
      'DSH AHU Academic credentials',
      null,
      null,
      null,
      CRYPTPROTECT_UI_FORBIDDEN,
      output,
    )
    if (ok === 0) throw dpapiError('CryptProtectData', api.getLastError())
    return outputBytes(api, output)
  } finally {
    plaintext.fill(0)
  }
}

export async function unprotectForCurrentWindowsUser(ciphertext: Buffer): Promise<Buffer> {
  const api = await bindings()
  const output: BlobOutput = {}
  const input: BlobInput = { cbData: ciphertext.length, pbData: ciphertext }

  const ok = api.cryptUnprotectData(
    input,
    null,
    null,
    null,
    null,
    CRYPTPROTECT_UI_FORBIDDEN,
    output,
  )
  if (ok === 0) throw dpapiError('CryptUnprotectData', api.getLastError())
  return outputBytes(api, output)
}
