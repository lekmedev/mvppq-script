<#
.SYNOPSIS
    Completely removes the DiskSpaceApi service, its firewall rule, and its
    HTTP.sys URL reservation.

.DESCRIPTION
    Idempotent. MUST run as Administrator. Data/log files are left on disk —
    delete C:\ProgramData\DiskSpaceApi manually if you want them gone.

.EXAMPLE
    .\uninstall.ps1
    .\uninstall.ps1 -KeepBinary
#>
[CmdletBinding()]
param(
    # Service is always removed; this switch only documents that the published
    # binary in .\publish is left alone (it always is).
    [switch] $KeepBinary
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ServiceName      = 'DiskSpaceApi'
$FirewallRuleName = 'DiskSpaceApi TCP 9988'
$DataDir          = 'C:\ProgramData\DiskSpaceApi'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This script must be run as Administrator.'
}

# ------------------------------ stop service --------------------------------
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') {
        Write-Host "==> Stopping $ServiceName" -ForegroundColor Cyan
        Stop-Service -Name $ServiceName -Force
        $svc.WaitForStatus('Stopped', '00:00:30') | Out-Null
    }

    Write-Host "==> Deleting service $ServiceName" -ForegroundColor Cyan
    & sc.exe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed ($LASTEXITCODE)" }
}
else {
    Write-Host "==> Service $ServiceName not found (already removed)" -ForegroundColor Yellow
}

# ---------------------------- firewall rule --------------------------------
$rule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
if ($rule) {
    Write-Host "==> Removing firewall rule '$FirewallRuleName'" -ForegroundColor Cyan
    Remove-NetFirewallRule -DisplayName $FirewallRuleName
}
else {
    Write-Host "==> Firewall rule already absent" -ForegroundColor Yellow
}

# --------------------------- URL reservation -------------------------------
Write-Host '==> Removing URL reservation http://+:9988/' -ForegroundColor Cyan
& netsh http delete urlacl url='http://+:9988/' | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'netsh http delete urlacl returned non-zero (may not exist).'
}

# -------------------------------- summary ----------------------------------
Write-Host ''
Write-Host '==> Uninstall complete' -ForegroundColor Green
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Warning 'Service still present — it may need a moment to be removed from the SCM.'
}
else {
    Write-Host "    Service '$ServiceName' is gone." -ForegroundColor Green
}
Write-Host "    Left data in place: $DataDir (delete manually to purge logs)."
