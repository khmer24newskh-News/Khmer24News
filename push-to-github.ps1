# Publish this repository to GitHub.
#
# Everything up to the push is done for you. The push itself needs your GitHub
# credentials, which cannot be scripted - that is the one step only you can take.
#
#   .\push-to-github.ps1
#
# Re-run it any time. It is idempotent: a clean tree is a no-op, and it refuses
# to commit if a credential would be published.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$remote = "https://github.com/khmer24newskh-News/Khmer24News.git"

function Fail($msg) { Write-Host "`n  FAILED: $msg" -ForegroundColor Red; exit 1 }

Write-Host "`n=== 1. audit for secrets ===" -ForegroundColor Cyan
Push-Location "$root\worker"
try { & npm.cmd run audit:secrets } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Fail "a real credential is in a committable file. Fix it before publishing." }

Write-Host "`n=== 2. run the tests ===" -ForegroundColor Cyan
Push-Location "$root\worker"
try { & npm.cmd test } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Fail "tests are failing. Fix them before publishing." }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail @"
git is not installed. Install it with:
    winget install --id Git.Git -e --source winget
then close and reopen the terminal so git is on PATH, and run this again.
"@
}

Write-Host "`n=== 3. commit ===" -ForegroundColor Cyan
Push-Location $root
try {
  if (-not (Test-Path ".git")) {
    & git init -q
    & git branch -M main
  }
  & git add -A
  if (-not (git status --porcelain)) {
    Write-Host "  nothing to commit - already up to date"
  } else {
    # Show the file list, so a surprise cannot slip through unnoticed.
    $count = (git status --porcelain | Measure-Object).Count
    Write-Host "  staging $count file(s)"
    & git status --porcelain | ForEach-Object { Write-Host "    $_" }
    if ($env:GIT_AUTHOR_NAME) { } else {
      & git config user.name "Khmer24 News"
      & git config user.email "news@khmer24.com"
    }
    & git commit -q -m "Khmer24 Business Intelligence: Worker-only news to sales brief

Fetches 34 news sources from Cloudflare itself on a 10-minute cron, classifies
them into business opportunities, streams breaking-news cards to Telegram, and
sends an 8-section brief at 07:30 ICT. No local process is required.

Google News refuses Cloudflare with HTTP 503 under every strategy measured, so
Bing News RSS with topical queries and keyword filters is used instead; see
worker/DISCOVERY-NOTES.md."
    Write-Host "  committed"
  }
  & git remote remove origin 2>$null
  & git remote add origin $remote
  Write-Host "  remote set to $remote"
} finally { Pop-Location }

Write-Host "`n=== 4. push ===" -ForegroundColor Cyan
Write-Host "  This is the only step that needs you. Pick one:"
Write-Host ""
Write-Host "  A) GitHub CLI (recommended) - installs and signs you in via the browser"
Write-Host "       winget install --id GitHub.cli -e --source winget"
Write-Host "       gh auth login"
Write-Host "       .\push-to-github.ps1"
Write-Host ""
Write-Host "  B) Personal Access Token - repo scope, then paste it when git asks"
Write-Host "       (https://github.com/settings/tokens)"
Write-Host "       .\push-to-github.ps1"
Write-Host ""
Push-Location $root
try { & git push -u origin main } finally { Pop-Location }

Write-Host "`n  Published: https://github.com/khmer24newskh-News/Khmer24News" -ForegroundColor Green
Write-Host "  Two things GitHub does not let a script set:" -ForegroundColor Yellow
Write-Host "    - the repository description and topic"
Write-Host "    - the licence (none is set, so nobody may legally reuse this)"
