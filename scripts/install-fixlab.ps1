[CmdletBinding()]
param(
    [string]$Repository = (Get-Location).Path,
    [string]$NodeVersion = "",
    [string]$Source = "github:microsoft/FixLab",
    [string]$NvmRoot = "",
    [switch]$InstallNode,
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

function Get-SafeSourceDisplay {
    param([string]$Value)

    $display = [regex]::Replace(
        $Value,
        '(?i)(https?://)[^/@\s]+@',
        '$1[REDACTED]@'
    )
    return [regex]::Replace(
        $display,
        '(?i)([?&](?:access_token|api_key|apikey|auth|password|secret|token)=)[^&\s]+',
        '$1[REDACTED]'
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
            $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
            $profileVersion = Get-ExactVersion ([string]$profile.toolchain.nodeVersion)
            if ($profileVersion) {
                return [pscustomobject]@{
                    Version = $profileVersion
                    Source = "$profilePath (toolchain.nodeVersion)"
                }
            }
            if ($profile.applications.frontend.workingDirectory) {
                $frontendDirectory = Join-Path $Root ([string]$profile.applications.frontend.workingDirectory)
            }
        }
        catch {
            throw "Repository profile is invalid JSON: $profilePath ($($_.Exception.Message))"
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
            $version = Get-ExactVersion (Get-Content -LiteralPath $path -Raw)
            if (-not $version) {
                throw "$path must contain an exact Node.js version such as 22.23.3."
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
            $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
            $version = Get-ExactVersion ([string]$package.engines.node)
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

function Get-NvmRoots {
    param([string]$Override)

    $roots = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
        $Override,
        $env:NVM_HOME,
        $(if ($env:APPDATA) { Join-Path $env:APPDATA "nvm" }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "nvm" })
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            $roots.Add((Resolve-Path -LiteralPath $candidate).Path)
        }
    }

    if ($env:ProgramFiles) {
        $nodeLink = Join-Path $env:ProgramFiles "nodejs"
        if (Test-Path -LiteralPath $nodeLink) {
            $nodeItem = Get-Item -LiteralPath $nodeLink -Force
            foreach ($target in @($nodeItem.Target)) {
                if (-not $target) {
                    continue
                }
                $targetPath = if ([System.IO.Path]::IsPathRooted($target)) {
                    $target
                }
                else {
                    Join-Path (Split-Path -Parent $nodeLink) $target
                }
                $targetRoot = Split-Path -Parent $targetPath
                if (Test-Path -LiteralPath $targetRoot -PathType Container) {
                    $roots.Add((Resolve-Path -LiteralPath $targetRoot).Path)
                }
            }
        }
    }

    foreach ($root in @($roots)) {
        $settingsPath = Join-Path $root "settings.txt"
        if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
            continue
        }
        $rootSetting = Get-Content -LiteralPath $settingsPath |
            Where-Object { $_ -match '^\s*root\s*:' } |
            Select-Object -First 1
        if ($rootSetting) {
            $configuredRoot = ($rootSetting -replace '^\s*root\s*:\s*', '').Trim()
            if (Test-Path -LiteralPath $configuredRoot -PathType Container) {
                $roots.Add((Resolve-Path -LiteralPath $configuredRoot).Path)
            }
        }
    }

    return @($roots | Select-Object -Unique)
}

function Test-NodeRuntime {
    param(
        [string]$Directory,
        [string]$RequiredVersion = ""
    )

    $nodePath = Join-Path $Directory "node.exe"
    $npmPath = Join-Path $Directory "npm.cmd"
    if (
        -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $npmPath -PathType Leaf)
    ) {
        return $null
    }

    $nodeOutput = (& $nodePath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    $actualVersion = Get-ExactVersion $nodeOutput
    if (-not $actualVersion -or ($RequiredVersion -and $actualVersion -ne $RequiredVersion)) {
        return $null
    }

    $npmOutput = (& $npmPath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $npmOutput) {
        return $null
    }

    $probeDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "fixlab-npm-probe-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $probeDirectory | Out-Null
    try {
        Set-Content -LiteralPath (Join-Path $probeDirectory "package.json") -Value '{"name":"fixlab-npm-probe","version":"1.0.0"}'
        Push-Location $probeDirectory
        try {
            $probeOutput = (& $npmPath pack --dry-run --ignore-scripts --json 2>&1 | Out-String)
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
        Remove-Item -LiteralPath $probeDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    return [pscustomobject]@{
        Version = $actualVersion
        Node = $nodePath
        Npm = $npmPath
        NpmVersion = $npmOutput
        Directory = $Directory
    }
}

function Find-NodeRuntime {
    param(
        [string[]]$Roots,
        [string]$RequiredVersion = ""
    )

    $directories = foreach ($root in $Roots) {
        if ($RequiredVersion) {
            foreach ($name in @("v$RequiredVersion", $RequiredVersion)) {
                $candidate = Join-Path $root $name
                if (Test-Path -LiteralPath $candidate -PathType Container) {
                    $candidate
                }
            }
            continue
        }
        Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^v?\d+\.\d+\.\d+$' } |
            Select-Object -ExpandProperty FullName
    }

    $runtimes = foreach ($directory in $directories | Select-Object -Unique) {
        Test-NodeRuntime -Directory $directory -RequiredVersion $RequiredVersion
    }
    return $runtimes |
        Where-Object { $_ } |
        Sort-Object { [version]$_.Version } -Descending |
        Select-Object -First 1
}

if ($env:OS -ne "Windows_NT") {
    throw "This bootstrap is for NVM for Windows. On other platforms, activate the repository-pinned Node.js version and install FixLab with npm."
}

$repositoryRoot = (Resolve-Path -LiteralPath $Repository).Path
$requestedVersion = Get-ExactVersion $NodeVersion
if ($NodeVersion -and -not $requestedVersion) {
    throw "-NodeVersion must be an exact version such as 22.23.3."
}

$repositoryRequirement = Get-RepositoryNodeVersion -Root $repositoryRoot
if (-not $requestedVersion -and $repositoryRequirement) {
    $requestedVersion = $repositoryRequirement.Version
    Write-Output "Repository requires Node.js $requestedVersion from $($repositoryRequirement.Source)."
}
elseif ($requestedVersion) {
    Write-Output "Requested Node.js version: $requestedVersion."
}
else {
    Write-Output "Repository has no exact Node.js pin; selecting the newest coherent NVM runtime."
}

$nvmRoots = Get-NvmRoots -Override $NvmRoot
if ($nvmRoots.Count -eq 0) {
    throw "NVM for Windows was not found. Install the supported NVM release, reopen PowerShell, and retry."
}
Write-Output "NVM roots:"
$nvmRoots | ForEach-Object { Write-Output "  $_" }

$runtime = Find-NodeRuntime -Roots $nvmRoots -RequiredVersion $requestedVersion
if (-not $runtime -and $requestedVersion) {
    $nvmExecutable = $nvmRoots |
        ForEach-Object { Join-Path $_ "nvm.exe" } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $nvmExecutable) {
        throw "Node.js $requestedVersion is not installed coherently, and nvm.exe was not found under the discovered roots."
    }
    if (-not $InstallNode) {
        Write-Output "Node.js $requestedVersion is not installed coherently."
        Write-Output "Next action: `"$nvmExecutable`" install $requestedVersion"
        Write-Output "Rerun this installer with -InstallNode to approve that installation."
        exit 2
    }
    if (-not $Yes) {
        Write-Output "Node.js $requestedVersion requires installation with $nvmExecutable."
        Write-Output "No changes made. Rerun with -InstallNode -Yes to approve the Node.js installation."
        exit 0
    }

    Write-Output "Installing Node.js $requestedVersion with $nvmExecutable..."
    & $nvmExecutable install $requestedVersion
    if ($LASTEXITCODE -ne 0) {
        throw "NVM failed to install Node.js $requestedVersion (exit code $LASTEXITCODE)."
    }
    $runtime = Find-NodeRuntime -Roots $nvmRoots -RequiredVersion $requestedVersion
    if (-not $runtime) {
        throw "NVM reported success but did not create a coherent Node.js $requestedVersion runtime. Repair or reinstall NVM for Windows, then retry."
    }
}

if (-not $runtime) {
    $repairScript = Join-Path $PSScriptRoot "repair-node-runtime.ps1"
    throw "No coherent NVM Node.js/npm installation was found. Repair NVM or run: pwsh -File `"$repairScript`" -Repository `"$repositoryRoot`" -NodeVersion $requestedVersion -Yes"
}

Write-Output "Selected runtime:"
Write-Output "  Node.js: $($runtime.Version) ($($runtime.Node))"
Write-Output "  npm: $($runtime.NpmVersion) ($($runtime.Npm))"
Write-Output "FixLab source: $(Get-SafeSourceDisplay -Value $Source)"

if (-not $Yes) {
    Write-Output "No changes made. Review the plan and rerun with -Yes to install FixLab."
    exit 0
}

& $runtime.Npm install --global $Source
if ($LASTEXITCODE -ne 0) {
    throw "FixLab installation failed with npm exit code $LASTEXITCODE."
}

$prefix = (& $runtime.Npm prefix --global 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $prefix) {
    throw "FixLab was installed, but npm could not report the global prefix."
}
$fixlabCommand = Join-Path $prefix "fixlab.cmd"
if (-not (Test-Path -LiteralPath $fixlabCommand -PathType Leaf)) {
    throw "FixLab installation completed, but the command was not found at $fixlabCommand."
}

$verificationPath = "$($runtime.Directory);$prefix;$env:PATH"
$verification = & $env:ComSpec /d /s /c "set `"PATH=$verificationPath`" && `"$fixlabCommand`" --help" 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $verification -notmatch "FixLab CLI") {
    throw "FixLab command verification failed at $fixlabCommand."
}

Write-Output "PASS FixLab CLI ($fixlabCommand)"
