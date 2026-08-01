[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Version) {
    $manifest = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
    $Version = $manifest.version
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid release version: $Version"
}

$packageName = "edge-ytdlp-youtube-downloader-v$Version"
$dist = Join-Path $root 'dist'
$staging = Join-Path $dist $packageName
$archive = Join-Path $dist "$packageName.zip"

$sourceFiles = @(
    'manifest.json',
    'background.js',
    'content.js',
    'page-bridge.js',
    'content.css',
    'popup.html',
    'popup.js',
    'popup.css',
    'options.html',
    'options.js',
    'options.css',
    'native-host.py',
    'setup-native-host.ps1',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'docs/screenshots/hero.png',
    'docs/screenshots/watch.png',
    'docs/screenshots/popup.png',
    'docs/screenshots/search.png',
    'README.md',
    'CHANGELOG.md',
    'LICENSE'
)

New-Item -ItemType Directory -Path $dist -Force | Out-Null

$resolvedDist = (Resolve-Path -LiteralPath $dist).Path
if (Test-Path -LiteralPath $staging) {
    $resolvedStaging = (Resolve-Path -LiteralPath $staging).Path
    if (-not $resolvedStaging.StartsWith($resolvedDist + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove a staging path outside dist.'
    }
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
}
if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
}

New-Item -ItemType Directory -Path $staging -Force | Out-Null
foreach ($relativePath in $sourceFiles) {
    $source = Join-Path $root $relativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Release file is missing: $relativePath"
    }
    $destination = Join-Path $staging $relativePath
    $destinationDir = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $destinationDir)) {
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $source -Destination $destination
}

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $archive -CompressionLevel Optimal
Remove-Item -LiteralPath $staging -Recurse -Force

Write-Host "Created: $archive"
