$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$basePackage = Join-Path $root 'packages\bundle\base\package.json'
$baseCordis  = Join-Path $root 'packages\bundle\base\cordis.patch.yml'
$hostTsconfig = Join-Path $root 'tsconfig.host.json'
$toolPackage = Join-Path $root 'packages\extensions\tool-ahu-academic\package.json'

foreach ($path in @($basePackage, $baseCordis, $hostTsconfig, $toolPackage)) {
  if (!(Test-Path $path)) { throw "Required file not found: $path" }
}

# 1. Add workspace dependency to dsh-base.
$pkg = Get-Content $basePackage -Raw
if ($pkg -notmatch [regex]::Escape('"@deepseek-ai/dsh-tool-ahu-academic"')) {
  $marker = '    "@deepseek-ai/dsh-tool-fs": "workspace:^",'
  $line = '    "@deepseek-ai/dsh-tool-ahu-academic": "workspace:^",'
  if ($pkg.Contains($marker)) {
    $pkg = $pkg.Replace($marker, "$marker`r`n$line")
  } else {
    $deps = '  "dependencies": {'
    if (!$pkg.Contains($deps)) { throw 'Could not find dsh-base dependencies.' }
    $pkg = $pkg.Replace($deps, "$deps`r`n$line")
  }
  Set-Content $basePackage $pkg -Encoding utf8 -NoNewline
  Write-Host '[AHU] Added dsh-base dependency.'
}

# 2. Add Cordis row to default bundle.
$cordis = Get-Content $baseCordis -Raw
if ($cordis -notmatch '(?m)^\s*-\s+id:\s+tool-ahu-academic\s*$') {
  $entry = @"
    - id: tool-ahu-academic
      name: '@deepseek-ai/dsh-tool-ahu-academic'

"@
  $marker = @"
    - id: tool-fs
      name: '@deepseek-ai/dsh-tool-fs'

"@
  if ($cordis.Contains($marker)) {
    $cordis = $cordis.Replace($marker, "$marker$entry")
  } else {
    $fallback = '    - id: tool-jobs'
    $index = $cordis.IndexOf($fallback)
    if ($index -lt 0) { throw 'Could not find a Tool section in dsh-base Cordis patch.' }
    $cordis = $cordis.Insert($index, $entry)
  }
  Set-Content $baseCordis $cordis -Encoding utf8 -NoNewline
  Write-Host '[AHU] Added native Cordis row.'
}

# 3. Add host TypeScript project reference, so normal repo typechecking sees it.
$hostConfigText = Get-Content $hostTsconfig -Raw
if ($hostConfigText -notmatch [regex]::Escape('./packages/extensions/tool-ahu-academic')) {
  $marker = '    { "path": "./packages/extensions/tool-cordis" },'
  $line = '    { "path": "./packages/extensions/tool-ahu-academic" },'
  if (!$hostConfigText.Contains($marker)) { throw 'Could not find extensions/tool-cordis project reference.' }
  $hostConfigText = $hostConfigText.Replace($marker, "$marker`r`n$line")
  Set-Content $hostTsconfig $hostConfigText -Encoding utf8 -NoNewline
  Write-Host '[AHU] Added tsconfig.host project reference.'
}

Write-Host '[AHU] Refreshing pnpm workspace...'
pnpm install
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Installed native AHU Academic Tool.'
Write-Host 'Start DSH normally: pnpm dsh web'
