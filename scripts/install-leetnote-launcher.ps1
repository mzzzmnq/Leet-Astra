# Usage:
#   pwsh -NoProfile -File .\scripts\install-leetnote-launcher.ps1
#   pwsh -NoProfile -File .\scripts\install-leetnote-launcher.ps1 -LeetNotePath 'D:\Projects\leetnote'
#   pwsh -NoProfile -File .\scripts\install-leetnote-launcher.ps1 -Uninstall
# No administrator privileges are needed. Keep this Leet Astra directory in place.
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Install')]
    [string]$LeetNotePath = 'D:\Projects\leetnote',
    [Parameter(Mandatory, ParameterSetName = 'Uninstall')]
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'leetnote-launcher-lib.ps1')

$registration = Get-OpenLeetLauncherRegistration
if ($Uninstall) {
    if ($registration -and $PSCmdlet.ShouldProcess($OpenLeetProtocolKey, 'Unregister the current-user LeetNote launcher')) {
        Remove-OpenLeetLauncherRegistration
        Write-Output 'Uninstalled the current-user openleet-leetnote protocol. Running services are unaffected.'
    }
    elseif (-not $registration) { Write-Output 'The current-user LeetNote launcher is not installed.' }
    return
}

$root = Resolve-OpenLeetLeetNotePath -LeetNotePath $LeetNotePath
$handler = Join-Path $PSScriptRoot 'leetnote-launcher.ps1'
$runtime = Get-OpenLeetPowerShellPath
if ($PSCmdlet.ShouldProcess($OpenLeetProtocolKey, "Register fixed start action for $root")) {
    Set-OpenLeetLauncherRegistration -LeetNotePath $root -HandlerPath $handler -PowerShellPath $runtime
    Write-Output 'Installed. Use the Start LeetNote button in Leet Astra and approve the browser external-app prompt.'
    Write-Output "Launcher log: $(Get-OpenLeetLauncherLogPath)"
}
