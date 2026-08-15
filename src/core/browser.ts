import { spawn } from 'node:child_process'

export async function openLocalAuthorizationPage(url: string): Promise<void> {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.port !== '3090'
  ) {
    throw new Error('Refusing to open a non-local AHU authorization URL.')
  }

  let command: string
  let args: string[]

  if (process.platform === 'win32') {
    // Fixed Windows URL protocol handler. No PowerShell, no cmd.exe, and
    // the URL is generated internally rather than supplied by the model.
    command = 'rundll32.exe'
    args = ['url.dll,FileProtocolHandler', url]
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
