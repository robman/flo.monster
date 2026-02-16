#Requires -Version 5.1
<#
.SYNOPSIS
    flo.monster Hub Installer for Windows
.DESCRIPTION
    Installs the flo.monster hub server in a Multipass VM.
    Requires Windows 10/11 with Hyper-V or VirtualBox support.
.EXAMPLE
    .\install-hub.ps1
    .\install-hub.ps1 -NonInteractive -Email "user@example.com"
.PARAMETER NonInteractive
    Run without prompts, using defaults or provided parameters.
.PARAMETER Help
    Show help information and exit.
.PARAMETER InstanceName
    Name for the Multipass VM (default: flo-hub).
.PARAMETER Email
    Email address for VAPID/push notifications.
.PARAMETER SetupType
    Installation type: "local" or "domain" (default: prompted).
.PARAMETER Domain
    Domain name for TLS setup (required when SetupType is "domain").
#>

[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [switch]$Help,
    [string]$InstanceName = "flo-hub",
    [string]$Email = "",
    [ValidateSet("local", "domain", "")]
    [string]$SetupType = "",
    [string]$Domain = ""
)

$ErrorActionPreference = "Stop"
$Version = "1.0.0"
$FloRepoUrl = "https://github.com/robman/flo.monster.git"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Output helpers ---
# Use distinct names to avoid overriding PowerShell built-in cmdlets.

function Write-InfoMsg {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Blue
}

function Write-SuccessMsg {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-WarnMsg {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-ErrorMsg {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

# --- Banner ---

function Show-Banner {
    Write-Host ""
    Write-Host "  __ _                                    _            " -ForegroundColor Cyan
    Write-Host " / _| | ___   _ __ ___   ___  _ __  ___| |_ ___ _ __ " -ForegroundColor Cyan
    Write-Host "| |_| |/ _ \ | '_ `` _ \ / _ \| '_ \/ __| __/ _ \ '__|" -ForegroundColor Cyan
    Write-Host "|  _| | (_) || | | | | | (_) | | | \__ \ ||  __/ |   " -ForegroundColor Cyan
    Write-Host "|_| |_|\___(_)_| |_| |_|\___/|_| |_|___/\__\___|_|   " -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Hub Installer v$Version (Windows)" -ForegroundColor White
    Write-Host ""
}

# --- Help ---

function Show-Help {
    Write-Host "Usage: .\install-hub.ps1 [OPTIONS]" -ForegroundColor White
    Write-Host ""
    Write-Host "Options:" -ForegroundColor Yellow
    Write-Host "  -Help                Show this help message"
    Write-Host "  -NonInteractive      Run without prompts"
    Write-Host "  -InstanceName <name> Multipass VM name (default: flo-hub)"
    Write-Host "  -Email <email>       Email for VAPID/push notifications"
    Write-Host "  -SetupType <type>    'local' or 'domain'"
    Write-Host "  -Domain <domain>     Domain name (required for 'domain' setup)"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor Yellow
    Write-Host "  .\install-hub.ps1"
    Write-Host "  .\install-hub.ps1 -NonInteractive -Email user@example.com"
    Write-Host "  .\install-hub.ps1 -SetupType domain -Domain hub.example.com -Email admin@example.com"
    Write-Host ""
}

# --- Admin check ---

function Test-Administrator {
    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- Multipass installation ---

function Install-Multipass {
    # Try winget first
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-InfoMsg "Installing Multipass via winget..."
        & winget install Canonical.Multipass --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            Write-SuccessMsg "Multipass installed via winget"
            return
        }
        Write-WarnMsg "winget install failed, trying alternatives..."
    }

    # Try Chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-InfoMsg "Installing Multipass via Chocolatey..."
        & choco install multipass -y
        if ($LASTEXITCODE -eq 0) {
            Write-SuccessMsg "Multipass installed via Chocolatey"
            return
        }
        Write-WarnMsg "Chocolatey install failed..."
    }

    # Manual download guidance
    Write-ErrorMsg "Could not install Multipass automatically."
    Write-Host ""
    Write-Host "Please install Multipass manually:" -ForegroundColor Yellow
    Write-Host "  1. Download from https://multipass.run/download/windows"
    Write-Host "  2. Run the installer"
    Write-Host "  3. Restart your terminal"
    Write-Host "  4. Run this script again"
    Write-Host ""
    exit 1
}

# --- Auth token generation ---

function New-AuthToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $token = [Convert]::ToBase64String($bytes) -replace '[/+=]', ''
    return $token.Substring(0, 32)
}

# --- Interactive configuration ---

function Get-Configuration {
    $config = @{
        InstanceName = $InstanceName
        Email        = $Email
        SetupType    = $SetupType
        Domain       = $Domain
        AuthToken    = ""
        HubHost      = ""
        TrustProxy   = ""
        SetupCaddy   = ""
        SetupSystemd = ""
        RepoUrl      = $FloRepoUrl
    }

    if ($NonInteractive) {
        # Validate required fields for non-interactive mode
        if (-not $config.Email) {
            Write-WarnMsg "No email provided. Push notifications will not work."
            $config.Email = "noreply@flo.monster"
        }
        if (-not $config.SetupType) {
            $config.SetupType = "local"
        }
        if ($config.SetupType -eq "domain" -and -not $config.Domain) {
            Write-ErrorMsg "Domain is required when SetupType is 'domain'. Use -Domain <domain>."
            exit 1
        }
        return $config
    }

    # Interactive prompts
    Write-Host "--- Configuration ---" -ForegroundColor Yellow
    Write-Host ""

    # Instance name
    $input = Read-Host "Multipass VM name [$($config.InstanceName)]"
    if ($input) { $config.InstanceName = $input }

    # Email
    while (-not $config.Email) {
        $config.Email = Read-Host "Email address (for push notifications)"
        if (-not $config.Email) {
            Write-WarnMsg "Email is required for push notification support."
        }
    }

    # Setup type
    while (-not $config.SetupType) {
        Write-Host ""
        Write-Host "Setup type:" -ForegroundColor Yellow
        Write-Host "  1) Local only  — Access via LAN IP (ws://)"
        Write-Host "  2) Domain + TLS — Public domain with automatic HTTPS (wss://)"
        Write-Host ""
        $choice = Read-Host "Choose setup type [1]"
        switch ($choice) {
            ""  { $config.SetupType = "local" }
            "1" { $config.SetupType = "local" }
            "2" { $config.SetupType = "domain" }
            default { Write-WarnMsg "Invalid choice. Enter 1 or 2." }
        }
    }

    # Domain (if domain setup)
    if ($config.SetupType -eq "domain") {
        while (-not $config.Domain) {
            $config.Domain = Read-Host "Domain name (e.g. hub.example.com)"
            if (-not $config.Domain) {
                Write-WarnMsg "Domain name is required for domain setup."
            }
        }
    }

    # Confirmation
    Write-Host ""
    Write-Host "--- Summary ---" -ForegroundColor Yellow
    Write-Host "  VM Name:    $($config.InstanceName)"
    Write-Host "  Email:      $($config.Email)"
    Write-Host "  Setup:      $($config.SetupType)"
    if ($config.Domain) {
        Write-Host "  Domain:     $($config.Domain)"
    }
    Write-Host ""

    $confirm = Read-Host "Proceed with installation? [Y/n]"
    if ($confirm -and $confirm -notin @("y", "Y", "yes", "Yes", "YES")) {
        Write-InfoMsg "Installation cancelled."
        exit 0
    }

    return $config
}

# --- Cloud-init file creation ---

function New-CloudInitFile {
    param(
        [hashtable]$Config
    )

    $templatePath = Join-Path $ScriptDir "hub-cloud-init.yaml"
    if (-not (Test-Path $templatePath)) {
        Write-ErrorMsg "Cloud-init template not found at $templatePath"
        Write-Host "  Expected: scripts/hub-cloud-init.yaml"
        exit 1
    }

    $content = Get-Content $templatePath -Raw
    $content = $content -replace '\{\{AUTH_TOKEN\}\}', $Config.AuthToken
    $content = $content -replace '\{\{VAPID_EMAIL\}\}', $Config.Email
    $content = $content -replace '\{\{HUB_HOST\}\}', $Config.HubHost
    $content = $content -replace '\{\{TRUST_PROXY\}\}', $Config.TrustProxy
    $content = $content -replace '\{\{DOMAIN\}\}', $Config.Domain
    $content = $content -replace '\{\{SETUP_CADDY\}\}', $Config.SetupCaddy
    $content = $content -replace '\{\{SETUP_SYSTEMD\}\}', $Config.SetupSystemd
    $content = $content -replace '\{\{FLO_REPO_URL\}\}', $Config.RepoUrl

    # Write to temp file
    $tempFile = [System.IO.Path]::GetTempFileName()
    Set-Content -Path $tempFile -Value $content -Encoding UTF8

    # Restrict ACL to current user only (protects auth token in temp file)
    $acl = Get-Acl $tempFile
    $acl.SetAccessRuleProtection($true, $false)
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $currentUser,
        "FullControl",
        "Allow"
    )
    $acl.AddAccessRule($rule)
    Set-Acl -Path $tempFile -AclObject $acl

    return $tempFile
}

# --- Check for existing VM ---

function Test-ExistingVM {
    param([string]$Name)

    $result = & multipass list --format json 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }

    $vms = $result | ConvertFrom-Json
    foreach ($vm in $vms.list) {
        if ($vm.name -eq $Name) {
            return $true
        }
    }
    return $false
}

# --- Launch VM ---

function Start-MultipassInstall {
    param(
        [hashtable]$Config,
        [string]$CloudInitFile
    )

    # Check for existing VM with same name
    if (Test-ExistingVM -Name $Config.InstanceName) {
        Write-ErrorMsg "A Multipass VM named '$($Config.InstanceName)' already exists."
        Write-Host ""
        Write-Host "  To remove it:   multipass delete $($Config.InstanceName) && multipass purge" -ForegroundColor Yellow
        Write-Host "  To use it:      multipass shell $($Config.InstanceName)" -ForegroundColor Yellow
        Write-Host "  Or choose a different name with -InstanceName" -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }

    Write-InfoMsg "Launching Multipass VM '$($Config.InstanceName)'..."
    Write-InfoMsg "This may take 5-10 minutes on first run..."
    Write-Host ""

    & multipass launch 24.04 `
        --name $Config.InstanceName `
        --cpus 2 `
        --memory 2G `
        --disk 10G `
        --cloud-init $CloudInitFile

    if ($LASTEXITCODE -ne 0) {
        Write-ErrorMsg "Multipass launch failed."
        Write-Host "  Check that Hyper-V or VirtualBox is enabled." -ForegroundColor Yellow
        Write-Host "  Run 'multipass launch 24.04 --name test' to diagnose." -ForegroundColor Yellow
        exit 1
    }

    # Clean up temp file immediately after launch
    Remove-Item $CloudInitFile -Force -ErrorAction SilentlyContinue

    Write-InfoMsg "VM launched. Waiting for cloud-init to complete..."
    Write-InfoMsg "This installs Node.js, pnpm, and the hub server inside the VM..."
    Write-Host ""

    & multipass exec $Config.InstanceName -- cloud-init status --wait

    if ($LASTEXITCODE -ne 0) {
        Write-WarnMsg "cloud-init reported issues. Checking hub status..."
    }

    # Get VM IP address
    $vmInfoJson = & multipass info $Config.InstanceName --format json
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorMsg "Failed to get VM info."
        exit 1
    }

    $vmInfo = $vmInfoJson | ConvertFrom-Json
    $vmIP = $vmInfo.info.($Config.InstanceName).ipv4[0]

    if (-not $vmIP) {
        Write-ErrorMsg "Could not determine VM IP address."
        exit 1
    }

    Write-SuccessMsg "VM is running at $vmIP"

    # Retrieve auth token from hub.json inside the VM
    $hubJsonRaw = & multipass exec $Config.InstanceName -- sudo cat /home/flo-hub/.flo-monster/hub.json
    if ($LASTEXITCODE -ne 0) {
        Write-WarnMsg "Could not read hub.json from VM. Using generated token."
        $authToken = $Config.AuthToken
    } else {
        $hubJson = $hubJsonRaw | ConvertFrom-Json
        $authToken = $hubJson.authToken
    }

    # Verify hub service is running
    $serviceStatus = & multipass exec $Config.InstanceName -- systemctl is-active flo-hub 2>$null
    if ($serviceStatus -eq "active") {
        Write-SuccessMsg "Hub service is running"
    } else {
        Write-WarnMsg "Hub service may not be running yet. Check with:"
        Write-Host "  multipass exec $($Config.InstanceName) -- systemctl status flo-hub" -ForegroundColor Yellow
    }

    return @{
        IP        = $vmIP
        AuthToken = $authToken
    }
}

# --- Results display ---

function Show-Results {
    param(
        [hashtable]$Config,
        [hashtable]$VMInfo
    )

    if ($Config.Domain) {
        $hubUrl = "wss://$($Config.Domain):8765"
    } else {
        $hubUrl = "ws://$($VMInfo.IP):8765"
    }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  flo.monster Hub - Installation Complete" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Hub URL:    $hubUrl" -ForegroundColor Cyan
    Write-Host "  Auth Token: $($VMInfo.AuthToken)" -ForegroundColor Cyan
    Write-Host "  VM IP:      $($VMInfo.IP)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Connect from browser:" -ForegroundColor Yellow
    Write-Host "    1. Open flo.monster"
    Write-Host "    2. Settings > Hub Connection"
    Write-Host "    3. Enter URL and token above"
    Write-Host ""
    Write-Host "  Management commands:" -ForegroundColor Yellow
    Write-Host "    multipass shell $($Config.InstanceName)    # SSH into VM"
    Write-Host "    multipass stop $($Config.InstanceName)     # Stop VM"
    Write-Host "    multipass start $($Config.InstanceName)    # Start VM"
    Write-Host "    multipass delete $($Config.InstanceName)   # Delete VM"
    Write-Host ""

    if ($Config.Domain) {
        Write-Host "  DNS setup required:" -ForegroundColor Yellow
        Write-Host "    Point $($Config.Domain) to your server's public IP"
        Write-Host "    Caddy will automatically provision TLS certificates"
        Write-Host ""
    }

    Write-Host "  View logs:" -ForegroundColor Yellow
    Write-Host "    multipass exec $($Config.InstanceName) -- journalctl -u flo-hub -f"
    Write-Host ""
}

# --- Main ---

function Main {
    Show-Banner

    if ($Help) {
        Show-Help
        return
    }

    # Admin check
    if (-not (Test-Administrator)) {
        Write-WarnMsg "Not running as Administrator. Multipass may require elevated privileges"
        Write-WarnMsg "for Hyper-V access. If installation fails, re-run as Administrator."
        Write-Host ""
    }

    # Check for Multipass
    if (-not (Get-Command multipass -ErrorAction SilentlyContinue)) {
        Write-InfoMsg "Multipass not found. Installing..."
        Install-Multipass

        # Refresh PATH after installation
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                     [System.Environment]::GetEnvironmentVariable("Path", "User")

        if (-not (Get-Command multipass -ErrorAction SilentlyContinue)) {
            Write-ErrorMsg "Multipass installation completed but 'multipass' not found in PATH."
            Write-Host "  Please restart your terminal and run this script again." -ForegroundColor Yellow
            exit 1
        }
        Write-SuccessMsg "Multipass is available"
    } else {
        Write-SuccessMsg "Multipass found: $(& multipass version | Select-Object -First 1)"
    }

    # Gather configuration
    $config = Get-Configuration

    # Generate auth token
    $config.AuthToken = New-AuthToken

    # Determine hub settings based on setup type
    if ($config.SetupType -eq "domain") {
        $config.HubHost    = "127.0.0.1"
        $config.TrustProxy = "true"
        $config.SetupCaddy = "true"
    } else {
        $config.HubHost    = "0.0.0.0"
        $config.TrustProxy = "false"
        $config.SetupCaddy = "false"
    }
    $config.SetupSystemd = "true"  # Always use systemd in VM

    # Create cloud-init from template
    Write-InfoMsg "Preparing cloud-init configuration..."
    $cloudInitFile = New-CloudInitFile -Config $config

    try {
        # Launch VM and install
        $vmInfo = Start-MultipassInstall -Config $config -CloudInitFile $cloudInitFile

        # Show results
        Show-Results -Config $config -VMInfo $vmInfo
    } finally {
        # Ensure temp file cleanup even on error
        if ($cloudInitFile -and (Test-Path $cloudInitFile)) {
            Remove-Item $cloudInitFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# Entry point
Main
