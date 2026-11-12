$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& (Get-Command python).Source (Join-Path $PSScriptRoot 'service_control.py') restart
if ($LASTEXITCODE -ne 0) { throw 'Recruitment service failed to restart. See the message above.' }