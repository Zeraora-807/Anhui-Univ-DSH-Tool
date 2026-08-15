$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$basePackage = Join-Path $root 'packages\bundle\base\package.json'
$baseCordis  = Join-Path $root 'packages\bundle\base\cordis.patch.yml'
$hostTsconfig = Join-Path $root 'tsconfig.host.json'

$pkg = Get-Content $basePackage -Raw
$pkg = [regex]::Replace(
  $pkg,
  '(?m)^\s*"@deepseek-ai/dsh-tool-ahu-academic":\s*"workspace:\^",\r?\n',
  ''
)
Set-Content $basePackage $pkg -Encoding utf8 -NoNewline

$cordis = Get-Content $baseCordis -Raw
$cordis = [regex]::Replace(
  $cordis,
  "(?ms)^\s{4}- id: tool-ahu-academic\r?\n\s{6}name: '@deepseek-ai/dsh-tool-ahu-academic'\r?\n\r?\n?",
  ''
)
Set-Content $baseCordis $cordis -Encoding utf8 -NoNewline

$hostConfigText = Get-Content $hostTsconfig -Raw
$hostConfigText = [regex]::Replace(
  $hostConfigText,
  '(?m)^\s*\{ "path": "\./packages/extensions/tool-ahu-academic" \},\r?\n',
  ''
)
Set-Content $hostTsconfig $hostConfigText -Encoding utf8 -NoNewline

pnpm install
Write-Host 'AHU Tool removed from the default bundle. Yet confidential data is still available in the original path.'
