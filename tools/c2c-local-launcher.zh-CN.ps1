[CmdletBinding()]
param(
    [ValidateSet('Permission','Pair','Check')]
    [string]$Action = 'Permission',
    # 非交互模式：与 -Confirm 一起使用时完全不调用 Read-Host。
    # 未提供时保持原有的交互式菜单行为不变。
    [ValidateSet('1','2')]
    [string]$Mode = '',
    [ValidateSet('YES')]
    [string]$Confirm = ''
)

# ============================================================================
# C2C Local 本机工具（正式 Runtime）  V1.4
# ----------------------------------------------------------------------------
# 参数契约：
#   交互模式（生产默认，保持原行为）：
#     powershell -File c2c-local-launcher.zh-CN.ps1 -Action Permission
#     显示 0/1/2 菜单；选择 2 时还必须输入 YES。会调用 Read-Host。
#   非交互 / 无头模式（自动化）：
#     powershell -File c2c-local-launcher.zh-CN.ps1 -Action Permission -Mode 1|2 -Confirm YES
#     -Mode 与 -Confirm YES 同时给出时绝不调用 Read-Host。
#     -Mode 2 视为已确认 Level2；-Mode 1 恢复 Level1。
#   -Mode 与 -Confirm 必须成对出现，否则按参数错误处理（退出码 1）。
#   其他动作：-Action Check / -Action Pair（Pair 仍是交互式验证码输出）。
#
# 测试专用环境变量（仅在显式设置时生效，绝不作为回退路径）：
#   C2C_LAUNCHER_RUNTIME_ROOT  绝对路径的“生产形态”Runtime 目录
#                              （需含 node\node.exe、bin\c2c.js、dist\cli\index.js）。
#                              设置时完全跳过 Get-ScheduledTask，也不要求 SHA 目录名；
#                              但仍校验文件存在性并拒绝重解析点。
#                              未设置时行为不变：仍从计划任务
#                              C2C-Workspace-Autostart-9e005ae5cc15 解析正式 Runtime。
#   C2C_LAUNCHER_TASK_NAME     仅覆盖计划任务名，只在 C2C_LAUNCHER_RUNTIME_ROOT
#                              未设置时生效；必须是合法的
#                              C2C-Workspace-Autostart-<12 位 hex> 名称。
#   C2C_STATE_DIR              Runtime 状态根目录（与 Runtime 自身 getStateDir() 一致）。
#                              设置时从 <C2C_STATE_DIR>\runtime\<workspaceId>.json 读取
#                              Bridge 身份；未设置时为
#                              %LOCALAPPDATA%\OpenAI\c2c-local\runtime\<workspaceId>.json。
#                              优先级：C2C_STATE_DIR > %LOCALAPPDATA%\OpenAI\c2c-local。
#   说明：不存在任何“跳过 Bridge 验证”的开关。错误的/伪造的 Runtime 根目录
#   仍然必须经过同一套 BRIDGE_* 判定后失败。
#
# 退出码（对外契约，测试依赖，请勿随意变更；交互与非交互模式相同）：
#   0  PASS      成功：CLI 侧与正在运行的 Bridge 侧均已验证且一致。
#   1  用法错误  PowerShell 参数校验拦截、-Mode/-Confirm 未成对、或运行期选项非法。
#   2  FAIL      突发失败：Runtime 解析失败、CLI 命令执行失败、JSON 不可解析、
#                权限命令返回状态不符合预期（CLI 侧 FAIL）。
#   3  VERIFY    验证失败：无法确认正在运行的 Bridge，或 Bridge 权限与请求不一致。
#                原因见紧随其后的 *_VERIFICATION_FAILED 与 BRIDGE_* 标记。
#
# stdout 标记（ASCII、各占一行，便于测试逐行断言）：
#   CLI_SIDE_LEVEL2=PASS | CLI_SIDE_LEVEL2=FAIL
#   BRIDGE_SIDE_LEVEL2=PASS | BRIDGE_SIDE_LEVEL2=FAIL
#   CLI_SIDE_LEVEL1=PASS | CLI_SIDE_LEVEL1=FAIL
#   BRIDGE_SIDE_LEVEL1=PASS | BRIDGE_SIDE_LEVEL1=FAIL
#   BRIDGE_EFFECTIVE_MODE=<level1|level2|readonly|unknown>
#   BRIDGE_PID=<pid>  BRIDGE_STARTED_AT=<iso>  BRIDGE_WORKSPACE_ID=<id>
#   （这三项仅在同一行、以空格分隔；只有 Bridge 身份校验通过后才打印）
#   BRIDGE_ROUTE=direct|fallback   （实际使用的 CLI 路线）
#
# 失败标记（大写 ASCII，配合退出码 2/3）：
#   BRIDGE_UNAVAILABLE           Runtime 身份文件缺失/不可解析/连接被拒/超时
#   BRIDGE_IDENTITY_MISMATCH     /admin/info 与身份文件在 pid/port/startedAt 上不一致
#   BRIDGE_WORKSPACE_MISMATCH    /admin/info 的 workspaceId/workspaceRoot 属于别的工作区
#   BRIDGE_ADMIN_UNAVAILABLE     /admin/info 返回 404/401/403（admin 通道不可信）
#   BRIDGE_UNVERIFIED            其他无法读取 Bridge 权威状态的情况（含 HTTP 5xx、字段非预期）
#   LEVEL2_BRIDGE_VERIFICATION_FAILED
#   LEVEL1_BRIDGE_VERIFICATION_FAILED
#
# 成功句 本机权限命令执行成功。 只有在 CLI 侧与 Bridge 侧同时 PASS 时才会出现。
# 本工具只做“报告”，不会启动、重启或修复 Bridge，也不会修改系统 Node/旧版源码。
# ============================================================================

$ErrorActionPreference = 'Stop'
$Workspace = 'C:\codex'
$WorkspaceId = '9e005ae5cc15'
$TaskName = "C2C-Workspace-Autostart-$WorkspaceId"
$BridgeTimeoutSeconds = 4
$ExitSuccess = 0
$ExitUsage = 1
$ExitFailure = 2
$ExitUnverified = 3

# 中文显示交给带 UTF-8 BOM 的 PowerShell 脚本，CMD 保持纯 ASCII。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# ===========================================================================
# Runtime 状态根目录：与 Runtime 的 getStateDir() 语义保持一致。
#   C2C_STATE_DIR 优先（Runtime 自身也是这个规则），否则
#   %LOCALAPPDATA%\OpenAI\c2c-local
# ===========================================================================
function Get-C2CStateRoot {
    $override = $env:C2C_STATE_DIR
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        return [IO.Path]::GetFullPath($override.Trim()).TrimEnd('\')
    }
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrWhiteSpace($local)) { $local = $env:LOCALAPPDATA }
    if ([string]::IsNullOrWhiteSpace($local)) {
        throw '无法确定当前用户的 LOCALAPPDATA 目录。'
    }
    return [IO.Path]::GetFullPath((Join-Path (Join-Path (Join-Path $local 'OpenAI') 'c2c-local'))).TrimEnd('\')
}

function Get-C2CRuntimeStatePath {
    return Join-Path (Join-Path (Get-C2CStateRoot) 'runtime') "$WorkspaceId.json"
}

# ===========================================================================
# 正式 Runtime 解析：默认只认计划任务；C2C_LAUNCHER_RUNTIME_ROOT 是测试专用接缝。
# 两条路径都执行同样的重解析/文件存在性校验。
# ===========================================================================
function Test-RuntimeLayout([string]$root) {
    $full = [IO.Path]::GetFullPath($root).TrimEnd('\')
    $node = Join-Path $full 'node\node.exe'
    $cli = Join-Path $full 'bin\c2c.js'
    $entry = Join-Path $full 'dist\cli\index.js'
    foreach ($p in @($full, $node, $cli, $entry)) {
        if (-not (Test-Path -LiteralPath $p)) {
            throw "Runtime 文件缺失：$p"
        }
        $it = Get-Item -LiteralPath $p -Force -ErrorAction Stop
        if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "发现重解析路径，已拒绝执行：$p"
        }
    }
    foreach ($p in @($node, $cli, $entry)) {
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
            throw "Runtime 文件缺失：$p"
        }
    }
    return [pscustomobject]@{
        Root = $full
        Sha = [IO.Path]::GetFileName($full)
        Node = $node
        Cli = $cli
    }
}

function Get-TestRuntimeRoot {
    $seam = $env:C2C_LAUNCHER_RUNTIME_ROOT
    if ([string]::IsNullOrWhiteSpace($seam)) { return $null }
    $path = $seam.Trim()
    if (-not [IO.Path]::IsPathRooted($path)) {
        throw "C2C_LAUNCHER_RUNTIME_ROOT 必须是绝对路径：$path"
    }
    return (Test-RuntimeLayout $path)
}

function Get-TaskName {
    # 仅测试用接缝：C2C_LAUNCHER_TASK_NAME 只覆盖计划任务名，
    # 且只在不使用 C2C_LAUNCHER_RUNTIME_ROOT 时生效。
    $seam = $env:C2C_LAUNCHER_TASK_NAME
    if (-not [string]::IsNullOrWhiteSpace($seam)) {
        $name = $seam.Trim()
        if ($name -cnotmatch '^C2C-Workspace-Autostart-[a-f0-9]{12}$') {
            throw "C2C_LAUNCHER_TASK_NAME 不是合法的 C2C 自启任务名：$name"
        }
        return $name
    }
    return $TaskName
}

function Get-ProductionRuntime {
    $seam = Get-TestRuntimeRoot
    if ($null -ne $seam) { return $seam }
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        throw '无法确定当前 Windows 用户目录。'
    }
    $runtimeHome = Join-Path $env:USERPROFILE 'C2C Local Runtime'
    $taskName = Get-TaskName
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $actions = @($task.Actions | Where-Object {
        -not [string]::IsNullOrWhiteSpace([string]$_.WorkingDirectory)
    })
    if ($actions.Count -ne 1) {
        throw '正式 C2C 自启任务没有唯一的 Runtime 工作目录，已拒绝执行。'
    }
    $workDir = [IO.Path]::GetFullPath([string]$actions[0].WorkingDirectory).TrimEnd('\')
    $sha = [IO.Path]::GetFileName($workDir)
    if ($sha -cnotmatch '^[a-f0-9]{40}$') {
        throw '正式自启任务的 Runtime 版本不是合法的 SHA，已拒绝执行。'
    }
    $expected = [IO.Path]::GetFullPath((Join-Path (Join-Path $runtimeHome 'versions') $sha)).TrimEnd('\')
    if (-not [string]::Equals($workDir, $expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw '自启任务指向了正式 Runtime 目录以外的位置，已拒绝执行。'
    }
    return (Test-RuntimeLayout $expected)
}

function Get-DisplayTaskName {
    # 提示信息里使用的任务名（与解析路径一致，但不抛错）。
    try { return (Get-TaskName) } catch { return $TaskName }
}

# ---------------------------------------------------------------------------
# CLI 侧：调用 Runtime 自带 CLI，只信任其 JSON 输出里的权限字段。
# ---------------------------------------------------------------------------
function Get-C2CPermissionLevel([string]$mode) {
    if ($mode -eq '2') { return 'level2' }
    return 'level1'
}

function ConvertFrom-C2CCliJson([string[]]$lines) {
    if ($null -eq $lines) { return $null }
    foreach ($line in @($lines)) {
        $text = ([string]$line).Trim()
        if ($text.Length -eq 0) { continue }
        if (-not $text.StartsWith('{')) { continue }
        try {
            $obj = $text | ConvertFrom-Json -ErrorAction Stop
        } catch {
            continue
        }
        if ($null -ne $obj -and $obj.PSObject.Properties.Name -contains 'effectiveMode') {
            return $obj
        }
    }
    return $null
}

function Get-LevelFromCliState([object]$state) {
    if ($null -eq $state) { return '' }
    # 优先 effectiveMode；缺失时退回 mode / baselineMode（兼容旧 CLI 输出）。
    foreach ($name in @('effectiveMode','mode','baselineMode')) {
        $prop = $state.PSObject.Properties[$name]
        if ($null -ne $prop -and -not [string]::IsNullOrWhiteSpace([string]$prop.Value)) {
            return ([string]$prop.Value).ToLowerInvariant()
        }
    }
    return ''
}

function Invoke-C2CCliPermission([object]$runtime, [string]$mode, [switch]$DirectBridge) {
    $arguments = @()
    if ($DirectBridge) {
        $arguments += @('permission', 'bridge', $mode)
    } else {
        $arguments += @('permission', $mode)
    }
    $arguments += @('-w', $Workspace, '--json')
    $raw = @(& $runtime.Node $runtime.Cli @arguments 2>&1)
    return [pscustomobject]@{
        ExitCode = [int]$LASTEXITCODE
        Raw = $raw
        Json = (ConvertFrom-C2CCliJson -lines $raw)
    }
}

function Test-CliSideLevel([object]$result, [string]$expectedLevel, [string]$mode) {
    if ($null -eq $result -or $null -eq $result.Json) { return $false }
    $state = $result.Json
    if ($result.ExitCode -ne 0) { return $false }
    if ($state.ok -ne $true) { return $false }
    if ([string]$state.workspaceId -cne $WorkspaceId) { return $false }
    $effective = Get-LevelFromCliState $state
    if ($effective -cne $expectedLevel) { return $false }
    if ($mode -eq '1') {
        $baseline = ''
        $bp = $state.PSObject.Properties['baselineMode']
        if ($null -ne $bp) { $baseline = ([string]$bp.Value).ToLowerInvariant() }
        if ([string]::IsNullOrWhiteSpace($baseline)) {
            $mp = $state.PSObject.Properties['mode']
            if ($null -ne $mp) { $baseline = ([string]$mp.Value).ToLowerInvariant() }
        }
        if ($baseline -cne 'level1') { return $false }
    }
    return $true
}

# ---------------------------------------------------------------------------
# Bridge 侧：读取 Runtime 身份文件 + GET /admin/info 独立验证。
# Result.Status:
#   PASS | BRIDGE_UNAVAILABLE | BRIDGE_IDENTITY_MISMATCH | BRIDGE_WORKSPACE_MISMATCH |
#   BRIDGE_ADMIN_UNAVAILABLE | BRIDGE_UNVERIFIED
# ---------------------------------------------------------------------------
function New-BridgeResult([string]$status, [string]$reason, [string]$effective) {
    return [pscustomobject]@{
        Status = $status
        Reason = $reason
        EffectiveMode = $effective
        Detail = $null
    }
}

function ConvertTo-CanonicalTimestamp([object]$value) {
    if ($null -eq $value) { return '' }
    $text = [string]$value
    if ([string]::IsNullOrWhiteSpace($text)) { return '' }
    $parsed = [datetime]::MinValue
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    if (-not [datetime]::TryParse($text, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        return $text.Trim()
    }
    return $parsed.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

function Test-PathUnderWorkspace([string]$candidate) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { return $false }
    try {
        $full = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
    } catch {
        return $false
    }
    $root = [IO.Path]::GetFullPath($Workspace).TrimEnd('\')
    return [string]::Equals($full, $root, [StringComparison]::OrdinalIgnoreCase)
}

function Get-BridgeEffectiveMode([object]$info) {
    if ($null -eq $info) { return '' }
    # 新版 Runtime 可能在 /admin/info 增加 effectiveMode，优先使用；
    # 当前 Runtime 只返回 permissionMode（= readPermission()，即 effectiveMode 字符串）。
    foreach ($name in @('effectiveMode','permissionMode','baselineMode')) {
        $prop = $info.PSObject.Properties[$name]
        if ($null -ne $prop -and -not [string]::IsNullOrWhiteSpace([string]$prop.Value)) {
            return ([string]$prop.Value).ToLowerInvariant()
        }
    }
    return ''
}

function Get-BridgeAuthorityState {
    $path = Get-C2CRuntimeStatePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return New-BridgeResult 'BRIDGE_UNAVAILABLE' 'runtime_state_missing' ''
    }
    $raw = $null
    try {
        $raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
    } catch {
        return New-BridgeResult 'BRIDGE_UNAVAILABLE' 'runtime_state_unreadable' ''
    }
    $state = $null
    try {
        $state = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return New-BridgeResult 'BRIDGE_UNAVAILABLE' 'runtime_state_unparseable' ''
    }
    if ($null -eq $state) {
        return New-BridgeResult 'BRIDGE_UNAVAILABLE' 'runtime_state_unparseable' ''
    }
    $service = [string]$state.service
    $stateWorkspaceId = [string]$state.workspaceId
    $stateRoot = [string]$state.workspaceRoot
    $statePid = $state.pid
    $statePort = $state.port
    $stateToken = [string]$state.adminToken
    $stateStartedAt = [string]$state.startedAt
    if ([string]::IsNullOrWhiteSpace($service) -or [string]::IsNullOrWhiteSpace($stateWorkspaceId) -or
        $null -eq $statePid -or $null -eq $statePort -or [string]::IsNullOrWhiteSpace($stateToken) -or
        [string]::IsNullOrWhiteSpace($stateStartedAt)) {
        return New-BridgeResult 'BRIDGE_UNAVAILABLE' 'runtime_state_incomplete' ''
    }
    if ($service -cne 'c2c-bridge') {
        return New-BridgeResult 'BRIDGE_UNAVAILABLE' 'runtime_state_foreign_service' ''
    }
    if ($stateWorkspaceId -cne $WorkspaceId) {
        return New-BridgeResult 'BRIDGE_WORKSPACE_MISMATCH' 'runtime_state_foreign_workspace' ''
    }
    if (-not (Test-PathUnderWorkspace $stateRoot)) {
        return New-BridgeResult 'BRIDGE_WORKSPACE_MISMATCH' 'runtime_state_foreign_root' ''
    }
    $portNumber = 0
    if (-not [int]::TryParse([string]$statePort, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
        return New-BridgeResult 'BRIDGE_UNAVAILABLE' 'runtime_state_bad_port' ''
    }

    $info = $null
    try {
        $response = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/admin/info" -f $portNumber) `
            -Headers @{ Authorization = "Bearer $stateToken" } `
            -TimeoutSec $BridgeTimeoutSeconds -UseBasicParsing -ErrorAction Stop
        $statusCode = [int]$response.StatusCode
        $body = [string]$response.Content
    } catch {
        if ($null -eq $_.Exception.Response) {
            # 连接被拒 / 超时 / 无监听：Bridge 不可用。
            return New-BridgeResult 'BRIDGE_UNAVAILABLE' ("connect_failed:" + $_.Exception.Message) ''
        }
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = 0 }
        $body = ''
        try {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $body = $reader.ReadToEnd()
            $reader.Dispose()
        } catch { $body = '' }
        if ($statusCode -eq 404 -or $statusCode -eq 401 -or $statusCode -eq 403) {
            # admin 通道被隐藏或 token 不匹配：绝不可视为成功。
            return New-BridgeResult 'BRIDGE_ADMIN_UNAVAILABLE' ("http_$statusCode") ''
        }
        if ($statusCode -eq 0) {
            return New-BridgeResult 'BRIDGE_UNAVAILABLE' ("connect_failed:" + $_.Exception.Message) ''
        }
        return New-BridgeResult 'BRIDGE_UNVERIFIED' ("http_$statusCode") ''
    }

    if ($statusCode -ne 200) {
        if ($statusCode -eq 404 -or $statusCode -eq 401 -or $statusCode -eq 403) {
            return New-BridgeResult 'BRIDGE_ADMIN_UNAVAILABLE' ("http_$statusCode") ''
        }
        return New-BridgeResult 'BRIDGE_UNVERIFIED' ("http_$statusCode") ''
    }

    try {
        $info = $body | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return New-BridgeResult 'BRIDGE_UNVERIFIED' 'admin_info_unparseable' ''
    }
    if ($null -eq $info) {
        return New-BridgeResult 'BRIDGE_UNVERIFIED' 'admin_info_unparseable' ''
    }

    $observedMode = Get-BridgeEffectiveMode $info
    $result = New-BridgeResult 'PASS' '' $observedMode
    $result.Detail = $info

    if ([string]$info.service -cne 'c2c-bridge') {
        return New-BridgeResult 'BRIDGE_UNVERIFIED' 'admin_info_foreign_service' $observedMode
    }
    if ([string]$info.workspaceId -cne $WorkspaceId -or -not (Test-PathUnderWorkspace ([string]$info.workspaceRoot))) {
        $mismatch = New-BridgeResult 'BRIDGE_WORKSPACE_MISMATCH' 'admin_info_foreign_workspace' $observedMode
        $mismatch.Detail = $info
        return $mismatch
    }
    $infoPid = 0
    $infoPort = 0
    $pidOk = [int]::TryParse([string]$info.pid, [ref]$infoPid) -and ($infoPid -eq [int]$statePid)
    $portOk = [int]::TryParse([string]$info.port, [ref]$infoPort) -and ($infoPort -eq $portNumber)
    $startedOk = [string]::Equals(
        (ConvertTo-CanonicalTimestamp $info.startedAt),
        (ConvertTo-CanonicalTimestamp $stateStartedAt),
        [StringComparison]::Ordinal)
    if (-not ($pidOk -and $portOk -and $startedOk)) {
        $mismatch = New-BridgeResult 'BRIDGE_IDENTITY_MISMATCH' 'admin_info_identity_mismatch' $observedMode
        $mismatch.Detail = $info
        return $mismatch
    }
    if ([string]::IsNullOrWhiteSpace($observedMode)) {
        $unverified = New-BridgeResult 'BRIDGE_UNVERIFIED' 'admin_info_permission_missing' ''
        $unverified.Detail = $info
        return $unverified
    }
    return $result
}

function Write-BridgeIdentityLine([object]$bridgeResult) {
    # 只有身份校验通过（/admin/info 与 Runtime 身份文件在 pid/port/startedAt 上一致）才输出这一行。
    if ($null -eq $bridgeResult -or $bridgeResult.Status -ne 'PASS' -or $null -eq $bridgeResult.Detail) { return }
    $info = $bridgeResult.Detail
    $pidText = [string]$info.pid
    $startedText = [string]$info.startedAt
    $wsText = [string]$info.workspaceId
    if ([string]::IsNullOrWhiteSpace($pidText) -or [string]::IsNullOrWhiteSpace($startedText) -or
        [string]::IsNullOrWhiteSpace($wsText)) { return }
    Write-Host ("BRIDGE_PID={0} BRIDGE_STARTED_AT={1} BRIDGE_WORKSPACE_ID={2}" -f $pidText, $startedText, $wsText)
}

function Write-BridgeFailure([string]$token, [string]$levelToken, [string]$cliToken, [object]$bridgeResult) {
    Write-Host ("{0}_BRIDGE_VERIFICATION_FAILED" -f $levelToken) -ForegroundColor Red
    Write-Host ($cliToken + '=PASS') -ForegroundColor Yellow
    Write-Host ("BRIDGE_SIDE_{0}=FAIL" -f $levelToken) -ForegroundColor Red
    $observed = ''
    if ($null -ne $bridgeResult) { $observed = [string]$bridgeResult.EffectiveMode }
    if ([string]::IsNullOrWhiteSpace($observed)) { $observed = 'unknown' }
    Write-Host ("BRIDGE_EFFECTIVE_MODE={0}" -f $observed) -ForegroundColor Yellow
    if (-not [string]::IsNullOrWhiteSpace($token)) {
        Write-Host $token -ForegroundColor Red
    }
    if ($null -ne $bridgeResult -and -not [string]::IsNullOrWhiteSpace([string]$bridgeResult.Reason)) {
        Write-Host ("BRIDGE_REASON={0}" -f $bridgeResult.Reason)
    }
    Write-Host ''
    Write-Host 'CLI 侧已确认，但无法确认“正在运行的 Bridge”具备同样的权限。' -ForegroundColor Red
    Write-Host '因此本次切换不视为成功。' -ForegroundColor Red
    Write-Host '本工具不会自动启动、重启或修复 Bridge，请检查自启/恢复状态：' -ForegroundColor Yellow
    Write-Host ("  · 计划任务 {0} 是否已运行" -f (Get-DisplayTaskName))
    Write-Host "  · 状态文件 $(Get-C2CRuntimeStatePath)"
    Write-Host '  · 日志 %LOCALAPPDATA%\OpenAI\c2c-local\logs\'
    Write-Host ("  · 退出码 {0}（2=突发失败，3=验证失败）" -f $ExitUnverified)
}

# ---------------------------------------------------------------------------
# 双验证主流程：CLI 侧 + Bridge 侧。成功判定只取决于这两项。
# ---------------------------------------------------------------------------
function Invoke-C2CBridgeCheck([string]$mode) {
    $level = Get-C2CPermissionLevel $mode
    $levelToken = $level.ToUpperInvariant()
    $cliToken = "CLI_SIDE_$levelToken"
    $bridgeToken = "BRIDGE_SIDE_$levelToken"
    $verifyToken = "$($levelToken)_BRIDGE_VERIFICATION_FAILED"

    Write-Host ''
    Write-Host '正在验证正在运行的 Bridge……'
    $bridge = Get-BridgeAuthorityState
    if ($bridge.Status -ne 'PASS') {
        Write-Host ($cliToken + '=UNKNOWN') -ForegroundColor Yellow
        Write-Host ("{0}=FAIL" -f $bridgeToken) -ForegroundColor Red
        $observed = ''
        if ($null -ne $bridge) { $observed = [string]$bridge.EffectiveMode }
        if ([string]::IsNullOrWhiteSpace($observed)) { $observed = 'unknown' }
        Write-Host ("BRIDGE_EFFECTIVE_MODE={0}" -f $observed) -ForegroundColor Yellow
        Write-Host ([string]$bridge.Status) -ForegroundColor Red
        if (-not [string]::IsNullOrWhiteSpace([string]$bridge.Reason)) {
            Write-Host ("BRIDGE_REASON={0}" -f $bridge.Reason)
        }
        Write-Host ''
        Write-Host 'Bridge 权威状态不可读，无法确认权限是否生效，因此不能报告成功。' -ForegroundColor Red
        Write-Host '本工具不会自动启动、重启或修复 Bridge，请检查自启/恢复状态：' -ForegroundColor Yellow
        Write-Host ("  · 计划任务 {0} 是否已运行" -f (Get-DisplayTaskName))
        Write-Host "  · 状态文件 $(Get-C2CRuntimeStatePath)"
        Write-Host '  · 日志 %LOCALAPPDATA%\OpenAI\c2c-local\logs\'
        throw (New-Object System.Management.Automation.RuntimeException("BRIDGE_CHECK_FAILED:$($bridge.Status)"))
    }

    if ($bridge.EffectiveMode -cne $level) {
        return [pscustomobject]@{
            Ok = $false
            Level = $level
            Verified = $true
            Bridge = $bridge
        }
    }
    return [pscustomobject]@{
        Ok = $true
        Level = $level
        Verified = $true
        Bridge = $bridge
    }
}

function Set-C2CPermission([object]$runtime, [string]$mode) {
    $level = Get-C2CPermissionLevel $mode
    $levelToken = $level.ToUpperInvariant()
    $cliToken = "CLI_SIDE_$levelToken"
    $bridgeToken = "BRIDGE_SIDE_$levelToken"
    $verifyToken = "$($levelToken)_BRIDGE_VERIFICATION_FAILED"

    # 优先路径：新版 Runtime 的 bridge-authority CLI（直接由 Bridge 权威执行）。
    $route = 'direct'
    $direct = Invoke-C2CCliPermission $runtime $mode -DirectBridge
    $cliResult = $null
    if (Test-CliSideLevel $direct $level $mode) {
        $cliResult = $direct
    } else {
        # 回退路径：当前 Runtime 不支持该子命令时，在启动器进程里执行本地
        # permission 命令，然后由本工具独立验证正在运行的 Bridge（双验证）。
        $route = 'fallback'
        $cliResult = Invoke-C2CCliPermission $runtime $mode
        if ($null -eq $cliResult.Json) {
            $detail = ($cliResult.Raw | Out-String).Trim()
            throw "权限命令没有返回可解析的 JSON（退出码 $($cliResult.ExitCode)），无法确认是否成功。$detail"
        }
    }

    Write-Host ("BRIDGE_ROUTE={0}" -f $route)
    $ok = Test-CliSideLevel $cliResult $level $mode
    if (-not $ok) {
        Write-Host ($cliToken + '=FAIL') -ForegroundColor Red
        Write-Host ($bridgeToken + '=UNKNOWN') -ForegroundColor Yellow
        $observed = Get-LevelFromCliState $cliResult.Json
        if ([string]::IsNullOrWhiteSpace($observed)) { $observed = 'unknown' }
        Write-Host ("CLI_EFFECTIVE_MODE={0}" -f $observed)
        $errMsg = ''
        if ($null -ne $cliResult.Json) {
            $ep = $cliResult.Json.PSObject.Properties['error']
            if ($null -ne $ep) { $errMsg = [string]$ep.Value }
        }
        # 明确告诉用户：这多半是当前 Runtime 的能力限制，不是 Bridge 故障，也不是本工具 bug。
        Write-Host ''
        Write-Host 'CLI 侧没有确认到目标权限，因此不再进行 Bridge 验证，也不会报告成功。' -ForegroundColor Red
        Write-Host '常见原因（按可能性排序）：' -ForegroundColor Yellow
        Write-Host '  1. 当前 Runtime 还不支持新的“桥接授权”路径（permission bridge），' -ForegroundColor Yellow
        Write-Host '     而本地 permission 命令无法确认当前 Windows 登录会话身份，' -ForegroundColor Yellow
        Write-Host '     于是它自己就返回了失败（CLI 退出码非 0 或 ok:false）。' -ForegroundColor Yellow
        Write-Host '     这属于 Runtime 版本能力限制，不是 Bridge 故障。' -ForegroundColor Yellow
        Write-Host '  2. 权限命令执行失败或返回了非预期状态。' -ForegroundColor Yellow
        if (-not [string]::IsNullOrWhiteSpace($errMsg)) {
            Write-Host "  Runtime 返回：$errMsg" -ForegroundColor Yellow
        }
        Write-Host ("  CLI 退出码：{0}；CLI 观测到的权限：{1}" -f $cliResult.ExitCode, $observed)
        throw ("CLI 侧权限命令返回状态不符合预期（退出码 $($cliResult.ExitCode)），不能认定切换成功。" + $errMsg)
    }
    Write-Host ($cliToken + '=PASS') -ForegroundColor Green

    $bridgeCheck = Invoke-C2CBridgeCheck $mode
    if (-not $bridgeCheck.Ok) {
        Write-BridgeFailure $verifyToken $levelToken $cliToken $bridgeCheck.Bridge
        return $false
    }
    Write-Host ($bridgeToken + '=PASS') -ForegroundColor Green
    Write-Host ("BRIDGE_EFFECTIVE_MODE={0}" -f $bridgeCheck.Bridge.EffectiveMode)
    Write-BridgeIdentityLine $bridgeCheck.Bridge

    Write-Host ''
    Write-Host '本机权限命令执行成功。' -ForegroundColor Green
    Write-Host "Workspace：$Workspace"
    Write-Host "当前权限：$($bridgeCheck.Bridge.EffectiveMode)（CLI 与 Bridge 双重验证一致）"
    if ($mode -eq '2') {
        Write-Host 'Level2 开启后跨 ChatGPT 对话持续有效，关闭 CMD 或切换聊天不会取消。'
        Write-Host '手动恢复 Level1、注销 Windows 或重启电脑后，Level2 将失效。'
    } else {
        Write-Host '已恢复 Level1。'
    }
    return $true
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
$headless = (-not [string]::IsNullOrWhiteSpace($Mode)) -or (-not [string]::IsNullOrWhiteSpace($Confirm))

try {
    # 非交互模式的成对参数校验：-Mode 与 -Confirm YES 必须同时给出。
    if ($headless) {
        if ($Action -ne 'Permission') {
            Write-Host '参数错误：-Mode/-Confirm 只能与 -Action Permission 一起使用。' -ForegroundColor Red
            exit $ExitUsage
        }
        if ([string]::IsNullOrWhiteSpace($Mode) -or [string]::IsNullOrWhiteSpace($Confirm)) {
            Write-Host '参数错误：非交互模式必须同时提供 -Mode 1|2 与 -Confirm YES。' -ForegroundColor Red
            exit $ExitUsage
        }
    }

    Write-Host '============================================'
    Write-Host '       C2C Local 本机工具（正式 Runtime）'
    Write-Host '============================================'
    $runtime = Get-ProductionRuntime
    Write-Host "工作区：$Workspace"
    Write-Host "Runtime：$($runtime.Sha)"
    Write-Host ''

    if ($Action -eq 'Check') {
        $version = & $runtime.Node '--version'
        if ($LASTEXITCODE -ne 0) { throw '正式 Runtime 的 Node 无法执行。' }
        Write-Host "随附 Node 版本：$version"
        Write-Host '路径校验：通过。'
        $bridge = Get-BridgeAuthorityState
        if ($bridge.Status -eq 'PASS') {
            Write-Host ("Bridge 状态：运行中（effectiveMode={0}）" -f $bridge.EffectiveMode)
        } else {
            Write-Host ("Bridge 状态：{0}" -f $bridge.Status) -ForegroundColor Yellow
        }
        exit $ExitSuccess
    }

    if ($Action -eq 'Pair') {
        Write-Host '正在生成 V1.4 配对验证码……'
        Write-Host '注意：验证码有时效，只在 ChatGPT 的 C2C Local 配对页面输入。'
        Write-Host ''
        & $runtime.Node $runtime.Cli 'pair' '-w' $Workspace
        if ($LASTEXITCODE -ne 0) { throw "验证码生成失败，退出码：$LASTEXITCODE" }
        Write-Host ''
        Write-Host '如果已经配对成功，无需反复生成新验证码。' -ForegroundColor Green
        exit $ExitSuccess
    }

    if ($headless) {
        # 非交互：不调用 Read-Host。
        Write-Host ("非交互模式：目标权限 Level{0}（-Confirm YES 已提供）。" -f $Mode)
        if (Set-C2CPermission $runtime $Mode) { exit $ExitSuccess }
        exit $ExitUnverified
    }

    Write-Host '权限选项：'
    Write-Host '  1  恢复 Level1（普通权限，推荐默认）'
    Write-Host '  2  启用 Level2（较高权限，跨 ChatGPT 对话保持）'
    Write-Host '     直到手动切回 Level1、注销 Windows 或重启电脑。'
    Write-Host '  0  退出，不修改权限'
    Write-Host ''
    Write-Host '说明：切换后本工具会同时验证 CLI 与正在运行的 Bridge，两项一致才算成功。'
    Write-Host ''
    $choice = (Read-Host '请输入选项 0 / 1 / 2').Trim()
    switch ($choice) {
        '1' {
            if (Set-C2CPermission $runtime '1') { exit $ExitSuccess }
            exit $ExitUnverified
        }
        '2' {
            $answer = (Read-Host '启用 Level2 会增加本机文件操作权限。确认请输入 YES').Trim()
            if ($answer -cne 'YES') {
                Write-Host '已取消，权限未修改。'
                exit $ExitSuccess
            }
            if (Set-C2CPermission $runtime '2') { exit $ExitSuccess }
            exit $ExitUnverified
        }
        '0' { Write-Host '已退出，权限未修改。'; exit $ExitSuccess }
        default {
            Write-Host '无效的选项，权限未修改。' -ForegroundColor Red
            exit $ExitUsage
        }
    }
} catch {
    $message = $_.Exception.Message
    Write-Host ''
    if ($message -like 'BRIDGE_CHECK_FAILED:*') {
        # 详细标记已在验证阶段打印。
        Write-Host '验证失败：无法确认正在运行的 Bridge（退出码 3，仅报告，不自动修复）。' -ForegroundColor Red
        exit $ExitUnverified
    }
    if ($message -like 'CLI 侧权限命令*') {
        Write-Host ('操作失败：' + $message) -ForegroundColor Red
        Write-Host 'CLI 侧未通过，未进行 Bridge 验证。' -ForegroundColor Yellow
        Write-Host '没有自动切换到系统 Node 或旧版源码。' -ForegroundColor Yellow
        exit $ExitFailure
    }
    Write-Host ('操作失败：' + $message) -ForegroundColor Red
    Write-Host '没有自动切换到系统 Node 或旧版源码。' -ForegroundColor Yellow
    exit $ExitFailure
}

