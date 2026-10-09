$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $repoRoot 'native\windows\execution-helper.cpp'
$buildDir = Join-Path $repoRoot 'build\native'
$outputPath = Join-Path $buildDir 'c2c-execution-helper.exe'
$objectPath = Join-Path $buildDir 'execution-helper.obj'

function Remove-BuildObject {
    if (Test-Path -LiteralPath $objectPath -PathType Leaf) {
        Remove-Item -LiteralPath $objectPath -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    [Console]::Error.WriteLine("Source file not found: $sourcePath")
    exit 1
}

$compiler = Get-Command cl.exe -ErrorAction SilentlyContinue
$compileArguments = @(
    '/nologo',
    '/std:c++17',
    '/EHsc',
    '/W4',
    '/DUNICODE',
    '/D_UNICODE',
    '/DWIN32_LEAN_AND_MEAN',
    '/DNOMINMAX',
    "/Fo$objectPath",
    "/Fe$outputPath",
    $sourcePath
)

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

if ($null -ne $compiler) {
    & $compiler.Source @compileArguments
    $compileExitCode = $LASTEXITCODE
    if ($compileExitCode -ne 0) {
        Remove-BuildObject
        exit $compileExitCode
    }
    Remove-BuildObject
    Write-Output $outputPath
    exit 0
}

$vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

if ($vswhereCandidates.Count -eq 0) {
    [Console]::Error.WriteLine('MSVC cl.exe was not found in PATH, and vswhere.exe is unavailable.')
    exit 1
}

$vswhere = $vswhereCandidates | Select-Object -First 1
$installationOutput = & $vswhere -latest -products '*' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
$vswhereExitCode = $LASTEXITCODE
$installationPath = $installationOutput | Select-Object -First 1
if ($vswhereExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($installationPath)) {
    [Console]::Error.WriteLine('No Visual Studio installation with the MSVC x86/x64 tools was found.')
    exit 1
}

$devCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $devCommand -PathType Leaf)) {
    [Console]::Error.WriteLine("VsDevCmd.bat was not found: $devCommand")
    exit 1
}

# VsDevCmd must initialize INCLUDE/LIB as well as PATH. Run the fixed compile
# command in that environment; no request data is interpolated into this script.
$clCommand = '/nologo /std:c++17 /EHsc /W4 /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX ' +
             '/Fo"' + $objectPath + '" /Fe"' + $outputPath + '" "' + $sourcePath + '"'
$command = 'call "' + $devCommand + '" -no_logo -arch=x64 -host_arch=x64 && cl.exe ' + $clCommand
$processInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = $env:ComSpec
$processInfo.Arguments = '/d /c ' + $command
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $processInfo
[void]$process.Start()
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
    Remove-BuildObject
    exit $process.ExitCode
}

Remove-BuildObject
Write-Output $outputPath
exit 0
