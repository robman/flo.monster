#!/usr/bin/env bash
# =============================================================================
# flo.monster Hub Server — Admin CLI
#
# Management wrapper for the flo.monster hub server.
# Auto-detects Multipass VM or direct installation and routes commands
# accordingly.
#
# Installed to /usr/local/bin/flo-admin by the hub installer.
#
# Usage:
#   flo-admin <command>
#
# See --help or run without arguments for all commands.
# =============================================================================
set -euo pipefail

VERSION="1.0.0"
INSTALL_MODE=""   # "multipass" or "direct"
VM_NAME="flo-hub"
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
# detect_mode — Determine if we're managing a Multipass VM or direct install
# -----------------------------------------------------------------------------
detect_mode() {
  # Check for Multipass VM named flo-hub
  if command -v multipass >/dev/null 2>&1 && multipass list 2>/dev/null | grep -q "$VM_NAME"; then
    INSTALL_MODE="multipass"
    return
  fi

  # Check for direct install (systemd service or flo-hub user)
  if systemctl is-active "$VM_NAME" >/dev/null 2>&1 || id "$HUB_USER" >/dev/null 2>&1; then
    INSTALL_MODE="direct"
    return
  fi

  error "No flo.monster hub installation found."
  echo
  echo "  Expected one of:"
  echo "    - Multipass VM named '$VM_NAME'"
  echo "    - systemd service '$VM_NAME' or user '$HUB_USER'"
  echo
  echo "  Install a hub server with:"
  echo "    curl -fsSL https://flo.monster/install/hub.sh | bash"
  exit 1
}

# -----------------------------------------------------------------------------
# read_hub_json — Read hub.json and output its contents
# In Multipass mode, reads from the VM. In direct mode, reads locally.
# -----------------------------------------------------------------------------
read_hub_json() {
  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    multipass exec "$VM_NAME" -- sudo cat "$HUB_JSON_PATH" 2>/dev/null
  else
    sudo cat "$HUB_JSON_PATH" 2>/dev/null
  fi
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
  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    multipass info "$VM_NAME" 2>/dev/null | grep -i 'ipv4' | awk '{print $2}'
  else
    hostname -I 2>/dev/null | awk '{print $1}'
  fi
}

# -----------------------------------------------------------------------------
# Command implementations
# -----------------------------------------------------------------------------

cmd_status() {
  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    multipass exec "$VM_NAME" -- sudo systemctl status "$VM_NAME"
  else
    sudo systemctl status "$VM_NAME"
  fi
}

cmd_logs() {
  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    multipass exec "$VM_NAME" -- sudo journalctl -u "$VM_NAME" -f --no-pager -n 100
  else
    sudo journalctl -u "$VM_NAME" -f --no-pager -n 100
  fi
}

cmd_restart() {
  info "Restarting flo-hub service..."
  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    multipass exec "$VM_NAME" -- sudo systemctl restart "$VM_NAME"
  else
    sudo systemctl restart "$VM_NAME"
  fi
  success "Service restarted"
}

cmd_stop() {
  info "Stopping flo-hub service..."
  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    multipass exec "$VM_NAME" -- sudo systemctl stop "$VM_NAME"
  else
    sudo systemctl stop "$VM_NAME"
  fi
  success "Service stopped"
}

cmd_start() {
  info "Starting flo-hub service..."
  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    multipass exec "$VM_NAME" -- sudo systemctl start "$VM_NAME"
  else
    sudo systemctl start "$VM_NAME"
  fi
  success "Service started"
}

cmd_shell() {
  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    info "Opening shell as $HUB_USER in Multipass VM..."
    multipass exec "$VM_NAME" -- sudo -u "$HUB_USER" -i
  else
    info "Opening shell as $HUB_USER..."
    sudo -u "$HUB_USER" -i
  fi
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
  if [[ "$hub_host" == "127.0.0.1" ]]; then
    # Behind reverse proxy (Caddy) — likely domain mode
    # Try to get the domain from Caddyfile
    local domain=""
    if [[ "$INSTALL_MODE" == "multipass" ]]; then
      domain="$(multipass exec "$VM_NAME" -- sudo head -1 /etc/caddy/Caddyfile 2>/dev/null | grep -oE '[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' || true)"
    else
      domain="$(sudo head -1 /etc/caddy/Caddyfile 2>/dev/null | grep -oE '[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' || true)"
    fi

    if [[ -n "$domain" ]]; then
      hub_url="wss://${domain}"
    else
      hub_url="ws://${hub_ip}:${HUB_PORT}"
      warn "Hub is bound to 127.0.0.1 (reverse proxy mode) but no domain found in Caddyfile."
      echo "  If using a domain, connect via wss://your-domain instead."
      echo
    fi
  else
    hub_url="ws://${hub_ip}:${HUB_PORT}"
  fi

  echo
  hr
  success "flo.monster Hub — Connection Details"
  hr
  echo
  echo "  Hub URL:      ${hub_url}"
  echo "  Auth Token:   ${auth_token}"
  echo "  Admin Token:  ${admin_token}"

  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    echo "  VM IP:        ${hub_ip}"
    echo "  Instance:     ${VM_NAME}"
  else
    echo "  Host IP:      ${hub_ip}"
  fi

  echo
  hr
  echo "  How to connect from the browser:"
  hr
  echo
  echo "  1. Open flo.monster in your browser"
  echo "  2. Go to Settings > Hub"
  echo "  3. Enter the Hub URL: ${hub_url}"
  echo "  4. Enter the Auth Token shown above"
  echo "  5. Click Connect"
  echo
  hr
}

cmd_uninstall() {
  echo
  warn "This will permanently remove the flo.monster hub installation."

  if [[ "$INSTALL_MODE" == "multipass" ]]; then
    echo
    echo "  This will:"
    echo "    - Delete the Multipass VM '$VM_NAME' and all its data"
    echo "    - Remove /usr/local/bin/flo-admin"
    echo
    echo -n "Are you sure? Type 'yes' to confirm: "
    local answer
    read -r answer < /dev/tty
    if [[ "$answer" != "yes" ]]; then
      echo "Uninstall cancelled."
      exit 0
    fi

    info "Deleting Multipass VM '$VM_NAME'..."
    multipass delete "$VM_NAME" --purge
    success "VM deleted"

    info "Removing flo-admin CLI..."
    sudo rm -f /usr/local/bin/flo-admin
    success "flo-admin removed"

  else
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
    if systemctl is-active "$VM_NAME" >/dev/null 2>&1; then
      info "Stopping flo-hub service..."
      sudo systemctl stop "$VM_NAME"
    fi
    if systemctl is-enabled "$VM_NAME" >/dev/null 2>&1; then
      info "Disabling flo-hub service..."
      sudo systemctl disable "$VM_NAME"
    fi
    if [[ -f "/etc/systemd/system/${VM_NAME}.service" ]]; then
      info "Removing systemd unit file..."
      sudo rm "/etc/systemd/system/${VM_NAME}.service"
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
  fi

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

  # Detect installation mode before running any command
  detect_mode

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
