<#
.SYNOPSIS
  dsh-hooks-plugin one-shot release + hot-install pipeline.

.DESCRIPTION
  Steps:
    1) node --check index.mjs client/index.js
    2) node --test test/core.test.mjs            (aborts unless green)
    3) bump version (patch+1, or -Version)
    4) npm pack
    5) npm publish                                (-CheckOnly stops here)
    6) poll npm registry until the new version is visible (kills the
       "published but registry lags -> hot install fails" race)
    7) dsh plugin --profile web add <pkg>@<ver>
    8) assert: installed version == ver / health=ok / recent 200

.EXAMPLE
  ./scripts/release.ps1                # patch+1, publish & install
  ./scripts/release.ps1 -Version 0.3.0 # explicit version
  ./scripts/release.ps1 -CheckOnly     # check only, changes nothing
#>
param(
  [string]$Version = '',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$root = (Get-Location).Path

Write-Host '==> [1/8] syntax check'
node --check index.mjs
if ($LASTEXITCODE -ne 0) { throw 'index.mjs syntax failed' }
node --check client/index.js
if ($LASTEXITCODE -ne 0) { throw 'client/index.js syntax failed' }
node --check test/core.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'test/core.test.mjs syntax failed' }

Write-Host '==> [2/8] unit tests'
node --test test/core.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'unit tests failed' }

$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$current = $pkg.version
if (-not $Version) {
  $m = [regex]::Match($current, '^(\d+)\.(\d+)\.(\d+)$')
  if (-not $m.Success) { throw "cannot derive next version from $current; use -Version" }
  $Version = '{0}.{1}.{2}' -f $m.Groups[1].Value, $m.Groups[2].Value, ([int]$m.Groups[3].Value + 1)
}
Write-Host "==> version: $current -> $Version"

Write-Host '==> [3/8] npm pack sanity'
npm pack --quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }

if ($CheckOnly) {
  Write-Host '[CheckOnly] stopped here: package.json untouched, nothing published/installed.'
  Write-Host "[CheckOnly] passed: node --check / node --test / npm pack / version derivation ($current -> $Version)"
  exit 0
}

Write-Host '==> [4/8] write version back to package.json'
$raw = Get-Content (Join-Path $root 'package.json') -Raw
$raw = $raw -replace '"version":\s*"[^"]+"', ('"version": "{0}"' -f $Version)
# Windows PowerShell 5.1 的 Set-Content -Encoding utf8 会写 BOM，导致 hot-installer
# 的严格 JSON.parse 失败并回滚（0.2.13 事故）。这里用 UTF8 无 BOM 写。
[System.IO.File]::WriteAllText((Join-Path $root 'package.json'), $raw, (New-Object System.Text.UTF8Encoding($false)))

Write-Host '==> [5/8] npm publish'
npm publish
if ($LASTEXITCODE -ne 0) { throw 'npm publish failed' }

Write-Host '==> [6/8] wait for npm registry propagation'
$latest = ''
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  $latest = npm view dsh-hooks-plugin dist-tags.latest --json --prefer-online 2>$null | ConvertFrom-Json
  if ($latest -eq $Version) { $ok = $true; break }
  Write-Host "  propagating... latest=$latest (want=$Version) [try $($i+1)]"
}
if (-not $ok) { throw "npm registry did not show $Version within 60s (latest=$latest)" }

Write-Host '==> [7/8] hot install into web profile'
dsh plugin --profile web add "dsh-hooks-plugin@$Version"
if ($LASTEXITCODE -ne 0) { throw 'hot-install failed' }

Write-Host '==> [8/8] assert install result'
Start-Sleep -Seconds 4
$installed = (Get-Content (Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\dsh-hooks-plugin\package.json') | ConvertFrom-Json).version
if ($installed -ne $Version) { throw "installed version $installed != target $Version" }
$health = (Invoke-WebRequest 'http://127.0.0.1:3080/dsh-hooks/health' -UseBasicParsing -TimeoutSec 10).Content.Trim()
if ($health -ne 'ok') { throw "health not ok: $health" }
$recent = (Invoke-WebRequest 'http://127.0.0.1:3080/dsh-hooks/recent' -UseBasicParsing -TimeoutSec 10).StatusCode
if ($recent -ne 200) { throw "recent endpoint unreachable: $recent" }

Write-Host "==> done: dsh-hooks-plugin@$Version published & hot-installed (health=$health recent=$recent)"
