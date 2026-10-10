<#
.SYNOPSIS
    Publishes DiskSpaceApi as a self-contained, single-file Windows x64 executable.

.DESCRIPTION
    Runs on a Windows machine with the .NET 8 SDK installed (or on any OS with
    EnableWindowsTargeting, see -Cross flag). Produces:

        publish\win-x64\DiskSpaceApi.exe   (single self-contained exe)
        publish\win-x64\appsettings.json

.EXAMPLE
    .\publish.ps1
    .\publish.ps1 -Configuration Release -OutputDir D:\build\DiskSpaceApi
#>
[CmdletBinding()]
param(
    [string] $Configuration = 'Release',
    [string] $OutputDir    = (Join-Path $PSScriptRoot 'publish\win-x64'),

    # Cross-publish from Linux/macOS. On Windows this is unnecessary.
    [switch] $Cross
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$project = Join-Path $PSScriptRoot 'DiskSpaceApi.csproj'
if (-not (Test-Path $project)) {
    throw "Project not found: $project"
}

if (-not $Cross -and -not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
    Write-Warning 'Not running on Windows; switching to cross-publish mode.'
    $Cross = $true
}

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
    throw 'dotnet CLI not found. Install the .NET 8 SDK: https://dotnet.microsoft.com/download'
}

Write-Host '==> .NET SDKs available' -ForegroundColor Cyan
& dotnet --list-sdks

$argsList = @(
    'publish'
    $project
    '-c', $Configuration
    '-f', 'net8.0-windows'
    '-r', 'win-x64'
    '--self-contained', 'true'
    '-p:PublishSingleFile=true'
    '-p:IncludeNativeLibrariesForSelfExtract=true'
    '-o', $OutputDir
    '--nologo'
)

if ($Cross) {
    $argsList += '-p:EnableWindowsTargeting=true'
}

Write-Host "==> dotnet $($argsList -join ' ')" -ForegroundColor Cyan
& dotnet @argsList
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

$exe = Join-Path $OutputDir 'DiskSpaceApi.exe'
if (-not (Test-Path $exe)) {
    throw "Expected single-file executable was not produced: $exe"
}

$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)

Write-Host ''
Write-Host '==> Publish succeeded' -ForegroundColor Green
Write-Host "    Executable : $exe ($sizeMb MB)"
Write-Host "    Config     : $(Join-Path $OutputDir 'appsettings.json')"
Write-Host "    SHA256     : $((Get-FileHash $exe -Algorithm SHA256).Hash)"
Write-Host ''
Write-Host 'Next step (as Administrator on the target machine):' -ForegroundColor Yellow
Write-Host '    .\install.ps1'
