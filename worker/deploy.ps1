<#
.SYNOPSIS
  One-command setup and deploy of the Cloudflare Worker.

.DESCRIPTION
  Does everything that does not need your Cloudflare credentials:
    - checks Node and the wrangler CLI
    - creates the D1 database and writes its id into wrangler.toml
    - runs the typecheck and test suites before deploying
    - deploys

  You do the two interactive things, because they require your account:
    - wrangler login   (browser OAuth, once)
    - the three secret prompts (so nothing sensitive is ever in a file)

.EXAMPLE
  .\deploy.ps1                 full setup, prompting for secrets
  .\deploy.ps1 -SkipSecrets    deploy without setting secrets (e.g. CI)
  .\deploy.ps1 -DryRun         everything except the final deploy
#>
[CmdletBinding()]
param(
  [switch]$SkipSecrets,
  [switch]$DryRun
)

# NOTE: deliberately NOT "Stop". The wrangler CLI writes progress and version
# warnings to stderr, which PowerShell would otherwise treat as terminating
# errors. Every step below checks $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot

function Write-Step($n, $t) { Write-Host "`n[$n/6] $t" -ForegroundColor Cyan }
function Write-Ok($t)       { Write-Host "      OK  $t" -ForegroundColor Green }
function Write-Warn2($t)    { Write-Host "      !!  $t" -ForegroundColor Yellow }
function Fail($t)           { Write-Host "      XX  $t" -ForegroundColor Red; exit 1 }

# --- 1. prerequisites -------------------------------------------------------
Write-Step 1 "Checking prerequisites"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js not found. Install from https://nodejs.org (18+)." }
$nodeVersion = (node --version)
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 18) { Fail "Node 18+ required, found $nodeVersion" }
Write-Ok "node $nodeVersion"

if (-not (Test-Path "node_modules")) {
  Write-Ok "installing dependencies (first run only)"
  & npm.cmd install --silent
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }
} else {
  Write-Ok "dependencies present"
}

# --- 2. verify before deploying --------------------------------------------
Write-Step 2 "Typecheck and tests"
& npm.cmd run --silent typecheck
if ($LASTEXITCODE -ne 0) { Fail "typecheck failed - not deploying" }
Write-Ok "typecheck clean"

$env:PYTHONIOENCODING = "utf-8"
& npm.cmd run --silent test
if ($LASTEXITCODE -ne 0) { Write-Warn2 "unit tests failed - continuing, but review before going live" }
else { Write-Ok "unit tests passed" }

& npm.cmd run --silent test:alerts
if ($LASTEXITCODE -ne 0) { Write-Warn2 "alert tests failed" } else { Write-Ok "alert tests passed" }

# --- 3. login ---------------------------------------------------------------
Write-Step 3 "Cloudflare authentication"
$authed = $false
try {
  $who = & npx.cmd wrangler whoami 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $who -match "Account ID|Logged in") { $authed = $true }
} catch { }
if ($authed) {
  Write-Ok "already authenticated"
} else {
  Write-Host "      A browser window will open - click Allow." -ForegroundColor Yellow
  & npx.cmd wrangler login
  if ($LASTEXITCODE -ne 0) { Fail "wrangler login failed" }
  Write-Ok "authenticated"
}

# --- 4. D1 database ---------------------------------------------------------
Write-Step 4 "D1 database"
$toml = "wrangler.toml"
$content = Get-Content $toml -Raw
if ($content -match 'database_id\s*=\s*"([0-9a-fA-F-]{36})"' -and $Matches[1] -ne "00000000-0000-0000-0000-000000000000") {
  Write-Ok "database_id already set ($($Matches[1]))"
} else {
  Write-Host "      creating the D1 database..." -ForegroundColor Yellow
  $out = & npx.cmd wrangler d1 create khmer24news 2>&1 | Out-String
  if ($out -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
    $dbId = $Matches[1]
    $content = $content -replace 'database_id\s*=\s*"[^"]*"', "database_id = `"$dbId`""
    [System.IO.File]::WriteAllText((Resolve-Path $toml), $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "created and wrote $dbId into wrangler.toml"
  } else {
    Write-Warn2 "could not parse the new database_id."
    Write-Warn2 "run: npx wrangler d1 list   then paste the id into wrangler.toml"
  }
}

# --- 5. secrets -------------------------------------------------------------
Write-Step 5 "Secrets"
if ($SkipSecrets) {
  Write-Warn2 "skipped (you passed -SkipSecrets)"
} else {
  Write-Host "      Each prompt is local and encrypted in Cloudflare." -ForegroundColor Yellow
  Write-Host "      Nothing is written to disk. Do not paste these into a chat." -ForegroundColor Yellow
  foreach ($s in @("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ADMIN_TOKEN")) {
    & npx.cmd wrangler secret put $s
    if ($LASTEXITCODE -eq 0) { Write-Ok "$s set" } else { Fail "could not set $s" }
  }
}

# --- 6. deploy --------------------------------------------------------------
Write-Step 6 "Deploy"
if ($DryRun) {
  Write-Ok "DryRun: skipping the actual deploy."
  exit 0
}
& npx.cmd wrangler deploy
if ($LASTEXITCODE -ne 0) { Fail "deploy failed" }

$url = (& npx.cmd wrangler deployments list 2>&1 | Out-String)
Write-Host "`n      Deployed. Watch it live with:  npx wrangler tail" -ForegroundColor Green
Write-Host "      Check:  https://khmer24news.<your-subdomain>.workers.dev/health" -ForegroundColor Green
Write-Host "      Verify Telegram: .../check" -ForegroundColor Green
Write-Host "      First run primes alerts and sends nothing by design." -ForegroundColor Green
