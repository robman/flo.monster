#!/usr/bin/env bash
# =============================================================================
# flo.monster Hub Server — Admin CLI
#
# Management CLI for the flo.monster hub server.
# Runs directly on the hub server (or inside a Multipass VM).
#
# Installed to /usr/local/bin/flo-admin by cloud-init or the direct installer.
#
# Usage:
#   flo-admin <command>
#
# See --help or run without arguments for all commands.
# =============================================================================
set -euo pipefail

VERSION="1.0.0"
SERVICE_NAME="flo-hub"
HUB_USER="flo-hub"
HUB_JSON_PATH="/home/flo-hub/.flo-monster/hub.json"
HUB_PORT=8765

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

# -----------------------------------------------------------------------------
# check_install — Verify we have a hub installation
# -----------------------------------------------------------------------------
check_install() {
  if systemctl is-active "$SERVICE_NAME" >/dev/null 2>&1 || id "$HUB_USER" >/dev/null 2>&1; then
    return
  fi

  error "No flo.monster hub installation found."
  echo
  echo "  Expected one of:"
  echo "    - systemd service '$SERVICE_NAME'"
  echo "    - user '$HUB_USER'"
  echo
  echo "  Install a hub server with:"
  echo "    curl -fsSL https://flo.monster/install/hub.sh | bash"
  exit 1
}

# -----------------------------------------------------------------------------
# read_hub_json — Read hub.json and output its contents
# -----------------------------------------------------------------------------
read_hub_json() {
  sudo cat "$HUB_JSON_PATH" 2>/dev/null
}

# -----------------------------------------------------------------------------
# redact_tokens — Pipe hub.json through sed to replace token values with ***
# -----------------------------------------------------------------------------
redact_tokens() {
  sed -E 's/("(authToken|adminToken)"[[:space:]]*:[[:space:]]*")[^"]+"/\1***"/g'
}

# -----------------------------------------------------------------------------
# get_hub_ip — Get the IP address of the hub
# -----------------------------------------------------------------------------
get_hub_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}

# -----------------------------------------------------------------------------
# Command implementations
# -----------------------------------------------------------------------------

cmd_status() {
  sudo systemctl status "$SERVICE_NAME"
}

cmd_logs() {
  sudo journalctl -u "$SERVICE_NAME" -f --no-pager -n 100
}

cmd_restart() {
  info "Restarting flo-hub service..."
  sudo systemctl restart "$SERVICE_NAME"
  success "Service restarted"
}

cmd_stop() {
  info "Stopping flo-hub service..."
  sudo systemctl stop "$SERVICE_NAME"
  success "Service stopped"
}

cmd_start() {
  info "Starting flo-hub service..."
  sudo systemctl start "$SERVICE_NAME"
  success "Service started"
}

cmd_shell() {
  info "Opening shell as $HUB_USER..."
  sudo -u "$HUB_USER" -i
}

cmd_config() {
  local json
  json="$(read_hub_json)" || {
    error "Could not read hub configuration at $HUB_JSON_PATH"
    exit 1
  }

  hr
  echo "Hub Configuration (tokens redacted)"
  hr
  echo "$json" | redact_tokens
  hr
}

cmd_info() {
  local json
  json="$(read_hub_json)" || {
    error "Could not read hub configuration at $HUB_JSON_PATH"
    exit 1
  }

  local auth_token admin_token hub_host hub_ip hub_url
  auth_token="$(echo "$json" | sed -n 's/.*"authToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  admin_token="$(echo "$json" | sed -n 's/.*"adminToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  hub_host="$(echo "$json" | sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  hub_host="${hub_host:-0.0.0.0}"
  hub_ip="$(get_hub_ip)"

  # Determine the hub URL
  local show_cert_step="false"
  if [[ "$hub_host" == "127.0.0.1" ]]; then
    # Behind reverse proxy (Caddy) — likely domain mode
    local domain=""
    domain="$(sudo head -1 /etc/caddy/Caddyfile 2>/dev/null | grep -oE '[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' || true)"

    if [[ -n "$domain" ]]; then
      hub_url="wss://${domain}"
    else
      hub_url="ws://${hub_ip}:${HUB_PORT}"
      warn "Hub is bound to 127.0.0.1 (reverse proxy mode) but no domain found in Caddyfile."
      echo "  If using a domain, connect via wss://your-domain instead."
      echo
    fi
  else
    # Local mode — check if TLS is configured
    local has_tls
    has_tls="$(echo "$json" | grep -c '"certFile"' || true)"

    if [[ "$has_tls" -gt 0 ]]; then
      hub_url="wss://${hub_ip}:${HUB_PORT}"
      show_cert_step="true"
    else
      hub_url="ws://${hub_ip}:${HUB_PORT}"
    fi
  fi

  echo
  hr
  success "flo.monster Hub — Connection Details"
  hr
  echo
  echo "  Hub URL:      ${hub_url}"
  echo "  Auth Token:   ${auth_token}"
  echo "  Admin Token:  ${admin_token}"
  echo "  Host IP:      ${hub_ip}"
  echo
  hr
  echo "  How to connect from the browser:"
  hr
  echo
  if [[ "$show_cert_step" == "true" ]]; then
    echo "  1. First, open https://${hub_ip}:${HUB_PORT}/tls-setup in your browser"
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
}

cmd_uninstall() {
  echo
  warn "This will permanently remove the flo.monster hub installation."
  echo
  echo "  This will:"
  echo "    - Stop and disable the flo-hub systemd service"
  echo "    - Remove the systemd unit file"
  echo "    - Remove /usr/local/bin/flo-admin"
  echo "    - Optionally remove the flo-hub user and all data"
  echo
  echo -n "Are you sure? Type 'yes' to confirm: "
  local answer
  read -r answer < /dev/tty
  if [[ "$answer" != "yes" ]]; then
    echo "Uninstall cancelled."
    exit 0
  fi

  # Stop and disable systemd service
  if systemctl is-active "$SERVICE_NAME" >/dev/null 2>&1; then
    info "Stopping flo-hub service..."
    sudo systemctl stop "$SERVICE_NAME"
  fi
  if systemctl is-enabled "$SERVICE_NAME" >/dev/null 2>&1; then
    info "Disabling flo-hub service..."
    sudo systemctl disable "$SERVICE_NAME"
  fi
  if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
    info "Removing systemd unit file..."
    sudo rm "/etc/systemd/system/${SERVICE_NAME}.service"
    sudo systemctl daemon-reload
  fi
  success "Service removed"

  # Ask about user and data removal
  echo
  echo -n "Also remove flo-hub user and all data (/home/flo-hub)? Type 'yes' to confirm: "
  local remove_user
  read -r remove_user < /dev/tty
  if [[ "$remove_user" == "yes" ]]; then
    info "Removing flo-hub user and home directory..."
    sudo userdel -r "$HUB_USER" 2>/dev/null || true
    success "User and data removed"

    # Also remove flo-agent user if it exists
    if id "flo-agent" >/dev/null 2>&1; then
      info "Removing flo-agent user..."
      sudo userdel "flo-agent" 2>/dev/null || true
      success "flo-agent user removed"
    fi

    # Remove sudoers file
    if [[ -f /etc/sudoers.d/flo-monster ]]; then
      info "Removing sudoers rules..."
      sudo rm -f /etc/sudoers.d/flo-monster
      success "Sudoers rules removed"
    fi
  else
    info "Keeping flo-hub user and data"
  fi

  info "Removing flo-admin CLI..."
  sudo rm -f /usr/local/bin/flo-admin
  success "flo-admin removed"

  echo
  success "flo.monster hub has been uninstalled."
}

# -----------------------------------------------------------------------------
# show_usage — Print usage information
# -----------------------------------------------------------------------------
show_usage() {
  cat <<'USAGE'
flo.monster Hub Server — Admin CLI

Usage: flo-admin <command>

Commands:
  status      Show hub service status
  logs        Tail hub logs (Ctrl+C to stop)
  restart     Restart the hub service
  stop        Stop the hub service
  start       Start the hub service
  shell       Open a shell as flo-hub user
  config      Show hub configuration (tokens redacted)
  info        Show connection details (URL + tokens)
  uninstall   Remove the hub installation

Options:
  --help, -h  Show this help message
  --version   Show version

USAGE
}

# -----------------------------------------------------------------------------
# main — Parse command and dispatch
# -----------------------------------------------------------------------------
main() {
  # Handle no arguments
  if [[ $# -eq 0 ]]; then
    show_usage
    exit 0
  fi

  # Handle flags
  case "$1" in
    --help|-h)
      show_usage
      exit 0
      ;;
    --version)
      echo "flo-admin v${VERSION}"
      exit 0
      ;;
  esac

  # Verify hub installation exists
  check_install

  # Dispatch command
  case "$1" in
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    restart)   cmd_restart ;;
    stop)      cmd_stop ;;
    start)     cmd_start ;;
    shell)     cmd_shell ;;
    config)    cmd_config ;;
    info)      cmd_info ;;
    uninstall) cmd_uninstall ;;
    *)
      error "Unknown command: $1"
      echo
      show_usage
      exit 1
      ;;
  esac
}

main "$@"
