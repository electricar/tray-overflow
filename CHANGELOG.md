# Changelog

## 1.12 — 2026-11-23
- Tray icons relayed by Mint's tray service are identified by the program behind them (or their Flatpak app id), because the service renames icons while apps run (title, tray id, connection name). No more duplicate entries.
- Existing duplicates and leftover names of the same app are merged automatically; the entry shown in the list wins, "icon changes" rules are kept.
- Apps running inside a generic runtime (Electron, Python, Java) are told apart by the app they run.
- "Forget all apps that aren't running".
- Relayed icons that start without a name at login stay hidden during that moment (no flash in the panel), and the program is remembered through all later renames.
- The icon list updates live while it's open.
- Leftover entries are also merged when an app gets its final tray name later (e.g. LastWave).

## 1.11 — 2026-11-23
- Apps that switch from a temporary name to their real name at login no longer leave a duplicate "not running" entry behind; existing duplicates are merged automatically.
- Entries for apps that aren't running get "Forget this app".
- The popup grid no longer leaves an empty slot for icons an app has made invisible.

## 1.10 — 2026-11-20
- Follow tray icons that set their name after they appear (e.g. LastWave); settings carry over to the real name.

## 1.9
- Safety net: every few seconds, icons that Cinnamon's tray failed to hide or restore are fixed directly.
- All nameless tray icons share one fixed entry.

## 1.8
- Support tray icons without a name (listed by their tooltip).
- Log every tray icon found (Looking Glass) for troubleshooting.

## 1.7
- Reconcile the icon list every 3 seconds, so icons missed at login are picked up.

## 1.6
- Flatpak apps are identified by their Flatpak app id instead of the shared `xdg-dbus-proxy` helper.

## 1.5
- Apps whose tray icon has a temporary D-Bus name (`:1.1436`, Electron apps, Mullvad, pCloud …) are identified by their program, so settings survive restarts.
- Separate delays for moving into the panel (default 0.5 s) and back (default 3 s).
- The icon list stays open while changing settings.
- Own on/off labels instead of theme switches (some themes draw both states the same).

## 1.4
- "Show in panel when its icon changes": hidden apps come back into the panel when their icon changes (e.g. a notification badge) and return when it looks normal again.
- Mint Update preset: up to date = normal, checking/installing = ignored.

## 1.3
- The overflow popup stays open while an app's menu is shown.

## 1.2
- Clicks are forwarded like the panel does (press, then release), so app menus open reliably.

## 1.1
- Use the stock tray applet's icon monitor instead of starting a second one, which made every app re-send its icon and broke some icons.

## 1.0
- First version: hide tray icons in a ^ overflow popup, choose per app.
