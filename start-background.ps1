$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& (Get-Command python).Source (Join-Path $PSScriptRoot 'service_control.py') start
if ($LASTEXITCODE -ne 0) { throw 'Recruitment service failed to start. See the message above.' }