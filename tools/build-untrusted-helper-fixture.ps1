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

$programFilesX86 = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)
if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
    $programFilesX86 = 'C:\Program Files (x86)'
}
Set-Item -Path 'Env:ProgramFiles(x86)' -Value $programFilesX86
if ([string]::IsNullOrWhiteSpace($env:ComSpec)) {
    $env:ComSpec = Join-Path $env:SystemRoot 'System32\cmd.exe'
}

$vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
$installationOutput = @()
if ($vswhereCandidates.Count -gt 0) {
    $installationOutput = & ($vswhereCandidates | Select-Object -First 1) -latest -products '*' `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
$installationPath = $installationOutput | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($installationPath)) {
    $visualStudioRoots = @(
        (Join-Path $programFilesX86 'Microsoft Visual Studio\2022\BuildTools'),
        (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022\BuildTools')
    )
    foreach ($root in $visualStudioRoots) {
        $msvcRoot = Join-Path $root 'VC\Tools\MSVC'
        $devCommand = Join-Path $root 'Common7\Tools\VsDevCmd.bat'
        $hasCompiler = Get-ChildItem -LiteralPath $msvcRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\Hostx64\x64\cl.exe') -PathType Leaf } |
            Select-Object -First 1
        if ($hasCompiler -and (Test-Path -LiteralPath $devCommand -PathType Leaf)) {
            $installationPath = $root
            break
        }
    }
}
if ([string]::IsNullOrWhiteSpace($installationPath)) {
    [Console]::Error.WriteLine('No usable MSVC x86/x64 compiler and Visual Studio developer environment were found.')
    exit 1
}
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
