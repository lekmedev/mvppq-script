<#
.SYNPSIS
    Installs DiskSpaceApi as a Windows Service (name: DiskSpaceApi).

.DESCRIPTION
    Idempotent: safe to re-run. Creates the service, URL reservation,
    firewall rule, and log directory.

    MUST run as Administrator.

.PARAMETER BinaryPath
    Path to the published DiskSpaceApi.exe. Defaults to
    .\publish\win-x64\DiskSpaceApi.exe next to this script.

.PARAMETER ServiceAccount
    'LocalSystem' (default) or a service account name such as
    'NT SERVICE\DiskSpaceApiSvc' or 'DOMAIN\User'.
    LocalSystem is the simplest and is already least-privilege *enough* —
    the service only reads drive capacity and writes its own log folder.
    No domain-join or admin rights are needed at runtime.

.PARAMETER NoStart
    Register the service but do not start it.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -BinaryPath C:\DiskSpaceApi\DiskSpaceApi.exe
#>
[CmdletBinding()]
param(
    [string] $BinaryPath = (Join-Path $PSScriptRoot 'publish\win-x64\DiskSpaceApi.exe'),
    [string] $ServiceAccount = 'LocalSystem',
    [switch] $NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --------------------------- configuration ---------------------------------
$ServiceName      = 'DiskSpaceApi'
$DisplayName      = 'Disk Space API'
$Description      = 'Reports this workstation IPv4 and free disk space over HTTP on TCP 9988.'
$Port             = 9988
$FirewallRuleName = 'DiskSpaceApi TCP 9988'
$FirewallRemotes  = '10.139.0.0/16'
$LogDir           = 'C:\ProgramData\DiskSpaceApi\logs'
$Binary           = (Resolve-Path $BinaryPath).Path

# ------------------------------ preflight ----------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This script must be run as Administrator.'
}

if (-not (Test-Path $Binary)) {
    throw "Publish output not found: $Binary`nRun publish.ps1 first."
}

foreach ($cmd in 'sc.exe', 'netsh', 'New-NetFirewallRule', 'New-Service') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "Required command not available: $cmd"
    }
}

Write-Host "==> Installing $DisplayName" -ForegroundColor Cyan
Write-Host "    Binary : $Binary"
Write-Host "    Account: $ServiceAccount"

# --------------------------- log directory ---------------------------------
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    Write-Host "==> Created log directory $LogDir" -ForegroundColor Cyan
}

# --------------------- service account permission grant ---------------------
# Runtime account needs write access to the log folder only.
if ($ServiceAccount -ne 'LocalSystem' -and $ServiceAccount -ne 'LocalService' -and $ServiceAccount -ne 'NetworkService') {
    try {
        $acl = Get-Acl $LogDir
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $ServiceAccount, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.SetAccessRule($rule)
        Set-Acl $LogDir $acl
        Write-Host "==> Granted Modify on $LogDir to $ServiceAccount" -ForegroundColor Cyan
    }
    catch {
        Write-Warning "Could not set ACL on $LogDir for ${ServiceAccount}: $($_.Exception.Message)"
    }
}

# --------------------------- service create/update --------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if ($existing) {
    Write-Host "==> Service already exists; reconfiguring" -ForegroundColor Yellow

    if ($existing.Status -eq 'Running') {
        Stop-Service -Name $ServiceName -Force
        $existing.WaitForStatus('Stopped', '00:00:30') | Out-Null
    }

    & sc.exe config $ServiceName binPath= "`"$Binary`"" start= auto obj= $ServiceAccount password= `` | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe config failed ($LASTEXITCODE)" }
    & sc.exe description $ServiceName $Description | Out-Null
}
else {
    Write-Host '==> Creating service' -ForegroundColor Cyan
    New-Service `
        -Name $ServiceName `
        -DisplayName $DisplayName `
        -Description $Description `
        -BinaryPathName "`"$Binary`"" `
        -StartupType Automatic | Out-Null
    Write-Host "==> Created service $ServiceName" -ForegroundColor Green
}

# ------------------------------ start service -------------------------------
if (-not $NoStart) {
    Start-Service -Name $ServiceName
    $svc = Get-Service -Name $ServiceName
    $svc.WaitForStatus('Running', '00:00:30') | Out-Null
    Write-Host '==> Service started' -ForegroundColor Green
}

# --------------------------- URL reservation -------------------------------
Write-Host '==> Reserving URL http://+:9988/ for the service account' -ForegroundColor Cyan
& netsh http add urlacl url="http://+:$Port/" user=$ServiceAccount | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'netsh http add urlacl returned non-zero; it may already exist.'
}

# --------------------------- firewall rule ---------------------------------
Write-Host "==> Creating inbound firewall rule '$FirewallRuleName'" -ForegroundColor Cyan
New-NetFirewallRule `
    -DisplayName $FirewallRuleName `
    -Description 'DiskSpaceApi disk-space JSON API' `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -RemoteAddress $FirewallRemotes `
    -Action Allow `
    -Profile Domain, Private | Out-Null

# ------------------------------ summary -------------------------------------
Write-Host ''
Write-Host '==> Installation complete' -ForegroundColor Green
& sc.exe query $ServiceName
Write-Host ''
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, State | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "Logs: $LogDir\service.log" -ForegroundColor Yellow
Write-Host 'Test: .\test-api.ps1'
