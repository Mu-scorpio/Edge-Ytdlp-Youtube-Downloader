[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [string]$PythonPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $PythonPath) {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { throw 'Python was not found. Install Python 3 or pass -PythonPath with python.exe.' }
    $PythonPath = $python.Source
}

if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw "Python was not found: $PythonPath" }
if (-not (Test-Path -LiteralPath (Join-Path $root 'native-host.py') -PathType Leaf)) { throw 'native-host.py was not found.' }

$launcherPath = Join-Path $root 'native-host.cmd'
$hostScriptPath = Join-Path $root 'native-host.py'
$launcher = "@echo off`r`n" + '"' + $PythonPath + '" "' + $hostScriptPath + '"' + "`r`n"
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding Ascii

$manifestPath = Join-Path $root 'com.local.ytdlp_downloader.json'
$manifest = [ordered]@{
    name = 'com.local.ytdlp_downloader'
    description = 'Local yt-dlp bridge for Edge'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding Ascii

$registryKey = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.local.ytdlp_downloader'
New-Item -Path $registryKey -Force | Out-Null
New-ItemProperty -Path $registryKey -Name '(Default)' -Value $manifestPath -PropertyType String -Force | Out-Null

Write-Host 'Native Messaging bridge installed.'
Write-Host "Extension ID: $ExtensionId"
Write-Host "To remove: Remove-Item 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.local.ytdlp_downloader' -Recurse"
