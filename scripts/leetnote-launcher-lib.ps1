# Shared implementation for the per-user, fixed-action LeetNote launcher.
# This file has no installation or service-start side effects when imported.
Set-StrictMode -Version Latest

$OpenLeetProtocolKey = 'HKCU:\Software\Classes\openleet-leetnote'
$OpenLeetLauncherOwner = 'openleet-fixed-start-v1'

function Resolve-OpenLeetLeetNotePath {
    param([Parameter(Mandatory)][string]$LeetNotePath)

    $item = Get-Item -LiteralPath $LeetNotePath -ErrorAction Stop
    if ($item.PSProvider.Name -ne 'FileSystem' -or -not $item.PSIsContainer) {
        throw 'LeetNotePath must be a filesystem directory.'
    }
    $root = $item.FullName
    foreach ($relative in @('start-all.ps1', 'scripts\services.ps1', 'scripts\postgres.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) {
            throw "LeetNotePath does not contain the expected $relative."
        }
    }
    return $root
}

function Get-OpenLeetPowerShellPath {
    $candidates = @((Join-Path $PSHOME 'pwsh.exe'))
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command 'pwsh.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) { return $command.Source }
    $fallback = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    throw 'PowerShell could not be found.'
}

function Get-OpenLeetLauncherRegistration {
    if (-not (Test-Path -LiteralPath $OpenLeetProtocolKey)) { return $null }
    $registration = Get-ItemProperty -LiteralPath $OpenLeetProtocolKey -ErrorAction Stop
    $owner = $registration.PSObject.Properties['OpenLeetLauncher']
    if (-not $owner -or $owner.Value -ne $OpenLeetLauncherOwner) {
        throw 'The openleet-leetnote protocol is owned by another application.'
    }
    return $registration
}

function Set-OpenLeetLauncherRegistration {
    param(
        [Parameter(Mandatory)][string]$LeetNotePath,
        [Parameter(Mandatory)][string]$HandlerPath,
        [Parameter(Mandatory)][string]$PowerShellPath
    )

    # Refuse to replace an unrelated protocol registration.
    $null = Get-OpenLeetLauncherRegistration
    $root = Resolve-OpenLeetLeetNotePath -LeetNotePath $LeetNotePath
    foreach ($path in @($HandlerPath, $PowerShellPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'The handler and PowerShell executable must exist.'
        }
        if ($path.Contains('"') -or $path.Contains('%')) {
            throw 'The handler and PowerShell paths cannot contain quotes or percent signs.'
        }
    }
    $command = '"{0}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" "%1"' -f $PowerShellPath, $HandlerPath
    $null = New-Item -Path $OpenLeetProtocolKey -Force
    Set-Item -LiteralPath $OpenLeetProtocolKey -Value 'URL:Leet Astra LeetNote Launcher'
    $null = New-ItemProperty -LiteralPath $OpenLeetProtocolKey -Name 'URL Protocol' -Value '' -PropertyType String -Force
    $null = New-ItemProperty -LiteralPath $OpenLeetProtocolKey -Name 'OpenLeetLauncher' -Value $OpenLeetLauncherOwner -PropertyType String -Force
    $null = New-ItemProperty -LiteralPath $OpenLeetProtocolKey -Name 'LeetNotePath' -Value $root -PropertyType String -Force
    $commandKey = Join-Path $OpenLeetProtocolKey 'shell\open\command'
    $null = New-Item -Path $commandKey -Force
    Set-Item -LiteralPath $commandKey -Value $command
    return [pscustomobject]@{ Protocol = 'openleet-leetnote://start'; LeetNotePath = $root; Command = $command }
}

function Remove-OpenLeetLauncherRegistration {
    $registration = Get-OpenLeetLauncherRegistration
    if ($registration) {
        # This is a fixed, owned HKCU registry key, never a filesystem path.
        Remove-Item -LiteralPath $OpenLeetProtocolKey -Recurse -Force
    }
}

function Get-OpenLeetLauncherLogPath {
    param([ValidateSet('launcher', 'start.out', 'start.err')][string]$Kind = 'launcher')
    return Join-Path $env:TEMP "openleet-leetnote.$Kind.log"
}

function Write-OpenLeetLauncherLog {
    param([Parameter(Mandatory)][string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath (Get-OpenLeetLauncherLogPath) -Value $line -Encoding UTF8
}

function Get-OpenLeetLauncherMutexName {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    return "Local\openleet-leetnote-launcher-$sid"
}

function Invoke-OpenLeetLeetNoteLaunch {
    param([Parameter(Mandatory)][string]$LaunchUri)

    # The URL is an action identifier only. It can never supply a command,
    # executable, project path, flags, or script arguments.
    if ($LaunchUri -cne 'openleet-leetnote://start' -and $LaunchUri -cne 'openleet-leetnote://start/') {
        throw 'Unsupported launch URI. Only openleet-leetnote://start is accepted.'
    }
    $mutex = New-Object System.Threading.Mutex($false, (Get-OpenLeetLauncherMutexName))
    $ownsMutex = $false
    try {
        try { $ownsMutex = $mutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) { return 'already-starting' }

        $registration = Get-OpenLeetLauncherRegistration
        if (-not $registration) { throw 'The launcher is not installed for this user.' }
        $root = Resolve-OpenLeetLeetNotePath -LeetNotePath $registration.LeetNotePath
        $startScript = Join-Path $PSScriptRoot 'start-leetnote-services.ps1'
        # Native Windows argument parsing requires a trailing backslash before
        # a closing quote to be doubled (including a project at a drive root).
        $quotedRoot = '"' + ($root -replace '(\\+)$', '$1$1') + '"'
        $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $startScript), '-LeetNotePath', $quotedRoot)
        Write-OpenLeetLauncherLog -Message "Starting services in $root"
        # Wait for the wrapper only, so concurrent protocol invocations cannot
        # race its port checks. start-all.ps1 detaches the actual services.
        $process = Start-Process -FilePath (Get-OpenLeetPowerShellPath) -ArgumentList $arguments `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Get-OpenLeetLauncherLogPath -Kind 'start.out') `
            -RedirectStandardError (Get-OpenLeetLauncherLogPath -Kind 'start.err')
        # Start-Process -Wait also waits for descendants, including permanent
        # services. Process.WaitForExit waits only for the wrapper process.
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "start-leetnote-services.ps1 exited with code $($process.ExitCode). See $(Get-OpenLeetLauncherLogPath -Kind 'start.err')."
        }
        # The browser checks actual HTTP readiness; start-all.ps1's successful
        # exit alone does not prove all services reached a healthy state.
        Write-OpenLeetLauncherLog -Message 'start-all.ps1 completed; check service health for readiness.'
        return 'started'
    }
    finally {
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
