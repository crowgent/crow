param(
  [string]$Version = "",
  [string]$Binary = "",
  [switch]$NoModifyPath
)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "crowgent/crow"
$ReleasesApi = "https://api.github.com/repos/$Repo/releases"

function Resolve-ReleaseVersion {
  param([string]$RequestedVersion)
  $clean = $RequestedVersion -replace '^crow@', '' -replace '^v', ''
  if ($clean -ne "") {
    return [PSCustomObject]@{
      Version = $clean
      BaseUrl = "https://github.com/$Repo/releases/download/crow@$clean"
    }
  }
  $response = Invoke-RestMethod -Uri "$ReleasesApi/latest" -Headers @{ "User-Agent" = "crow-install" }
  $version = "$($response.tag_name)" -replace '^crow@', ''
  if ($version -eq "") {
    throw "Failed to resolve the latest Crow release version. See https://github.com/$Repo/releases"
  }
  return [PSCustomObject]@{
    Version = $version
    BaseUrl = "https://github.com/$Repo/releases/latest/download"
  }
}

function Get-ExpectedChecksum {
  param([string]$ChecksumFile, [string]$AssetName)
  foreach ($line in (Get-Content $ChecksumFile)) {
    if ($line.Trim() -eq "") { continue }
    $parts = $line -split '\s+'
    if ($parts.Count -lt 2) { continue }
    $name = $parts[1] -replace '^\*', ''
    if ($name -eq $AssetName) {
      return $parts[0]
    }
  }
  throw "Missing checksum for $AssetName"
}

function Write-InstallMetadata {
  param(
    [string]$CrowDir,
    [string]$Version,
    [string]$BinaryPath,
    [string]$InstallDir,
    [string]$AssetName,
    [string]$Target
  )
  $installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $data = [ordered]@{
    schemaVersion = 1
    installMethod = "script"
    version = $Version
    repo = $Repo
    binaryPath = $BinaryPath
    installDir = $InstallDir
    assetName = $AssetName
    target = $Target
    installedAt = $installedAt
    shellConfigPath = $null
    pathCommand = $null
  }
  $json = $data | ConvertTo-Json
  $path = Join-Path $CrowDir "install.json"
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
  return $path
}

function Update-UserPath {
  param([string]$InstallDir)
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($null -eq $current) { $current = "" }
  $parts = $current -split ';'
  foreach ($part in $parts) {
    if ($part -ieq $InstallDir) {
      return $true
    }
  }
  if ($current -eq "") {
    $next = $InstallDir
  } else {
    $next = "$current;$InstallDir"
  }
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
  if ($null -eq $env:Path -or $env:Path -eq "") {
    $env:Path = $InstallDir
  } else {
    $env:Path = "$env:Path;$InstallDir"
  }
  return $false
}

function Install-Crow {
  param(
    [string]$RequestedVersion = "",
    [string]$LocalBinary = "",
    [switch]$NoModifyPath,
    [string]$CrowDir = "",
    [string]$InstallDir = ""
  )
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = "Stop"
  try {
    if ([System.Environment]::OSVersion.Platform.ToString() -ne "Win32NT") {
      throw "This installer runs on Windows only. On macOS or Linux, use: curl -fsSL https://raw.githubusercontent.com/crowgent/crow/main/install.sh | bash"
    }
    if ($CrowDir -eq "") {
      if ($null -eq $env:USERPROFILE -or $env:USERPROFILE -eq "") {
        throw "Cannot determine the user profile folder (USERPROFILE is not set)."
      }
      $CrowDir = Join-Path $env:USERPROFILE ".crow"
    }
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq "AMD64") {
      $target = "windows-x64"
    } elseif ($arch -eq "ARM64") {
      throw "No Crow release binary for windows-arm64. Supported targets: darwin-arm64, linux-x64, windows-x64. Build from source instead: git clone https://github.com/$Repo.git"
    } else {
      throw "Unsupported architecture: $arch. Crow release binaries are built for x64 and arm64 only."
    }
    $assetName = "crow-$target.exe"
    $binaryName = "crow.exe"
    if ($InstallDir -eq "") {
      $InstallDir = Join-Path $CrowDir "bin"
    }
    New-Item -ItemType Directory -Force -Path $CrowDir | Out-Null
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $binaryPath = Join-Path $InstallDir $binaryName
    $resolvedVersion = $null
    if ($LocalBinary -ne "") {
      if (-not (Test-Path $LocalBinary)) {
        throw "Binary not found at $LocalBinary"
      }
      Copy-Item -Force $LocalBinary $binaryPath
    } else {
      $resolved = Resolve-ReleaseVersion $RequestedVersion
      $resolvedVersion = $resolved.Version
      $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("crow-install-" + [Guid]::NewGuid().ToString("N"))
      New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
      try {
        $downloaded = Join-Path $tmpDir $assetName
        $checksumFile = Join-Path $tmpDir "checksums.txt"
        Write-Output "Downloading $assetName..."
        Invoke-RestMethod -Uri "$($resolved.BaseUrl)/$assetName" -OutFile $downloaded -Headers @{ "User-Agent" = "crow-install" }
        Invoke-RestMethod -Uri "$($resolved.BaseUrl)/checksums.txt" -OutFile $checksumFile -Headers @{ "User-Agent" = "crow-install" }
        $expected = Get-ExpectedChecksum $checksumFile $assetName
        $actual = (Get-FileHash -Algorithm SHA256 -Path $downloaded).Hash
        if ($expected -ine $actual) {
          throw "Checksum mismatch for $assetName"
        }
        Copy-Item -Force $downloaded $binaryPath
      } finally {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
      }
    }
    $installedVersion = $resolvedVersion
    try {
      $out = & "$binaryPath" --version 2>$null
      if ($out) {
        $installedVersion = "$out".Trim()
      }
    } catch {
    }
    if ($null -eq $installedVersion -or $installedVersion -eq "") {
      $installedVersion = "unknown"
    }
    if ($installedVersion -match '-rc|-alpha|-beta|-pre') {
      Write-Warning "Installing pre-release version $installedVersion. Pre-releases may be unstable."
    }
    Write-InstallMetadata -CrowDir $CrowDir -Version $installedVersion -BinaryPath $binaryPath -InstallDir $InstallDir -AssetName $assetName -Target $target | Out-Null
    $onPath = $false
    if (-not $NoModifyPath) {
      $already = Update-UserPath $InstallDir
      $onPath = $already
    }
    if (-not $onPath) {
      $sessionParts = $env:Path -split ';'
      foreach ($part in $sessionParts) {
        if ($part -ieq $InstallDir) {
          $onPath = $true
          break
        }
      }
    }
    Write-Output ""
    Write-Output "Crow $installedVersion installed to $binaryPath"
    Write-Output ""
    if (-not $onPath) {
      Write-Output "Note: $InstallDir is not in PATH yet, so 'crow' will say 'command not found' until you add it"
      Write-Output "to your user PATH (System > Environment Variables) or start a new terminal."
      Write-Output ""
    }
    Write-Output "Run:"
    Write-Output "  crow --help"
    Write-Output ""
    Write-Output "To uninstall later:"
    Write-Output "  crow uninstall"
    Write-Output ""
  } finally {
    $ErrorActionPreference = $oldEap
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    Install-Crow -RequestedVersion $Version -LocalBinary $Binary -NoModifyPath:$NoModifyPath
  } catch {
    Write-Error $_.Exception.Message
    exit 1
  }
}
