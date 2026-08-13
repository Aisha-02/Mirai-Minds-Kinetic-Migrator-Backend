# End-to-end comparison API test (Node backend -> EC2 service when COMPARISON_ENGINE_MODE=service)
# Usage: .\scripts\test-comparison-api.ps1 -BaseUrl http://localhost:4000 -Email test@example.com -Password password123

param(
    [string]$BaseUrl = "http://localhost:4000",
    [string]$Email = "test@example.com",
    [string]$Password = "password123",
    [string]$BusinessObject = "MATERIAL"
)

$ErrorActionPreference = "Stop"
$preload = Join-Path $PSScriptRoot "..\test-data\preload.csv"
$postload = Join-Path $PSScriptRoot "..\test-data\postload.csv"

if (-not (Test-Path $preload)) { throw "Missing $preload" }
if (-not (Test-Path $postload)) { throw "Missing $postload" }

Write-Host "==> Health check"
$health = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get
Write-Host ($health | ConvertTo-Json -Compress)

Write-Host "`n==> Login (register if needed)"
try {
    $login = Invoke-RestMethod -Uri "$BaseUrl/api/auth/login" -Method Post -ContentType "application/json" `
        -Body (@{ email = $Email; password = $Password } | ConvertTo-Json)
} catch {
    Write-Host "Login failed, registering..."
    Invoke-RestMethod -Uri "$BaseUrl/api/auth/register" -Method Post -ContentType "application/json" `
        -Body (@{ email = $Email; password = $Password; role = "normal_user" } | ConvertTo-Json) | Out-Null
    $login = Invoke-RestMethod -Uri "$BaseUrl/api/auth/login" -Method Post -ContentType "application/json" `
        -Body (@{ email = $Email; password = $Password } | ConvertTo-Json)
}

$token = $login.token
$headers = @{ Authorization = "Bearer $token" }

Write-Host "`n==> Upload preload"
$preloadForm = @{
    file = Get-Item $preload
    businessObject = $BusinessObject
}
$preloadRes = Invoke-RestMethod -Uri "$BaseUrl/api/comparisons/upload-preload" -Method Post -Headers $headers -Form $preloadForm
$batchId = $preloadRes.batch_id
Write-Host "batch_id=$batchId"

Write-Host "`n==> Upload postload"
$postloadForm = @{
    file = Get-Item $postload
    batch_id = $batchId
}
Invoke-RestMethod -Uri "$BaseUrl/api/comparisons/upload-postload" -Method Post -Headers $headers -Form $postloadForm | Out-Null

Write-Host "`n==> Run comparison"
$run = Invoke-RestMethod -Uri "$BaseUrl/api/comparisons/$batchId/run" -Method Post -Headers $headers -ContentType "application/json" -Body "{}"

Write-Host "`n==> Result"
Write-Host "comparison_evaluator: $($run.comparison_evaluator)"
if ($run.comparison_fallback_reason) {
    Write-Host "comparison_fallback_reason: $($run.comparison_fallback_reason)" -ForegroundColor Yellow
}
Write-Host "report status: $($run.report.status)"
if ($run.report.summary_json) {
    $summary = $run.report.summary_json
    Write-Host "missingRecords: $($summary.missingRecords.Count)"
    Write-Host "valueMismatches: $($summary.valueMismatches.Count)"
    Write-Host "extraRecords: $($summary.extraRecords.Count)"
}

if ($run.comparison_evaluator -eq "comparison-engine-service") {
    Write-Host "`nSUCCESS: EC2 comparison engine was used." -ForegroundColor Green
} elseif ($run.comparison_evaluator -eq "node-local-fallback") {
    Write-Host "`nWARNING: Fell back to in-process comparison (EC2 not reached)." -ForegroundColor Yellow
} else {
    Write-Host "`nINFO: Used in-process comparison (COMPARISON_ENGINE_MODE=local)." -ForegroundColor Cyan
}
