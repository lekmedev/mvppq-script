<#
.SYNOPSIS
    Smoke-tests the DiskSpaceApi HTTP endpoint.

.DESCRIPTION
    Validates the JSON contract: 200 on /disk and /, 404 on an unknown route,
    405 on a bad method, correct free-space shape, and a 10.139.x.x IP.
    Exits non-zero when a check fails.

.PARAMETER BaseUrl
    Defaults to this machine's own 10.139.x.x address, matching production use.

.EXAMPLE
    .\test-api.ps1
    .\test-api.ps1 -BaseUrl http://10.139.20.88:9988
#>
[CmdletBinding()]
param(
    [string] $BaseUrl,

    # Seconds per request.
    [int] $TimeoutSec = 10
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Port = 9988
$script:Failures = 0
$script:Checks = 0

function Write-Check {
    param([string] $Name, [bool] $Passed, [string] $Detail = '')
    $script:Checks++
    if ($Passed) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
    }
    else {
        $script:Failures++
        Write-Host "  [FAIL] $Name" -ForegroundColor Red
        if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkYellow }
    }
}

if (-not $BaseUrl) {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '10.139.*' -and $_.AddressState -eq 'Preferred' } |
        Select-Object -First 1 -ExpandProperty IPAddress

    if (-not $ip) {
        Write-Warning 'No 10.139.x.x address found on this host; using localhost.'
        $ip = '127.0.0.1'
    }
    $BaseUrl = "http://${ip}:$Port"
}

Write-Host "==> Testing $BaseUrl" -ForegroundColor Cyan
Write-Host ''

# --------------------------- reachability ----------------------------------
try {
    $health = Invoke-WebRequest -Uri "$BaseUrl/disk" -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing
    Write-Check 'GET /disk returns HTTP 200' ($health.StatusCode -eq 200) "status=$($health.StatusCode)"
}
catch {
    Write-Check 'GET /disk returns HTTP 200' $false $_.Exception.Message
    Write-Host ''
    Write-Host 'Endpoint unreachable — is the service running and is the firewall open?' -ForegroundColor Red
    exit 1
}

# --------------------------- content type ---------------------------------
$ct = $health.Headers['Content-Type']
Write-Check 'Content-Type is application/json' ("$ct" -like 'application/json*') "content-type=$ct"

$cl = $health.Headers['Content-Length']
$actualLen = $health.RawContentLength
Write-Check 'Content-Length matches body length' ("$cl" -eq "$actualLen") "header=$cl actual=$actualLen"

# --------------------------- JSON body ------------------------------------
try {
    $data = $health.Content | ConvertFrom-Json
    Write-Check 'Response is valid JSON' $true
}
catch {
    Write-Check 'Response is valid JSON' $false $_.Exception.Message
    exit 1
}

Write-Check 'Payload has "ip" property' ($null -ne $data.PSObject.Properties['ip']) "ip=$($data.ip)"

if ("$($data.ip)" -eq 'Unknown') {
    Write-Check 'IP is a 10.139.x.x address' $false 'service reported Unknown (no matching interface)'
}
else {
    Write-Check 'IP is a 10.139.x.x address' ("$($data.ip)" -like '10.139.*') "ip=$($data.ip)"
}

foreach ($disk in 'C', 'D') {
    $prop = "${disk}_free_gb"
    $present = $null -ne $data.PSObject.Properties[$prop]
    if ($present) {
        $value = $data.$prop
        if ($null -eq $value) {
            Write-Check "$prop present (drive absent or unready -> null)" $true "$prop=null"
        }
        else {
            Write-Check "$prop is a number >= 0" (($value -is [int] -or $value -is [long] -or $value -is [double]) -and $value -ge 0) "$prop=$value"
        }
    }
    else {
        Write-Check "$prop present" $false 'property missing from response'
    }
}

# --------------------------- routes and methods ---------------------------
Write-Check 'GET / (alias) returns HTTP 200' (
    (Invoke-WebRequest -Uri "$BaseUrl/" -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing).StatusCode -eq 200
)

try {
    Invoke-WebRequest -Uri "$BaseUrl/nope" -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing | Out-Null
    Write-Check 'Unknown route returns HTTP 404' $false 'got 2xx'
}
catch [System.Net.WebException] {
    $code = [int]$_.Exception.Response.StatusCode
    Write-Check 'Unknown route returns HTTP 404' ($code -eq 404) "status=$code"
}

try {
    Invoke-WebRequest -Uri "$BaseUrl/disk" -Method POST -Body '{}' -TimeoutSec $TimeoutSec -UseBasicParsing | Out-Null
    Write-Check 'POST returns HTTP 405' $false 'got 2xx'
}
catch [System.Net.WebException] {
    $code = [int]$_.Exception.Response.StatusCode
    Write-Check 'POST returns HTTP 405' ($code -eq 405) "status=$code"
}

# --------------------------- throughput -----------------------------------
$sw = [Diagnostics.Stopwatch]::StartNew()
$ok = 0
for ($i = 0; $i -lt 20; $i++) {
    try {
        Invoke-WebRequest -Uri "$BaseUrl/disk" -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing | Out-Null
        $ok++
    }
    catch { }
}
$sw.Stop()
$avg = if ($ok -gt 0) { [math]::Round($sw.ElapsedMilliseconds / $ok, 1) } else { 0 }
Write-Check '20 sequential requests all succeeded' ($ok -eq 20) "$ok/20 ok, avg ${avg}ms"

# --------------------------- parallel -------------------------------------
$jobs = 1..8 | ForEach-Object {
    Start-ThreadJob -ScriptBlock {
        param($u)
        try { (Invoke-WebRequest -Uri $u -TimeoutSec 15 -UseBasicParsing).StatusCode } catch { 0 }
    } -ArgumentList "$BaseUrl/disk"
}
Wait-Job $jobs -Timeout 30 | Out-Null
$codes = Receive-Job $jobs
Remove-Job $jobs -Force
$ok200 = ($codes | Where-Object { $_ -eq 200 }).Count
Write-Check '8 concurrent requests all return 200' ($ok200 -eq 8) "$ok200/8 returned 200"

# --------------------------- listener release ----------------------------
$listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
Write-Check 'Port 9988 is listening' ($listening.Count -gt 0) "listeners=$($listening.Count)"

# --------------------------- summary --------------------------------------
Write-Host ''
if ($script:Failures -eq 0) {
    Write-Host "ALL CHECKS PASSED ($script:Checks/$script:Checks)" -ForegroundColor Green
    exit 0
}
else {
    Write-Host "$($script:Failures) of $script:Checks checks FAILED" -ForegroundColor Red
    exit 1
}
