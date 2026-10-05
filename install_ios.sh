#!/usr/bin/env bash
# Build a Release iOS build and install on a connected iPhone.
# No Metro server required at runtime — the JS bundle is embedded.
#
# Automatic signing builds against the *selected* device and registers it
# with your team, updating the provisioning profile so the app can install.
# (Free/personal teams can register devices too, up to their limit.)
#
# Usage:
#   ./install_ios.sh                    # pick from connected devices (prompts if >1)
#   ./install_ios.sh <udid>             # target a device (CoreDevice id or hardware UDID)
#   ./install_ios.sh --list             # list connected devices and exit
#   ./install_ios.sh --clean            # clean DerivedData before building

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$PROJECT_ROOT/ios"
WORKSPACE="$IOS_DIR/connect.xcworkspace"
SCHEME="connect"
CONFIG="Release"
DERIVED_DATA="$IOS_DIR/build/DerivedData"

cyan()  { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red()   { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }

# Available, non-Watch devices, one raw line each.
list_devices() {
  xcrun devicectl list devices 2>/dev/null | awk 'NR>2 && /available/ && !/Watch/ {print}'
}

# Fill NAME and HWUDID for a CoreDevice id. Hardware UDID (8hex-16hex) is what
# xcodebuild -destination expects; the CoreDevice id (a UUID) is what devicectl uses.
NAME=""
HWUDID=""
resolve_device() {
  local details
  details="$(xcrun devicectl device info details --device "$1" 2>/dev/null)"
  HWUDID="$(printf '%s\n' "$details" | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}' | head -n1)"
  NAME="$(printf '%s\n' "$details" | awk -F': ' '/ name:/{print $2; exit}')"
}

# ── Parse args ────────────────────────────────────────────────────────────────
CLEAN=0
LIST=0
DEVICE_ID=""
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --list)  LIST=1 ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) DEVICE_ID="$arg" ;;
  esac
done

# ── Enumerate connected devices ───────────────────────────────────────────────
cyan "Connected iOS devices:"
CORE_IDS=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  id="$(printf '%s\n' "$line" | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -n1)"
  [[ -n "$id" ]] && CORE_IDS+=("$id")
done < <(list_devices)

if [[ ${#CORE_IDS[@]} -eq 0 ]]; then
  red "No connected iPhone found. Plug it in, trust this Mac, then re-run."
  exit 1
fi

for c in "${CORE_IDS[@]}"; do
  resolve_device "$c"
  printf "  %-24s %s  (hw: %s)\n" "${NAME:-unknown}" "$c" "${HWUDID:-?}"
done

[[ $LIST -eq 1 ]] && exit 0

# ── Select a device ───────────────────────────────────────────────────────────
CHOSEN_CORE=""
if [[ -n "$DEVICE_ID" ]]; then
  for c in "${CORE_IDS[@]}"; do
    if [[ "$c" == "$DEVICE_ID" ]]; then CHOSEN_CORE="$c"; break; fi
    resolve_device "$c"
    if [[ "$HWUDID" == "$DEVICE_ID" ]]; then CHOSEN_CORE="$c"; break; fi
  done
  if [[ -z "$CHOSEN_CORE" ]]; then
    red "Device '$DEVICE_ID' is not connected/available. Run: ./install_ios.sh --list"
    exit 1
  fi
elif [[ ${#CORE_IDS[@]} -eq 1 ]]; then
  CHOSEN_CORE="${CORE_IDS[0]}"
else
  if [[ ! -e /dev/tty ]]; then
    red "Multiple devices connected and no TTY to prompt. Pass a UDID explicitly."
    exit 1
  fi
  cyan "Multiple devices connected — choose one:"
  i=1
  for c in "${CORE_IDS[@]}"; do
    resolve_device "$c"
    printf "  %d) %-24s (%s)\n" "$i" "${NAME:-unknown}" "$c" > /dev/tty
    i=$((i+1))
  done
  printf "Selection [1-%d]: " "${#CORE_IDS[@]}" > /dev/tty
  read -r sel < /dev/tty
  if ! [[ "$sel" =~ ^[0-9]+$ ]] || (( sel < 1 || sel > ${#CORE_IDS[@]} )); then
    red "Invalid selection."
    exit 1
  fi
  CHOSEN_CORE="${CORE_IDS[$((sel-1))]}"
fi

# Resolve the final choice (sets NAME + HWUDID).
resolve_device "$CHOSEN_CORE"
if [[ -z "$HWUDID" ]]; then
  red "Could not read hardware UDID for $CHOSEN_CORE."
  exit 1
fi

cyan "Target device:  ${NAME:-unknown}"
cyan "  CoreDevice:   $CHOSEN_CORE"
cyan "  Hardware UDID:$HWUDID"
cyan "Workspace:      $WORKSPACE"
cyan "Scheme:         $SCHEME ($CONFIG)"

if [[ ! -d "$WORKSPACE" ]]; then
  red "Workspace not found. Did you run 'cd ios && pod install'?"
  exit 1
fi

if [[ $CLEAN -eq 1 ]]; then
  cyan "Cleaning DerivedData…"
  rm -rf "$DERIVED_DATA"
fi

cyan "Building (Release) for selected device — registering it for signing if needed…"
set -o pipefail
XCBUILD_LOG="$IOS_DIR/build.install.log"
set +e
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination "platform=iOS,id=$HWUDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  -quiet \
  CODE_SIGN_STYLE=Automatic \
  build 2>&1 | tee "$XCBUILD_LOG" | grep -E "(error:|warning:|note:|\*\* BUILD)"
BUILD_STATUS=${PIPESTATUS[0]}
set -e

if [[ $BUILD_STATUS -ne 0 ]]; then
  red "Build failed — check $XCBUILD_LOG"
  exit "$BUILD_STATUS"
fi

# Locate the built .app
APP_PATH="$(find "$DERIVED_DATA/Build/Products/$CONFIG-iphoneos" -maxdepth 2 -name '*.app' -type d 2>/dev/null | head -n1)"

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  red "Build did not produce a .app — check $XCBUILD_LOG"
  exit 1
fi

green "Built: $APP_PATH"

# Read the bundle id straight from the built app so launch always targets
# what we just installed (survives bundle-id renames).
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP_PATH/Info.plist" 2>/dev/null)"
if [[ -z "$BUNDLE_ID" ]]; then
  red "Could not read CFBundleIdentifier from $APP_PATH — skipping launch."
fi

cyan "Installing on device…"
xcrun devicectl device install app --device "$CHOSEN_CORE" "$APP_PATH"

if [[ -n "$BUNDLE_ID" ]]; then
  cyan "Launching ${BUNDLE_ID}…"
  if ! xcrun devicectl device process launch --device "$CHOSEN_CORE" "$BUNDLE_ID"; then
    red "Launch failed. If this is the first install with this dev cert, trust it on the device:"
    red "  iPhone → Settings → General → VPN & Device Management → tap the developer cert → Trust."
    red "Then tap the app icon, or re-run this script."
  fi
fi

green "Done. App installed. No Metro required at runtime."
