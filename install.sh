#!/usr/bin/env bash
set -euo pipefail

APP="crow"
REPO="crowgent/crow"
RELEASES_API="https://api.github.com/repos/${REPO}/releases"
USER_DIR="${HOME}/.crow"
# Install straight into a directory that is already on PATH when possible, so
# `crow` works in the current shell with no manual export. An install that
# already lives in ~/.crow/bin is moved there on re-run by
# migrate_legacy_install below (old binary and PATH line cleaned up).
if [[ -w /usr/local/bin ]]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${USER_DIR}/bin"
fi
METADATA_PATH="${USER_DIR}/install.json"
PATH_MARKER="# crow"

requested_version=""
binary_path=""
no_modify_path=false
written_config_file=""
written_path_command=""

usage() {
  cat <<'EOF'
Install Crow from GitHub Releases.

Usage:
  curl -fsSL https://raw.githubusercontent.com/crowgent/crow/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/crowgent/crow/main/install.sh | bash -s -- --version 1.1.30
  bash install.sh --binary /path/to/crow

Options:
  -v, --version <version>  Install a specific version
  -b, --binary <path>      Install from a local binary instead of downloading
      --no-modify-path     Do not edit shell config files
  -h, --help               Show this help text
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -v|--version)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --version requires a version argument" >&2
        exit 1
      fi
      requested_version="$2"
      shift 2
      ;;
    -b|--binary)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --binary requires a path argument" >&2
        exit 1
      fi
      binary_path="$2"
      shift 2
      ;;
    --no-modify-path)
      no_modify_path=true
      shift
      ;;
    *)
      echo "Warning: Unknown option '$1'" >&2
      shift
      ;;
  esac
done

mkdir -p "$USER_DIR"
chmod 700 "$USER_DIR"
if [[ "$INSTALL_DIR" == "${USER_DIR}/bin" ]]; then
  mkdir -p "$INSTALL_DIR"
  chmod 700 "$INSTALL_DIR"
fi

resolve_target() {
  local raw_os arch
  raw_os=$(uname -s)
  case "$raw_os" in
    Darwin*) OS="darwin" ;;
    Linux*)  OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
    *)
      echo "Unsupported OS: ${raw_os}" >&2
      exit 1
      ;;
  esac

  arch=$(uname -m)
  case "$arch" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)
      echo "Unsupported architecture: ${arch}" >&2
      exit 1
      ;;
  esac

  case "${OS}-${ARCH}" in
    darwin-arm64|linux-x64|windows-x64) ;;
    *)
      echo "Unsupported platform: ${OS}-${ARCH}" >&2
      exit 1
      ;;
  esac

  TARGET="${OS}-${ARCH}"
  if [[ "$TARGET" == windows-* ]]; then
    ASSET_NAME="crow-${TARGET}.exe"
    BINARY_NAME="crow.exe"
  else
    ASSET_NAME="crow-${TARGET}"
    BINARY_NAME="crow"
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

json_or_null() {
  if [[ -n "${1:-}" ]]; then
    printf '"%s"' "$(json_escape "$1")"
  else
    printf 'null'
  fi
}

write_metadata() {
  local version="$1"
  cat > "$METADATA_PATH" <<METAEOF
{
  "schemaVersion": 1,
  "installMethod": "script",
  "version": "$(json_escape "$version")",
  "repo": "$(json_escape "$REPO")",
  "binaryPath": "$(json_escape "${INSTALL_DIR}/${BINARY_NAME}")",
  "installDir": "$(json_escape "$INSTALL_DIR")",
  "assetName": "$(json_escape "$ASSET_NAME")",
  "target": "$(json_escape "$TARGET")",
  "installedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "shellConfigPath": $(json_or_null "$written_config_file"),
  "pathCommand": $(json_or_null "$written_path_command")
}
METAEOF
  chmod 600 "$METADATA_PATH"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
    return
  fi
  echo "No SHA-256 tool found (expected sha256sum, shasum, or openssl)." >&2
  exit 1
}

verify_checksum() {
  local binary_file="$1" checksum_file="$2"
  local expected actual
  expected=$(awk -v asset="$ASSET_NAME" '$2 == asset || $2 == "*"asset { print $1 }' "$checksum_file")
  if [[ -z "$expected" ]]; then
    echo "Missing checksum for ${ASSET_NAME}" >&2
    exit 1
  fi
  actual=$(sha256_file "$binary_file")
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch for ${ASSET_NAME}" >&2
    exit 1
  fi
}

add_to_path() {
  local config_file="$1" command="$2"
  if grep -Fxq "$command" "$config_file" 2>/dev/null; then
    written_config_file="$config_file"
    written_path_command="$command"
    return
  fi
  printf '\n%s\n%s\n' "$PATH_MARKER" "$command" >> "$config_file"
  written_config_file="$config_file"
  written_path_command="$command"
}

migrate_legacy_install() {
  local old_config old_command old_binary tmp_file
  [[ -f "$METADATA_PATH" ]] || return 0
  old_binary=$(sed -n 's/.*"binaryPath":[[:space:]]*"\([^"]*\)".*/\1/p' "$METADATA_PATH" | head -n 1)
  [[ -n "$old_binary" && "$old_binary" != "${INSTALL_DIR}/${BINARY_NAME}" ]] || return 0
  if [[ -f "$old_binary" ]]; then
    rm -f "$old_binary"
  fi
  old_config=$(sed -n 's/.*"shellConfigPath":[[:space:]]*"\([^"]*\)".*/\1/p' "$METADATA_PATH" | head -n 1)
  old_command=$(sed -n 's/.*"pathCommand":[[:space:]]*"\([^"]*\)".*/\1/p' "$METADATA_PATH" | head -n 1)
  if [[ -n "$old_config" && -n "$old_command" && -f "$old_config" ]]; then
    tmp_file="${old_config}.crow-tmp"
    grep -vxF -e "$old_command" -e "$PATH_MARKER" "$old_config" > "$tmp_file" || true
    mv "$tmp_file" "$old_config"
  fi
  return 0
}

maybe_update_path() {
  if [[ "$no_modify_path" == true ]]; then return; fi
  if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then return; fi

  local current_shell config_files config_file path_command
  local xdg_config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  current_shell=$(basename "${SHELL:-bash}")

  case "$current_shell" in
    fish)
      config_files="$xdg_config_home/fish/config.fish"
      path_command="fish_add_path $INSTALL_DIR"
      ;;
    zsh)
      config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv"
      path_command="export PATH=$INSTALL_DIR:\$PATH"
      ;;
    *)
      config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile"
      path_command="export PATH=$INSTALL_DIR:\$PATH"
      ;;
  esac

  config_file=""
  for file in $config_files; do
    if [[ -f "$file" ]]; then
      config_file="$file"
      break
    fi
  done

  if [[ -z "$config_file" ]]; then
    echo "Add this to your shell config manually:" >&2
    echo "  export PATH=$INSTALL_DIR:\$PATH" >&2
    return
  fi

  add_to_path "$config_file" "$path_command"
}

warn_if_prerelease() {
  local version="$1"
  case "$version" in
    *-rc*|*-alpha*|*-beta*|*-pre*)
      cat >&2 <<EOF

Warning: Installing pre-release version ${version}.
Pre-releases may be unstable. For the latest stable release, re-run with:
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --version STABLE_VERSION

See https://github.com/${REPO}/releases for available versions.

EOF
      ;;
  esac
}

resolve_release_version() {
  if [[ -n "$requested_version" ]]; then
    RESOLVED_VERSION="${requested_version}"
    RELEASE_BASE_URL="https://github.com/${REPO}/releases/download/crow@${RESOLVED_VERSION}"
    return
  fi

  local response tag
  if ! response=$(curl -fsSL "${RELEASES_API}/latest"); then
    echo "Failed to fetch the latest Crow release from ${RELEASES_API}/latest." >&2
    echo "No release may be published yet. See https://github.com/${REPO}/releases" >&2
    exit 1
  fi
  tag=$(printf '%s' "$response" \
    | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)
  RESOLVED_VERSION="${tag#crow@}"
  if [[ -z "$RESOLVED_VERSION" ]]; then
    echo "Failed to resolve the latest Crow release version." >&2
    echo "No release may be published yet. See https://github.com/${REPO}/releases" >&2
    exit 1
  fi
  RELEASE_BASE_URL="https://github.com/${REPO}/releases/latest/download"
  warn_if_prerelease "$RESOLVED_VERSION"
}

install_downloaded_release() {
  local tmp_dir binary_file checksum_file
  tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/crow-install.XXXXXX")
  trap "rm -rf \"$tmp_dir\"" EXIT

  binary_file="${tmp_dir}/${ASSET_NAME}"
  checksum_file="${tmp_dir}/checksums.txt"

  echo "Downloading ${ASSET_NAME}..."
  curl -fSL "${RELEASE_BASE_URL}/${ASSET_NAME}" -o "$binary_file"
  curl -fsSL "${RELEASE_BASE_URL}/checksums.txt" -o "$checksum_file"
  verify_checksum "$binary_file" "$checksum_file"

  cp "$binary_file" "${INSTALL_DIR}/${BINARY_NAME}"
  [[ "$TARGET" != windows-* ]] && chmod 755 "${INSTALL_DIR}/${BINARY_NAME}"
}

install_local_binary() {
  if [[ ! -f "$binary_path" ]]; then
    echo "Binary not found at ${binary_path}" >&2
    exit 1
  fi
  cp "$binary_path" "${INSTALL_DIR}/${BINARY_NAME}"
  [[ "$TARGET" != windows-* ]] && chmod 755 "${INSTALL_DIR}/${BINARY_NAME}"
}

resolve_installed_version() {
  INSTALLED_VERSION=$("${INSTALL_DIR}/${BINARY_NAME}" --version 2>/dev/null | tr -d '\r') || true
  : "${INSTALLED_VERSION:=unknown}"
}

resolve_target

if [[ -n "$binary_path" ]]; then
  install_local_binary
else
  resolve_release_version
  install_downloaded_release
fi

migrate_legacy_install
maybe_update_path
resolve_installed_version
write_metadata "$INSTALLED_VERSION"

echo ""
echo "Crow ${INSTALLED_VERSION} installed to ${INSTALL_DIR}/${BINARY_NAME}"
echo ""
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo "Note: this shell does not have ${INSTALL_DIR} in PATH yet, so 'crow'"
  echo "will say 'command not found' until you run one of these:"
  echo "  export PATH=${INSTALL_DIR}:\$PATH"
  echo "or start a new shell."
  echo ""
fi
echo "Run:"
echo "  crow --help"
echo ""
echo "To uninstall later:"
echo "  crow uninstall"
echo ""
