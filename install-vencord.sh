#!/usr/bin/env bash
# E2EE-Discord — one-click installer for Vencord (macOS / Linux)
# Made by XO.ST · https://github.com/xo907/e2ee-discord
#
# Vencord only loads custom plugins that are compiled into it, so this script downloads
# Vencord's source, adds the E2EE-Discord plugin, builds it, injects it into Discord and
# enables the plugin. Run it again any time to update.
#
# Usage:  bash install-vencord.sh [--branch auto|stable|ptb|canary] [--uninstall] [--yes]
#   or:   curl -fsSL https://raw.githubusercontent.com/xo907/e2ee-discord/main/install-vencord.sh | bash
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/xo907/e2ee-discord/main"
VENCORD_REPO="https://github.com/Vendicated/Vencord.git"
PLUGIN_FOLDER="e2eeDiscord"
PLUGIN_NAME="E2EEDiscord"
MIN_NODE_MAJOR=22

if [[ "$(uname -s)" == "Darwin" ]]; then
  INSTALL_ROOT="$HOME/Library/Application Support/E2EE-Discord"
else
  INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/e2ee-discord"
fi
VENCORD_DIR="$INSTALL_ROOT/Vencord"

BRANCH="auto"
UNINSTALL=0
YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$BRANCH" in auto|stable|ptb|canary) ;; *) echo "Invalid --branch: $BRANCH" >&2; exit 1 ;; esac

RED=$'\033[31m'; GREEN=$'\033[32m'; GRAY=$'\033[90m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
step() { printf '%s==>%s %s\n' "$RED" "$RESET" "$1"; }
info() { printf '    %s%s%s\n' "$GRAY" "$1" "$RESET"; }
done_() { printf '    %s%s%s\n' "$GREEN" "$1" "$RESET"; }
fail() { printf '\n  %sInstallation failed:%s %s\n' "$RED" "$RESET" "$1" >&2; info "Help: https://github.com/xo907/e2ee-discord/issues"; exit 1; }
confirm() {
  [[ $YES -eq 1 ]] && return 0
  local answer
  # read from the terminal even when the script is piped into bash
  read -r -p "    $1 [Y/n] " answer </dev/tty || answer=""
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }

printf '\n  %sX %sO%s   %sE2EE-Discord installer for Vencord%s\n' "$BOLD" "$RED" "$RESET" "$BOLD" "$RESET"
printf '       %sMade by XO.ST%s\n\n' "$GRAY" "$RESET"

node_major() { have node && node --version | sed 's/^v//; s/\..*//' || echo 0; }

install_prerequisites() {
  step "Checking requirements"
  local missing=()
  have git || missing+=("git")
  [[ "$(node_major)" -ge $MIN_NODE_MAJOR ]] || missing+=("node")

  if [[ ${#missing[@]} -gt 0 ]]; then
    if [[ "$(uname -s)" == "Darwin" ]] && have brew; then
      confirm "Missing: ${missing[*]}. Install with Homebrew?" || fail "${missing[*]} required"
      brew install "${missing[@]}"
    else
      info "Missing: ${missing[*]}. Install them first, for example:"
      info "  Debian/Ubuntu: sudo apt install git nodejs npm   (Node $MIN_NODE_MAJOR+, see https://nodejs.org)"
      info "  Fedora:        sudo dnf install git nodejs"
      info "  Arch:          sudo pacman -S git nodejs npm"
      info "  macOS:         install Homebrew (https://brew.sh), then run this again"
      fail "missing requirements: ${missing[*]}"
    fi
  fi
  [[ "$(node_major)" -ge $MIN_NODE_MAJOR ]] || fail "Node.js $MIN_NODE_MAJOR or newer is required (found $(node --version 2>/dev/null || echo none))"
  done_ "git $(git --version | sed 's/git version //')"
  done_ "node $(node --version)"

  if ! have pnpm; then
    confirm "pnpm (the package manager Vencord uses) is not installed. Install it with npm?" || fail "pnpm required"
    if ! npm install --global pnpm; then
      info "Retrying with sudo…"
      sudo npm install --global pnpm || fail "could not install pnpm"
    fi
    hash -r
    have pnpm || fail "pnpm was installed but is not on PATH yet. Open a new terminal and run this again."
  fi
  done_ "pnpm $(pnpm --version)"
}

sync_vencord() {
  step "Getting the latest Vencord"
  mkdir -p "$INSTALL_ROOT"
  if [[ -d "$VENCORD_DIR/.git" ]]; then
    git -C "$VENCORD_DIR" fetch --depth 1 origin main
    git -C "$VENCORD_DIR" reset --hard origin/main
  else
    rm -rf "$VENCORD_DIR"
    git clone --depth 1 "$VENCORD_REPO" "$VENCORD_DIR"
  fi
  done_ "Vencord $(git -C "$VENCORD_DIR" rev-parse --short HEAD)"
}

copy_plugin() {
  step "Adding the E2EE-Discord plugin"
  local target="$VENCORD_DIR/src/userplugins/$PLUGIN_FOLDER"
  mkdir -p "$target"
  local script_dir=""
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  local local_dir="$script_dir/vencord/$PLUGIN_FOLDER"
  if [[ -n "$script_dir" && -f "$local_dir/index.ts" && -f "$local_dir/native.ts" && -f "$local_dir/core.js" ]]; then
    cp "$local_dir/index.ts" "$local_dir/native.ts" "$local_dir/core.js" "$target/"
    done_ "copied from $local_dir"
  else
    for file in index.ts native.ts core.js; do
      curl -fsSL "$REPO_RAW/vencord/$PLUGIN_FOLDER/$file" -o "$target/$file"
    done
    done_ "downloaded from github.com/xo907/e2ee-discord"
  fi
}

build_vencord() {
  step "Building Vencord (this takes a minute)"
  (cd "$VENCORD_DIR" && CI=true pnpm install --frozen-lockfile && pnpm build)
  done_ "built"
}

DISCORD_WAS_RUNNING=()
stop_discord() {
  local name running=()
  for name in Discord DiscordPTB DiscordCanary discord discord-ptb discord-canary "Discord PTB" "Discord Canary"; do
    pgrep -x "$name" >/dev/null 2>&1 && running+=("$name")
  done
  [[ ${#running[@]} -eq 0 ]] && return 0
  confirm "Discord (${running[*]}) needs to be closed. Close it now?" || fail "please close Discord and run this again"
  for name in "${running[@]}"; do pkill -x "$name" || true; done
  DISCORD_WAS_RUNNING=("${running[@]}")
  sleep 2
}

start_discord() {
  [[ ${#DISCORD_WAS_RUNNING[@]} -eq 0 ]] && return 0
  if [[ "$(uname -s)" == "Darwin" ]]; then
    case "$BRANCH" in ptb) open -a "Discord PTB" ;; canary) open -a "Discord Canary" ;; *) open -a "Discord" ;; esac || true
  else
    local cmd
    for cmd in discord discord-ptb discord-canary; do
      if have "$cmd"; then nohup "$cmd" >/dev/null 2>&1 & break; fi
    done
  fi
}

run_vencord_installer() {
  (cd "$VENCORD_DIR" && node scripts/runInstaller.mjs -- "--$1" --branch "$BRANCH")
}

enable_plugin() {
  step "Enabling E2EE-Discord"
  mkdir -p "$VENCORD_DIR/settings"
  SETTINGS_FILE="$VENCORD_DIR/settings/settings.json" PLUGIN_NAME="$PLUGIN_NAME" node -e '
    const fs = require("fs");
    const file = process.env.SETTINGS_FILE;
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    settings.plugins ??= {};
    settings.plugins[process.env.PLUGIN_NAME] = { ...(settings.plugins[process.env.PLUGIN_NAME] || {}), enabled: true };
    fs.writeFileSync(file, JSON.stringify(settings, null, 4));
  '
  done_ "enabled in Vencord settings"
}

if [[ $UNINSTALL -eq 1 ]]; then
  [[ -f "$VENCORD_DIR/scripts/runInstaller.mjs" ]] || fail "nothing to uninstall: $VENCORD_DIR not found"
  stop_discord
  step "Removing Vencord from Discord"
  run_vencord_installer uninstall || fail "the Vencord installer could not uninstall (try running with sudo)"
  if confirm "Also delete $INSTALL_ROOT?"; then rm -rf "$INSTALL_ROOT"; fi
  start_discord
  printf '\n'; done_ "E2EE-Discord and Vencord were removed."
  exit 0
fi

install_prerequisites
sync_vencord
copy_plugin
build_vencord || fail "building Vencord failed"
stop_discord
step "Injecting Vencord into Discord (branch: $BRANCH)"
run_vencord_installer install || fail "the Vencord installer failed (on Linux, system-wide installs may need: sudo bash install-vencord.sh)"
enable_plugin
start_discord

printf '\n  %sAll set!%s %s\n' "$GREEN" "$RESET" "$([[ ${#DISCORD_WAS_RUNNING[@]} -gt 0 ]] && echo 'Discord is restarting.' || echo 'Start Discord.')"
info "Open any chat and click the lock in the message bar. Right-click it for the menu."
info "Keep the folder $INSTALL_ROOT — Discord loads Vencord from it."
info "Run this script again to update. Use --uninstall to remove."
