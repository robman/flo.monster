#!/usr/bin/env bash
# =============================================================================
# flo.monster Hub Server — Installer
#
# One-command installer for the flo.monster hub server.
# Supports macOS (via Multipass), Linux desktop (via Multipass), and bare
# Linux servers (direct install).
#
# Usage:
#   curl -fsSL https://flo.monster/install/hub.sh | bash
#   # or
#   ./scripts/install-hub.sh [OPTIONS]
#
# See --help for all options.
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
VERSION="1.0.0"
FLO_REPO_URL="${FLO_REPO_URL:-https://github.com/robman/flo.monster.git}"
FLO_BASE_URL="${FLO_BASE_URL:-https://flo.monster}"
FLO_REPO_BRANCH="${FLO_REPO_BRANCH:-}"
NODE_VERSION="22"
HUB_PORT=8765
ADMIN_PORT=8766
MULTIPASS_CPUS=2
MULTIPASS_MEMORY="2G"
MULTIPASS_DISK="10G"
MULTIPASS_IMAGE="24.04"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd 2>/dev/null || echo ".")"

# Default values for configuration
DEFAULT_INSTANCE_NAME="flo-hub"
DEFAULT_SETUP_TYPE="local"     # "local" or "domain"
DEFAULT_SYSTEMD="yes"

# Will be set during execution
INSTALL_MODE=""                # "multipass" or "direct"
NON_INTERACTIVE=false
INSTANCE_NAME=""
EMAIL=""
SETUP_TYPE=""
DOMAIN=""
INSTALL_SYSTEMD=""
AUTH_TOKEN=""
ADMIN_TOKEN=""

# Temp files to clean up
CLEANUP_FILES=()

# -----------------------------------------------------------------------------
# Output helpers
# -----------------------------------------------------------------------------
info()    { echo -e "\033[1;34m[INFO]\033[0m $*"; }
success() { echo -e "\033[1;32m[OK]\033[0m $*"; }
warn()    { echo -e "\033[1;33m[WARN]\033[0m $*"; }
error()   { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; }

# Print a horizontal rule
hr() {
  echo "──────────────────────────────────────────────────────────────"
}

# Ask for confirmation (returns 0 for yes, 1 for no)
# Usage: confirm "Question?" [default_yes|default_no]
confirm() {
  local prompt="$1"
  local default="${2:-default_yes}"

  if $NON_INTERACTIVE; then
    [[ "$default" == "default_yes" ]] && return 0 || return 1
  fi

  local yn_hint
  if [[ "$default" == "default_yes" ]]; then
    yn_hint="[Y/n]"
  else
    yn_hint="[y/N]"
  fi

  while true; do
    read -rp "$prompt $yn_hint " answer < /dev/tty
    case "$answer" in
      y|Y|yes|Yes|YES) return 0 ;;
      n|N|no|No|NO)    return 1 ;;
      "")
        [[ "$default" == "default_yes" ]] && return 0 || return 1
        ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

# -----------------------------------------------------------------------------
# Cleanup trap
# -----------------------------------------------------------------------------
cleanup() {
  for f in ${CLEANUP_FILES[@]+"${CLEANUP_FILES[@]}"}; do
    rm -f "$f" 2>/dev/null || true
  done
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# parse_args — Handle CLI flags
# -----------------------------------------------------------------------------
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        show_help
        exit 0
        ;;
      --version)
        echo "flo.monster Hub Installer v${VERSION}"
        exit 0
        ;;
      --non-interactive)
        NON_INTERACTIVE=true
        shift
        ;;
      --instance-name)
        INSTANCE_NAME="$2"
        shift 2
        ;;
      --instance-name=*)
        INSTANCE_NAME="${1#*=}"
        shift
        ;;
      --email)
        EMAIL="$2"
        shift 2
        ;;
      --email=*)
        EMAIL="${1#*=}"
        shift
        ;;
      --domain)
        DOMAIN="$2"
        SETUP_TYPE="domain"
        shift 2
        ;;
      --domain=*)
        DOMAIN="${1#*=}"
        SETUP_TYPE="domain"
        shift
        ;;
      --local-only)
        SETUP_TYPE="local"
        shift
        ;;
      --no-systemd)
        INSTALL_SYSTEMD="no"
        shift
        ;;
      --systemd)
        INSTALL_SYSTEMD="yes"
        shift
        ;;
      --mode)
        case "$2" in
          multipass|direct)
            INSTALL_MODE="$2"
            ;;
          *)
            error "Invalid mode: $2 (must be 'multipass' or 'direct')"
            exit 1
            ;;
        esac
        shift 2
        ;;
      --mode=*)
        case "${1#*=}" in
          multipass|direct)
            INSTALL_MODE="${1#*=}"
            ;;
          *)
            error "Invalid mode: ${1#*=} (must be 'multipass' or 'direct')"
            exit 1
            ;;
        esac
        shift
        ;;
      *)
        error "Unknown option: $1"
        echo "Run with --help for usage information."
        exit 1
        ;;
    esac
  done
}

# -----------------------------------------------------------------------------
# show_help
# -----------------------------------------------------------------------------
show_help() {
  cat <<'HELPTEXT'
flo.monster Hub Server — Installer

USAGE:
  install-hub.sh [OPTIONS]

DESCRIPTION:
  Sets up a flo.monster hub server with proper user isolation, security
  hardening, and optional TLS via Caddy reverse proxy.

  On macOS and Linux desktops, the hub runs inside a Multipass VM for
  isolation. On bare Linux servers, it installs directly with OS-level
  user separation (flo-hub / flo-agent).

OPTIONS:
  --help, -h            Show this help message
  --version             Show installer version
  --non-interactive     Skip interactive prompts (use defaults or flags/env vars)
  --mode MODE           Force install mode: "multipass" or "direct"
  --instance-name NAME  Multipass VM instance name (default: flo-hub)
  --email ADDRESS       Email for push notifications and TLS certificates
  --domain DOMAIN       Domain name (implies domain+TLS setup type)
  --local-only          Local-only setup (no domain, self-signed TLS)
  --systemd             Install systemd service (direct mode, default)
  --no-systemd          Do not install systemd service

ENVIRONMENT VARIABLES:
  FLO_REPO_URL          Git repository URL (default: https://github.com/robman/flo.monster.git)
  FLO_REPO_BRANCH       Git branch to clone (default: repo default branch)
  FLO_BASE_URL          Base URL for downloading installer assets (default: https://flo.monster)
  FLO_INSTANCE_NAME     Same as --instance-name
  FLO_EMAIL             Same as --email
  FLO_DOMAIN            Same as --domain
  FLO_SETUP_TYPE        "local" or "domain"
  FLO_NO_SYSTEMD        Set to "1" to skip systemd service

EXAMPLES:
  # Interactive install (auto-detects environment)
  ./scripts/install-hub.sh

  # Non-interactive local-only install on bare server
  ./scripts/install-hub.sh --non-interactive --local-only --email admin@example.com

  # Non-interactive domain install
  ./scripts/install-hub.sh --non-interactive --domain hub.example.com --email admin@example.com

  # Force Multipass mode on Linux
  ./scripts/install-hub.sh --mode multipass

DEVELOPER TESTING:
  To test installer changes without deploying to production:

  # Test against a local cloud-init template and specific branch
  FLO_BASE_URL=/path/to/repo/scripts FLO_REPO_BRANCH=my-feature-branch ./scripts/install-hub.sh

  # Test against a specific GitHub fork and branch
  FLO_REPO_URL=https://github.com/yourfork/flo.monster.git FLO_REPO_BRANCH=my-branch ./scripts/install-hub.sh

HELPTEXT
}

# -----------------------------------------------------------------------------
# detect_environment — Determine macOS / Linux desktop / Linux server
# -----------------------------------------------------------------------------
detect_environment() {
  if [[ -n "$INSTALL_MODE" ]]; then
    info "Install mode forced to: $INSTALL_MODE"
    return
  fi

  local os
  os="$(uname -s)"

  case "$os" in
    Darwin)
      INSTALL_MODE="multipass"
      info "Detected macOS — will use Multipass VM"
      ;;
    Linux)
      # Check for desktop session
      if [[ -n "${DISPLAY:-}" ]] || [[ -n "${WAYLAND_DISPLAY:-}" ]] || [[ "${XDG_SESSION_TYPE:-}" == "x11" ]] || [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
        INSTALL_MODE="multipass"
        info "Detected Linux desktop — will use Multipass VM"
      else
        INSTALL_MODE="direct"
        info "Detected bare Linux server — will install directly"
      fi
      ;;
    *)
      error "Unsupported operating system: $os"
      echo "This installer supports macOS and Linux."
      exit 1
      ;;
  esac
}

# -----------------------------------------------------------------------------
# generate_auth_token — Create a secure random token
# -----------------------------------------------------------------------------
generate_auth_token() {
  command -v openssl >/dev/null 2>&1 || {
    error "openssl is required for token generation but was not found."
    exit 1
  }
  openssl rand -base64 32 | tr -d '/+=' | head -c 32
}

# -----------------------------------------------------------------------------
# generate_self_signed_cert — Create a self-signed TLS cert for local mode
# Args: $1 = IP address (for SAN), $2 = target directory
# -----------------------------------------------------------------------------
generate_self_signed_cert() {
  local ip="$1"
  local tls_dir="$2"

  info "Generating self-signed TLS certificate for ${ip}..."

  mkdir -p "$tls_dir"
  chmod 700 "$tls_dir"

  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "${tls_dir}/key.pem" \
    -out "${tls_dir}/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=flo-monster-hub" \
    -addext "subjectAltName=IP:${ip}" \
    2>/dev/null

  chmod 600 "${tls_dir}/key.pem"
  chmod 644 "${tls_dir}/cert.pem"

  success "TLS certificate generated (self-signed, valid 10 years)"
}

# -----------------------------------------------------------------------------
# apply_env_defaults — Read config from env vars if flags weren't set
# -----------------------------------------------------------------------------
apply_env_defaults() {
  [[ -z "$INSTANCE_NAME" ]] && INSTANCE_NAME="${FLO_INSTANCE_NAME:-}"
  [[ -z "$EMAIL" ]] && EMAIL="${FLO_EMAIL:-}"
  [[ -z "$DOMAIN" ]] && DOMAIN="${FLO_DOMAIN:-}"
  [[ -z "$SETUP_TYPE" ]] && SETUP_TYPE="${FLO_SETUP_TYPE:-}"
  if [[ -z "$INSTALL_SYSTEMD" ]]; then
    if [[ "${FLO_NO_SYSTEMD:-}" == "1" ]]; then
      INSTALL_SYSTEMD="no"
    fi
  fi
}

# -----------------------------------------------------------------------------
# prompt_config — Interactive configuration prompts
# -----------------------------------------------------------------------------
prompt_config() {
  hr
  echo "flo.monster Hub Server — Configuration"
  hr
  echo

  # Instance name (Multipass only)
  if [[ "$INSTALL_MODE" == "multipass" ]] && [[ -z "$INSTANCE_NAME" ]]; then
    if $NON_INTERACTIVE; then
      INSTANCE_NAME="$DEFAULT_INSTANCE_NAME"
    else
      read -rp "Instance name [$DEFAULT_INSTANCE_NAME]: " INSTANCE_NAME < /dev/tty
      INSTANCE_NAME="${INSTANCE_NAME:-$DEFAULT_INSTANCE_NAME}"
    fi
  fi

  # Email address
  if [[ -z "$EMAIL" ]]; then
    if $NON_INTERACTIVE; then
      error "Email address is required. Use --email or FLO_EMAIL environment variable."
      exit 1
    else
      while [[ -z "$EMAIL" ]]; do
        read -rp "Email address (for push notifications): " EMAIL < /dev/tty
        if [[ -z "$EMAIL" ]]; then
          warn "Email address is required."
        fi
      done
    fi
  fi

  # Setup type
  if [[ -z "$SETUP_TYPE" ]]; then
    if $NON_INTERACTIVE; then
      SETUP_TYPE="$DEFAULT_SETUP_TYPE"
    else
      echo
      echo "Setup type:"
      echo "  1) Local only — hub accessible on LAN, self-signed TLS"
      echo "  2) Domain + TLS — public domain with automatic HTTPS via Caddy"
      echo
      while true; do
        read -rp "Choose setup type [1]: " choice < /dev/tty
        case "${choice:-1}" in
          1) SETUP_TYPE="local"; break ;;
          2) SETUP_TYPE="domain"; break ;;
          *) echo "Please enter 1 or 2." ;;
        esac
      done
    fi
  fi

  # Domain name (if domain mode)
  if [[ "$SETUP_TYPE" == "domain" ]] && [[ -z "$DOMAIN" ]]; then
    if $NON_INTERACTIVE; then
      error "Domain name is required for domain setup. Use --domain or FLO_DOMAIN."
      exit 1
    else
      while [[ -z "$DOMAIN" ]]; do
        read -rp "Domain name (e.g., hub.example.com): " DOMAIN < /dev/tty
        if [[ -z "$DOMAIN" ]]; then
          warn "Domain name is required for domain setup."
        fi
      done
    fi
  fi

  # Systemd service (direct mode only)
  if [[ "$INSTALL_MODE" == "direct" ]] && [[ -z "$INSTALL_SYSTEMD" ]]; then
    if $NON_INTERACTIVE; then
      INSTALL_SYSTEMD="$DEFAULT_SYSTEMD"
    else
      if confirm "Install as systemd service?"; then
        INSTALL_SYSTEMD="yes"
      else
        INSTALL_SYSTEMD="no"
      fi
    fi
  fi

  # Default instance name for Multipass if still unset
  [[ "$INSTALL_MODE" == "multipass" ]] && [[ -z "$INSTANCE_NAME" ]] && INSTANCE_NAME="$DEFAULT_INSTANCE_NAME"

  # Generate auth tokens
  AUTH_TOKEN="$(generate_auth_token)"
  ADMIN_TOKEN="$(generate_auth_token)"

  # Print summary
  echo
  hr
  echo "Configuration Summary"
  hr
  echo "  Install mode:   $INSTALL_MODE"
  [[ "$INSTALL_MODE" == "multipass" ]] && echo "  Instance name:  $INSTANCE_NAME"
  echo "  Email:          $EMAIL"
  echo "  Setup type:     $SETUP_TYPE"
  [[ "$SETUP_TYPE" == "domain" ]] && echo "  Domain:         $DOMAIN"
  [[ "$INSTALL_MODE" == "direct" ]] && echo "  Systemd:        $INSTALL_SYSTEMD"
  hr
  echo

  if ! $NON_INTERACTIVE; then
    if ! confirm "Proceed with installation?"; then
      echo "Installation cancelled."
      exit 0
    fi
  fi
}

# -----------------------------------------------------------------------------
# generate_hub_json — Output hub.json content to stdout
# -----------------------------------------------------------------------------
generate_hub_json() {
  local host bind_host trust_proxy public_host tls_block=""

  if [[ "$SETUP_TYPE" == "domain" ]]; then
    # Behind Caddy reverse proxy: bind to localhost only
    bind_host="127.0.0.1"
    trust_proxy="true"
    public_host="${DOMAIN}"
  else
    # Local-only: bind to all interfaces so LAN can reach it
    bind_host="0.0.0.0"
    trust_proxy="false"
    # publicHost = the IP used for the self-signed TLS cert SAN
    public_host="${PUBLIC_HOST_IP:-}"
    # Self-signed TLS for local mode (so wss:// works from HTTPS pages)
    tls_block=',
  "tls": {
    "certFile": "/home/flo-hub/.flo-monster/tls/cert.pem",
    "keyFile": "/home/flo-hub/.flo-monster/tls/key.pem"
  }'
  fi

  # Build optional publicHost line
  local public_host_line=""
  if [[ -n "$public_host" ]]; then
    public_host_line="\"publicHost\": \"${public_host}\","
  fi

  cat <<HUBJSON
{
  "host": "${bind_host}",
  "port": ${HUB_PORT},
  ${public_host_line}
  "name": "flo.monster Hub",
  "localhostBypassAuth": false,
  "authToken": "${AUTH_TOKEN}",
  "adminPort": ${ADMIN_PORT},
  "adminToken": "${ADMIN_TOKEN}",
  "trustProxy": ${trust_proxy},
  "tools": {
    "bash": {
      "enabled": true,
      "runAsUser": "flo-agent",
      "mode": "restricted"
    },
    "filesystem": {
      "enabled": true,
      "allowedPaths": ["/home/flo-hub/.flo-monster/sandbox"],
      "blockedPaths": [
        "/home/flo-hub/.ssh",
        "/home/flo-hub/.gnupg",
        "/home/flo-hub/.flo-monster/hub.json",
        "/etc/shadow",
        "/dev",
        "/proc",
        "/sys"
      ]
    }
  },
  "fetchProxy": {
    "enabled": true,
    "allowedPatterns": ["*"],
    "blockedPatterns": [
      "*.local", "*.internal", "localhost",
      "169.254.*", "10.*", "192.168.*",
      "172.16.*", "172.17.*", "172.18.*", "172.19.*",
      "172.20.*", "172.21.*", "172.22.*", "172.23.*",
      "172.24.*", "172.25.*", "172.26.*", "172.27.*",
      "172.28.*", "172.29.*", "172.30.*", "172.31.*",
      "127.*", "::1", "fc00::*", "fd00::*", "fe80::*"
    ]
  },
  "sandboxPath": "/home/flo-hub/.flo-monster/sandbox",
  "agentStorePath": "/home/flo-hub/.flo-monster/agents",
  "pushConfig": {
    "enabled": true,
    "vapidEmail": "${EMAIL}"
  },
  "failedAuthConfig": {
    "maxAttempts": 5,
    "lockoutMinutes": 15
  }${tls_block}
}
HUBJSON
}

# -----------------------------------------------------------------------------
# generate_caddyfile — Output Caddyfile content to stdout
# -----------------------------------------------------------------------------
generate_caddyfile() {
  cat <<CADDYFILE
# flo.monster Hub — Caddy reverse proxy configuration
# WebSocket hub endpoint
${DOMAIN} {
  reverse_proxy localhost:${HUB_PORT}
  tls ${EMAIL}
}

# Admin WebSocket endpoint
${DOMAIN}:${ADMIN_PORT} {
  reverse_proxy localhost:${ADMIN_PORT}
  tls ${EMAIL}
}
CADDYFILE
}

# -----------------------------------------------------------------------------
# generate_systemd_unit — Output systemd unit file content to stdout
# -----------------------------------------------------------------------------
generate_systemd_unit() {
  cat <<'UNITFILE'
[Unit]
Description=flo.monster Hub Server
After=network.target

[Service]
Type=simple
User=flo-hub
WorkingDirectory=/home/flo-hub/flo.monster/packages/hub
ExecStart=/bin/bash -c 'source /home/flo-hub/setup-env.sh && exec node node_modules/.bin/tsx src/index.ts'
Restart=always
RestartSec=5
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITFILE
}

# -----------------------------------------------------------------------------
# install_multipass — Install Multipass if not present
# -----------------------------------------------------------------------------
install_multipass() {
  if command -v multipass >/dev/null 2>&1; then
    success "Multipass is already installed"
    return
  fi

  info "Installing Multipass..."

  local os
  os="$(uname -s)"

  case "$os" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        error "Homebrew is required to install Multipass on macOS."
        echo "Install it from https://brew.sh and re-run this script."
        exit 1
      fi
      brew install --cask multipass
      ;;
    Linux)
      if ! command -v snap >/dev/null 2>&1; then
        error "Snap is required to install Multipass on Linux desktop."
        echo "Install snapd for your distribution and re-run this script."
        exit 1
      fi
      sudo snap install multipass
      ;;
    *)
      error "Cannot install Multipass on $os"
      exit 1
      ;;
  esac

  # Verify installation
  if ! command -v multipass >/dev/null 2>&1; then
    error "Multipass installation failed."
    exit 1
  fi

  # Give the daemon time to initialize after fresh install
  info "Waiting for Multipass daemon to initialize..."
  sleep 5

  success "Multipass installed successfully"
}

# -----------------------------------------------------------------------------
# create_cloud_init — Generate cloud-init yaml from template
# -----------------------------------------------------------------------------
create_cloud_init() {
  local template_path="${SCRIPT_DIR}/hub-cloud-init.yaml"
  if [[ ! -f "$template_path" ]]; then
    template_path="$(mktemp)"
    CLEANUP_FILES+=("$template_path")
    if [[ "$FLO_BASE_URL" != http* ]]; then
      # Local path — copy directly
      local local_template="${FLO_BASE_URL}/hub-cloud-init.yaml"
      info "Using local cloud-init template: ${local_template}" >&2
      if [[ ! -f "$local_template" ]]; then
        error "Local cloud-init template not found: ${local_template}"
        exit 1
      fi
      cp "$local_template" "$template_path"
    else
      # Remote URL — download
      # NOTE: info must go to stderr — this function's stdout is captured by $()
      info "Downloading cloud-init template..." >&2
      if ! curl -fsSL "${FLO_BASE_URL}/install/hub-cloud-init.yaml" -o "$template_path"; then
        error "Failed to download cloud-init template from ${FLO_BASE_URL}/install/hub-cloud-init.yaml"
        exit 1
      fi
    fi
  fi

  # Create temp file — must be world-readable for Multipass daemon
  local tmpfile
  tmpfile="$(mktemp)"
  CLEANUP_FILES+=("$tmpfile")

  # Compute template values
  local hub_host trust_proxy setup_caddy setup_systemd safe_domain tls_config
  if [[ "$SETUP_TYPE" == "domain" ]]; then
    hub_host="127.0.0.1"
    trust_proxy="true"
    setup_caddy="true"
    safe_domain="$DOMAIN"
    tls_config=""
  else
    hub_host="0.0.0.0"
    trust_proxy="false"
    setup_caddy="false"
    # Empty domain breaks YAML (bare { becomes flow mapping) — use placeholder
    safe_domain="placeholder.local"
    # Self-signed TLS for local mode — note: leading comma included
    tls_config='"tls": { "certFile": "/home/flo-hub/.flo-monster/tls/cert.pem", "keyFile": "/home/flo-hub/.flo-monster/tls/key.pem" },'
  fi
  setup_systemd="true"

  # Perform placeholder substitutions (must match hub-cloud-init.yaml placeholders)
  sed \
    -e "s|{{FLO_REPO_URL}}|${FLO_REPO_URL}|g" \
    -e "s|{{FLO_REPO_BRANCH}}|${FLO_REPO_BRANCH}|g" \
    -e "s|{{AUTH_TOKEN}}|${AUTH_TOKEN}|g" \
    -e "s|{{VAPID_EMAIL}}|${EMAIL}|g" \
    -e "s|{{HUB_HOST}}|${hub_host}|g" \
    -e "s|{{TRUST_PROXY}}|${trust_proxy}|g" \
    -e "s|{{DOMAIN}}|${safe_domain}|g" \
    -e "s|{{SETUP_CADDY}}|${setup_caddy}|g" \
    -e "s|{{SETUP_SYSTEMD}}|${setup_systemd}|g" \
    -e "s|{{TLS_CONFIG}}|${tls_config}|g" \
    "$template_path" > "$tmpfile"

  # Multipass daemon runs as a separate user — file must be readable
  chmod 644 "$tmpfile"

  echo "$tmpfile"
}

# -----------------------------------------------------------------------------
# health_check_hub — Verify the hub is responding before printing success
# -----------------------------------------------------------------------------
health_check_hub() {
  local host="$1"
  local port="${2:-8765}"
  local max_attempts=30
  local attempt=0

  # Use HTTPS for local-mode TLS, HTTP for domain mode (behind Caddy)
  local scheme="http"
  local curl_flags="-sf"
  if [[ "$SETUP_TYPE" != "domain" ]]; then
    scheme="https"
    curl_flags="-sfk"  # -k accepts self-signed certs
  fi

  info "Verifying hub is running..."
  while [[ $attempt -lt $max_attempts ]]; do
    if curl $curl_flags "${scheme}://${host}:${port}/api/status" 2>/dev/null | grep -q '"ok"'; then
      success "Hub is responding"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  warn "Hub may not be running yet — check with: flo-admin logs"
  return 1
}

# -----------------------------------------------------------------------------
# install_flo_admin — Install the flo-admin CLI to /usr/local/bin (direct mode)
# -----------------------------------------------------------------------------
install_flo_admin() {
  info "Installing flo-admin CLI..."
  local source_path="/home/flo-hub/flo.monster/scripts/flo-admin.sh"
  if [[ -f "$source_path" ]]; then
    sudo cp "$source_path" /usr/local/bin/flo-admin
    sudo chmod +x /usr/local/bin/flo-admin
    success "flo-admin installed to /usr/local/bin/flo-admin"
  else
    warn "Could not find flo-admin.sh at $source_path — install it manually later"
  fi
}

# -----------------------------------------------------------------------------
# run_multipass_install — Launch and configure a Multipass VM
# -----------------------------------------------------------------------------
run_multipass_install() {
  install_multipass

  # Check if instance already exists
  if multipass info "$INSTANCE_NAME" >/dev/null 2>&1; then
    warn "Multipass instance '$INSTANCE_NAME' already exists."
    if $NON_INTERACTIVE; then
      error "Instance already exists. Delete it first: multipass delete $INSTANCE_NAME --purge"
      exit 1
    fi
    if confirm "Delete existing instance and reinstall?" "default_no"; then
      info "Deleting existing instance..."
      multipass delete "$INSTANCE_NAME" --purge
    else
      echo "Installation cancelled."
      exit 0
    fi
  fi

  # Generate cloud-init
  info "Generating cloud-init configuration..."
  local cloud_init_file
  cloud_init_file="$(create_cloud_init)"

  # Pre-flight: verify Multipass can reach the image catalog
  info "Checking Multipass image availability..."
  if ! multipass find "$MULTIPASS_IMAGE" >/dev/null 2>&1; then
    warn "Multipass cannot reach the image catalog."
    echo "  This often happens right after install — retrying in 10 seconds..."
    sleep 10
    if ! multipass find "$MULTIPASS_IMAGE" >/dev/null 2>&1; then
      error "Multipass still cannot reach the Ubuntu image catalog."
      echo "  Possible causes:"
      echo "    - Multipass daemon is still starting (try again in a minute)"
      echo "    - Network/firewall blocking access to cloud-images.ubuntu.com"
      echo "    - VPN interfering with Multipass networking"
      echo "  Try: multipass find"
      exit 1
    fi
  fi

  # Launch VM
  info "Launching Multipass VM '$INSTANCE_NAME'..."
  info "  Image:  Ubuntu ${MULTIPASS_IMAGE}"
  info "  CPUs:   ${MULTIPASS_CPUS}"
  info "  Memory: ${MULTIPASS_MEMORY}"
  info "  Disk:   ${MULTIPASS_DISK}"
  echo
  info "This may take several minutes (downloading image, installing dependencies, building)..."

  multipass launch "$MULTIPASS_IMAGE" \
    --name "$INSTANCE_NAME" \
    --cpus "$MULTIPASS_CPUS" \
    --memory "$MULTIPASS_MEMORY" \
    --disk "$MULTIPASS_DISK" \
    --cloud-init "$cloud_init_file"

  # Clean up cloud-init file immediately (contains auth token)
  rm -f "$cloud_init_file"

  # Wait for cloud-init to complete (may return non-zero for non-critical errors)
  info "Waiting for cloud-init to finish..."
  local cloud_init_status=0
  multipass exec "$INSTANCE_NAME" -- cloud-init status --wait || cloud_init_status=$?

  if [[ $cloud_init_status -ne 0 ]]; then
    warn "cloud-init completed with warnings (exit code $cloud_init_status)"
    echo "  Check cloud-init logs: multipass exec $INSTANCE_NAME -- sudo cat /var/log/cloud-init-output.log"
  fi

  success "VM provisioned successfully"

  # Get VM IP address (needed for health check)
  # Use multipass info plain text to avoid jq dependency on macOS host
  local vm_ip
  vm_ip="$(multipass info "$INSTANCE_NAME" | grep -i 'ipv4' | awk '{print $2}')"

  # Health check (non-fatal — don't block results/flo-admin if hub is slow to start)
  health_check_hub "$vm_ip" "$HUB_PORT" || true

  # Retrieve tokens from hub.json in the VM (parse with grep/sed — no jq on macOS)
  local vm_hub_json
  vm_hub_json="$(multipass exec "$INSTANCE_NAME" -- sudo cat /home/flo-hub/.flo-monster/hub.json 2>/dev/null)" || true

  if [[ -n "$vm_hub_json" ]]; then
    local vm_auth_token
    vm_auth_token="$(echo "$vm_hub_json" | sed -n 's/.*"authToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [[ -n "$vm_auth_token" ]]; then
      AUTH_TOKEN="$vm_auth_token"
    fi

    local vm_admin_token
    vm_admin_token="$(echo "$vm_hub_json" | sed -n 's/.*"adminToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [[ -n "$vm_admin_token" ]]; then
      ADMIN_TOKEN="$vm_admin_token"
    fi
  fi

  # Print results
  print_multipass_results "$vm_ip"
}

# -----------------------------------------------------------------------------
# check_direct_prerequisites — Verify we can do a direct install
# -----------------------------------------------------------------------------
check_direct_prerequisites() {
  # Check for Debian/Ubuntu (apt-based)
  if ! command -v apt-get >/dev/null 2>&1; then
    error "Direct install requires a Debian/Ubuntu-based system (apt-get not found)."
    echo "For other distributions, use Multipass mode: --mode multipass"
    exit 1
  fi

  # Check for root or sudo
  if [[ "$(id -u)" -ne 0 ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      error "This script must be run as root or with sudo available."
      exit 1
    fi
    # Verify sudo works
    if ! sudo -n true 2>/dev/null; then
      info "This installer requires root privileges. You may be prompted for your password."
      if ! sudo true; then
        error "Failed to obtain root privileges."
        exit 1
      fi
    fi
  fi
}

# -----------------------------------------------------------------------------
# create_users — Create flo-hub and flo-agent system users
# -----------------------------------------------------------------------------
create_users() {
  # Create flo-hub user
  if id "flo-hub" >/dev/null 2>&1; then
    info "User 'flo-hub' already exists"
  else
    info "Creating user 'flo-hub'..."
    sudo useradd \
      --create-home \
      --home-dir /home/flo-hub \
      --shell /bin/bash \
      --comment "flo.monster Hub Server" \
      flo-hub
    success "User 'flo-hub' created"
  fi

  # Secure home directory: flo-agent cannot read hub home
  sudo chmod 750 /home/flo-hub

  # Create flo-agent system user (no login)
  if id "flo-agent" >/dev/null 2>&1; then
    info "User 'flo-agent' already exists"
  else
    info "Creating system user 'flo-agent'..."
    sudo useradd \
      --system \
      --shell /usr/sbin/nologin \
      --comment "flo.monster Agent Sandbox" \
      flo-agent
    success "User 'flo-agent' created"
  fi

  # Configure sudo: flo-hub can run commands as flo-agent without password
  info "Configuring sudo rules..."
  sudo tee /etc/sudoers.d/flo-monster > /dev/null <<'SUDOERS'
# flo.monster: Allow flo-hub to run commands as flo-agent (agent sandbox isolation)
flo-hub ALL=(flo-agent) NOPASSWD: ALL
SUDOERS
  sudo chmod 440 /etc/sudoers.d/flo-monster
  success "Sudo rules configured"
}

# -----------------------------------------------------------------------------
# install_apt_packages — Install system dependencies
# -----------------------------------------------------------------------------
install_apt_packages() {
  info "Updating package lists..."
  sudo apt-get update -qq

  local packages=(git curl build-essential jq)

  if [[ "$SETUP_TYPE" == "domain" ]]; then
    # Add Caddy's official repository
    info "Adding Caddy APT repository..."
    sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
    sudo apt-get update -qq
    packages+=(caddy)
  fi

  info "Installing system packages: ${packages[*]}..."
  sudo apt-get install -y -qq "${packages[@]}"
  success "System packages installed"
}

# -----------------------------------------------------------------------------
# install_node — Install nvm + Node.js as flo-hub user
# -----------------------------------------------------------------------------
install_node() {
  info "Installing nvm and Node.js ${NODE_VERSION} for flo-hub..."

  sudo -u flo-hub bash <<NODEINSTALL
set -euo pipefail

# Install nvm
export HOME=/home/flo-hub
if [ ! -d "\$HOME/.nvm" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi

# Load nvm
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"

# Install Node.js
nvm install ${NODE_VERSION}
nvm use ${NODE_VERSION}
nvm alias default ${NODE_VERSION}

# Enable corepack for pnpm
corepack enable
corepack prepare pnpm@latest --activate
NODEINSTALL

  success "Node.js ${NODE_VERSION} installed for flo-hub"
}

# -----------------------------------------------------------------------------
# clone_and_build — Clone repo and install dependencies as flo-hub
# -----------------------------------------------------------------------------
clone_and_build() {
  local repo_dir="/home/flo-hub/flo.monster"

  if [[ -d "$repo_dir" ]]; then
    info "Repository already exists at $repo_dir, updating..."
    sudo -u flo-hub bash <<REPOUPDATE
set -euo pipefail
export HOME=/home/flo-hub
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
nvm use ${NODE_VERSION}

cd ${repo_dir}
git pull --ff-only
pnpm install --frozen-lockfile
REPOUPDATE
  else
    info "Cloning repository..."
    sudo -u flo-hub git clone "$FLO_REPO_URL" "$repo_dir"

    info "Installing dependencies (this may take a few minutes)..."
    sudo -u flo-hub bash <<REPOBUILD
set -euo pipefail
export HOME=/home/flo-hub
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
nvm use ${NODE_VERSION}

cd ${repo_dir}
pnpm install --frozen-lockfile
REPOBUILD
  fi

  success "Repository cloned and dependencies installed"
}

# -----------------------------------------------------------------------------
# write_hub_config — Generate hub.json and directory structure
# -----------------------------------------------------------------------------
write_hub_config() {
  local flo_dir="/home/flo-hub/.flo-monster"
  local sandbox_dir="${flo_dir}/sandbox"
  local agents_dir="${flo_dir}/agents"

  info "Creating hub configuration..."

  # Create directories
  sudo -u flo-hub mkdir -p "$flo_dir" "$sandbox_dir" "$agents_dir"

  # Sandbox needs to be accessible by flo-agent
  sudo chmod 755 "$sandbox_dir"

  # Generate self-signed TLS cert for local mode (before writing hub.json which references it)
  if [[ "$SETUP_TYPE" != "domain" ]]; then
    local server_ip
    server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || server_ip="127.0.0.1"
    local tls_dir="${flo_dir}/tls"
    sudo -u flo-hub mkdir -p "$tls_dir"
    # generate_self_signed_cert needs to run as flo-hub so key ownership is correct
    sudo -u flo-hub bash -c "$(declare -f generate_self_signed_cert info success); generate_self_signed_cert '${server_ip}' '${tls_dir}'"
  fi

  # Write hub.json with restrictive permissions (contains auth token)
  # For local mode, pass the server IP so generate_hub_json can set publicHost
  if [[ "$SETUP_TYPE" != "domain" ]]; then
    PUBLIC_HOST_IP="${server_ip}" generate_hub_json | sudo -u flo-hub tee "${flo_dir}/hub.json" > /dev/null
  else
    generate_hub_json | sudo -u flo-hub tee "${flo_dir}/hub.json" > /dev/null
  fi
  sudo chmod 600 "${flo_dir}/hub.json"

  success "Hub configuration written to ${flo_dir}/hub.json"
}

# -----------------------------------------------------------------------------
# write_setup_env — Copy setup-env.sh to flo-hub home and source from .bashrc
# -----------------------------------------------------------------------------
write_setup_env() {
  info "Installing Node.js environment loader..."

  local env_script="/home/flo-hub/setup-env.sh"

  # Copy setup-env.sh
  if [[ -f "${SCRIPT_DIR}/setup-env.sh" ]]; then
    sudo cp "${SCRIPT_DIR}/setup-env.sh" "$env_script"
  else
    # Write it inline if the repo script isn't available (e.g., piped install)
    sudo tee "$env_script" > /dev/null <<'ENVSCRIPT'
#!/usr/bin/env bash
# flo.monster Hub — Node.js environment loader
# Source this file to set up the Node.js environment for the flo-hub user.
export NVM_DIR="/home/flo-hub/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null 2>&1
ENVSCRIPT
  fi

  sudo chown flo-hub:flo-hub "$env_script"
  sudo chmod 755 "$env_script"

  # Source from .bashrc if not already present
  local bashrc="/home/flo-hub/.bashrc"
  if ! sudo -u flo-hub grep -q "setup-env.sh" "$bashrc" 2>/dev/null; then
    echo 'source ~/setup-env.sh' | sudo -u flo-hub tee -a "$bashrc" > /dev/null
  fi

  success "Environment loader installed"
}

# -----------------------------------------------------------------------------
# setup_proc_hardening — Add hidepid=2 to /proc mount
# -----------------------------------------------------------------------------
setup_proc_hardening() {
  info "Hardening /proc visibility..."

  # Check if already configured
  if grep -q "hidepid=2" /etc/fstab 2>/dev/null; then
    info "/proc hardening already configured in /etc/fstab"
    return
  fi

  # Add hidepid=2 to fstab
  echo "proc /proc proc defaults,hidepid=2 0 0" | sudo tee -a /etc/fstab > /dev/null

  # Remount /proc with hidepid
  sudo mount -o remount,hidepid=2 /proc 2>/dev/null || {
    warn "Could not remount /proc with hidepid=2 (may require reboot)"
  }

  success "/proc hardened with hidepid=2"
}

# -----------------------------------------------------------------------------
# setup_caddy — Write Caddyfile and enable Caddy
# -----------------------------------------------------------------------------
setup_caddy() {
  if [[ "$SETUP_TYPE" != "domain" ]]; then
    return
  fi

  info "Configuring Caddy reverse proxy for ${DOMAIN}..."

  # Write Caddyfile
  generate_caddyfile | sudo tee /etc/caddy/Caddyfile > /dev/null

  # Test configuration
  if sudo caddy validate --config /etc/caddy/Caddyfile 2>/dev/null; then
    success "Caddy configuration is valid"
  else
    warn "Caddy configuration validation failed — check /etc/caddy/Caddyfile"
  fi

  # Enable and start Caddy
  sudo systemctl enable caddy
  sudo systemctl restart caddy

  success "Caddy configured and started for ${DOMAIN}"
}

# -----------------------------------------------------------------------------
# setup_systemd — Create and enable the flo-hub systemd service
# -----------------------------------------------------------------------------
setup_systemd() {
  if [[ "$INSTALL_SYSTEMD" != "yes" ]]; then
    return
  fi

  info "Creating systemd service..."

  local unit_file="/etc/systemd/system/flo-hub.service"

  # Check if service already exists
  if [[ -f "$unit_file" ]]; then
    warn "Systemd service already exists at $unit_file"
    if ! $NON_INTERACTIVE; then
      if ! confirm "Overwrite existing service file?"; then
        info "Keeping existing service file"
        return
      fi
    fi
  fi

  # Write unit file
  generate_systemd_unit | sudo tee "$unit_file" > /dev/null

  # Reload systemd
  sudo systemctl daemon-reload

  # Enable service (start on boot)
  sudo systemctl enable flo-hub.service

  # Start service
  sudo systemctl start flo-hub.service

  # Brief wait, then check status
  sleep 2
  if sudo systemctl is-active --quiet flo-hub.service; then
    success "flo-hub service started successfully"
  else
    warn "flo-hub service may not have started correctly"
    echo "  Check status with: sudo systemctl status flo-hub.service"
    echo "  Check logs with:   sudo journalctl -u flo-hub.service -f"
  fi
}

# -----------------------------------------------------------------------------
# run_direct_install — Full direct installation on bare server
# -----------------------------------------------------------------------------
run_direct_install() {
  check_direct_prerequisites
  # Switch to a universally accessible directory so that 'sudo -u flo-hub'
  # commands don't fail trying to restore the caller's CWD (e.g. /home/user
  # on Debian where home dirs are 700). This prevents spurious errors like
  # "find: Failed to restore initial working directory: Permission denied".
  cd /
  create_users
  install_apt_packages
  install_node
  clone_and_build
  write_hub_config
  write_setup_env
  setup_proc_hardening
  setup_caddy
  setup_systemd

  # Health check (only if systemd service was installed)
  if [[ "$INSTALL_SYSTEMD" == "yes" ]]; then
    health_check_hub "localhost" "$HUB_PORT" || true
  fi

  # Install flo-admin CLI
  install_flo_admin

  print_direct_results
}

# -----------------------------------------------------------------------------
# print_multipass_results — Show summary after Multipass install
# -----------------------------------------------------------------------------
print_multipass_results() {
  local vm_ip="$1"

  local hub_url
  if [[ "$SETUP_TYPE" == "domain" ]]; then
    hub_url="wss://${DOMAIN}"
  else
    hub_url="wss://${vm_ip}:${HUB_PORT}"
  fi

  echo
  echo
  hr
  success "flo.monster Hub Server — Installation Complete"
  hr
  echo
  echo "  Hub URL:      ${hub_url}"
  echo "  Auth Token:   ${AUTH_TOKEN}"
  echo "  Admin Token:  ${ADMIN_TOKEN}"
  echo "  VM IP:        ${vm_ip}"
  echo "  Instance:     ${INSTANCE_NAME}"
  echo
  hr
  echo "  How to connect from the browser:"
  hr
  echo
  if [[ "$SETUP_TYPE" != "domain" ]]; then
    echo "  1. First, open https://${vm_ip}:${HUB_PORT}/tls-setup in your browser"
    echo "     and accept the self-signed certificate warning"
    echo "  2. Open flo.monster in your browser"
    echo "  3. Go to Settings > Hub"
    echo "  4. Enter the Hub URL: ${hub_url}"
    echo "  5. Enter the Auth Token shown above"
    echo "  6. Click Connect"
  else
    echo "  1. Open flo.monster in your browser"
    echo "  2. Go to Settings > Hub"
    echo "  3. Enter the Hub URL: ${hub_url}"
    echo "  4. Enter the Auth Token shown above"
    echo "  5. Click Connect"
  fi
  echo
  hr
  echo "  API Keys:"
  hr
  echo
  echo "  This hub has no API keys yet. You can either:"
  echo
  echo "  a) Enter your API key in the browser (it stays in your browser)"
  echo "  b) Add shared keys to hub.json so all connected browsers can use them:"
  echo
  echo "     multipass exec ${INSTANCE_NAME} -- sudo nano /home/flo-hub/.flo-monster/hub.json"
  echo
  echo '     Add a "sharedApiKeys" section:'
  echo '     "sharedApiKeys": {'
  echo '       "anthropic": "sk-ant-..."'
  echo '     }'
  echo
  echo "     Then restart:  multipass exec ${INSTANCE_NAME} -- flo-admin restart"
  echo
  hr
  echo "  Management:"
  hr
  echo
  echo "  multipass exec ${INSTANCE_NAME} -- flo-admin status     Service status"
  echo "  multipass exec ${INSTANCE_NAME} -- flo-admin logs       Tail hub logs"
  echo "  multipass exec ${INSTANCE_NAME} -- flo-admin restart    Restart the hub"
  echo "  multipass exec ${INSTANCE_NAME} -- flo-admin info       Show connection details"
  echo
  echo "  Or open a shell in the VM:"
  echo
  echo "  multipass shell ${INSTANCE_NAME}"
  echo "  flo-admin status"
  echo "  flo-admin logs"
  echo "  flo-admin info"
  echo
  hr
  echo
}

# -----------------------------------------------------------------------------
# print_direct_results — Show summary after direct install
# -----------------------------------------------------------------------------
print_direct_results() {
  local hub_url
  local host_display

  if [[ "$SETUP_TYPE" == "domain" ]]; then
    hub_url="wss://${DOMAIN}"
    host_display="$DOMAIN"
  else
    # Try to get the server's IP address
    local server_ip
    server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || server_ip="<server-ip>"
    hub_url="wss://${server_ip}:${HUB_PORT}"
    host_display="$server_ip"
  fi

  echo
  echo
  hr
  success "flo.monster Hub Server — Installation Complete"
  hr
  echo
  echo "  Hub URL:      ${hub_url}"
  echo "  Auth Token:   ${AUTH_TOKEN}"
  echo "  Admin Token:  ${ADMIN_TOKEN}"
  echo "  Host:         ${host_display}"
  echo
  hr
  echo "  How to connect from the browser:"
  hr
  echo
  if [[ "$SETUP_TYPE" != "domain" ]]; then
    echo "  1. First, open https://${host_display}:${HUB_PORT}/tls-setup in your browser"
    echo "     and accept the self-signed certificate warning"
    echo "  2. Open flo.monster in your browser"
    echo "  3. Go to Settings > Hub"
    echo "  4. Enter the Hub URL: ${hub_url}"
    echo "  5. Enter the Auth Token shown above"
    echo "  6. Click Connect"
  else
    echo "  1. Open flo.monster in your browser"
    echo "  2. Go to Settings > Hub"
    echo "  3. Enter the Hub URL: ${hub_url}"
    echo "  4. Enter the Auth Token shown above"
    echo "  5. Click Connect"
  fi
  echo
  hr
  echo "  API Keys:"
  hr
  echo
  echo "  This hub has no API keys yet. You can either:"
  echo
  echo "  a) Enter your API key in the browser (it stays in your browser)"
  echo "  b) Add shared keys to hub.json so all connected browsers can use them:"
  echo
  echo "     sudo nano /home/flo-hub/.flo-monster/hub.json"
  echo
  echo '     Add a "sharedApiKeys" section:'
  echo '     "sharedApiKeys": {'
  echo '       "anthropic": "sk-ant-..."'
  echo '     }'
  echo
  echo "     Then restart:  flo-admin restart"
  echo
  hr
  echo "  Management:"
  hr
  echo

  if [[ "$INSTALL_SYSTEMD" == "yes" ]]; then
    echo "  flo-admin status      Service status"
    echo "  flo-admin logs        Tail hub logs"
    echo "  flo-admin restart     Restart the hub"
    echo "  flo-admin shell       Shell as flo-hub user"
    echo "  flo-admin info        Show connection details"
    echo "  flo-admin config      View configuration"
    echo "  flo-admin uninstall   Remove the hub"
  else
    echo "  Start manually:    sudo -u flo-hub bash -c 'source ~/setup-env.sh && cd ~/flo.monster/packages/hub && node node_modules/.bin/tsx src/index.ts'"
  fi

  echo

  hr
  echo "  Documentation: https://flo.monster/docs/hub"
  hr
  echo
}

# -----------------------------------------------------------------------------
# main — Orchestrate the installation
# -----------------------------------------------------------------------------
main() {
  echo
  echo "  _____ _                                 _            "
  echo " |  ___| | ___   _ __ ___   ___  _ __  __| |_ ___ _ __ "
  echo " | |_  | |/ _ \\ | '_ \` _ \\ / _ \\| '_ \\/ _\` __/ _ \\ '__|"
  echo " |  _| | | (_) || | | | | | (_) | | | \\__ | ||  __/ |   "
  echo " |_|   |_|\\___(_)_| |_| |_|\\___/|_| |_|___/\\__\\___|_|   "
  echo
  echo "  Hub Server Installer v${VERSION}"
  echo

  parse_args "$@"
  apply_env_defaults

  # Log dev overrides if any are set
  if [[ "$FLO_BASE_URL" != "https://flo.monster" ]]; then
    info "Using custom FLO_BASE_URL: ${FLO_BASE_URL}"
  fi
  if [[ -n "$FLO_REPO_BRANCH" ]]; then
    info "Using custom FLO_REPO_BRANCH: ${FLO_REPO_BRANCH}"
  fi
  if [[ "$FLO_REPO_URL" != "https://github.com/robman/flo.monster.git" ]]; then
    info "Using custom FLO_REPO_URL: ${FLO_REPO_URL}"
  fi

  detect_environment
  prompt_config

  case "$INSTALL_MODE" in
    multipass)
      run_multipass_install
      ;;
    direct)
      run_direct_install
      ;;
    *)
      error "Unknown install mode: $INSTALL_MODE"
      exit 1
      ;;
  esac

  success "Installation complete!"
}

# Run main with all arguments
main "$@"
