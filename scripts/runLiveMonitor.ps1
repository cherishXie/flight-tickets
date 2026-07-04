param(
  [string]$BackupPath = "flight-tickets-backup.json",
  [string]$OutputPath = "",
  [string]$EmlOutbox = "flight-alert-outbox",
  [string]$ReportDir = "flight-monitor-reports",
  [string]$NodePath = "node",
  [int]$MaxReportFiles = 120,
  [int]$MaxOutboxFiles = 300,
  [switch]$DryRun,
  [switch]$ForceAmadeus,
  [switch]$Smtp
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = $BackupPath
}

New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$readinessReport = Join-Path $ReportDir "readiness-$timestamp.json"
$collectReport = Join-Path $ReportDir "collect-$timestamp.json"

function Remove-OldFiles {
  param(
    [string]$Directory,
    [string[]]$Filters,
    [int]$Keep,
    [string]$Label
  )

  if ($Keep -lt 1) {
    return
  }

  if (-not (Test-Path -LiteralPath $Directory)) {
    return
  }

  $files = @(
    foreach ($filter in $Filters) {
      Get-ChildItem -LiteralPath $Directory -Filter $filter -File -ErrorAction SilentlyContinue
    }
  )

  $files = @($files | Sort-Object FullName -Unique)
  $toRemove = @($files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip $Keep)

  foreach ($file in $toRemove) {
    Remove-Item -LiteralPath $file.FullName -Force
  }

  if ($toRemove.Count -gt 0) {
    Write-Host "Pruned $($toRemove.Count) old $Label file(s)."
  }
}

function Invoke-RetentionCleanup {
  if ($DryRun) {
    Write-Host "Dry run: skipping retention cleanup."
    return
  }

  Remove-OldFiles -Directory $ReportDir -Filters @("readiness-*.json", "collect-*.json") -Keep $MaxReportFiles -Label "report"
  Remove-OldFiles -Directory $EmlOutbox -Filters @("*.eml") -Keep $MaxOutboxFiles -Label "outbox"
}

$readinessArgs = @(
  "scripts/checkLiveReadiness.mjs",
  "--input", $BackupPath,
  "--collect-command",
  "--report-output", $readinessReport
)

if ($Smtp) {
  $readinessArgs += "--smtp"
}

Write-Host "Checking live monitor readiness..."
& $NodePath @readinessArgs
$readinessExit = $LASTEXITCODE
if ($readinessExit -ne 0) {
  Write-Host "Readiness check failed. Report: $readinessReport"
  Invoke-RetentionCleanup
  exit $readinessExit
}

$collectArgs = @(
  "scripts/collectLiveOnce.mjs",
  "--input", $BackupPath,
  "--output", $OutputPath,
  "--eml-outbox", $EmlOutbox,
  "--report-output", $collectReport
)

if ($DryRun) {
  $collectArgs += "--dry-run"
}

if ($ForceAmadeus) {
  $collectArgs += "--force-amadeus"
}

if ($Smtp) {
  $collectArgs += "--smtp"
}

Write-Host "Collecting live flight prices..."
& $NodePath @collectArgs
$collectExit = $LASTEXITCODE
Write-Host "Collect report: $collectReport"
Invoke-RetentionCleanup
exit $collectExit
