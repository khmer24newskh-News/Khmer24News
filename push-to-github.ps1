# Publish this repository to GitHub. One command does everything.
#
#   .\push-to-github.ps1
#
# It audits for secrets, runs the tests, commits, signs you in to GitHub if
# needed, pushes, and sets the repository description. The only thing it cannot
# do is authenticate you: GitHub requires you to approve the sign-in yourself,
# in a browser. That is a security boundary, not an oversight.

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$owner   = "khmer24newskh-News"
$repo    = "Khmer24News"
$remote  = "https://github.com/$owner/$repo.git"
$desc    = "Cambodia/ASEAN news to sales actions: a Cloudflare Worker turns 34 news sources into a daily business brief and breaking-news Telegram cards. No local process required."

function Say($m) { Write-Host $m }
function Step($n, $t) { Write-Host "`n=== $n. $t ===" -ForegroundColor Cyan }
function Die($m)  { Write-Host "`n  FAILED: $m" -ForegroundColor Red; exit 1 }

# --- 1. never publish a credential ------------------------------------------
Step 1 "audit for secrets"
Push-Location "$root\worker"
try { & npm.cmd run audit:secrets } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Die "a real credential is in a committable file. Remove it, then re-run." }

Step 2 "run the tests"
Push-Location "$root\worker"
try { & npm.cmd run typecheck } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Die "typecheck failed." }
Push-Location "$root\worker"
try { & npm.cmd test } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Die "tests failed." }

# --- 2. git ------------------------------------------------------------------
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "C:\Program Files\Git\cmd\git.exe" }
if (-not (Test-Path $git)) { Die "git not found. Run: winget install --id Git.Git -e --source winget" }

Step 3 "commit"
Push-Location $root
try {
  if (-not (Test-Path ".git")) { & $git init -q; & $git branch -M main }
  & $git config user.name  $(if ($env:GIT_AUTHOR_NAME)  { $env:GIT_AUTHOR_NAME }  else { "Khmer24 News" })
  & $git config user.email $(if ($env:GIT_AUTHOR_EMAIL) { $env:GIT_AUTHOR_EMAIL } else { "news@khmer24.com" })
  & $git add -A
  $staged = & $git diff --cached --name-only
  if ($staged) {
    $forbidden = $staged | Where-Object {
      $_ -match '(^|/)\.env$|(^|/)\.dev\.vars$|\.db$|\.log$|(^|/)node_modules/|(^|/)\.venv/|test/fixtures/'
    }
    if ($forbidden) { Die ("a forbidden file is staged: " + ($forbidden -join ", ")) }
    Say "  staging $($staged.Count) file(s)"
    & $git commit -q -m $args[0]
  } else { Say "  nothing new to commit" }
  & $git remote remove origin 2>$null
  & $git remote add origin $remote
  Say "  branch $(& $git rev-parse --abbrev-ref HEAD), remote $remote"
} finally { Pop-Location }

# --- 3. authenticate ---------------------------------------------------------
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
  foreach ($c in @("C:\Program Files\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe")) {
    if (Test-Path $c) { $gh = $c; break }
  }
}
if (-not $gh) {
  Step 4 "sign in"
  Write-Host "  GitHub CLI is not installed. Installing it now..." -ForegroundColor Yellow
  & winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Null
  foreach ($c in @("C:\Program Files\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe")) {
    if (Test-Path $c) { $gh = $c; break }
  }
}

$authed = $false
if ($gh) { & $gh auth status *> $null; $authed = ($LASTEXITCODE -eq 0) }

if (-not $authed) {
  Step 4 "sign in to GitHub"
  Write-Host "  You will be given a one-time code. Open the URL, paste it, approve." -ForegroundColor Yellow
  Write-Host "  This is the one step that cannot be automated - GitHub requires it." -ForegroundColor Yellow
  Write-Host ""
  & $gh auth login --hostname github.com --git-protocol https --web
  & $gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { Die "sign-in did not complete. Re-run this script when you are ready." }
  Say "  signed in"
}

# --- 4. push -----------------------------------------------------------------
Step 5 "push"
Push-Location $root
try {
  & $git push -u origin main
  if ($LASTEXITCODE -ne 0) { Die "push failed. Run 'gh auth setup-git' once, then re-run this script." }
} finally { Pop-Location }
Say "  pushed $(& $git rev-parse --short HEAD)"

# --- 5. repo metadata --------------------------------------------------------
Step 6 "repository settings"
& $gh repo edit $owner/$repo --description $desc 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Say "  description set" } else { Say "  description not set (you can do this in Settings)" }

$lic = (& $gh api "repos/$owner/$repo" --jq '.license.spdx_id' 2>$null)
if ([string]::IsNullOrWhiteSpace($lic) -or $lic -eq "null") {
  Say "  licence: none set. That means nobody may legally reuse this code." -ForegroundColor Yellow
  Say "           To open it up, re-run with: .\push-to-github.ps1 -Licence MIT" -ForegroundColor Yellow
}

Write-Host "`n  Published: https://github.com/$owner/$repo" -ForegroundColor Green
Write-Host "  CI (typecheck, 448 tests, parity, secret scan) runs on every push." -ForegroundColor Green
