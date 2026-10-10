$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helperPath = Join-Path $repoRoot 'build\native\c2c-execution-helper.exe'
$launcherPath = Join-Path $repoRoot 'build\native\c2c-execution-launcher.exe'
$metadataDirectory = Join-Path $repoRoot 'dist\execution'
$metadataPath = Join-Path $metadataDirectory 'c2c-execution-helper-integrity.json'

foreach ($artifact in @($helperPath, $launcherPath)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
        [Console]::Error.WriteLine("Execution artifact is missing: $artifact")
        exit 1
    }
    $attributes = [System.IO.File]::GetAttributes($artifact)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        [Console]::Error.WriteLine("Execution artifact is a reparse point: $artifact")
        exit 1
    }
    $resolved = (Resolve-Path -LiteralPath $artifact).Path
    if ([System.IO.Path]::GetFullPath($resolved) -ne [System.IO.Path]::GetFullPath($artifact)) {
        [Console]::Error.WriteLine("Execution artifact path is not canonical: $artifact")
        exit 1
    }
}
if (-not (Test-Path -LiteralPath $metadataDirectory -PathType Container)) {
    [Console]::Error.WriteLine('TypeScript distribution output is missing; integrity metadata was not produced.')
    exit 1
}

$helperHash = (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant()
$launcherHash = (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($helperHash -notmatch '^[a-f0-9]{64}$' -or $launcherHash -notmatch '^[a-f0-9]{64}$') {
    [Console]::Error.WriteLine('Execution artifact hash could not be established.')
    exit 1
}

$metadata = [ordered]@{
    version = 2
    protocolVersion = 5
    helperPath = 'build/native/c2c-execution-helper.exe'
    sha256 = $helperHash
    launcherPath = 'build/native/c2c-execution-launcher.exe'
    launcherSha256 = $launcherHash
}
$temporaryPath = "$metadataPath.$PID.tmp"
[System.IO.File]::WriteAllText($temporaryPath, ($metadata | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryPath -Destination $metadataPath -Force
Write-Output $metadataPath
