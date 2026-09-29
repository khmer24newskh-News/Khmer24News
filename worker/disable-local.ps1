<#
.SYNOPSIS
  Turns the local Python setup off, once the Cloudflare Worker is confirmed live.

.DESCRIPTION
  Disables (does not delete) the two Windows scheduled tasks and stops the local
  database from growing. The Worker keeps working with this PC switched off.
  Re-enable with .\disable-local.ps1 -Undo
#>
[CmdletBinding()]
param([switch]$Undo)

$tasks = @("Khmer24 Alerts", "Khmer24 Daily Report")

foreach ($name in $tasks) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "  --  $name not found (already removed?)"; continue }
  if ($Undo) {
    Enable-ScheduledTask -TaskName $name | Out-Null
    Write-Host "  ON  $name re-enabled" -ForegroundColor Green
  } else {
    Disable-ScheduledTask -TaskName $name | Out-Null
    Write-Host "  OFF $name disabled" -ForegroundColor Yellow
  }
}

if (-not $Undo) {
  Write-Host ""
  Write-Host "Local sending is now off. The Worker runs from Cloudflare on its own cron,"
  Write-Host "so this PC can be switched off." -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Re-enable with:  .\disable-local.ps1 -Undo" -ForegroundColor DarkGray
}
