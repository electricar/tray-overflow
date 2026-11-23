// SPDX-License-Identifier: GPL-2.0-or-later
// Tray Overflow - https://github.com/electricar/tray-overflow
// Copyright (C) 2026 electricar
//
// Parts (click forwarding, icon positioning, scroll handling) are based on
// the XApp Status applet (xapp-status@cinnamon.org) from Linux Mint's
// Cinnamon, which is licensed GPL-2.0-or-later.
//
// Windows-style hidden tray icons for Cinnamon.
//
// How it works:
//  * Icons you mark as "hidden" are registered with Main.systrayManager as
//    "tray icon replacements". Both stock tray applets (xapp-status and
//    systray) already honour that list and stop showing those icons.
//  * This applet listens to the stock xapp-status applet's icon monitor
//    (it does NOT start a second monitor - a new monitor makes every tray
//    app re-send its icon, which breaks some pixmap icons, e.g. Electron
//    apps) and draws the hidden XApp/AppIndicator icons inside a ^ popup. Clicks are forwarded to the
//    app exactly like the stock applet does.
//  * Legacy XEmbed icons (rare: some Wine/old apps) can only be hidden
//    completely - they can't be moved into the popup.
//  * Optional per app: "show in panel when its icon changes". The applet
//    remembers which icon looks are normal (stay hidden) and which are
//    in-between states to ignore (e.g. Mint Update "checking"); any other
//    look moves the icon into the panel until it looks normal again.
//  * Removing this applet unregisters everything, so all icons come back.

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Tooltips = imports.ui.tooltips;
const SignalManager = imports.misc.signalManager;
const Mainloop = imports.mainloop;
const Cinnamon = imports.gi.Cinnamon;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const XApp = imports.gi.XApp;
const Meta = imports.gi.Meta;
const AppletManager = imports.ui.appletManager;

const STOCK_UUID = "xapp-status@cinnamon.org";

// Built-in knowledge about Mint Update's tray icon states.
const PRESETS = [
    {
        match: name => name.startsWith("mintupdate"),
        normal: ["icon:mintupdate-up-to-date-symbolic"],
        ignore: ["icon:mintupdate-checking-symbolic", "icon:mintupdate-installing-symbolic"]
    }
];

/* Some tray icons (Electron apps, Mullvad, pCloud ...) have no name of their
 * own and show up under their temporary D-Bus connection (":1.1436") or a
 * PID-based name. Those change on every start, so for them we use the
 * program behind the connection instead ("app:vesktop"). */
const GENERIC_EXES = ["electron", "node", "python", "python3", "java", "bash", "sh", "env", "bwrap"];

function pidForBusName(busName) {
    let m = busName.match(/statusnotifieritem-(\d+)-\d+$/i);
    if (m) return parseInt(m[1]);
    try {
        let ret = Gio.DBus.session.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "GetConnectionUnixProcessID",
            new GLib.Variant("(s)", [busName]), new GLib.VariantType("(u)"),
            Gio.DBusCallFlags.NONE, 500, null);
        return ret.deep_unpack()[0];
    } catch (e) {
        return 0;
    }
}

function programName(pid) {
    let base = "";
    try {
        base = GLib.path_get_basename(GLib.file_read_link("/proc/" + pid + "/exe")).replace(/ \(deleted\)$/, "");
    } catch (e) { /* ignore */ }

    if (!base || GENERIC_EXES.includes(base.replace(/[0-9.]+$/, ""))) {
        try {
            let [ok, bytes] = GLib.file_get_contents("/proc/" + pid + "/comm");
            let comm = imports.byteArray.toString(bytes).trim();
            if (comm) base = comm;
        } catch (e) { /* ignore */ }
    }
    // Still generic (e.g. "electron", "python3")? Use the app path it runs.
    if (!base || GENERIC_EXES.includes(base.replace(/[0-9.]+$/, ""))) {
        try {
            let [ok, bytes] = GLib.file_get_contents("/proc/" + pid + "/cmdline");
            let args = imports.byteArray.toString(bytes).split("\0").slice(1).filter(a => a && !a.startsWith("-"));
            if (args.length) {
                let parts = args[0].split("/").filter(x => x);
                let name = parts.pop() || "";
                if (["app", "app.asar", "resources", "main.js", "index.js", "main.py", "__main__.py"].includes(name)) {
                    name = parts.filter(x => x !== "resources").pop() || name;
                }
                name = name.replace(/\.(asar|py|jar|js)$/, "");
                if (name) base = name;
            }
        } catch (e) { /* ignore */ }
    }
    return base.toLowerCase();
}

/* Flatpak apps talk to D-Bus through a helper (xdg-dbus-proxy), so the
 * program behind every Flatpak tray icon looks the same. The sandbox info
 * file (the same one the desktop portals use) names the real app. */
function flatpakAppId(pid) {
    try {
        let kf = new GLib.KeyFile();
        kf.load_from_file("/proc/" + pid + "/root/.flatpak-info", GLib.KeyFileFlags.NONE);
        let name = kf.get_string("Application", "name");
        if (name) return name;
    } catch (e) { /* not a Flatpak, or not readable */ }
    try {
        let [ok, bytes] = GLib.file_get_contents("/proc/" + pid + "/cgroup");
        let m = imports.byteArray.toString(bytes).match(/app-flatpak-([A-Za-z0-9._-]+?)-\d+\.scope/);
        if (m) return m[1];
    } catch (e) { /* ignore */ }
    return null;
}

// Ids from 1.5 that several Flatpak apps shared.
const SHARED_IDS = ["app:xdg-dbus-proxy", "app:bwrap"];

// "flatpak:dev.vencord.vesktop" or "app:cryptomator" - never changes for an app.
function programIdForPid(pid) {
    if (!pid) return "";
    let fp = flatpakAppId(pid);
    if (fp) return "flatpak:" + fp.toLowerCase();
    let prog = programName(pid);
    return prog ? "app:" + prog : "";
}

function stableId(rawName) {
    let raw = rawName || "";
    let lower = raw.toLowerCase();
    let unstable = raw.startsWith(":") || /statusnotifieritem-\d+-\d+$/.test(lower);
    if (!unstable) return lower;
    return programIdForPid(pidForBusName(raw)) || lower;
}

function isProgramId(id) {
    return id.startsWith("app:") || id.startsWith("flatpak:");
}

function unpackV(v) {
    while (v instanceof GLib.Variant) v = v.deep_unpack();
    return v;
}

// Asynchronous D-Bus call; resolves to the unpacked reply or null.
function dbusCall(bus, path, iface, method, params, replyType) {
    return new Promise(resolve => {
        try {
            Gio.DBus.session.call(bus, path, iface, method, params,
                replyType ? new GLib.VariantType(replyType) : null,
                Gio.DBusCallFlags.NONE, 1000, null, (conn, res) => {
                    try {
                        resolve(conn.call_finish(res).deep_unpack());
                    } catch (e) {
                        resolve(null);
                    }
                });
        } catch (e) {
            resolve(null);
        }
    });
}

function sortableName(s) {
    return String(s).normalize("NFD").toLowerCase();
}

/* Mint's tray service (xapp-sn-watcher) names each relayed icon after the
 * app's tray title, its tray id or its connection - and switches between
 * them while the app runs. The service's list of registered apps lets us
 * map every one of those names to the program behind the icon. */
async function buildTrayProgramMap() {
    let map = new Map();
    let reply = await dbusCall("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
        "org.freedesktop.DBus.Properties", "Get",
        new GLib.Variant("(ss)", ["org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"]), "(v)");
    if (!reply) return null;

    let items = unpackV(reply[0]) || [];
    await Promise.all(items.map(async item => {
        let i = item.indexOf("/");
        let bus = i >= 0 ? item.substring(0, i) : item;
        let path = i >= 0 ? item.substring(i) : "/StatusNotifierItem";

        let pidReply = await dbusCall("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetConnectionUnixProcessID", new GLib.Variant("(s)", [bus]), "(u)");
        let pid = pidReply ? pidReply[0] : 0;
        if (!pid) {
            let m = bus.match(/-(\d+)-\d+$/);
            pid = m ? parseInt(m[1]) : 0;
        }
        let prog = programIdForPid(pid);
        if (!prog) return;

        let names = [bus];
        for (let prop of ["Id", "Title"]) {
            let r = await dbusCall(bus, path, "org.freedesktop.DBus.Properties", "Get",
                new GLib.Variant("(ss)", ["org.kde.StatusNotifierItem", prop]), "(v)");
            let v = r ? unpackV(r[0]) : null;
            if (typeof v === "string" && v) names.push(v);
        }
        for (let n of names) {
            if (!map.has(sortableName(n))) map.set(sortableName(n), prog);
        }
    }));
    return map;
}

function isUnstableId(id) {
    return id.startsWith(":") || /statusnotifieritem-\d+-\d+$/.test(id);
}

/* A stable fingerprint of what the icon currently looks like. Pixmap icons
 * (Electron apps such as Vesktop) arrive as temp PNG files whose path changes
 * on every update, so for files we hash the content instead of the path. */
function iconSignature(proxy) {
    let icon = null;
    try {
        icon = proxy.icon_name;
    } catch (e) {
        return null;
    }
    if (!icon) return null;

    if (icon.includes("/")) {
        try {
            let [ok, bytes] = GLib.file_get_contents(icon);
            if (!ok || !bytes || bytes.length === 0) return null;
            return "img:" + GLib.compute_checksum_for_data(GLib.ChecksumType.MD5, bytes);
        } catch (e) {
            return null; // file already replaced - the next update will tell us
        }
    }
    return "icon:" + icon;
}

const XAPP_PREFIX = "org.x.statusicon.";

function prettyName(name) {
    let n = name || "";
    if (n.startsWith("app:")) return n.substring(4);
    if (n.startsWith("untitled:")) return n.substring(9);
    if (n === "untitled") return "(unnamed icon)";
    if (n.startsWith("flatpak:")) {
        let parts = n.substring(8).split(".");
        return parts[parts.length - 1];       // dev.aunetx.deezer -> deezer
    }
    if (n.toLowerCase().startsWith(XAPP_PREFIX)) {
        n = n.substring(XAPP_PREFIX.length);
    }
    return n;
}

function plainText(markup) {
    if (!markup) return "";
    let s = String(markup)
        .replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
    return s.split("\n")[0].trim();
}

function truncate(s, len) {
    return s.length > len ? s.substring(0, len - 1) + "…" : s;
}

/* Menu items that don't depend on the theme's switch images (some themes
 * draw "on" and "off" the same) and keep the menu open when clicked. */
class ToggleItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, state, onText, offText) {
        super._init.call(this, {});
        this._onText = onText;
        this._offText = offText;

        this.label = new St.Label({ text: text, y_align: Clutter.ActorAlign.CENTER });
        this.addActor(this.label);
        this.actor.label_actor = this.label;

        this._statusLabel = new St.Label({ text: "", style_class: "popup-inactive-menu-item", y_align: Clutter.ActorAlign.CENTER });
        this.addActor(this._statusLabel);

        this._stateLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        let bin = new St.Bin({ x_align: St.Align.END, child: this._stateLabel });
        this.addActor(bin, { expand: true, span: -1, align: St.Align.END });

        this.setToggleState(state);
    }

    setStatus(text) {
        this._statusLabel.set_text(text ? "  " + text : "");
    }

    setToggleState(state) {
        this.state = state;
        this._stateLabel.set_text(state ? "● " + this._onText : "○ " + this._offText);
        this._stateLabel.set_style(state
            ? "font-weight: bold; color: #43a047; padding-left: 12px;"
            : "color: #8a8a8a; padding-left: 12px;");
    }

    activate(event) {
        this.setToggleState(!this.state);
        this.emit("toggled", this.state);
        super.activate(event, true);   // true = keep the menu open
    }
}

class ActionItem extends PopupMenu.PopupMenuItem {
    activate(event) {
        super.activate(event, true);   // keep the menu open
    }
}

/* One hidden XApp icon, drawn inside the overflow popup. */
class OverflowIcon {
    constructor(applet, proxy) {
        this.applet = applet;
        this.proxy = proxy;

        this.actor = new St.Bin({
            style_class: "applet-box",
            style: "padding: 4px;",
            reactive: true,
            track_hover: true,
            can_focus: true
        });

        this._tooltip = new Tooltips.Tooltip(this.actor, "");

        this._pressedButton = 0;
        this.actor.connect("button-press-event", (a, e) => this._onPress(a, e));
        this.actor.connect("button-release-event", (a, e) => this._onRelease(a, e));
        this.actor.connect("scroll-event", (a, e) => this._onScroll(a, e));

        this._propsId = this.proxy.connect("g-properties-changed", () => this.refresh());

        this.refresh();
    }

    get sortName() {
        return prettyName(this.proxy.name).toLowerCase();
    }

    get isVisible() {
        return !!this.proxy.visible;
    }

    refresh() {
        this._updateIcon();

        let tip = plainText(this.proxy.tooltip_text) || prettyName(this.proxy.name);
        this._tooltip.set_text(tip);

        this.actor.visible = this.isVisible;
    }

    _updateIcon() {
        let name = this.proxy.icon_name;
        let size = this.applet.overflowIconSize;
        let symbolic = !!(name && name.match(/symbolic/));
        let type = symbolic ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
        let icon;

        try {
            if (this.proxy.icon_size !== size) this.proxy.icon_size = size;
        } catch (e) { /* not fatal */ }

        if (!name) {
            icon = new St.Icon({ icon_name: "application-x-executable", icon_type: St.IconType.FULLCOLOR, icon_size: size });
        } else if (name.includes("/")) {
            let gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(name) });
            icon = new St.Icon({ gicon: gicon, icon_type: type, icon_size: size });
        } else {
            icon = new St.Icon({ icon_name: name, icon_type: type, icon_size: size });
        }

        this.actor.set_child(icon);
    }

    _positionInfo() {
        let alloc = Cinnamon.util_get_transformed_allocation(this.actor);
        let x = Math.round(alloc.x1 / global.ui_scale);
        let y = Math.round(alloc.y1 / global.ui_scale);
        let w = Math.round((alloc.x2 - alloc.x1) / global.ui_scale);
        let h = Math.round((alloc.y2 - alloc.y1) / global.ui_scale);

        switch (this.applet.orientation) {
            case St.Side.TOP:
                return [x, y + h, Gtk.PositionType.TOP];
            case St.Side.LEFT:
                return [x + w, y, Gtk.PositionType.LEFT];
            case St.Side.RIGHT:
                return [x, y, Gtk.PositionType.RIGHT];
            case St.Side.BOTTOM:
            default:
                return [x, y, Gtk.PositionType.BOTTOM];
        }
    }

    // Same sequence as the panel: press is forwarded on press, release on
    // the real release. Apps open their menus on release, and they can only
    // grab the pointer once the button is up and our popup's grab is gone -
    // so the popup closes on release, right before the release is forwarded.
    _onPress(actor, event) {
        this._tooltip.hide();

        let button = event.get_button();
        let [x, y, o] = this._positionInfo();
        this._pressedButton = button;

        try {
            this.proxy.call_button_press(x, y, button, event.get_time(), o, null, null);
        } catch (e) {
            global.logError("Tray Overflow: press forwarding failed: " + e);
        }

        return Clutter.EVENT_STOP;
    }

    _onRelease(actor, event) {
        let button = event.get_button();
        if (button !== this._pressedButton) return Clutter.EVENT_STOP;
        this._pressedButton = 0;

        let [x, y, o] = this._positionInfo();
        let proxy = this.proxy;

        // Keep the popup visible, but give up its pointer grab so the app
        // can open its menu on top of it.
        this.applet.handOff(proxy);
        global.stage.set_key_focus(null);

        Mainloop.timeout_add(50, () => {
            try {
                proxy.call_button_release(x, y, button, Clutter.CURRENT_TIME, o, null, null);
            } catch (e) {
                global.logError("Tray Overflow: release forwarding failed: " + e);
            }
            return GLib.SOURCE_REMOVE;
        });

        return Clutter.EVENT_STOP;
    }

    _onScroll(actor, event) {
        let direction = event.get_scroll_direction();
        let map = {};
        map[Clutter.ScrollDirection.UP] = [XApp.ScrollDirection.UP, -1];
        map[Clutter.ScrollDirection.DOWN] = [XApp.ScrollDirection.DOWN, 1];
        map[Clutter.ScrollDirection.LEFT] = [XApp.ScrollDirection.LEFT, -1];
        map[Clutter.ScrollDirection.RIGHT] = [XApp.ScrollDirection.RIGHT, 1];

        if (map[direction]) {
            let [dir, delta] = map[direction];
            try {
                this.proxy.call_scroll(delta, dir, event.get_time(), null, null);
            } catch (e) { /* ignore */ }
        }
        return Clutter.EVENT_STOP;
    }

    destroy() {
        if (this._propsId) {
            this.proxy.disconnect(this._propsId);
            this._propsId = 0;
        }
        this._tooltip.destroy();
        this.actor.destroy();
    }
}

class TrayOverflowApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.uuid = metadata.uuid;
        this.orientation = orientation;
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.settings = new Settings.AppletSettings(this, this.uuid, instanceId);
        this.settings.bind("hide-new-icons", "hideNewIcons", () => this._onHideNewChanged());
        this.settings.bind("columns", "columns", () => this._layoutGrid());
        this.settings.bind("overflow-icon-size", "overflowIconSize", () => this._refreshOverflowIcons());
        this.settings.bind("attention-delay-in", "attentionDelayIn", null);
        this.settings.bind("attention-delay-out", "attentionDelayOut", null);

        this._popped = new Set();       // hidden apps currently moved into the panel
        this._attnTimers = {};          // name -> pending move timer

        this.xappIcons = {};      // key -> { proxy, name, overflow: OverflowIcon|null }
        this.legacyIcons = [];    // [{ icon, role }]
        this.signals = new SignalManager.SignalManager(null);
        this.monitorSignals = new SignalManager.SignalManager(null);
        this._hookedMonitor = null;
        this._ownMonitor = null;
        this._noStockCount = 0;

        this._setButtonIcon();
        this._buildMenus();
    }

    /* ---------- settings helpers ---------- */

    _getList(key) {
        let v = this.settings.getValue(key);
        return Array.isArray(v) ? v.slice() : [];
    }

    // The user's choice (switch in the list).
    _isHidden(name) {
        // Relayed icons start without a name at login; keep them out of the
        // panel during that moment unless "(unnamed icon)" is set to Panel.
        if (name === "untitled") return !this._getList("shown-list").includes(name);
        return this._getList("hidden-list").includes(name);
    }

    // What actually happens right now: hidden, unless its icon changed.
    _isEffectivelyHidden(name) {
        return this._isHidden(name) && !this._popped.has(name);
    }

    _setHidden(name, hidden) {
        this._popped.delete(name);
        this._cancelAttnTimer(name);
        let hiddenList = this._getList("hidden-list").filter(n => n !== name);
        let shownList = this._getList("shown-list").filter(n => n !== name);

        if (hidden) hiddenList.push(name);
        else shownList.push(name);

        this.settings.setValue("hidden-list", hiddenList);
        this.settings.setValue("shown-list", shownList);

        this._applyRoles();
        this._syncOverflow();
        if (hidden) this._evaluateName(name);
    }

    on_show_all_clicked() {
        this._popped.clear();
        let shownList = this._getList("shown-list");
        for (let n of this._getList("hidden-list")) {
            if (!shownList.includes(n)) shownList.push(n);
        }
        this.settings.setValue("hidden-list", []);
        this.settings.setValue("shown-list", shownList);
        this._applyRoles();
        this._syncOverflow();
    }

    _onHideNewChanged() {
        if (!this.hideNewIcons) return;
        // Apply the rule to icons that are already there but undecided.
        let changed = false;
        let hiddenList = this._getList("hidden-list");
        let shownList = this._getList("shown-list");
        for (let entry of this._knownEntries()) {
            if (!hiddenList.includes(entry.name) && !shownList.includes(entry.name)) {
                hiddenList.push(entry.name);
                changed = true;
            }
        }
        if (changed) {
            this.settings.setValue("hidden-list", hiddenList);
            this._applyRoles();
            this._syncOverflow();
        }
    }

    _maybeAutoHide(name) {
        if (!this.hideNewIcons || !name) return;
        let hiddenList = this._getList("hidden-list");
        if (hiddenList.includes(name) || this._getList("shown-list").includes(name)) return;
        hiddenList.push(name);
        this.settings.setValue("hidden-list", hiddenList);
        // Deferred: we may be inside the tray's own redisplay loop right now.
        this._scheduleApply();
    }

    _scheduleApply() {
        if (this._applyId) return;
        this._applyId = Mainloop.idle_add(() => {
            this._applyId = 0;
            this._applyRoles();
            this._syncOverflow();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ---------- tell the stock tray applets what to hide ---------- */

    _applyRoles() {
        let mgr = Main.systrayManager;
        let set = new Set();

        // Saved ids that are plain names hide the icon even before we see it.
        for (let n of this._getList("hidden-list")) {
            if (!this._popped.has(n) && !n.startsWith("app:") && !isUnstableId(n)) set.add(n.toLowerCase());
        }
        // Running icons: hide by whatever name they have right now.
        for (let key in this.xappIcons) {
            let e = this.xappIcons[key];
            // Nameless icons can only be hidden via the empty name "" (which
            // hides every nameless icon - they're rare).
            let hideable = e.role || e.name.startsWith("untitled");
            if (hideable && this._isEffectivelyHidden(e.name)) set.add(e.role);
        }
        let names = Array.from(set).sort();

        let sig = names.join("\n");
        if (sig === this._appliedRoles) return;
        this._appliedRoles = sig;

        if (Array.isArray(mgr._roles)) {
            // Batch update -> a single "changed" signal (less flicker).
            for (let i = mgr._roles.length - 1; i >= 0; i--) {
                if (mgr._roles[i].uuid === this.uuid) mgr._roles.splice(i, 1);
            }
            for (let n of names) {
                mgr._roles.push({ role: n.toLowerCase(), uuid: this.uuid });
            }
            mgr.emit("changed");
        } else {
            mgr.unregisterTrayIconReplacement(this.uuid);
            for (let n of names) mgr.registerTrayIconReplacement(n, this.uuid);
        }
    }

    _ownedByOtherApplet(name) {
        try {
            return Main.systrayManager._roles.some(r => r.role === name && r.uuid !== this.uuid);
        } catch (e) {
            return false;
        }
    }

    /* ---------- lifecycle ---------- */

    on_applet_added_to_panel() {
        // Legacy (XEmbed) icons: we only need to know their names.
        try {
            let d = Main.statusIconDispatcher;
            this.signals.connect(d, "status-icon-added", (o, icon, role) => {
                this.legacyIcons.push({ icon: icon, role: (role || "").toLowerCase() });
                global.log("Tray Overflow: found legacy tray icon role=\"" + role + "\"");
                this._maybeAutoHide((role || "").toLowerCase());
            }, this);
            this.signals.connect(d, "status-icon-removed", (o, icon) => {
                this.legacyIcons = this.legacyIcons.filter(e => e.icon !== icon);
            }, this);
            this.signals.connect(d, "before-redisplay", () => {
                this.legacyIcons = [];
            }, this);
        } catch (e) {
            global.logError("Tray Overflow: legacy tray not available: " + e);
        }

        this._hookMonitor();
        // The stock applet may load after us, or get reloaded later.
        this._pollId = Mainloop.timeout_add_seconds(3, () => {
            try {
                this._hookMonitor();
                this._reconcile();
            } catch (e) {
                global.logError("Tray Overflow: poll failed: " + e);
            }
            return GLib.SOURCE_CONTINUE;
        });

        this.signals.connect(Gtk.IconTheme.get_default(), "changed", this._refreshOverflowIcons, this);

        // Registers our roles; this also makes the systray re-announce its
        // legacy icons, so we learn their names.
        this._applyRoles();
        this._syncOverflow();
    }

    on_applet_removed_from_panel() {
        this._removed = true;
        if (this._resolveId) {
            Mainloop.source_remove(this._resolveId);
            this._resolveId = 0;
        }
        this._endHandOff();
        if (this._layoutId) {
            Mainloop.source_remove(this._layoutId);
            this._layoutId = 0;
        }
        for (let n in this._attnTimers) this._cancelAttnTimer(n);
        this._resetXappIcons();
        if (this._applyId) {
            Mainloop.source_remove(this._applyId);
            this._applyId = 0;
        }
        this.signals.disconnectAllSignals();
        this._appliedRoles = null;
        try {
            Main.systrayManager.unregisterTrayIconReplacement(this.uuid);
        } catch (e) {
            global.logError(e);
        }
        for (let key in this.xappIcons) {
            if (this.xappIcons[key].overflow) this.xappIcons[key].overflow.destroy();
        }
        this.xappIcons = {};
        this.legacyIcons = [];
        if (this._pollId) {
            Mainloop.source_remove(this._pollId);
            this._pollId = 0;
        }
        this.monitorSignals.disconnectAllSignals();
        this._hookedMonitor = null;
        this._ownMonitor = null;
        if (this.settings && this.settings.finalize) this.settings.finalize();
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        this._setButtonIcon();
        if (this.menu && this.menu.setOrientation) this.menu.setOrientation(orientation);
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    closeOverflow() {
        this._endHandOff();
        this.menu.close(false);
    }

    /* ---------- popup stays open while the app's menu is shown ----------
     * Our popup is modal (holds the pointer). An app can only show its menu
     * once we let go, so on click we drop the grab but keep the popup
     * visible, then watch the app's menu:
     *  - no menu within 700 ms      -> it was an "open app" click: close
     *  - menu closed, pointer still over the popup and no new window
     *    focused (Esc, or clicked back into the popup)  -> grab again, stay
     *  - menu closed otherwise (item chosen, clicked elsewhere) -> close
     */
    handOff(proxy) {
        this._endHandOff();

        let mgr = this.menuManager;
        if (!this.menu.isOpen || typeof mgr._ungrab !== "function" || typeof mgr._grab !== "function") {
            this.closeOverflow();
            return;
        }

        try {
            mgr._ungrab();
        } catch (e) {
            global.logError("Tray Overflow: could not release grab: " + e);
            this.closeOverflow();
            return;
        }

        let h = {
            proxy: proxy,
            menuSeen: false,
            focusAtMenu: null,
            menuWindows: new Set(),
            sigs: new SignalManager.SignalManager(null),
            noMenuTimer: 0,
            doneTimer: 0,
            maxTimer: 0
        };
        this._handoff = h;

        const MENU_TYPES = [Meta.WindowType.DROPDOWN_MENU, Meta.WindowType.POPUP_MENU, Meta.WindowType.MENU];

        let sawMenu = () => {
            if (!h.menuSeen) {
                h.menuSeen = true;
                h.focusAtMenu = global.display.focus_window;
            }
        };

        // Any app menu shows up as a popup/dropdown window ...
        h.sigs.connect(global.display, "window-created", (display, win) => {
            if (!MENU_TYPES.includes(win.get_window_type())) return;
            sawMenu();
            h.menuWindows.add(win);
            h.sigs.connect(win, "unmanaged", () => {
                h.menuWindows.delete(win);
                this._checkHandOffDone();
            });
        });

        // ... and XApp icons also report it as a property.
        h.sigs.connect(proxy, "g-properties-changed", () => {
            if (proxy.primary_menu_is_open || proxy.secondary_menu_is_open) sawMenu();
            this._checkHandOffDone();
        });

        h.sigs.connect(this.menu, "open-state-changed", (m, open) => {
            if (!open) this._endHandOff();
        });

        h.noMenuTimer = Mainloop.timeout_add(700, () => {
            h.noMenuTimer = 0;
            if (this._handoff === h && !h.menuSeen) this.closeOverflow();
            return GLib.SOURCE_REMOVE;
        });

        h.maxTimer = Mainloop.timeout_add_seconds(120, () => {
            h.maxTimer = 0;
            if (this._handoff === h) this.closeOverflow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _handOffMenuOpen(h) {
        let propOpen = false;
        try {
            propOpen = !!(h.proxy.primary_menu_is_open || h.proxy.secondary_menu_is_open);
        } catch (e) { /* proxy gone */ }
        return h.menuWindows.size > 0 || propOpen;
    }

    _checkHandOffDone() {
        let h = this._handoff;
        if (!h || !h.menuSeen || h.doneTimer) return;
        if (this._handOffMenuOpen(h)) return;

        // Small delay: the window and the property don't change in a fixed order.
        h.doneTimer = Mainloop.timeout_add(150, () => {
            h.doneTimer = 0;
            if (this._handoff !== h || this._handOffMenuOpen(h)) return GLib.SOURCE_REMOVE;

            let fw = global.display.focus_window;
            let focusChanged = fw && fw !== h.focusAtMenu;
            let [px, py] = global.get_pointer();
            let inside = this._pointerInsidePopup(px, py);

            this._endHandOff();
            if (focusChanged || !inside) {
                this.closeOverflow();
            } else {
                this._regrab();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _pointerInsidePopup(px, py) {
        let actor = this.menu.actor;
        if (!actor || !actor.visible) return false;
        let [ax, ay] = actor.get_transformed_position();
        let [aw, ah] = actor.get_transformed_size();
        return px >= ax && px <= ax + aw && py >= ay && py <= ay + ah;
    }

    _regrab() {
        let mgr = this.menuManager;
        if (!this.menu.isOpen) return;
        try {
            if (!mgr.grabbed) mgr._grab();
            if (mgr.grabbed) {
                this.menu.actor.grab_key_focus();
            } else {
                this.menu.close(false);
            }
        } catch (e) {
            global.logError("Tray Overflow: could not re-grab: " + e);
            this.menu.close(false);
        }
    }

    _endHandOff() {
        let h = this._handoff;
        if (!h) return;
        this._handoff = null;
        for (let t of ["noMenuTimer", "doneTimer", "maxTimer"]) {
            if (h[t]) {
                Mainloop.source_remove(h[t]);
                h[t] = 0;
            }
        }
        h.sigs.disconnectAllSignals();
        h.menuWindows.clear();
    }

    _setButtonIcon() {
        let icon = "pan-up-symbolic";
        switch (this.orientation) {
            case St.Side.TOP: icon = "pan-down-symbolic"; break;
            case St.Side.LEFT: icon = "pan-end-symbolic"; break;
            case St.Side.RIGHT: icon = "pan-start-symbolic"; break;
        }
        this.set_applet_icon_symbolic_name(icon);
    }

    /* ---------- finding the icons (without a second monitor) ---------- */

    _findStockApplet() {
        try {
            for (let a of AppletManager.getRunningInstancesForUuid(STOCK_UUID)) {
                if (a && a.monitor) return a;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    _hookMonitor() {
        let stock = this._findStockApplet();
        let monitor = null;

        if (stock) {
            this._noStockCount = 0;
            monitor = stock.monitor;
        } else {
            // Only start our own monitor if the stock tray really isn't there
            // (give it a few seconds at login).
            this._noStockCount++;
            if (this._noStockCount < 3 && !this._ownMonitor) return;
            if (!this._ownMonitor) {
                try {
                    this._ownMonitor = new XApp.StatusIconMonitor();
                    global.log("Tray Overflow: no XApp Status applet found, using own monitor");
                } catch (e) {
                    global.logError("Tray Overflow: could not start XApp.StatusIconMonitor: " + e);
                    return;
                }
            }
            monitor = this._ownMonitor;
        }

        if (monitor === this._hookedMonitor) return;

        // Switch to the new monitor (first hook, stock applet reloaded, ...)
        this.monitorSignals.disconnectAllSignals();
        if (monitor !== this._ownMonitor) this._ownMonitor = null;
        this._hookedMonitor = monitor;

        this.monitorSignals.connect(monitor, "icon-added", (m, p) => {
            try {
                this._onIconAdded(m, p);
            } catch (e) {
                global.logError("Tray Overflow: icon-added failed: " + e);
            }
        });
        this.monitorSignals.connect(monitor, "icon-removed", this._onIconRemoved, this);

        this._resetXappIcons();
        this._reconcile();
        global.log("Tray Overflow: watching " + Object.keys(this.xappIcons).length + " tray icons");
    }

    /* Safety net: Mint's tray only re-checks its icons when the hide list
     * changes, and it can miss some (e.g. nameless icons that were already
     * in the panel at login). Fix any icon that ended up in the wrong place
     * directly, using the stock applet's own methods. */
    _enforceStock(stock, monitor) {
        if (!stock || stock.monitor !== monitor) return;
        if (typeof stock.removeStatusIcon !== "function" ||
            typeof stock.ignoreStatusIcon !== "function" ||
            typeof stock.addStatusIcon !== "function") return;

        let roles = [];
        try { roles = Main.systrayManager.getRoles(); } catch (e) { return; }

        try {
            // Should be hidden, but is still in the panel.
            for (let k of Object.keys(stock.statusIcons || {})) {
                let p = stock.statusIcons[k] && stock.statusIcons[k].proxy;
                let e = p ? this.xappIcons[this._key(p)] : null;
                if (!e || this._ownedByOtherApplet(e.role)) continue;
                if (this._isEffectivelyHidden(e.name)) {
                    global.log("Tray Overflow: hiding " + e.name + " directly (stock tray missed it)");
                    stock.removeStatusIcon(p);
                    stock.ignoreStatusIcon(p);
                }
            }

            // Should be visible, but the stock tray still hides it - and
            // nobody (no other applet) asks for it to be hidden.
            for (let k of Object.keys(stock.ignoredProxies || {})) {
                let p = stock.ignoredProxies[k];
                let e = p ? this.xappIcons[this._key(p)] : null;
                if (!e || this._isEffectivelyHidden(e.name)) continue;
                if (roles.includes(e.role)) continue;
                global.log("Tray Overflow: restoring " + e.name + " directly (stock tray missed it)");
                delete stock.ignoredProxies[k];
                stock.addStatusIcon(p);
            }
        } catch (e) {
            global.logError("Tray Overflow: enforcing tray state failed: " + e);
        }
    }

    /* Compare our icon list with what actually exists and fix differences.
     * Runs on every poll, so an icon we missed (e.g. at login, while the
     * stock applet was still starting) is picked up within 3 seconds. */
    _reconcile() {
        let monitor = this._hookedMonitor;
        if (!monitor) return;

        let present = new Map();
        let complete = false;

        // 1. The monitor's own list - the authoritative one.
        try {
            let list = monitor.list_icons() || [];
            for (let p of list) {
                if (p) present.set(this._key(p), p);
            }
            complete = true;
        } catch (e) { /* older libxapp: fall back to the stock applet's lists */ }

        // 2. What the stock applet shows or hides (same objects, covers gaps).
        let stock = this._findStockApplet();
        if (stock && stock.monitor === monitor) {
            try {
                for (let k in stock.statusIcons) {
                    let p = stock.statusIcons[k] && stock.statusIcons[k].proxy;
                    if (p) present.set(this._key(p), p);
                }
                for (let k in stock.ignoredProxies) {
                    let p = stock.ignoredProxies[k];
                    if (p) present.set(this._key(p), p);
                }
            } catch (e) { /* ignore */ }
        }

        let changed = false;

        for (let [key, proxy] of present) {
            if (this.xappIcons[key]) continue;
            try {
                this._onIconAdded(monitor, proxy);
            } catch (e) {
                global.logError("Tray Overflow: failed to add icon " + key + ": " + e);
            }
            changed = true;
        }

        // Only drop icons when we have a complete list to compare against.
        if (complete && present.size > 0) {
            for (let key of Object.keys(this.xappIcons)) {
                if (present.has(key)) continue;
                try {
                    this._onIconRemoved(monitor, this.xappIcons[key].proxy);
                } catch (e) {
                    global.logError("Tray Overflow: failed to remove icon " + key + ": " + e);
                }
                changed = true;
            }
        }

        this._enforceStock(stock, monitor);

        if (!this._purged && present.size > 0) {
            this._purged = true;
            this._purgeStaleIds();
        }

        if (changed) this._syncOverflow();
    }

    _disconnectEntry(entry) {
        if (entry.propsId) {
            try { entry.proxy.disconnect(entry.propsId); } catch (e) { /* ignore */ }
            entry.propsId = 0;
        }
    }

    _resetXappIcons() {
        for (let key in this.xappIcons) {
            this._disconnectEntry(this.xappIcons[key]);
            let ov = this.xappIcons[key].overflow;
            if (ov) {
                if (ov.actor.get_parent()) this.grid.remove_child(ov.actor);
                ov.destroy();
            }
        }
        this.xappIcons = {};
    }

    /* ---------- "show in panel when its icon changes" ---------- */

    _getRules() {
        let r = this.settings.getValue("attention-rules");
        return (r && typeof r === "object" && !Array.isArray(r)) ? JSON.parse(JSON.stringify(r)) : {};
    }

    _getRule(name) {
        let r = this._getRules()[name];
        return (r && r.enabled) ? r : null;
    }

    _saveRule(name, rule) {
        let rules = this._getRules();
        if (rule) rules[name] = rule;
        else delete rules[name];
        this.settings.setValue("attention-rules", rules);
    }

    _currentSig(name) {
        for (let key in this.xappIcons) {
            let e = this.xappIcons[key];
            if (e.name === name) {
                e.lastSig = iconSignature(e.proxy) || e.lastSig;
                if (e.lastSig) return e.lastSig;
            }
        }
        return null;
    }

    _freshRule(name) {
        let rule = { enabled: true, normal: [], ignore: [] };
        let preset = PRESETS.find(p => p.match(name));
        if (preset) {
            rule.normal = preset.normal.slice();
            rule.ignore = preset.ignore.slice();
        } else {
            // Whatever it looks like right now counts as "normal".
            let sig = this._currentSig(name);
            if (sig) rule.normal.push(sig);
        }
        return rule;
    }

    _setRuleEnabled(name, enabled) {
        if (enabled) {
            this._saveRule(name, this._freshRule(name));
        } else {
            this._saveRule(name, null);
            this._cancelAttnTimer(name);
            if (this._popped.delete(name)) {
                this._applyRoles();
                this._syncOverflow();
            }
        }
        this._evaluateName(name);
    }

    _markCurrent(name, kind) { // kind: "normal" | "ignore"
        let rule = this._getRule(name);
        let sig = this._currentSig(name);
        if (!rule || !sig) return;
        rule.normal = rule.normal.filter(s => s !== sig);
        rule.ignore = rule.ignore.filter(s => s !== sig);
        rule[kind].push(sig);
        this._saveRule(name, rule);

        if (kind === "normal") {
            this._cancelAttnTimer(name);
            this._setPopped(name, false);
        }
    }

    _relearn(name) {
        this._cancelAttnTimer(name);
        this._setPopped(name, false);
        this._saveRule(name, this._freshRule(name));
    }

    _evaluateName(name) {
        for (let key in this.xappIcons) {
            if (this.xappIcons[key].name === name) this._evaluateAttention(this.xappIcons[key]);
        }
    }

    _evaluateAttention(entry) {
        let name = entry.name;
        if (!name) return;

        let rule = this._getRule(name);
        if (!rule || !this._isHidden(name)) return;

        let visible = true;
        try { visible = !!entry.proxy.visible; } catch (e) { /* ignore */ }

        let sig = iconSignature(entry.proxy);
        if (!sig) return;
        entry.lastSig = sig;

        // Never seen a normal look yet (rule enabled while the app was
        // closed): learn the first one.
        if (rule.normal.length === 0 && !rule.ignore.includes(sig)) {
            rule.normal.push(sig);
            this._saveRule(name, rule);
        }

        let want;
        if (!visible || rule.normal.includes(sig)) {
            want = false;
        } else if (rule.ignore.includes(sig)) {
            this._cancelAttnTimer(name);   // in-between state: keep as is
            return;
        } else {
            want = true;
        }

        if (want === this._popped.has(name)) {
            this._cancelAttnTimer(name);
            return;
        }

        this._cancelAttnTimer(name);
        let delay = Math.max(0, (want ? this.attentionDelayIn : this.attentionDelayOut) || 0) * 1000;
        this._attnTimers[name] = Mainloop.timeout_add(Math.max(1, delay), () => {
            delete this._attnTimers[name];
            // Still the same look after the delay?
            if (entry.lastSig === sig && this.xappIcons[this._key(entry.proxy)] === entry) {
                this._setPopped(name, want);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelAttnTimer(name) {
        if (this._attnTimers[name]) {
            Mainloop.source_remove(this._attnTimers[name]);
            delete this._attnTimers[name];
        }
    }

    _setPopped(name, popped) {
        if (popped === this._popped.has(name)) return;
        if (popped) this._popped.add(name);
        else this._popped.delete(name);
        global.log("Tray Overflow: " + name + (popped ? " -> panel (icon changed)" : " -> overflow (icon back to normal)"));
        this._applyRoles();
        this._syncOverflow();
    }

    /* ---------- XApp icons ---------- */

    _key(proxy) {
        return proxy.get_name() + proxy.get_object_path();
    }

    _onIconAdded(monitor, proxy) {
        let key = this._key(proxy);
        if (this.xappIcons[key]) return;

        // role: what the stock tray matches on (changes for some apps)
        // name: our stable id, used for every saved setting
        let role = (proxy.name || "").toLowerCase();
        let name = stableId(proxy.name);
        if (!name) {
            // Some apps register their tray icon without any name. Mint's tray
            // can only treat all of those alike, so they share one entry
            // (labelled with the tooltip in the list).
            name = "untitled";
        }
        global.log("Tray Overflow: found tray icon name=\"" + (proxy.name || "") + "\" id=\"" + name +
                   "\" tooltip=\"" + plainText(proxy.tooltip_text) + "\"");
        let entry = { proxy: proxy, name: name, role: role, overflow: null, lastSig: null, propsId: 0,
                      progId: isProgramId(name) ? name : null, resolveTried: false };
        this.xappIcons[key] = entry;
        if (name !== role) this._migrateId(role, name);
        if (name.startsWith("flatpak:")) this._inheritShared(name, proxy);

        entry.propsId = proxy.connect("g-properties-changed", (p, changed) => {
            let props = {};
            try { props = changed.deep_unpack(); } catch (e) { /* ignore */ }
            if ("Name" in props) this._onNameChanged(entry);
            if ("IconName" in props || "Visible" in props) this._evaluateAttention(entry);
        });

        this._maybeAutoHide(name);
        this._applyRoles();
        this._evaluateAttention(entry);
        this._syncOverflow();
        this._refreshOpenLists();
        if (entry.progId) this._adoptId(entry, entry.progId);   // merge old duplicates
        else this._scheduleResolve();
    }

    /* ---------- identify relayed tray icons by their program ---------- */

    _scheduleResolve() {
        if (this._resolveId) return;
        this._resolveId = Mainloop.timeout_add(400, () => {
            this._resolveId = 0;
            this._resolvePrograms().catch(e => global.logError("Tray Overflow: resolve failed: " + e));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _resolvePrograms() {
        let pending = Object.values(this.xappIcons).filter(e => !e.progId && !e.resolveTried);
        if (pending.length === 0) return;

        let map = await buildTrayProgramMap();
        if (!map || this._removed) return;

        for (let e of pending) {
            if (this.xappIcons[this._key(e.proxy)] !== e) continue;   // gone meanwhile
            let prog = map.get(sortableName(e.proxy.name || ""));
            if (prog) {
                this._adoptId(e, prog);
            } else {
                e.resolveTried = true;   // native XApp icon (e.g. Mint Update): its name is stable
            }
        }
    }

    /* Switch an icon to its program id and fold every older entry of the
     * same app (earlier names, duplicates from older versions) into it. */
    _adoptId(entry, newId) {
        entry.progId = newId;
        if (entry.name === newId && !this._needsMerge(entry, newId)) return;

        let oldId = entry.name;
        let labels = new Set([prettyName(newId), prettyName(entry.role), entry.role, prettyName(oldId)]);
        let inUse = new Set(Object.values(this.xappIcons).filter(e => e !== entry).map(e => e.name));
        let known = new Set([].concat(this._getList("hidden-list"), this._getList("shown-list"),
                                      Object.keys(this._getRules())));
        let candidates = [oldId].concat(Array.from(known).filter(id =>
            id !== oldId && id !== newId && !inUse.has(id) && labels.has(prettyName(id))));
        candidates = candidates.filter(id => id !== newId && !inUse.has(id) && id !== "untitled");

        // The entry you currently see (and switch) in the list wins; other
        // leftovers only fill in what's missing.
        if (oldId !== newId && this._hasSettings(oldId)) this._mergeInto(oldId, newId);
        for (let id of candidates) {
            if (id !== oldId && this._hasSettings(id)) this._mergeInto(id, newId, true);
        }
        for (let id of candidates) this._forgetId(id);

        if (oldId !== newId) {
            this._cancelAttnTimer(oldId);
            this._popped.delete(oldId);
            entry.name = newId;
            global.log("Tray Overflow: " + entry.role + " is " + newId +
                       (candidates.length ? " (merged: " + candidates.join(", ") + ")" : ""));
        }
        this._refreshOpenLists();

        this._applyRoles();
        this._syncOverflow();
        this._evaluateAttention(entry);
    }

    // Copy settings of one id onto another. Without onlyMissing, panel/hidden
    // and the "icon changes" rule of `from` replace those of `to`.
    _mergeInto(from, to, onlyMissing) {
        let hidden = this._getList("hidden-list");
        let shown = this._getList("shown-list");
        let rules = this._getRules();

        let toHasState = hidden.includes(to) || shown.includes(to);
        if ((hidden.includes(from) || shown.includes(from)) && !(onlyMissing && toHasState)) {
            let target = hidden.includes(from) ? "hidden" : "shown";
            hidden = hidden.filter(n => n !== to);
            shown = shown.filter(n => n !== to);
            (target === "hidden" ? hidden : shown).push(to);
            this.settings.setValue("hidden-list", hidden);
            this.settings.setValue("shown-list", shown);
        }
        if (rules[from] && !(onlyMissing && rules[to])) {
            rules[to] = JSON.parse(JSON.stringify(rules[from]));
            this.settings.setValue("attention-rules", rules);
        }
    }

    _needsMerge(entry, id) {
        let label = prettyName(id);
        let inUse = new Set(Object.values(this.xappIcons).filter(e => e !== entry).map(e => e.name));
        let known = [].concat(this._getList("hidden-list"), this._getList("shown-list"), Object.keys(this._getRules()));
        return known.some(k => k !== id && !inUse.has(k) && (prettyName(k) === label || k === entry.role));
    }

    /* Some apps (e.g. LastWave) create their tray icon first and set its
     * name a moment later. Follow the change so the icon ends up under its
     * real name, with the settings it had under the old one. */
    _onNameChanged(entry) {
        let role = (entry.proxy.name || "").toLowerCase();
        if (role === entry.role) return;

        if (entry.progId) {
            // Identified by its program: only the name the stock tray uses
            // changes. Old entries saved under this new name are merged.
            entry.role = role;
            this._adoptId(entry, entry.progId);
            this._applyRoles();
            this._syncOverflow();
            return;
        }

        let oldId = entry.name;
        let id = stableId(entry.proxy.name) || "untitled";
        global.log("Tray Overflow: icon renamed \"" + entry.role + "\" -> \"" + role + "\" (id " + id + ")");
        entry.role = role;

        if (id !== oldId) {
            this._cancelAttnTimer(oldId);
            this._popped.delete(oldId);
            entry.name = id;

            // Name was a connection id -> we now know the program. Keep that
            // id through any later renames (tray id, title ...).
            if (isProgramId(id)) {
                entry.progId = null;
                this._adoptId(entry, id);   // sets progId and merges old duplicates
            }

            // "untitled" is the shared start-up state of every relayed icon,
            // not a real app: never move or delete its setting.
            if (oldId !== "untitled") {
                if (!this._hasSettings(id)) this._copySettings(oldId, id);
                if (!Object.values(this.xappIcons).some(e => e !== entry && e.name === oldId)) {
                    this._forgetId(oldId);
                }
            }
        }

        this._applyRoles();
        this._syncOverflow();
        this._evaluateAttention(entry);
        this._refreshOpenLists();
        if (!entry.progId) {
            entry.resolveTried = false;
            this._scheduleResolve();
        }
    }

    _forgetId(id) {
        for (let key of ["hidden-list", "shown-list"]) {
            let list = this._getList(key);
            if (list.includes(id)) this.settings.setValue(key, list.filter(n => n !== id));
        }
        let rules = this._getRules();
        if (rules[id]) {
            delete rules[id];
            this.settings.setValue("attention-rules", rules);
        }
        this._cancelAttnTimer(id);
        this._popped.delete(id);
    }

    _hasSettings(id) {
        return this._getList("hidden-list").includes(id) ||
               this._getList("shown-list").includes(id) ||
               !!this._getRules()[id];
    }

    _copySettings(fromId, toId) {
        for (let key of ["hidden-list", "shown-list"]) {
            let list = this._getList(key);
            if (list.includes(fromId) && !list.includes(toId)) {
                list.push(toId);
                this.settings.setValue(key, list);
            }
        }
        let rules = this._getRules();
        if (rules[fromId] && !rules[toId]) {
            rules[toId] = JSON.parse(JSON.stringify(rules[fromId]));
            this.settings.setValue("attention-rules", rules);
        }
    }

    // Settings saved under an old temporary name -> move to the stable id.
    _migrateId(oldId, newId) {
        for (let key of ["hidden-list", "shown-list"]) {
            let list = this._getList(key);
            if (list.includes(oldId)) {
                list = list.filter(n => n !== oldId && n !== newId);
                list.push(newId);
                this.settings.setValue(key, list);
            }
        }
        let rules = this._getRules();
        if (rules[oldId]) {
            if (!rules[newId]) rules[newId] = rules[oldId];
            delete rules[oldId];
            this.settings.setValue("attention-rules", rules);
        }
    }

    // A Flatpak app seen for the first time with its own id takes over the
    // settings of the old shared "xdg-dbus-proxy" entry. The "icon changes"
    // rule only goes to the app whose current look it learned (Vesktop).
    _inheritShared(id, proxy) {
        let hidden = this._getList("hidden-list");
        let shown = this._getList("shown-list");
        let rules = this._getRules();
        if (hidden.includes(id) || shown.includes(id) || rules[id]) return;

        let old = SHARED_IDS.find(o => hidden.includes(o) || shown.includes(o) || rules[o]);
        if (!old) return;

        if (hidden.includes(old)) {
            hidden.push(id);
            this.settings.setValue("hidden-list", hidden);
        } else if (shown.includes(old)) {
            shown.push(id);
            this.settings.setValue("shown-list", shown);
        }

        let rule = rules[old];
        if (rule && rule.enabled) {
            let sig = iconSignature(proxy);
            if (sig && rule.normal.includes(sig)) {
                rules[id] = JSON.parse(JSON.stringify(rule));
                delete rules[old];
                this.settings.setValue("attention-rules", rules);
            }
        }
    }

    // Temporary names that belong to no running app can never match again.
    _purgeStaleIds() {
        // Leftovers from 1.10: "app:cryptomator" next to "cryptomator".
        let known = new Set([].concat(this._getList("hidden-list"), this._getList("shown-list"),
                                      Object.keys(this._getRules())));
        let running = new Set(Object.values(this.xappIcons).map(e => e.name));
        for (let id of known) {
            let m = id.match(/^(app|flatpak):(.+)$/);
            if (!m || running.has(id)) continue;
            let plain = m[2];
            if (known.has(plain) || running.has(plain)) {
                if (!this._hasSettings(plain)) this._copySettings(id, plain);
                this._forgetId(id);
            }
        }

        let current = new Set(Object.values(this.xappIcons).map(e => e.role));
        for (let key of ["hidden-list", "shown-list"]) {
            let list = this._getList(key);
            let kept = list.filter(n => !isUnstableId(n) || current.has(n));
            if (kept.length !== list.length) this.settings.setValue(key, kept);
        }
        let rules = this._getRules();
        let changed = false;
        for (let n in rules) {
            if (isUnstableId(n) && !current.has(n)) {
                delete rules[n];
                changed = true;
            }
        }
        if (changed) this.settings.setValue("attention-rules", rules);
    }

    _onIconRemoved(monitor, proxy) {
        let key = this._key(proxy);
        let entry = this.xappIcons[key];
        if (!entry) return;

        if (entry.overflow) {
            if (entry.overflow.actor.get_parent()) this.grid.remove_child(entry.overflow.actor);
            entry.overflow.destroy();
        }
        this._disconnectEntry(entry);
        delete this.xappIcons[key];
        this._refreshOpenLists();

        // App quit: forget that it was moved into the panel.
        if (!Object.values(this.xappIcons).some(e => e.name === entry.name)) {
            this._cancelAttnTimer(entry.name);
            if (this._popped.delete(entry.name)) this._applyRoles();
        }
        this._syncOverflow();
    }

    _syncOverflow() {
        for (let key in this.xappIcons) {
            let entry = this.xappIcons[key];
            let want = entry.name && this._isEffectivelyHidden(entry.name) && !this._ownedByOtherApplet(entry.role);

            if (want && !entry.overflow) {
                entry.overflow = new OverflowIcon(this, entry.proxy);
                // An app hiding/showing its icon changes the grid: re-pack it
                // so no empty slot is left behind.
                entry.overflow.actor.connect("notify::visible", () => this._layoutGridLater());
            } else if (!want && entry.overflow) {
                if (entry.overflow.actor.get_parent()) this.grid.remove_child(entry.overflow.actor);
                entry.overflow.destroy();
                entry.overflow = null;
            }
        }
        this._layoutGrid();
    }

    _refreshOverflowIcons() {
        for (let key in this.xappIcons) {
            if (this.xappIcons[key].overflow) this.xappIcons[key].overflow.refresh();
        }
    }

    _overflowIcons() {
        let list = [];
        for (let key in this.xappIcons) {
            if (this.xappIcons[key].overflow) list.push(this.xappIcons[key].overflow);
        }
        list.sort((a, b) => GLib.utf8_collate(a.sortName, b.sortName));
        return list;
    }

    _layoutGrid() {
        if (!this.grid) return;

        for (let child of this.grid.get_children()) {
            this.grid.remove_child(child);
        }

        let cols = Math.max(1, this.columns || 5);
        let i = 0;
        for (let icon of this._overflowIcons().filter(ic => ic.isVisible)) {
            this.gridLayout.attach(icon.actor, i % cols, Math.floor(i / cols), 1, 1);
            i++;
        }
        this._updateEmptyState();
    }

    _layoutGridLater() {
        if (this._layoutId) return;
        this._layoutId = Mainloop.idle_add(() => {
            this._layoutId = 0;
            this._layoutGrid();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateEmptyState() {
        let visibleCount = this._overflowIcons().filter(i => i.isVisible).length;
        let legacyHidden = this._knownEntries().filter(e => e.kind === "legacy" && this._isEffectivelyHidden(e.name) && e.running).length;

        this.gridItem.actor.visible = visibleCount > 0;
        this.emptyItem.actor.visible = visibleCount === 0;

        let tip = visibleCount === 1 ? "1 hidden icon" : visibleCount + " hidden icons";
        if (legacyHidden > 0) tip += " (+" + legacyHidden + " legacy hidden completely)";
        this.set_applet_tooltip(tip);
    }

    /* ---------- menus ---------- */

    _buildMenus() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        // Icon grid
        this.gridLayout = new Clutter.GridLayout({ column_spacing: 2, row_spacing: 2 });
        this.grid = new St.Widget({ layout_manager: this.gridLayout });
        this.gridItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false, hover: false });
        this.gridItem.addActor(this.grid, { span: -1, expand: true });
        this.menu.addMenuItem(this.gridItem);

        this.emptyItem = new PopupMenu.PopupMenuItem("No hidden icons", { reactive: false });
        this.menu.addMenuItem(this.emptyItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // "Which icons appear in the panel" - in the popup ...
        this.manageItem = new PopupMenu.PopupSubMenuMenuItem("Icons shown in the panel");
        this.menu.addMenuItem(this.manageItem);
        this.menu.connect("open-state-changed", (m, open) => {
            if (open) {
                this._fillManageMenu(this.manageItem.menu);
                this._updateEmptyState();
            }
        });

        // ... and in the right-click menu.
        this.ctxManageItem = new PopupMenu.PopupSubMenuMenuItem("Icons shown in the panel");
        this._applet_context_menu.addMenuItem(this.ctxManageItem, 0);
        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(), 1);
        this._applet_context_menu.connect("open-state-changed", (m, open) => {
            if (open) this._fillManageMenu(this.ctxManageItem.menu);
        });
    }

    _knownEntries() {
        let byName = {};

        for (let key in this.xappIcons) {
            let e = this.xappIcons[key];
            if (!e.name || this._ownedByOtherApplet(e.role)) continue;
            let tip = plainText(e.proxy.tooltip_text);
            let pretty = prettyName(e.name);
            let label = pretty;
            if (tip && tip.toLowerCase() !== pretty.toLowerCase()) label += " — " + tip;
            byName[e.name] = { name: e.name, label: truncate(label, 55), kind: "xapp", running: true };
        }

        for (let e of this.legacyIcons) {
            if (!e.role || byName[e.role] || this._ownedByOtherApplet(e.role)) continue;
            byName[e.role] = { name: e.role, label: e.role, kind: "legacy", running: true };
        }

        // Hidden apps that aren't running right now - keep them listed so
        // they can be un-hidden.
        for (let n of this._getList("hidden-list")) {
            if (!byName[n] && !isUnstableId(n) && !SHARED_IDS.includes(n) && n !== "untitled") byName[n] = { name: n, label: truncate(prettyName(n), 55), kind: "unknown", running: false };
        }

        return Object.values(byName).sort((a, b) => GLib.utf8_collate(a.label.toLowerCase(), b.label.toLowerCase()));
    }

    // Rebuild the icon list(s) if they are open right now.
    _refreshOpenLists() {
        for (let item of [this.manageItem, this.ctxManageItem]) {
            if (item && item.menu && item.menu.isOpen) this._refillLater(item.menu, null);
        }
    }

    _refillLater(subMenu, focusKey) {
        // Rebuild after the click has finished. The clicked item is about to
        // be destroyed; if it still had key focus, Cinnamon would treat that
        // as "focus left the menu" and close it - so park focus first.
        Mainloop.idle_add(() => {
            if (!subMenu.isOpen) return GLib.SOURCE_REMOVE;
            if (subMenu.sourceActor) subMenu.sourceActor.grab_key_focus();
            this._fillManageMenu(subMenu, focusKey);
            return GLib.SOURCE_REMOVE;
        });
    }

    _addAttentionItems(subMenu, e, mainItem, items) {
        let rule = this._getRule(e.name);
        let popped = this._popped.has(e.name);

        if (popped) mainItem.setStatus("icon changed");

        if (!e.running) {
            let forget = new ActionItem("      ↳ Forget this app (remove from the list)");
            forget.connect("activate", () => {
                this._forgetId(e.name);
                this._applyRoles();
                this._syncOverflow();
                this._refillLater(subMenu, null);
            });
            subMenu.addMenuItem(forget);
            items[e.name + "#forget"] = forget;
            if (!rule) return;      // keep the list short for apps that aren't running
        }

        let sw = new ToggleItem("      ↳ Show in panel when its icon changes", !!rule, "On", "Off");
        sw.connect("toggled", (it, state) => {
            this._setRuleEnabled(e.name, state);
            this._refillLater(subMenu, e.name + "#rule");
        });
        subMenu.addMenuItem(sw);
        items[e.name + "#rule"] = sw;

        if (!rule) return;

        let action = (text, key, fn) => {
            let it = new ActionItem("      ↳ " + text);
            it.connect("activate", () => {
                fn();
                this._refillLater(subMenu, e.name + "#rule");
            });
            subMenu.addMenuItem(it);
            items[e.name + key] = it;
        };

        if (popped) {
            action("This look is normal (hide it again)", "#normal", () => this._markCurrent(e.name, "normal"));
            action("Ignore this look (in-between state)", "#ignore", () => this._markCurrent(e.name, "ignore"));
        } else if (e.running) {
            action("Re-learn: current look is normal", "#relearn", () => this._relearn(e.name));
        }
    }

    _fillManageMenu(subMenu, focusKey) {
        subMenu.removeAll();
        let items = {};

        let entries = this._knownEntries();
        if (entries.length === 0) {
            subMenu.addMenuItem(new PopupMenu.PopupMenuItem("No tray icons found", { reactive: false }));
            return;
        }

        for (let e of entries) {
            let item = new ToggleItem(e.label, !this._isHidden(e.name), "Panel", "Hidden");
            let status = [];
            if (e.kind === "legacy") status.push("legacy: hides completely");
            if (!e.running) status.push("not running");
            if (status.length) item.setStatus(status.join(", "));

            item.connect("toggled", (it, state) => {
                this._setHidden(e.name, !state);
                this._refillLater(subMenu, e.name);
            });
            subMenu.addMenuItem(item);
            items[e.name] = item;

            if (e.kind !== "legacy" && this._isHidden(e.name)) {
                this._addAttentionItems(subMenu, e, item, items);
            }
        }

        subMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let showAll = new ActionItem("Show all in panel");
        showAll.connect("activate", () => {
            this.on_show_all_clicked();
            this._refillLater(subMenu, "#showall");
        });
        subMenu.addMenuItem(showAll);
        items["#showall"] = showAll;

        if (entries.some(e => !e.running)) {
            let forgetAll = new ActionItem("Forget all apps that aren't running");
            forgetAll.connect("activate", () => {
                for (let e of entries) {
                    if (!e.running) this._forgetId(e.name);
                }
                this._applyRoles();
                this._syncOverflow();
                this._refillLater(subMenu, "#showall");
            });
            subMenu.addMenuItem(forgetAll);
        }

        let hideAll = new ActionItem("Hide all in overflow");
        hideAll.connect("activate", () => {
            let hiddenList = this._getList("hidden-list");
            let shownList = this._getList("shown-list");
            for (let e of entries) {
                if (!hiddenList.includes(e.name)) hiddenList.push(e.name);
            }
            shownList = shownList.filter(n => !hiddenList.includes(n));
            this.settings.setValue("hidden-list", hiddenList);
            this.settings.setValue("shown-list", shownList);
            this._applyRoles();
            this._syncOverflow();
            this._refillLater(subMenu, "#hideall");
        });
        subMenu.addMenuItem(hideAll);
        items["#hideall"] = hideAll;

        if (focusKey && items[focusKey]) items[focusKey].actor.grab_key_focus();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new TrayOverflowApplet(metadata, orientation, panelHeight, instanceId);
}
