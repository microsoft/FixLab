[CmdletBinding()]
param(
    [string]$Repository = (Get-Location).Path,
    [string]$NodeVersion = "",
    [ValidateSet("x64", "arm64")]
    [string]$Architecture = "x64",
    [string]$DestinationRoot = (
        Join-Path $env:LOCALAPPDATA "FixLab\runtimes"
    ),
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

function Get-ExactVersion {
    param([string]$Value)

    $normalized = $Value.Trim().TrimStart("v")
    if ($normalized -match '^\d+\.\d+\.\d+$') {
        return $normalized
    }
    return ""
}

function Assert-NoReparsePoints {
    param(
        [string]$Path,
        [switch]$InspectDescendants
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $current = [System.IO.Path]::GetPathRoot($fullPath)
    $relative = $fullPath.Substring($current.Length)
    foreach ($segment in $relative.Split(
        [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ),
        [System.StringSplitOptions]::RemoveEmptyEntries
    )) {
        $current = Join-Path $current $segment
        $item = Get-Item `
            -LiteralPath $current `
            -Force `
            -ErrorAction SilentlyContinue
        if (-not $item) {
            continue
        }
        if (
            $item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint
        ) {
            throw "Refusing to use a path containing a reparse point: $current"
        }
    }

    if (
        $InspectDescendants -and
        (Test-Path -LiteralPath $fullPath -PathType Container)
    ) {
        $reparsePoint = Get-ChildItem `
            -LiteralPath $fullPath `
            -Force `
            -Recurse `
            -Attributes ReparsePoint `
            -ErrorAction Stop |
                Select-Object -First 1
        if ($reparsePoint) {
            throw "Refusing to use a directory containing a reparse point: $($reparsePoint.FullName)"
        }
    }

    return $fullPath
}

function Test-FixLabOwnershipMarker {
    param([string]$Path)

    $item = Get-Item `
        -LiteralPath $Path `
        -Force `
        -ErrorAction SilentlyContinue
    if (-not $item) {
        return $false
    }
    if (
        $item.Attributes -band
        [System.IO.FileAttributes]::ReparsePoint
    ) {
        throw "Refusing to trust a reparse-point ownership marker: $Path"
    }
    if ($item.PSIsContainer) {
        throw "Refusing to trust a non-file ownership marker: $Path"
    }
    return (Get-Content -LiteralPath $Path -Raw).Trim() -eq (
        "FixLab portable runtime root"
    )
}

function Get-RepositoryNodeVersion {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        throw "Repository directory does not exist: $Root"
    }

    $profilePath = Join-Path $Root ".github\fixlab\repository-profile.json"
    $frontendDirectory = ""
    if (Test-Path -LiteralPath $profilePath -PathType Leaf) {
        try {
            $profile = Get-Content -LiteralPath $profilePath -Raw |
                ConvertFrom-Json
            $configuredVersion = [string]$profile.toolchain.nodeVersion
            if ($configuredVersion) {
                $profileVersion = Get-ExactVersion $configuredVersion
                if (-not $profileVersion) {
                    throw "$profilePath toolchain.nodeVersion must be an exact version such as 18.18.0."
                }
                return [pscustomobject]@{
                    Version = $profileVersion
                    Source = "$profilePath (toolchain.nodeVersion)"
                }
            }
            if ($profile.applications.frontend.workingDirectory) {
                $frontendDirectory = Join-Path $Root (
                    [string]$profile.applications.frontend.workingDirectory
                )
            }
        }
        catch {
            throw "Repository profile is invalid: $profilePath ($($_.Exception.Message))"
        }
    }

    $directories = @($Root)
    if ($frontendDirectory) {
        $directories += $frontendDirectory
    }
    foreach ($directory in $directories | Select-Object -Unique) {
        foreach ($name in @(".nvmrc", ".node-version")) {
            $path = Join-Path $directory $name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                continue
            }
            $version = Get-ExactVersion (
                Get-Content -LiteralPath $path -Raw
            )
            if (-not $version) {
                throw "$path must contain an exact Node.js version such as 18.18.0."
            }
            return [pscustomobject]@{
                Version = $version
                Source = $path
            }
        }

        $packagePath = Join-Path $directory "package.json"
        if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
            continue
        }
        try {
            $package = Get-Content -LiteralPath $packagePath -Raw |
                ConvertFrom-Json
            $configuredVersion = [string]$package.engines.node
            $version = Get-ExactVersion $configuredVersion
            if ($version) {
                return [pscustomobject]@{
                    Version = $version
                    Source = "$packagePath (engines.node)"
                }
            }
        }
        catch {
            throw "package.json is invalid JSON: $packagePath ($($_.Exception.Message))"
        }
    }

    return $null
}

function Test-PortableRuntime {
    param(
        [string]$Directory,
        [string]$RequiredVersion
    )

    $nodePath = Join-Path $Directory "node.exe"
    $npmPath = Join-Path $Directory "npm.cmd"
    $npmCliPath = Join-Path $Directory "node_modules\npm\bin\npm-cli.js"
    if (
        -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $npmPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $npmCliPath -PathType Leaf)
    ) {
        return $null
    }

    $nodeOutput = (& $nodePath --version 2>&1 | Out-String).Trim()
    if (
        $LASTEXITCODE -ne 0 -or
        (Get-ExactVersion $nodeOutput) -ne $RequiredVersion
    ) {
        return $null
    }

    $npmOutput = (& $npmPath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $npmOutput) {
        return $null
    }

    $probeDirectory = Join-Path (
        [System.IO.Path]::GetTempPath()
    ) "fixlab-portable-npm-probe-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $probeDirectory | Out-Null
    try {
        Set-Content `
            -LiteralPath (Join-Path $probeDirectory "package.json") `
            -Value '{"name":"fixlab-portable-npm-probe","version":"1.0.0"}'
        Push-Location $probeDirectory
        try {
            $probeOutput = (
                & $npmPath pack --dry-run --ignore-scripts --json 2>&1 |
                    Out-String
            )
            $probeStatus = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        if (
            $probeStatus -ne 0 -or
            $probeOutput -match 'Class extends value undefined|(?:TypeError|ReferenceError|SyntaxError):'
        ) {
            return $null
        }
    }
    finally {
        Remove-Item `
            -LiteralPath $probeDirectory `
            -Recurse `
            -Force `
            -ErrorAction SilentlyContinue
    }

    return [pscustomobject]@{
        Node = $nodePath
        Npm = $npmPath
        NpmCli = $npmCliPath
        NodeVersion = $RequiredVersion
        NpmVersion = $npmOutput
        Directory = $Directory
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "Portable Node runtime repair currently supports Windows only."
}
if (-not $env:LOCALAPPDATA -and -not $DestinationRoot) {
    throw "LOCALAPPDATA is unavailable; pass an explicit -DestinationRoot."
}

$repositoryRoot = (Resolve-Path -LiteralPath $Repository).Path
$requestedVersion = Get-ExactVersion $NodeVersion
if ($NodeVersion -and -not $requestedVersion) {
    throw "-NodeVersion must be an exact version such as 18.18.0."
}
if (-not $requestedVersion) {
    $requirement = Get-RepositoryNodeVersion -Root $repositoryRoot
    if (-not $requirement) {
        throw "No exact repository Node.js version was found. Pass -NodeVersion with an exact version."
    }
    $requestedVersion = $requirement.Version
    Write-Output "Repository requires Node.js $requestedVersion from $($requirement.Source)."
}

$destinationRootFull = [System.IO.Path]::GetFullPath($DestinationRoot)
$destinationRootFull = Assert-NoReparsePoints -Path $destinationRootFull
$ownershipMarker = Join-Path $destinationRootFull ".fixlab-runtime-root"
$runtimeName = "node-v$requestedVersion-win-$Architecture"
$runtimePath = [System.IO.Path]::GetFullPath(
    (Join-Path $destinationRootFull $runtimeName)
)
$rootPrefix = $destinationRootFull.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
if (
    -not $runtimePath.StartsWith(
        $rootPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )
) {
    throw "Runtime destination must remain inside DestinationRoot."
}
$runtimePath = Assert-NoReparsePoints -Path $runtimePath

$archiveName = "$runtimeName.zip"
$downloadBase = "https://nodejs.org/dist/v$requestedVersion"
$archiveUrl = "$downloadBase/$archiveName"
$checksumsUrl = "$downloadBase/SHASUMS256.txt"

Write-Output "Portable Node.js repair plan:"
Write-Output "  version: $requestedVersion"
Write-Output "  architecture: $Architecture"
Write-Output "  destination: $runtimePath"
Write-Output "  archive: $archiveUrl"
Write-Output "  checksum manifest: $checksumsUrl"
Write-Output "  system PATH changes: none"
Write-Output "  NVM changes: none"

$current = $null
if (Test-Path -LiteralPath $runtimePath) {
    if (-not (Test-FixLabOwnershipMarker -Path $ownershipMarker)) {
        throw "Refusing to inspect an existing runtime because DestinationRoot is not marked as FixLab-owned: $destinationRootFull"
    }
    Assert-NoReparsePoints `
        -Path $runtimePath `
        -InspectDescendants | Out-Null
    $current = Test-PortableRuntime `
        -Directory $runtimePath `
        -RequiredVersion $requestedVersion
}
if ($current) {
    Write-Output "Portable runtime is already ready:"
    Write-Output "  Node.js: $($current.NodeVersion) ($($current.Node))"
    Write-Output "  npm: $($current.NpmVersion) ($($current.Npm))"
    exit 0
}

if (-not $Yes) {
    Write-Output "No changes made. Review the plan and rerun with -Yes to repair the runtime."
    exit 0
}

New-Item -ItemType Directory -Path $destinationRootFull -Force | Out-Null
$destinationRootFull = Assert-NoReparsePoints -Path $destinationRootFull
if (
    (Test-Path -LiteralPath $runtimePath) -and
    -not (Test-FixLabOwnershipMarker -Path $ownershipMarker)
) {
    throw "Refusing to replace an existing runtime because DestinationRoot is not marked as FixLab-owned: $destinationRootFull"
}
if (-not (Test-FixLabOwnershipMarker -Path $ownershipMarker)) {
    Set-Content `
        -LiteralPath $ownershipMarker `
        -Value "FixLab portable runtime root"
}
$downloadsContainer = Join-Path $destinationRootFull ".downloads"
$downloadsContainer = Assert-NoReparsePoints -Path $downloadsContainer
New-Item `
    -ItemType Directory `
    -Path $downloadsContainer `
    -Force | Out-Null
$downloadsContainer = Assert-NoReparsePoints -Path $downloadsContainer
$downloadRoot = Join-Path $downloadsContainer (
    "repair-$([guid]::NewGuid())"
)
$archivePath = Join-Path $downloadRoot $archiveName
$checksumsPath = Join-Path $downloadRoot "SHASUMS256.txt"
$extractPath = Join-Path $downloadRoot "extract"
New-Item -ItemType Directory -Path $downloadRoot | Out-Null

try {
    Invoke-WebRequest -UseBasicParsing $archiveUrl -OutFile $archivePath
    Invoke-WebRequest `
        -UseBasicParsing `
        $checksumsUrl `
        -OutFile $checksumsPath

    $checksumLine = Get-Content -LiteralPath $checksumsPath |
        Where-Object { $_ -match "  $([regex]::Escape($archiveName))$" } |
        Select-Object -First 1
    if (-not $checksumLine) {
        throw "Official checksum manifest does not contain $archiveName."
    }
    $expectedHash = ($checksumLine -split '\s+', 2)[0].ToUpperInvariant()
    $actualHash = (
        Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
    ).Hash
    if ($actualHash -ne $expectedHash) {
        throw "Node.js archive checksum mismatch. Expected $expectedHash, got $actualHash."
    }
    Write-Output "PASS  Official Node.js SHA-256 checksum ($actualHash)"

    New-Item -ItemType Directory -Path $extractPath | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath
    $extractedRuntime = Join-Path $extractPath $runtimeName
    Assert-NoReparsePoints `
        -Path $extractedRuntime `
        -InspectDescendants | Out-Null
    $verified = Test-PortableRuntime `
        -Directory $extractedRuntime `
        -RequiredVersion $requestedVersion
    if (-not $verified) {
        throw "Downloaded archive did not produce a coherent Node.js $requestedVersion and npm runtime."
    }

    if (
        (Test-Path -LiteralPath $runtimePath) -and
        (Test-FixLabOwnershipMarker -Path $ownershipMarker)
    ) {
        Assert-NoReparsePoints `
            -Path $runtimePath `
            -InspectDescendants | Out-Null
        Remove-Item -LiteralPath $runtimePath -Recurse -Force
    }
    Move-Item -LiteralPath $extractedRuntime -Destination $runtimePath
}
finally {
    if (Test-Path -LiteralPath $downloadRoot) {
        Remove-Item -LiteralPath $downloadRoot -Recurse -Force
    }
}

$runtimePath = Assert-NoReparsePoints `
    -Path $runtimePath `
    -InspectDescendants
$runtime = Test-PortableRuntime `
    -Directory $runtimePath `
    -RequiredVersion $requestedVersion
if (-not $runtime) {
    throw "Portable Node.js repair completed but final verification failed."
}

Write-Output "Portable runtime repaired and verified:"
Write-Output "  Node.js: $($runtime.NodeVersion) ($($runtime.Node))"
Write-Output "  npm: $($runtime.NpmVersion) ($($runtime.Npm))"
Write-Output "Use it in the current PowerShell session without changing the permanent PATH:"
Write-Output "  `$env:PATH = `"$runtimePath;`$env:PATH`""
