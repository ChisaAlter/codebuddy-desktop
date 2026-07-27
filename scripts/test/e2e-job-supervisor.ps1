[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Supervise', 'Terminate')]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$RuntimeDir,
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [Parameter(Mandatory = $true)]
  [string]$StatePath,
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,
  [Parameter(Mandatory = $true)]
  [string]$SourceSha256,
  [Parameter(Mandatory = $true)]
  [string]$JobName,
  [Parameter(Mandatory = $true)]
  [string]$ControlPipeName,
  [Parameter(Mandatory = $true)]
  [string]$ControlPipeToken,
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,
  [Parameter(Mandatory = $true)]
  [string]$ProjectRealRoot,
  [Parameter(Mandatory = $true)]
  [string]$MarkerPath,
  [Parameter(Mandatory = $true)]
  [string]$MarkerToken
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Resolve-FullPath {
  param([string]$Value, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 32767 -or $Value.IndexOf([char]0) -ge 0) {
    throw "$Label is invalid"
  }
  return [System.IO.Path]::GetFullPath($Value)
}

function Assert-DirectRuntimeFile {
  param([string]$Candidate, [string]$ExpectedName, [string]$Label, [bool]$MustExist)
  $full = Resolve-FullPath $Candidate $Label
  $parent = [System.IO.Path]::GetDirectoryName($full)
  if (-not [string]::Equals($parent, $script:ResolvedRuntimeDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be a direct runtime file"
  }
  if (-not [string]::Equals([System.IO.Path]::GetFileName($full), $ExpectedName, [System.StringComparison]::Ordinal)) {
    throw "$Label name does not match the ownership token"
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "$Label is missing"
  }
  if (Test-Path -LiteralPath $full) {
    $attributes = [System.IO.File]::GetAttributes($full)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label cannot be a reparse point"
    }
  }
  return $full
}

function Assert-BoundedString {
  param([AllowNull()][object]$Value, [string]$Label, [int]$Maximum, [bool]$AllowEmpty)
  if ($null -eq $Value -or -not ($Value -is [string])) {
    throw "$Label must be a string"
  }
  $text = [string]$Value
  if ((-not $AllowEmpty -and $text.Length -eq 0) -or $text.Length -gt $Maximum -or $text.IndexOf([char]0) -ge 0) {
    throw "$Label is outside its allowed bounds"
  }
  return $text
}

function Assert-RuntimeOwnership {
  $resolvedProjectRoot = Resolve-FullPath $ProjectRoot 'ProjectRoot'
  $resolvedProjectRealRoot = Resolve-FullPath $ProjectRealRoot 'ProjectRealRoot'
  if (-not (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container) -or
      -not (Test-Path -LiteralPath $resolvedProjectRealRoot -PathType Container)) {
    throw 'Runtime project ownership anchors are missing'
  }
  if ($MarkerToken -notmatch '^[0-9a-f]{32}$') {
    throw 'MarkerToken must be a 128-bit lowercase ownership token'
  }
  $expectedRuntimeRoot = [System.IO.Path]::Combine($resolvedProjectRoot, '.omo', 'e2e-runtime')
  $runtimePrefix = $expectedRuntimeRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
    [System.IO.Path]::DirectorySeparatorChar
  if (-not $script:ResolvedRuntimeDir.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'RuntimeDir is outside the project runtime ownership root'
  }
  $cursor = $script:ResolvedRuntimeDir
  while (-not [string]::Equals($cursor, $resolvedProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    if ([string]::IsNullOrWhiteSpace($cursor) -or
        -not $cursor.StartsWith($resolvedProjectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
          [System.IO.Path]::DirectorySeparatorChar,
          [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Runtime ownership path escaped the project root'
    }
    $attributes = [System.IO.File]::GetAttributes($cursor)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Runtime ownership path cannot contain a reparse point or junction'
    }
    $cursor = [System.IO.Path]::GetDirectoryName($cursor)
  }
  $resolvedMarkerPath = Resolve-FullPath $MarkerPath 'MarkerPath'
  $expectedMarkerPath = [System.IO.Path]::Combine($script:ResolvedRuntimeDir, '.codebuddy-e2e-runtime-owner')
  if (-not [string]::Equals($resolvedMarkerPath, $expectedMarkerPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $resolvedMarkerPath -PathType Leaf)) {
    throw 'Runtime ownership marker is missing or misplaced'
  }
  $markerInfo = Get-Item -LiteralPath $resolvedMarkerPath
  if (($markerInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $markerInfo.Length -ne 33) {
    throw 'Runtime ownership marker must be a regular bounded file'
  }
  $markerText = [System.IO.File]::ReadAllText($resolvedMarkerPath, [System.Text.Encoding]::UTF8)
  if (-not [string]::Equals($markerText, $MarkerToken + [char]10, [System.StringComparison]::Ordinal)) {
    throw 'Runtime ownership marker token mismatch'
  }
}

if ($JobName -notmatch '^CodeBuddyE2E-([0-9a-f]{32})$') {
  throw 'JobName must be a random CodeBuddy E2E name'
}
$token = $Matches[1]
$expectedControlPipeName = "CodeBuddyE2E-Control-$ControlPipeToken"
if ($ControlPipeToken -notmatch '^[0-9a-f]{32}$' -or $ControlPipeName.Length -gt 96 -or
    -not [string]::Equals($ControlPipeName, $expectedControlPipeName, [System.StringComparison]::Ordinal)) {
  throw 'ControlPipeName must match the control ownership token'
}
$script:ResolvedRuntimeDir = Resolve-FullPath $RuntimeDir 'RuntimeDir'
if (-not (Test-Path -LiteralPath $script:ResolvedRuntimeDir -PathType Container)) {
  throw 'RuntimeDir is missing'
}
$runtimeAttributes = [System.IO.File]::GetAttributes($script:ResolvedRuntimeDir)
if (($runtimeAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'RuntimeDir cannot be a reparse point'
}
Assert-RuntimeOwnership

$resolvedConfigPath = Assert-DirectRuntimeFile $ConfigPath "e2e-job-$token.config.json" 'ConfigPath' ($Mode -eq 'Supervise')
$resolvedStatePath = Assert-DirectRuntimeFile $StatePath "e2e-job-$token.state.json" 'StatePath' $false
$resolvedSourcePath = Assert-DirectRuntimeFile $SourcePath "e2e-job-$token.cs" 'SourcePath' $true
if ($SourceSha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'SourceSha256 must be a lowercase SHA-256 digest'
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $sourceStream = [System.IO.File]::OpenRead($resolvedSourcePath)
  try {
    $actualSourceHash = ([System.BitConverter]::ToString($sha256.ComputeHash($sourceStream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sourceStream.Dispose()
  }
} finally {
  $sha256.Dispose()
}
if (-not [string]::Equals($actualSourceHash, $SourceSha256, [System.StringComparison]::Ordinal)) {
  throw 'Supervisor source hash mismatch'
}
$sourceInfo = Get-Item -LiteralPath $resolvedSourcePath
if ($sourceInfo.Length -lt 1 -or $sourceInfo.Length -gt 262144) {
  throw 'Supervisor source is outside its allowed bounds'
}
$sourceText = [System.IO.File]::ReadAllText($resolvedSourcePath, [System.Text.Encoding]::UTF8)
Add-Type -TypeDefinition $sourceText -Language CSharp | Out-Null

if ($Mode -eq 'Terminate') {
  $result = [CodeBuddy.E2E.JobSupervisor]::Terminate($JobName)
  if ([string]::IsNullOrWhiteSpace($result) -or $result.Length -gt 4096) {
    throw 'Terminate mode returned an invalid result'
  }
  [Console]::Out.WriteLine($result)
  exit 0
}

$configInfo = Get-Item -LiteralPath $resolvedConfigPath
if ($configInfo.Length -lt 2 -or $configInfo.Length -gt 524288) {
  throw 'ConfigPath is outside its allowed bounds'
}
$configText = [System.IO.File]::ReadAllText($resolvedConfigPath, [System.Text.Encoding]::UTF8)
$config = $configText | ConvertFrom-Json
$requiredProperties = @('version', 'jobName', 'executable', 'arguments', 'workingDirectory')
$actualProperties = @($config.PSObject.Properties.Name)
foreach ($required in $requiredProperties) {
  if ($actualProperties -notcontains $required) { throw "Config is missing $required" }
}
foreach ($actual in $actualProperties) {
  if ($requiredProperties -notcontains $actual) { throw 'Config contains an unsupported property' }
}
if ([int]$config.version -ne 2) { throw 'Config version is unsupported' }
$configJobName = Assert-BoundedString $config.jobName 'config.jobName' 64 $false
if (-not [string]::Equals($configJobName, $JobName, [System.StringComparison]::Ordinal)) {
  throw 'Config JobName mismatch'
}
$executable = Assert-BoundedString $config.executable 'config.executable' 32767 $false
$workingDirectory = Assert-BoundedString $config.workingDirectory 'config.workingDirectory' 32767 $false

$arguments = @($config.arguments)
if ($arguments.Count -gt 256) { throw 'Config arguments exceed the allowed count' }
$argumentValues = New-Object 'System.Collections.Generic.List[string]'
$argumentCharacters = 0
foreach ($argument in $arguments) {
  $value = Assert-BoundedString $argument 'config.argument' 32767 $true
  $argumentCharacters += $value.Length + 1
  if ($argumentCharacters -gt 32767) { throw 'Config arguments exceed the allowed size' }
  $argumentValues.Add($value)
}

# L17: delete the validated config file with a short retry loop. On Windows, AV
# or the indexer can briefly hold a handle and make [System.IO.File]::Delete
# throw IOException; without a retry the harness fails spuriously.
$deleteAttempts = 0
$deleteMaxAttempts = 3
$deleted = $false
while (-not $deleted -and $deleteAttempts -lt $deleteMaxAttempts) {
  $deleteAttempts += 1
  try {
    [System.IO.File]::Delete($resolvedConfigPath)
    $deleted = $true
  } catch {
    if ($deleteAttempts -ge $deleteMaxAttempts) { throw }
    Start-Sleep -Milliseconds 200
  }
}
if (Test-Path -LiteralPath $resolvedConfigPath) {
  throw 'Validated ConfigPath could not be removed before root resume'
}

$exitCode = [CodeBuddy.E2E.JobSupervisor]::Supervise(
  $JobName,
  $executable,
  $argumentValues.ToArray(),
  $workingDirectory,
  $ControlPipeName,
  $ProjectRoot,
  $ProjectRealRoot,
  $MarkerPath,
  $MarkerToken,
  $resolvedStatePath
)
exit $exitCode
