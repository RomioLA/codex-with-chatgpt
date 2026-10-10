param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $repoRoot 'tests\windows\untrusted-helper.cpp'
$canonicalOutput = [System.IO.Path]::GetFullPath($OutputPath)
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $canonicalOutput.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    [System.IO.Path]::GetExtension($canonicalOutput) -ne '.exe') {
    [Console]::Error.WriteLine('The untrusted helper fixture must be built as an EXE under the system temp directory.')
    exit 1
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    [Console]::Error.WriteLine("Source file not found: $sourcePath")
    exit 1
}

$outputDirectory = [System.IO.Path]::GetDirectoryName($canonicalOutput)
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$objectPath = "$canonicalOutput.obj"
$compiler = Get-Command cl.exe -ErrorAction SilentlyContinue
$compileArguments = @(
    '/nologo',
    '/std:c++17',
    '/EHsc',
    '/W4',
    '/DWIN32_LEAN_AND_MEAN',
    '/DNOMINMAX',
    "/Fo$objectPath",
    "/Fe$canonicalOutput",
    $sourcePath
)

if ($null -ne $compiler) {
    & $compiler.Source @compileArguments
    exit $LASTEXITCODE
}

$vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
if ($vswhereCandidates.Count -eq 0) {
    [Console]::Error.WriteLine('MSVC cl.exe was not found in PATH, and vswhere.exe is unavailable.')
    exit 1
}

$installationOutput = & ($vswhereCandidates | Select-Object -First 1) -latest -products '*' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($installationOutput | Select-Object -First 1))) {
    [Console]::Error.WriteLine('No Visual Studio installation with the MSVC x86/x64 tools was found.')
    exit 1
}
$installationPath = $installationOutput | Select-Object -First 1
$devCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $devCommand -PathType Leaf)) {
    [Console]::Error.WriteLine("VsDevCmd.bat was not found: $devCommand")
    exit 1
}

$clCommand = '/nologo /std:c++17 /EHsc /W4 /DWIN32_LEAN_AND_MEAN /DNOMINMAX ' +
             '/Fo"' + $objectPath + '" /Fe"' + $canonicalOutput + '" "' + $sourcePath + '"'
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
exit $process.ExitCode
