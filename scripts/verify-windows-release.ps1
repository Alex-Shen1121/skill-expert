param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Directory
)

$ErrorActionPreference = "Stop"

function Get-RequiredFile([string]$Name) {
  $Path = Join-Path $Directory $Name
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "正式资产不是普通文件：$Name"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Assert-Version([string]$Label, [string]$Actual) {
  $Normalized = $Actual.Trim()
  if ($Normalized -ne $Version) {
    throw "$Label 版本不匹配：预期 $Version，实际 $Normalized"
  }
}

$Cli = Get-RequiredFile "skill-expert-cli-v$Version-windows-x64.exe"
$Nsis = Get-RequiredFile "skill-expert-v$Version-windows-x64-setup.exe"
$Msi = Get-RequiredFile "skill-expert-v$Version-windows-x64.msi"

$CliVersion = (& $Cli --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $CliVersion -ne "skill-expert-cli $Version") {
  throw "CLI 版本不匹配：预期 skill-expert-cli $Version，实际 $CliVersion"
}

$NsisVersion = (Get-Item -LiteralPath $Nsis).VersionInfo.ProductVersion
if ($NsisVersion -eq "$Version.0") {
  $NsisVersion = $Version
}
Assert-Version "NSIS" $NsisVersion

$Installer = New-Object -ComObject WindowsInstaller.Installer
$Database = $Installer.OpenDatabase($Msi, 0)
$View = $Database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = 'ProductVersion'")
$View.Execute()
$Record = $View.Fetch()
if ($null -eq $Record) {
  throw "MSI 缺少 ProductVersion"
}
Assert-Version "MSI" $Record.StringData(1)
$View.Close()

Write-Host "Windows 正式资产原生版本回验通过：$Version。"
