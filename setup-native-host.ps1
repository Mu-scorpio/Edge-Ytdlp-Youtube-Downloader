[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [string]$PythonPath,
    [switch]$SkipToolInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:InstallLog = New-Object System.Collections.Generic.List[string]

function Write-Step {
    param([string]$Message, [ValidateSet('info', 'ok', 'warn', 'error')][string]$Level = 'info')
    $prefix = switch ($Level) {
        'ok' { '[OK]' }
        'warn' { '[WARN]' }
        'error' { '[ERROR]' }
        default { '[..]' }
    }
    $line = "$prefix $Message"
    $script:InstallLog.Add($line) | Out-Null
    $color = switch ($Level) {
        'ok' { 'Green' }
        'warn' { 'Yellow' }
        'error' { 'Red' }
        default { 'Cyan' }
    }
    Write-Host $line -ForegroundColor $color
}

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-Python {
    param([string]$Preferred)
    if ($Preferred) {
        if (-not (Test-Path -LiteralPath $Preferred -PathType Leaf)) {
            throw "指定的 Python 路径不存在: $Preferred`n请安装 Python 3.9+ 后重试，或传入正确的 -PythonPath。"
        }
        return (Resolve-Path -LiteralPath $Preferred).Path
    }
    foreach ($candidate in @('py', 'python', 'python3')) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        try {
            $versionText = & $cmd.Source --version 2>&1 | Out-String
            if ($versionText -match 'Python\s+(\d+)\.(\d+)') {
                $major = [int]$Matches[1]
                $minor = [int]$Matches[2]
                if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 9)) {
                    return $cmd.Source
                }
                Write-Step "发现 $candidate ($($versionText.Trim()))，但需要 Python 3.9+。" 'warn'
            }
        } catch {
            continue
        }
    }
    return $null
}

function Install-PythonWithWinget {
    if (-not (Test-CommandExists 'winget')) {
        return $false
    }
    Write-Step '正在通过 winget 安装 Python 3...' 'info'
    try {
        & winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
        return $true
    } catch {
        Write-Step "winget 安装 Python 失败: $($_.Exception.Message)" 'warn'
        return $false
    }
}

function Install-WithWinget {
    param(
        [string]$Id,
        [string]$DisplayName,
        [string]$CheckCommand
    )
    if (Test-CommandExists $CheckCommand) {
        Write-Step "$DisplayName 已安装。" 'ok'
        return $true
    }
    if (-not (Test-CommandExists 'winget')) {
        Write-Step "未找到 $DisplayName，且本机没有 winget，请手动安装后重新运行本脚本。" 'warn'
        return $false
    }
    Write-Step "正在通过 winget 安装 $DisplayName ($Id)..." 'info'
    try {
        $output = & winget install -e --id $Id --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-String
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
        if (Test-CommandExists $CheckCommand) {
            Write-Step "$DisplayName 安装成功。" 'ok'
            return $true
        }
        Write-Step "$DisplayName 安装后仍未在 PATH 中找到。winget 输出:`n$output" 'warn'
        Write-Step '请关闭并重新打开终端，或注销后重试。' 'warn'
        return $false
    } catch {
        Write-Step "安装 $DisplayName 失败: $($_.Exception.Message)" 'warn'
        return $false
    }
}

function Install-YtDlp {
    param([string]$PythonExe)
    Write-Step '正在安装/升级 yt-dlp[default]（含 EJS 依赖）...' 'info'
    try {
        & $PythonExe -m pip install --user --upgrade 'yt-dlp[default]' | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "pip 退出码 $LASTEXITCODE"
        }
        Write-Step 'yt-dlp[default] 已安装/升级。' 'ok'
        return $true
    } catch {
        Write-Step "安装 yt-dlp 失败: $($_.Exception.Message)" 'error'
        Write-Step '可手动执行: py -m pip install --user --upgrade "yt-dlp[default]"' 'warn'
        return $false
    }
}

function Test-YtDlpAvailable {
    param([string]$PythonExe)
    if (Test-CommandExists 'yt-dlp') { return $true }
    if (Test-CommandExists 'yt-dlp.exe') { return $true }
    try {
        & $PythonExe -c "import yt_dlp; print(yt_dlp.version.__version__)" 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# --- main ---
Write-Host ''
Write-Host '=== YT-DLP Edge 本机桥接安装 ===' -ForegroundColor White
Write-Host "扩展目录: $root"
Write-Host "扩展 ID:  $ExtensionId"
Write-Host ''

if (-not (Test-Path -LiteralPath (Join-Path $root 'native-host.py') -PathType Leaf)) {
    throw @"
未在扩展目录找到 native-host.py。
当前目录: $root
请确认你是在解压后的扩展根目录中运行本脚本，且不要从 ZIP 内直接运行。
"@
}

# Python
$PythonPath = Resolve-Python -Preferred $PythonPath
if (-not $PythonPath) {
    Write-Step '未检测到 Python 3.9+。' 'warn'
    if (-not $SkipToolInstall) {
        $installed = Install-PythonWithWinget
        if ($installed) {
            $PythonPath = Resolve-Python -Preferred $null
        }
    }
}
if (-not $PythonPath) {
    throw @"
未找到可用的 Python 3.9+。

请任选一种方式安装后重试：
  1. Microsoft Store / 官网安装 Python 3.12，勾选 "Add python.exe to PATH"
  2. winget install -e --id Python.Python.3.12
  3. 安装后重新打开 PowerShell，再运行本脚本
  4. 或手动指定: .\setup-native-host.ps1 -ExtensionId "..." -PythonPath "C:\Path\to\python.exe"
"@
}
Write-Step "使用 Python: $PythonPath" 'ok'

# Tools
if (-not $SkipToolInstall) {
    Write-Host ''
    Write-Host '--- 检查并安装下载依赖 ---' -ForegroundColor White
    $null = Install-YtDlp -PythonExe $PythonPath
    if (-not (Test-YtDlpAvailable -PythonExe $PythonPath)) {
        Write-Step 'yt-dlp 仍不可用。下载功能将无法工作，请手动安装后重试。' 'error'
    } else {
        Write-Step 'yt-dlp 可用。' 'ok'
    }
    $null = Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS' -CheckCommand 'node'
    $null = Install-WithWinget -Id 'Gyan.FFmpeg' -DisplayName 'FFmpeg' -CheckCommand 'ffmpeg'
} else {
    Write-Step '已跳过工具自动安装 (-SkipToolInstall)。' 'warn'
}

# Dependency summary
Write-Host ''
Write-Host '--- 依赖状态摘要 ---' -ForegroundColor White
$checks = @(
    @{ Name = 'Python'; Check = { param($p) $true }; Path = $PythonPath }
    @{ Name = 'yt-dlp'; Check = { param($p) Test-YtDlpAvailable -PythonExe $p } }
    @{ Name = 'Node.js'; Check = { param($p) Test-CommandExists 'node' } }
    @{ Name = 'FFmpeg'; Check = { param($p) Test-CommandExists 'ffmpeg' } }
)
$missing = @()
foreach ($item in $checks) {
    $ok = & $item.Check $PythonPath
    if ($ok) {
        Write-Step "$($item.Name): 就绪" 'ok'
    } else {
        Write-Step "$($item.Name): 缺失" 'error'
        $missing += $item.Name
    }
}

# Native host launcher + registry
Write-Host ''
Write-Host '--- 注册 Native Messaging Host ---' -ForegroundColor White

$launcherPath = Join-Path $root 'native-host.cmd'
$hostScriptPath = Join-Path $root 'native-host.py'
$launcher = "@echo off`r`n" +
    "set `"PYTHONUTF8=1`"`r`n" +
    '"' + $PythonPath + '" "' + $hostScriptPath + '"' + "`r`n"
try {
    Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding Ascii
} catch {
    throw @"
无法写入 native-host.cmd: $($_.Exception.Message)
请确认扩展目录可写，且未被其他程序占用。
"@
}
Write-Step "已生成启动器: $launcherPath" 'ok'

$manifestPath = Join-Path $root 'com.local.ytdlp_downloader.json'
$manifest = [ordered]@{
    name            = 'com.local.ytdlp_downloader'
    description     = 'Local yt-dlp bridge for Edge'
    path            = $launcherPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3
try {
    Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding Ascii
} catch {
    throw "无法写入 Native Host JSON: $($_.Exception.Message)"
}
Write-Step "已生成配置: $manifestPath" 'ok'

$registryKey = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.local.ytdlp_downloader'
try {
    New-Item -Path $registryKey -Force | Out-Null
    New-ItemProperty -Path $registryKey -Name '(Default)' -Value $manifestPath -PropertyType String -Force | Out-Null
} catch {
    throw @"
写入注册表失败: $($_.Exception.Message)
需要当前用户写权限。请不要使用被策略锁定的账户，或联系管理员。
目标键: $registryKey
"@
}
Write-Step "已注册: $registryKey" 'ok'

Write-Host ''
Write-Host '=== 安装完成 ===' -ForegroundColor Green
Write-Host "扩展 ID: $ExtensionId"
Write-Host '下一步:'
Write-Host '  1. 打开 edge://extensions 并重新加载本扩展'
Write-Host '  2. 刷新已打开的 YouTube 页面'
Write-Host '  3. 点击扩展图标，确认"本机下载器已连接"'
if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host "仍有缺失依赖: $($missing -join ', ')" -ForegroundColor Yellow
    Write-Host '可在扩展弹窗中点击"安装缺失工具"，或手动安装后重开终端。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host "卸载注册: Remove-Item '$registryKey' -Recurse"
Write-Host "桥接日志: $env:LOCALAPPDATA\YT-DLP-Edge\bridge.log"
