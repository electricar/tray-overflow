#!/bin/sh
# Installs (or updates) the Tray Overflow applet for the current user.
set -e
UUID="tray-overflow@electricar"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"

mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/
echo "Installed to $DEST"

# If the applet is already on the panel, reload it so updates take effect.
dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon \
    org.Cinnamon.ReloadXlet string:"$UUID" string:'APPLET' 2>/dev/null || true

echo "Now: right-click the panel -> Applets -> add 'Tray Overflow'."
echo "Then use panel edit mode to drag it right next to the tray icons."
