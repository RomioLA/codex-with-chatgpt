$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helperPath = Join-Path $repoRoot 'build\native\c2c-execution-helper.exe'
$metadataDirectory = Join-Path $repoRoot 'dist\execution'
$metadataPath = Join-Path $metadataDirectory 'c2c-execution-helper-integrity.json'

if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    [Console]::Error.WriteLine('Execution helper artifact is missing; integrity metadata was not produced.')
    exit 1
}
if (-not (Test-Path -LiteralPath $metadataDirectory -PathType Container)) {
    [Console]::Error.WriteLine('TypeScript distribution output is missing; integrity metadata was not produced.')
    exit 1
}

$resolvedHelper = (Resolve-Path -LiteralPath $helperPath).Path
if ([System.IO.Path]::GetFullPath($resolvedHelper) -ne [System.IO.Path]::GetFullPath($helperPath)) {
    [Console]::Error.WriteLine('Execution helper artifact path is not canonical.')
    exit 1
}
$hash = (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -notmatch '^[a-f0-9]{64}$') {
    [Console]::Error.WriteLine('Execution helper artifact hash could not be established.')
    exit 1
}

$metadata = [ordered]@{
    version = 1
    protocolVersion = 5
    helperPath = 'build/native/c2c-execution-helper.exe'
    sha256 = $hash
}
$temporaryPath = "$metadataPath.$PID.tmp"
[System.IO.File]::WriteAllText($temporaryPath, ($metadata | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryPath -Destination $metadataPath -Force
Write-Output $metadataPath
