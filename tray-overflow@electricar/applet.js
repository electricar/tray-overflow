// SPDX-License-Identifier: GPL-2.0-or-later
// Tray Overflow - https://github.com/electricar/tray-overflow
// Copyright (C) 2026 electricar
//
// A system tray for Cinnamon with a Windows-style ^ overflow: every tray icon
// either sits in the panel or in a popup, chosen per app. It replaces the
// stock "XApp Status Applet". The panel part (icon display, click and scroll
// forwarding, recording indicator) is based on that applet
// (xapp-status@cinnamon.org from Linux Mint's Cinnamon, GPL-2.0-or-later).

const Applet = imports.ui.applet;
const AppletManager = imports.ui.appletManager;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Tooltips = imports.ui.tooltips;
const SignalManager = imports.misc.signalManager;
const Mainloop = imports.mainloop;
const Gettext = imports.gettext;
const Cinnamon = imports.gi.Cinnamon;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const XApp = imports.gi.XApp;
const Meta = imports.gi.Meta;

const UUID = "tray-overflow@electricar";
const STOCK_TRAY_UUID = "xapp-status@cinnamon.org";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(text) {
    return Gettext.dgettext(UUID, text);
}

function ngettext(singular, plural, n) {
    return Gettext.dngettext(UUID, singular, plural, n);
}

const HORIZONTAL_STYLE = "padding-left: 2px; padding-right: 2px; padding-top: 0; padding-bottom: 0";
const VERTICAL_STYLE = "padding-left: 0; padding-right: 0; padding-top: 2px; padding-bottom: 2px";

const XAPP_PREFIX = "org.x.statusicon.";

// Relayed tray icons start without a name; they share this id until we know
// which app they belong to.
const UNTITLED = "untitled";

// Icons for the panel button (first one the icon theme has is used).
const BUTTON_ICONS = {
    dots: ["view-more-symbolic", "view-more-horizontal-symbolic", "open-menu-symbolic"],
    grid: ["view-app-grid-symbolic", "view-grid-symbolic", "view-app-grid"]
};

// How long an icon may stay unidentified before it is shown under its name.
const SETTLE_TIMEOUT_MS = 3000;

// Programs that only run an app; the app itself is found in comm/cmdline.
const GENERIC_EXES = ["electron", "node", "python", "python3", "java", "bash", "sh", "env", "bwrap"];

// Built-in knowledge about Mint Update's tray icon states.
const PRESETS = [
    {
        match: id => id.startsWith("mintupdate"),
        normal: ["icon:mintupdate-up-to-date-symbolic"],
        ignore: ["icon:mintupdate-checking-symbolic", "icon:mintupdate-installing-symbolic"]
    }
];


/* ------------------------------------------------------------------------
 * Small helpers (all I/O is asynchronous)
 * ---------------------------------------------------------------------- */

function decode(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    return imports.byteArray.toString(bytes);
}

function readFile(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            try {
                let [ok, contents] = file.load_contents_finish(res);
                resolve(ok ? contents : null);
            } catch (e) {
                resolve(null);
            }
        });
    });
}

function readLink(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).query_info_async("standard::symlink-target",
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null, (file, res) => {
                try {
                    resolve(file.query_info_finish(res).get_symlink_target());
                } catch (e) {
                    resolve(null);
                }
            });
    });
}

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

function unpackVariant(v) {
    while (v instanceof GLib.Variant) v = v.deep_unpack();
    return v;
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

// Same normalisation Mint's tray service uses for icon names.
function sortableName(s) {
    return String(s).normalize("NFD").toLowerCase();
}

function isProgramId(id) {
    return id.startsWith("app:") || id.startsWith("flatpak:");
}

// Names that are only a temporary D-Bus connection, never stored.
function isUnstableName(name) {
    return name.startsWith(":") || /statusnotifieritem-\d+-\d+$/i.test(name);
}

function prettyName(id) {
    let n = id || "";
    if (n.startsWith("app:")) return n.substring(4);
    if (n.startsWith("flatpak:")) {
        let parts = n.substring(8).split(".");
        return parts[parts.length - 1];           // dev.vencord.vesktop -> vesktop
    }
    if (n === UNTITLED) return _("(unnamed icon)");
    if (n.toLowerCase().startsWith(XAPP_PREFIX)) return n.substring(XAPP_PREFIX.length);
    return n;
}

/* Display names ("OBS Studio" instead of "studio") from the app list Cinnamon
 * keeps in memory for its menu. Matched by Flatpak id, desktop file name,
 * program name or window class. */
const LAUNCHER_EXES = ["flatpak", "env", "sh", "bash", "python", "python3", "java", "electron", "snap", "gtk-launch"];

function stripExtension(name) {
    return name.replace(/\.(py|bin|sh|appimage|exe)$/i, "");
}

class AppNames {
    constructor() {
        this._index = null;
    }

    invalidate() {
        this._index = null;
    }

    _build() {
        let index = new Map();
        let add = (key, name) => {
            if (key && name && !index.has(key)) index.set(key, name);
        };

        let apps = [];
        try {
            apps = Cinnamon.AppSystem.get_default().get_all();
        } catch (e) { /* no app list: fall back to plain names */ }

        for (let app of apps) {
            let name = app.get_name();
            add("id:" + (app.get_id() || "").toLowerCase().replace(/\.desktop$/, ""), name);
            try {
                add("id:" + (app.get_flatpak_app_id() || "").toLowerCase(), name);
            } catch (e) { /* older Cinnamon */ }

            let info = app.get_app_info();
            if (!info) continue;
            try {
                let exe = info.get_executable();
                let base = exe ? GLib.path_get_basename(exe).toLowerCase() : "";
                if (base && !LAUNCHER_EXES.includes(base)) add("exe:" + stripExtension(base), name);
            } catch (e) { /* ignore */ }
            try {
                let wmClass = info.get_startup_wm_class();
                if (wmClass) add("exe:" + wmClass.toLowerCase(), name);
            } catch (e) { /* ignore */ }
        }
        this._index = index;
    }

    lookup(id) {
        if (!id || id === UNTITLED) return null;
        if (!this._index) this._build();

        if (id.startsWith("flatpak:")) return this._index.get("id:" + id.substring(8)) || null;
        let key = stripExtension(id.startsWith("app:") ? id.substring(4) : id.toLowerCase());
        return this._index.get("id:" + key) || this._index.get("exe:" + key) || null;
    }
}

/* What the icon currently looks like. Pixmap icons (Electron apps) arrive as
 * temp PNG files whose path changes on every update, so files are hashed. */
async function iconSignature(iconName) {
    if (!iconName) return null;
    if (!iconName.includes("/")) return "icon:" + iconName;

    let bytes = await readFile(iconName);
    if (!bytes || bytes.length === 0) return null;
    return "img:" + GLib.compute_checksum_for_data(GLib.ChecksumType.MD5, bytes);
}


/* ------------------------------------------------------------------------
 * Which program is behind a tray icon
 *
 * Mint's tray service (xapp-sn-watcher) relays most apps' tray icons and
 * names each one after the app's tray title, its tray id or its connection,
 * switching between them while the app runs. The program behind the icon
 * never changes, so settings are stored under it ("app:cryptomator",
 * "flatpak:dev.vencord.vesktop").
 * ---------------------------------------------------------------------- */

async function pidForBusName(busName) {
    let m = busName.match(/statusnotifieritem-(\d+)-\d+$/i);
    if (m) return parseInt(m[1]);

    let reply = await dbusCall("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "GetConnectionUnixProcessID", new GLib.Variant("(s)", [busName]), "(u)");
    return reply ? reply[0] : 0;
}

// Flatpak apps talk to D-Bus through a shared helper; the sandbox info names the app.
async function flatpakAppId(pid) {
    let info = await readFile("/proc/" + pid + "/root/.flatpak-info");
    if (info) {
        try {
            let kf = new GLib.KeyFile();
            kf.load_from_bytes(new GLib.Bytes(info), GLib.KeyFileFlags.NONE);
            let name = kf.get_string("Application", "name");
            if (name) return name;
        } catch (e) { /* not a Flatpak */ }
    }

    let cgroup = await readFile("/proc/" + pid + "/cgroup");
    if (cgroup) {
        let m = decode(cgroup).match(/app-flatpak-([A-Za-z0-9._-]+?)-\d+\.scope/);
        if (m) return m[1];
    }
    return null;
}

function isGenericExe(name) {
    return !name || GENERIC_EXES.includes(name.replace(/[0-9.]+$/, ""));
}

async function programName(pid) {
    let base = "";

    let exe = await readLink("/proc/" + pid + "/exe");
    if (exe) base = GLib.path_get_basename(exe).replace(/ \(deleted\)$/, "");

    if (isGenericExe(base)) {
        let comm = await readFile("/proc/" + pid + "/comm");
        let c = comm ? decode(comm).trim() : "";
        if (c) base = c;
    }

    // Still generic (e.g. "electron", "python3")? Use the app path it runs.
    if (isGenericExe(base)) {
        let cmdline = await readFile("/proc/" + pid + "/cmdline");
        let args = cmdline ? decode(cmdline).split("\0").slice(1).filter(a => a && !a.startsWith("-")) : [];
        if (args.length) {
            let parts = args[0].split("/").filter(x => x);
            let name = parts.pop() || "";
            if (["app", "app.asar", "resources", "main.js", "index.js", "main.py", "__main__.py"].includes(name)) {
                name = parts.filter(x => x !== "resources").pop() || name;
            }
            name = name.replace(/\.(asar|py|jar|js)$/, "");
            if (name) base = name;
        }
    }
    return base.toLowerCase();
}

async function programIdForPid(pid) {
    if (!pid) return "";
    let fp = await flatpakAppId(pid);
    if (fp) return "flatpak:" + fp.toLowerCase();
    let prog = await programName(pid);
    return prog ? "app:" + prog : "";
}

// Map of every name Mint's tray service may use for an icon -> program id.
async function buildTrayProgramMap() {
    let reply = await dbusCall("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
        "org.freedesktop.DBus.Properties", "Get",
        new GLib.Variant("(ss)", ["org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"]), "(v)");
    let map = new Map();
    if (!reply) return map;

    let items = unpackVariant(reply[0]) || [];
    await Promise.all(items.map(async item => {
        let i = item.indexOf("/");
        let bus = i >= 0 ? item.substring(0, i) : item;
        let path = i >= 0 ? item.substring(i) : "/StatusNotifierItem";

        let prog = await programIdForPid(await pidForBusName(bus));
        if (!prog) return;

        let names = [bus];
        for (let prop of ["Id", "Title"]) {
            let r = await dbusCall(bus, path, "org.freedesktop.DBus.Properties", "Get",
                new GLib.Variant("(ss)", ["org.kde.StatusNotifierItem", prop]), "(v)");
            let v = r ? unpackVariant(r[0]) : null;
            if (typeof v === "string" && v) names.push(v);
        }
        for (let n of names) {
            if (!map.has(sortableName(n))) map.set(sortableName(n), prog);
        }
    }));
    return map;
}


/* ------------------------------------------------------------------------
 * Menu items that don't depend on the theme's switch images (some themes
 * draw "on" and "off" alike) and keep the menu open when clicked.
 * ---------------------------------------------------------------------- */

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


/* ------------------------------------------------------------------------
 * Screen recording indicator (as in the stock tray applet)
 * ---------------------------------------------------------------------- */

class RecorderIcon {
    constructor(applet) {
        this.applet = applet;
        this.actor = new St.BoxLayout({
            style_class: "applet-box",
            reactive: false,
            visible: false,
            x_expand: true,
            y_expand: true
        });

        this.icon_holder = new St.Bin();
        this.iconSize = this.applet.getPanelIconSize(St.IconType.FULLCOLOR);
        this.actor.add_actor(this.icon_holder);

        this._indicator = new St.DrawingArea();
        this._indicator.connect("repaint", area => this._paint(area));
        this.icon_holder.add_actor(this._indicator);

        this._recordListenerId = Main.screenRecorder.connect("recording", () => this._recordingStateChanged());
        this._recordingStateChanged();

        this.refresh();
    }

    _recordingStateChanged() {
        this.actor.visible = Main.screenRecorder.recording;
        this._indicator.queue_repaint();
    }

    _paint(area) {
        let [width, height] = area.get_surface_size();
        let size = Math.max(width, height);
        let border = area.get_theme_node().get_foreground_color();
        let cr = area.get_context();

        Clutter.cairo_set_source_color(cr, new Clutter.Color({ red: 255, green: 0, blue: 0, alpha: 255 }));
        cr.arc(width / 2, height / 2, size / 4.0, 0.0, 2.0 * Math.PI);
        cr.fillPreserve();
        Clutter.cairo_set_source_color(cr, border);
        cr.stroke();
        cr.$dispose();
    }

    refresh() {
        let vertical = this.applet.orientation == St.Side.LEFT || this.applet.orientation == St.Side.RIGHT;
        this.actor.vertical = vertical;
        this.iconSize = this.applet.getPanelIconSize(St.IconType.FULLCOLOR);
        this._indicator.set_size(this.iconSize, this.iconSize);
        this._indicator.queue_repaint();
    }

    destroy() {
        if (this._recordListenerId > 0) {
            Main.screenRecorder.disconnect(this._recordListenerId);
            this._recordListenerId = 0;
        }
        this.actor.destroy();
    }
}


/* ------------------------------------------------------------------------
 * One tray icon. It lives either in the panel or in the overflow popup;
 * the applet moves its actor between the two.
 * ---------------------------------------------------------------------- */

class TrayIcon {
    constructor(applet, entry) {
        this.applet = applet;
        this.entry = entry;
        this.proxy = entry.proxy;
        this.inOverflow = false;
        this._timers = new Set();
        this._loaderHandle = null;

        this.actor = new St.BoxLayout({
            style_class: "applet-box",
            reactive: !global.settings.get_boolean("panel-edit-mode"),
            track_hover: true,
            // Fill the space, or the app's menu would be placed inside the panel.
            x_expand: true,
            y_expand: true
        });

        this.icon_holder = new St.Bin();
        this.label = new St.Label({ "y-align": St.Align.END });
        this.actor.add_actor(this.icon_holder);
        this.actor.add_actor(this.label);

        this._tooltip = new Tooltips.PanelItemTooltip(this, "", applet.orientation);

        this.actor.connect("button-press-event", (a, e) => this._onButtonPress(a, e));
        this.actor.connect("button-release-event", (a, e) => this._onButtonRelease(a, e));
        this.actor.connect("scroll-event", (a, e) => this._onScroll(a, e));
        this.actor.connect("enter-event", () => { this._tooltip.preventShow = false; });

        this._propsId = this.proxy.connect("g-properties-changed", (p, changed) => this._onPropertiesChanged(changed));

        this.refresh();
    }

    setOverflow(inOverflow) {
        if (this.inOverflow === inOverflow) return;
        this.inOverflow = inOverflow;
        this.refresh();
    }

    get isVisible() {
        return !!this.proxy.visible;
    }

    _onPropertiesChanged(changed) {
        let props = changed.deep_unpack();

        if ("IconName" in props) this._setIconName(this.proxy.icon_name);
        if ("TooltipText" in props) this._setTooltipText(this.proxy.tooltip_text);
        if ("Label" in props) this._setLabel(this.proxy.label);
        if ("Visible" in props) this.actor.visible = this.isVisible;
        if (("PrimaryMenuIsOpen" in props && !this.proxy.primary_menu_is_open) ||
            ("SecondaryMenuIsOpen" in props && !this.proxy.secondary_menu_is_open)) {
            this.actor.sync_hover();
        }
    }

    refresh() {
        let vertical = !this.inOverflow &&
            (this.applet.orientation == St.Side.LEFT || this.applet.orientation == St.Side.RIGHT);
        this.actor.vertical = vertical;
        if (vertical) this.actor.add_style_class_name("vertical");
        else this.actor.remove_style_class_name("vertical");

        // In the panel the icon fills its slot (the app's menu is placed by
        // it); in the popup grid it keeps its natural size.
        this.actor.x_expand = !this.inOverflow;
        this.actor.y_expand = !this.inOverflow;
        this.actor.set_style(this.inOverflow ? "padding: 4px;" : null);

        this._setIconName(this.proxy.icon_name);
        this._setLabel(this.proxy.label);
        this._setTooltipText(this.proxy.tooltip_text);
        this.actor.visible = this.isVisible;
        this.actor.queue_relayout();
    }

    _iconSize(type) {
        return this.inOverflow ? this.applet.overflowIconSize : this.applet.getPanelIconSize(type);
    }

    _setIconName(iconName) {
        if (!iconName) {
            this.icon_holder.hide();
            return;
        }

        let type = iconName.match(/symbolic/) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
        let size = this._iconSize(type);
        if (this.proxy.icon_size !== size) this.proxy.icon_size = size;

        // Symbolic icons are assumed to be square and suitable for an St.Icon.
        if (iconName.includes("/") && type != St.IconType.SYMBOLIC) {
            this._loaderHandle = St.TextureCache.get_default().load_image_from_file_async(
                iconName,
                // In a horizontal panel the image may be wider than tall.
                (this.actor.vertical || this.inOverflow) ? size : -1,
                size,
                (cache, handle, actor) => {
                    if (handle !== this._loaderHandle) return;   // a newer icon is on its way
                    this.icon_holder.child = actor;
                    this.icon_holder.show();
                });
            return;
        }

        this.icon_holder.child = new St.Icon({ icon_type: type, icon_size: size, icon_name: iconName });
        this.icon_holder.show();
    }

    _setTooltipText(text) {
        this._tooltip.preventShow = !text;
        this._tooltip.set_markup(text || "");
        if (this._tooltip.visible) {
            this._tooltip.hide();
            this._tooltip.show();
        }
    }

    _setLabel(text) {
        this.label.set_text(text || "");
        let horizontal = this.applet.orientation == St.Side.TOP || this.applet.orientation == St.Side.BOTTOM;
        this.label.visible = !this.inOverflow && horizontal && !!text;
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

    _onButtonPress(actor, event) {
        this._tooltip.hide();
        this._tooltip.preventShow = true;

        // Ctrl + right click opens the applet's own menu (as in the stock tray).
        if (event.get_button() == Clutter.BUTTON_SECONDARY && (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            return Clutter.EVENT_PROPAGATE;
        }

        let [x, y, o] = this._positionInfo();
        this.proxy.call_button_press(x, y, event.get_button(), event.get_time(), o, null, null);
        this._pressedButton = event.get_button();
        return Clutter.EVENT_STOP;
    }

    _onButtonRelease(actor, event) {
        let button = event.get_button();
        let [x, y, o] = this._positionInfo();

        if (!this.inOverflow) {
            this.proxy.call_button_release(x, y, button, event.get_time(), o, null, null);
            return Clutter.EVENT_STOP;
        }

        if (button !== this._pressedButton) return Clutter.EVENT_STOP;
        this._pressedButton = 0;

        // In the popup: give up the popup's pointer grab (it stays visible),
        // then forward the release so the app can open its menu on top.
        this.applet.handOff(this.proxy);
        global.stage.set_key_focus(null);

        let id = Mainloop.timeout_add(50, () => {
            this._timers.delete(id);
            this.proxy.call_button_release(x, y, button, Clutter.CURRENT_TIME, o, null, null);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return Clutter.EVENT_STOP;
    }

    _onScroll(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.SMOOTH) return Clutter.EVENT_STOP;

        let map = {};
        map[Clutter.ScrollDirection.UP] = [XApp.ScrollDirection.UP, -1];
        map[Clutter.ScrollDirection.DOWN] = [XApp.ScrollDirection.DOWN, 1];
        map[Clutter.ScrollDirection.LEFT] = [XApp.ScrollDirection.LEFT, -1];
        map[Clutter.ScrollDirection.RIGHT] = [XApp.ScrollDirection.RIGHT, 1];

        if (map[direction]) {
            let [dir, delta] = map[direction];
            this.proxy.call_scroll(delta, dir, event.get_time(), null, null);
        }
        return Clutter.EVENT_STOP;
    }

    destroy() {
        for (let id of this._timers) Mainloop.source_remove(id);
        this._timers.clear();
        if (this._propsId) {
            this.proxy.disconnect(this._propsId);
            this._propsId = 0;
        }
        this._tooltip.destroy();
        this.actor.destroy();
    }
}


/* ------------------------------------------------------------------------
 * The applet
 * ---------------------------------------------------------------------- */

class TrayOverflowApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.uuid = metadata.uuid;
        this.orientation = orientation;
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.actor.remove_style_class_name("applet-box");
        this.actor.set_important(true);

        this.settings = new Settings.AppletSettings(this, this.uuid, instanceId);
        this.settings.bind("hide-new-icons", "hideNewIcons", () => this._onHideNewChanged());
        this.settings.bind("attention-delay-in", "attentionDelayIn", null);
        this.settings.bind("attention-delay-out", "attentionDelayOut", null);
        this.settings.bind("columns", "columns", () => this._layoutGrid());
        this.settings.bind("overflow-icon-size", "overflowIconSize", () => this._refreshIcons());
        this.settings.bind("debug-log", "debugLog", null);
        this.settings.bind("button-icon", "buttonIcon", () => this._setChevronIcon());
        this.settings.bind("use-custom-icon", "useCustomIcon", () => this._setChevronIcon());
        this.settings.bind("button-custom-icon", "buttonCustomIcon", () => this._setChevronIcon());
        this.settings.bind("show-count", "showCount", () => this._layoutGrid());
        this.settings.bind("open-on-hover", "openOnHover", () => this._onOpenOnHoverChanged());
        this.settings.bind("hover-delay", "hoverDelay", null);
        this.settings.bind("close-delay", "closeDelay", null);
        this.settings.bind("show-list-in-popup", "showListInPopup", () => this._updatePopupList());

        this._appNames = new AppNames();
        this.entries = {};          // proxy key -> entry
        this._popped = new Set();   // hidden ids currently shown in the panel (icon changed)
        this._attnTimers = {};      // id -> pending move timer
        this._handoff = null;
        this._removed = false;

        this.signals = new SignalManager.SignalManager(null);

        // Panel: [^] [visible icons ...] [recording indicator]
        let vertical = orientation == St.Side.LEFT || orientation == St.Side.RIGHT;
        this.manager_container = new St.BoxLayout({ vertical: vertical, style: vertical ? VERTICAL_STYLE : HORIZONTAL_STYLE });
        this.actor.add_actor(this.manager_container);

        // The panel button: icon, plus optionally the number of hidden icons.
        this._chevronIcon = new St.Icon({ icon_type: St.IconType.SYMBOLIC });
        this._chevronCount = new St.Label({ style_class: "applet-label", y_align: Clutter.ActorAlign.CENTER, visible: false });
        this._chevron = new St.BoxLayout({ style_class: "applet-box", reactive: true, track_hover: true });
        this._chevron.add_actor(this._chevronIcon);
        this._chevron.add_actor(this._chevronCount);
        this._chevron.connect("enter-event", () => this._onChevronEnter());
        this._chevron.connect("leave-event", () => this._cancelHoverOpen());
        this._chevronTooltip = new Tooltips.Tooltip(this._chevron, "");
        this.manager_container.add_actor(this._chevron);
        this._setChevronIcon();

        this._recorder = Main.screenRecorder ? new RecorderIcon(this) : null;
        if (this._recorder) this.manager_container.add_actor(this._recorder.actor);

        this._buildMenus();

        this.monitor = new XApp.StatusIconMonitor();
        this.signals.connect(this.monitor, "icon-added", (m, proxy) => this._onIconAdded(proxy));
        this.signals.connect(this.monitor, "icon-removed", (m, proxy) => this._onIconRemoved(proxy));

        this.signals.connect(Gtk.IconTheme.get_default(), "changed", () => this._refreshIcons());
        this.signals.connect(global.settings, "changed::panel-edit-mode", () => this._onPanelEditModeChanged());
        // Icons other applets display themselves (e.g. the network applet's).
        this.signals.connect(Main.systrayManager, "changed", () => this._placeAll());
        // Listen to the panel directly: the applet holds symbolic and full-colour icons.
        this.signals.connect(this.panel, "icon-size-changed", () => this._refreshIcons());
        this.signals.connect(global, "scale-changed", () => this._onScaleChanged());
        try {
            this.signals.connect(Cinnamon.AppSystem.get_default(), "installed-changed", () => {
                this._appNames.invalidate();
                this._refreshOpenLists();
            });
        } catch (e) { /* ignore */ }
    }

    _displayName(id) {
        return this._appNames.lookup(id) || prettyName(id);
    }

    _log(msg) {
        if (this.debugLog) global.log("Tray Overflow: " + msg);
    }

    /* ---------- settings ---------- */

    _getList(key) {
        let v = this.settings.getValue(key);
        return Array.isArray(v) ? v.slice() : [];
    }

    _getRules() {
        let r = this.settings.getValue("attention-rules");
        return (r && typeof r === "object" && !Array.isArray(r)) ? JSON.parse(JSON.stringify(r)) : {};
    }

    _getRule(id) {
        let r = this._getRules()[id];
        return (r && r.enabled) ? r : null;
    }

    _saveRule(id, rule) {
        let rules = this._getRules();
        if (rule) rules[id] = rule;
        else delete rules[id];
        this.settings.setValue("attention-rules", rules);
    }

    // The user's choice. Unnamed icons (apps still starting) stay out of the
    // panel unless "(unnamed icon)" is set to Panel.
    _isHidden(id) {
        if (id === UNTITLED) return !this._getList("shown-list").includes(id);
        return this._getList("hidden-list").includes(id);
    }

    // What actually happens right now: hidden, unless its icon changed.
    _isEffectivelyHidden(id) {
        return this._isHidden(id) && !this._popped.has(id);
    }

    _hasSettings(id) {
        return this._getList("hidden-list").includes(id) ||
               this._getList("shown-list").includes(id) ||
               !!this._getRules()[id];
    }

    _setHidden(id, hidden) {
        this._popped.delete(id);
        this._cancelAttnTimer(id);

        let hiddenList = this._getList("hidden-list").filter(n => n !== id);
        let shownList = this._getList("shown-list").filter(n => n !== id);
        if (hidden) hiddenList.push(id);
        else shownList.push(id);
        this.settings.setValue("hidden-list", hiddenList);
        this.settings.setValue("shown-list", shownList);

        this._placeAll();
        if (hidden) this._evaluateId(id);
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

    // Copy settings of one id onto another. Without onlyMissing, panel/hidden
    // and the "icon changes" rule of `from` replace those of `to`.
    _mergeInto(from, to, onlyMissing) {
        let hidden = this._getList("hidden-list");
        let shown = this._getList("shown-list");
        let rules = this._getRules();

        let toHasState = hidden.includes(to) || shown.includes(to);
        if ((hidden.includes(from) || shown.includes(from)) && !(onlyMissing && toHasState)) {
            let intoHidden = hidden.includes(from);
            hidden = hidden.filter(n => n !== to);
            shown = shown.filter(n => n !== to);
            (intoHidden ? hidden : shown).push(to);
            this.settings.setValue("hidden-list", hidden);
            this.settings.setValue("shown-list", shown);
        }
        if (rules[from] && !(onlyMissing && rules[to])) {
            rules[to] = JSON.parse(JSON.stringify(rules[from]));
            this.settings.setValue("attention-rules", rules);
        }
    }

    on_show_all_clicked() {
        let shownList = this._getList("shown-list");
        for (let n of this._getList("hidden-list")) {
            if (!shownList.includes(n)) shownList.push(n);
        }
        this._popped.clear();
        this.settings.setValue("hidden-list", []);
        this.settings.setValue("shown-list", shownList);
        this._placeAll();
    }

    _onHideNewChanged() {
        if (!this.hideNewIcons) return;
        for (let entry of Object.values(this.entries)) {
            if (entry.settled && !this._hasSettings(entry.id)) this._setHidden(entry.id, true);
        }
    }

    /* ---------- icons coming and going ---------- */

    _key(proxy) {
        return proxy.get_name() + proxy.get_object_path();
    }

    _onIconAdded(proxy) {
        let key = this._key(proxy);
        if (this.entries[key]) return;

        let entry = {
            key: key,
            proxy: proxy,
            role: "",          // the name the icon has right now (lower case)
            id: null,          // the id settings are stored under, once known
            progId: null,      // program id, kept through any later renames
            settled: false,
            idSeq: 0,
            sigSeq: 0,
            lastSig: null,
            icon: null,
            settleTimer: 0,
            propsId: 0
        };
        this.entries[key] = entry;

        entry.propsId = proxy.connect("g-properties-changed", (p, changed) => {
            let props = changed.deep_unpack();
            if ("Name" in props) this._identify(entry);
            if ("IconName" in props || "Visible" in props) this._evaluateAttention(entry);
            if ("Visible" in props) this._layoutGridLater();
        });

        this._log("icon added: \"" + (proxy.name || "") + "\"");
        this._identify(entry);
    }

    _onIconRemoved(proxy) {
        let entry = this.entries[this._key(proxy)];
        if (!entry) return;

        this._log("icon removed: " + (entry.id || entry.role));
        this._destroyEntry(entry);
        delete this.entries[entry.key];

        if (entry.id && !Object.values(this.entries).some(e => e.id === entry.id)) {
            this._cancelAttnTimer(entry.id);
            this._popped.delete(entry.id);
        }
        this._afterPlacementChange();
    }

    _destroyEntry(entry) {
        if (entry.settleTimer) {
            Mainloop.source_remove(entry.settleTimer);
            entry.settleTimer = 0;
        }
        if (entry.propsId) {
            entry.proxy.disconnect(entry.propsId);
            entry.propsId = 0;
        }
        if (entry.icon) {
            entry.icon.destroy();
            entry.icon = null;
        }
    }

    /* ---------- identifying icons ----------
     * An icon is only shown once we know which app it belongs to (usually a
     * few milliseconds); until then it is invisible, so nothing flashes in
     * the panel while apps start. */

    _identify(entry) {
        entry.role = (entry.proxy.name || "").toLowerCase();

        // Known program: renames don't change anything.
        if (entry.progId) return;

        let seq = ++entry.idSeq;
        let raw = entry.proxy.name || "";

        if (!entry.settled && !entry.settleTimer) {
            entry.settleTimer = Mainloop.timeout_add(SETTLE_TIMEOUT_MS, () => {
                entry.settleTimer = 0;
                if (!entry.settled) this._settle(entry, entry.role && !isUnstableName(entry.role) ? entry.role : UNTITLED);
                return GLib.SOURCE_REMOVE;
            });
        }

        if (!raw) return;   // nameless: wait for the name (or the timeout)

        if (isUnstableName(raw)) {
            pidForBusName(raw).then(pid => programIdForPid(pid)).then(prog => {
                if (this._removed || seq !== entry.idSeq || this.entries[entry.key] !== entry) return;
                if (prog) this._settle(entry, prog);
            }).catch(e => global.logError("Tray Overflow: " + e));
            return;
        }

        entry.waitingForMap = seq;
        this._scheduleResolve();
    }

    _scheduleResolve() {
        if (this._resolveId) return;
        this._resolveId = Mainloop.timeout_add(250, () => {
            this._resolveId = 0;
            this._resolveFromTrayService().catch(e => global.logError("Tray Overflow: " + e));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _resolveFromTrayService() {
        let waiting = Object.values(this.entries).filter(e => e.waitingForMap);
        if (waiting.length === 0) return;

        let map = await buildTrayProgramMap();
        if (this._removed) return;

        for (let entry of waiting) {
            if (this.entries[entry.key] !== entry || entry.waitingForMap !== entry.idSeq) continue;
            entry.waitingForMap = 0;
            // No match: a native XApp icon (e.g. Mint Update) - its name is stable.
            this._settle(entry, map.get(sortableName(entry.proxy.name || "")) || entry.role);
        }
    }

    _settle(entry, id) {
        if (entry.settleTimer) {
            Mainloop.source_remove(entry.settleTimer);
            entry.settleTimer = 0;
        }
        if (isProgramId(id)) entry.progId = id;

        let oldId = entry.id;
        if (oldId !== id) {
            this._log("icon \"" + entry.role + "\" is " + id);
            this._adoptId(entry, oldId, id);
        }
        entry.settled = true;

        if (this.hideNewIcons && id !== UNTITLED && !this._hasSettings(id)) {
            let hiddenList = this._getList("hidden-list");
            hiddenList.push(id);
            this.settings.setValue("hidden-list", hiddenList);
        }

        this._place(entry);
        this._afterPlacementChange();
        this._evaluateAttention(entry);
    }

    /* Give an icon its final id. Settings saved under the previous id, or
     * under other names the same app had before (older versions stored
     * names that apps change while running), are folded into it. */
    _adoptId(entry, oldId, newId) {
        let inUse = new Set(Object.values(this.entries).filter(e => e !== entry && e.id).map(e => e.id));
        let leftovers = [];

        if (isProgramId(newId)) {
            let labels = new Set([prettyName(newId), entry.role, prettyName(entry.role)]);
            let known = new Set([].concat(this._getList("hidden-list"), this._getList("shown-list"),
                                          Object.keys(this._getRules())));
            leftovers = Array.from(known).filter(id =>
                id !== newId && id !== oldId && id !== UNTITLED && !inUse.has(id) && labels.has(prettyName(id)));
        }

        // The entry the user last saw in the list wins; leftovers fill gaps.
        if (oldId && oldId !== newId && oldId !== UNTITLED && this._hasSettings(oldId)) this._mergeInto(oldId, newId);
        for (let id of leftovers) {
            if (this._hasSettings(id)) this._mergeInto(id, newId, true);
        }
        for (let id of leftovers) this._forgetId(id);
        if (oldId && oldId !== newId && oldId !== UNTITLED && !inUse.has(oldId)) this._forgetId(oldId);

        if (oldId) {
            this._cancelAttnTimer(oldId);
            this._popped.delete(oldId);
        }
        entry.id = newId;
        if (leftovers.length) this._log(newId + ": merged " + leftovers.join(", "));
    }

    /* ---------- placing icons: panel, overflow, or nowhere ---------- */

    _ignoredByOtherApplet(entry) {
        try {
            return Main.systrayManager.getRoles().indexOf(entry.role) != -1;
        } catch (e) {
            return false;
        }
    }

    _place(entry) {
        let where = "none";
        if (entry.settled && !this._ignoredByOtherApplet(entry)) {
            where = this._isEffectivelyHidden(entry.id) ? "overflow" : "panel";
        }

        if (where === "none") {
            if (entry.icon) {
                entry.icon.destroy();
                entry.icon = null;
            }
            return;
        }

        if (!entry.icon) entry.icon = new TrayIcon(this, entry);
        let actor = entry.icon.actor;
        let target = where === "panel" ? this.manager_container : this.grid;
        let parent = actor.get_parent();
        if (parent !== target) {
            if (parent) parent.remove_child(actor);
            entry.icon.setOverflow(where === "overflow");
            if (where === "panel") this.manager_container.add_actor(actor);
            // overflow icons are attached by _layoutGrid()
        }
    }

    _placeAll() {
        for (let entry of Object.values(this.entries)) this._place(entry);
        this._afterPlacementChange();
    }

    _afterPlacementChange() {
        this._sortPanel();
        this._layoutGrid();
        this._refreshOpenLists();
    }

    _sortFunc(a, b) {
        let asym = (a.proxy.icon_name || "").includes("-symbolic");
        let bsym = (b.proxy.icon_name || "").includes("-symbolic");
        if (asym && !bsym) return 1;
        if (bsym && !asym) return -1;
        return GLib.utf8_collate(this._displayName(a.id).toLowerCase(), this._displayName(b.id).toLowerCase());
    }

    _sortPanel() {
        let inPanel = Object.values(this.entries).filter(e => e.icon && !e.icon.inOverflow);
        inPanel.sort((a, b) => this._sortFunc(a, b));

        this.manager_container.set_child_at_index(this._chevron, 0);
        let i = 1;
        for (let e of inPanel) this.manager_container.set_child_at_index(e.icon.actor, i++);
        if (this._recorder) this.manager_container.set_child_at_index(this._recorder.actor, -1);
    }

    _overflowEntries() {
        let list = Object.values(this.entries).filter(e => e.icon && e.icon.inOverflow);
        list.sort((a, b) => GLib.utf8_collate(this._displayName(a.id).toLowerCase(), this._displayName(b.id).toLowerCase()));
        return list;
    }

    _layoutGridLater() {
        if (this._layoutId) return;
        this._layoutId = Mainloop.idle_add(() => {
            this._layoutId = 0;
            this._layoutGrid();
            return GLib.SOURCE_REMOVE;
        });
    }

    _layoutGrid() {
        if (!this.grid) return;
        for (let child of this.grid.get_children()) this.grid.remove_child(child);

        // Only visible icons get a slot, so there are no gaps.
        let cols = Math.max(1, this.columns || 5);
        let visible = this._overflowEntries().filter(e => e.icon.isVisible);
        visible.forEach((e, i) => this.gridLayout.attach(e.icon.actor, i % cols, Math.floor(i / cols), 1, 1));

        this.gridItem.actor.visible = visible.length > 0;
        this.emptyItem.actor.visible = visible.length === 0;
        this._chevronTooltip.set_text(ngettext("%d hidden icon", "%d hidden icons", visible.length).format(visible.length));
        this._chevronCount.set_text(String(visible.length));
        this._chevronCount.visible = !!this.showCount && visible.length > 0;
    }

    _refreshIcons() {
        for (let entry of Object.values(this.entries)) {
            if (entry.icon) entry.icon.refresh();
        }
        if (this._recorder) this._recorder.refresh();
        this._setChevronIcon();
    }

    _setChevronIcon() {
        let icon = this._chevronIcon;
        let style = this.buttonIcon || "arrow";
        let custom = (this.buttonCustomIcon || "").trim();

        if (this.useCustomIcon && custom) {
            let type = custom.match(/symbolic/) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
            icon.icon_type = type;
            icon.gicon = custom.includes("/")
                ? new Gio.FileIcon({ file: Gio.File.new_for_path(custom) })
                : new Gio.ThemedIcon({ name: custom });
            icon.icon_size = this.getPanelIconSize(type);
            return;
        }

        icon.icon_type = St.IconType.SYMBOLIC;
        icon.icon_size = this.getPanelIconSize(St.IconType.SYMBOLIC);

        if (BUTTON_ICONS[style]) {
            icon.gicon = Gio.ThemedIcon.new_from_names(BUTTON_ICONS[style]);
            return;
        }

        // Arrow pointing to where the popup opens.
        let name = "pan-up-symbolic";
        switch (this.orientation) {
            case St.Side.TOP: name = "pan-down-symbolic"; break;
            case St.Side.LEFT: name = "pan-end-symbolic"; break;
            case St.Side.RIGHT: name = "pan-start-symbolic"; break;
        }
        icon.icon_name = name;
    }

    /* ---------- open on hover, close when the pointer leaves ---------- */

    _onChevronEnter() {
        if (!this.openOnHover || this.menu.isOpen || global.settings.get_boolean("panel-edit-mode")) return;
        this._cancelHoverOpen();
        this._hoverId = Mainloop.timeout_add(Math.max(1, this.hoverDelay || 0), () => {
            this._hoverId = 0;
            if (this._chevron.hover && !this.menu.isOpen) this.menu.open(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHoverOpen() {
        if (this._hoverId) {
            Mainloop.source_remove(this._hoverId);
            this._hoverId = 0;
        }
    }

    _onOpenOnHoverChanged() {
        this._cancelHoverOpen();
        if (this.openOnHover && this.menu.isOpen) this._startLeaveWatch();
        else this._stopLeaveWatch();
    }

    // While the popup is open in hover mode, close it once the pointer has
    // been outside the popup and the button for a moment - but never while
    // an app's menu (opened from the popup) is showing.
    _startLeaveWatch() {
        this._stopLeaveWatch();
        let outsideSince = 0;
        this._leaveId = Mainloop.timeout_add(150, () => {
            if (!this.menu.isOpen || !this.openOnHover) {
                this._leaveId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._handoff) {
                outsideSince = 0;
                return GLib.SOURCE_CONTINUE;
            }

            let [px, py] = global.get_pointer();
            let inside = this._pointerInsidePopup(px, py) || this._pointerInside(this._chevron, px, py);
            let now = GLib.get_monotonic_time();

            if (inside) {
                outsideSince = 0;
            } else if (!outsideSince) {
                outsideSince = now;
            } else if (now - outsideSince > Math.max(100, this.closeDelay || 500) * 1000) {
                this._leaveId = 0;
                this.closeOverflow();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLeaveWatch() {
        if (this._leaveId) {
            Mainloop.source_remove(this._leaveId);
            this._leaveId = 0;
        }
    }

    _onScaleChanged() {
        if (this._scaleId) Mainloop.source_remove(this._scaleId);
        this._scaleId = Mainloop.timeout_add(1500, () => {
            this._scaleId = 0;
            this._refreshIcons();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onPanelEditModeChanged() {
        let reactive = !global.settings.get_boolean("panel-edit-mode");
        for (let entry of Object.values(this.entries)) {
            if (entry.icon) entry.icon.actor.reactive = reactive;
        }
    }

    /* ---------- "show in panel when its icon changes" ---------- */

    _freshRule(id, currentSig) {
        let rule = { enabled: true, normal: [], ignore: [] };
        let preset = PRESETS.find(p => p.match(id));
        if (preset) {
            rule.normal = preset.normal.slice();
            rule.ignore = preset.ignore.slice();
        } else if (currentSig) {
            rule.normal.push(currentSig);   // whatever it looks like now is "normal"
        }
        return rule;
    }

    _entryFor(id) {
        return Object.values(this.entries).find(e => e.id === id) || null;
    }

    async _currentSig(id) {
        let entry = this._entryFor(id);
        if (!entry) return null;
        let sig = await iconSignature(entry.proxy.icon_name);
        if (sig) entry.lastSig = sig;
        return entry.lastSig;
    }

    async _setRuleEnabled(id, enabled) {
        if (enabled) {
            this._saveRule(id, this._freshRule(id, await this._currentSig(id)));
        } else {
            this._saveRule(id, null);
            this._cancelAttnTimer(id);
            this._setPopped(id, false);
        }
        this._evaluateId(id);
        this._refreshOpenLists();
    }

    _markCurrent(id, kind) { // kind: "normal" | "ignore"
        let rule = this._getRule(id);
        let entry = this._entryFor(id);
        let sig = entry ? entry.lastSig : null;
        if (!rule || !sig) return;

        rule.normal = rule.normal.filter(s => s !== sig);
        rule.ignore = rule.ignore.filter(s => s !== sig);
        rule[kind].push(sig);
        this._saveRule(id, rule);

        if (kind === "normal") {
            this._cancelAttnTimer(id);
            this._setPopped(id, false);
        }
    }

    async _relearn(id) {
        this._cancelAttnTimer(id);
        this._setPopped(id, false);
        this._saveRule(id, this._freshRule(id, await this._currentSig(id)));
        this._refreshOpenLists();
    }

    _evaluateId(id) {
        for (let entry of Object.values(this.entries)) {
            if (entry.id === id) this._evaluateAttention(entry);
        }
    }

    _evaluateAttention(entry) {
        this._evaluateAttentionAsync(entry).catch(e => global.logError("Tray Overflow: " + e));
    }

    async _evaluateAttentionAsync(entry) {
        if (!entry.settled) return;
        let id = entry.id;
        let rule = this._getRule(id);
        if (!rule || !this._isHidden(id)) return;

        let seq = ++entry.sigSeq;
        let sig = await iconSignature(entry.proxy.icon_name);
        if (this._removed || seq !== entry.sigSeq || this.entries[entry.key] !== entry || !sig) return;
        entry.lastSig = sig;

        // Rule enabled while the app wasn't running: learn the first look.
        if (rule.normal.length === 0 && !rule.ignore.includes(sig)) {
            rule.normal.push(sig);
            this._saveRule(id, rule);
        }

        let want;
        if (!entry.proxy.visible || rule.normal.includes(sig)) {
            want = false;
        } else if (rule.ignore.includes(sig)) {
            this._cancelAttnTimer(id);   // in-between state: keep as is
            return;
        } else {
            want = true;
        }

        this._cancelAttnTimer(id);
        if (want === this._popped.has(id)) return;

        let delay = Math.max(0, (want ? this.attentionDelayIn : this.attentionDelayOut) || 0) * 1000;
        this._attnTimers[id] = Mainloop.timeout_add(Math.max(1, delay), () => {
            delete this._attnTimers[id];
            if (entry.lastSig === sig && this.entries[entry.key] === entry) this._setPopped(id, want);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelAttnTimer(id) {
        if (this._attnTimers[id]) {
            Mainloop.source_remove(this._attnTimers[id]);
            delete this._attnTimers[id];
        }
    }

    _setPopped(id, popped) {
        if (popped === this._popped.has(id)) return;
        if (popped) this._popped.add(id);
        else this._popped.delete(id);
        this._log(id + (popped ? " -> panel (icon changed)" : " -> overflow (icon back to normal)"));
        this._placeAll();
    }

    /* ---------- the popup stays open while an app's menu is shown ----------
     * The popup holds the pointer while it's open, and an app can only show
     * its menu once we let go. So on click we release the grab but keep the
     * popup visible, then watch the app's menu:
     *  - no menu within 700 ms -> it was an "open the app" click: close
     *  - menu closed with the pointer still over the popup and no new
     *    window focused (Esc, or a click back into the popup) -> grab again
     *  - menu closed otherwise (item chosen, clicked elsewhere) -> close */

    closeOverflow() {
        this._endHandOff();
        this.menu.close(false);
    }

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

        // Any app menu shows up as a popup window ...
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
        } catch (e) { /* icon gone */ }
        return h.menuWindows.size > 0 || propOpen;
    }

    _checkHandOffDone() {
        let h = this._handoff;
        if (!h || !h.menuSeen || h.doneTimer || this._handOffMenuOpen(h)) return;

        // The window and the property don't change in a fixed order.
        h.doneTimer = Mainloop.timeout_add(150, () => {
            h.doneTimer = 0;
            if (this._handoff !== h || this._handOffMenuOpen(h)) return GLib.SOURCE_REMOVE;

            let fw = global.display.focus_window;
            let focusChanged = fw && fw !== h.focusAtMenu;
            let [px, py] = global.get_pointer();
            let inside = this._pointerInsidePopup(px, py);

            this._endHandOff();
            if (focusChanged || !inside) this.closeOverflow();
            else this._regrab();
            return GLib.SOURCE_REMOVE;
        });
    }

    _pointerInsidePopup(px, py) {
        return this._pointerInside(this.menu.actor, px, py);
    }

    _pointerInside(actor, px, py) {
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
            if (mgr.grabbed) this.menu.actor.grab_key_focus();
            else this.menu.close(false);
        } catch (e) {
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

    /* ---------- menus ---------- */

    _buildMenus() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        // Shown when the stock tray is on the panel too (icons would appear twice).
        this.noticeItem = new PopupMenu.PopupMenuItem(_("Remove the XApp Status Applet from the panel"), { reactive: false });
        this.noticeItem.actor.visible = false;
        this.menu.addMenuItem(this.noticeItem);

        this.gridLayout = new Clutter.GridLayout({ column_spacing: 2, row_spacing: 2 });
        this.grid = new St.Widget({ layout_manager: this.gridLayout, x_expand: false, x_align: Clutter.ActorAlign.START });
        this.gridItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false, hover: false });
        this.gridItem.addActor(this.grid, { span: -1, expand: false });
        this.menu.addMenuItem(this.gridItem);

        this.emptyItem = new PopupMenu.PopupMenuItem(_("No hidden icons"), { reactive: false });
        this.menu.addMenuItem(this.emptyItem);

        this.listSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this.listSeparator);

        this.manageItem = new PopupMenu.PopupSubMenuMenuItem(_("Icons shown in the panel"));
        this.menu.addMenuItem(this.manageItem);
        this.menu.connect("open-state-changed", (m, open) => {
            this._cancelHoverOpen();
            if (!open) {
                this._stopLeaveWatch();
                return;
            }
            if (this.openOnHover) this._startLeaveWatch();
            this.noticeItem.actor.visible = this._stockTrayRunning();
            if (this.showListInPopup !== false) this._fillManageMenu(this.manageItem.menu);
        });

        this.ctxManageItem = new PopupMenu.PopupSubMenuMenuItem(_("Icons shown in the panel"));
        this._applet_context_menu.addMenuItem(this.ctxManageItem, 0);
        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(), 1);
        this._applet_context_menu.connect("open-state-changed", (m, open) => {
            if (open) this._fillManageMenu(this.ctxManageItem.menu);
        });

        this._layoutGrid();
        this._updatePopupList();
    }

    // The icon list in the popup is optional; the right-click menu always has it.
    _updatePopupList() {
        let show = this.showListInPopup !== false;
        if (!show && this.manageItem.menu.isOpen) this.manageItem.menu.close(false);
        this.manageItem.actor.visible = show;
        this.listSeparator.actor.visible = show;
    }

    _stockTrayRunning() {
        try {
            return AppletManager.getRunningInstancesForUuid(STOCK_TRAY_UUID).length > 0;
        } catch (e) {
            return false;
        }
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    // Rebuild the icon list(s) if they are open right now.
    _refreshOpenLists() {
        for (let item of [this.manageItem, this.ctxManageItem]) {
            if (item && item.menu.isOpen) this._refillLater(item.menu, null);
        }
    }

    _refillLater(subMenu, focusKey) {
        // Rebuild after the click has finished. The clicked item is about to
        // be destroyed; if it still had key focus, Cinnamon would treat that
        // as "focus left the menu" and close it - so park focus first.
        if (this._refillIds && this._refillIds.has(subMenu)) return;
        if (!this._refillIds) this._refillIds = new Map();

        let id = Mainloop.idle_add(() => {
            this._refillIds.delete(subMenu);
            if (!subMenu.isOpen) return GLib.SOURCE_REMOVE;
            if (subMenu.sourceActor) subMenu.sourceActor.grab_key_focus();
            this._fillManageMenu(subMenu, focusKey);
            return GLib.SOURCE_REMOVE;
        });
        this._refillIds.set(subMenu, id);
    }

    _knownEntries() {
        let byId = {};

        for (let e of Object.values(this.entries)) {
            if (!e.settled || this._ignoredByOtherApplet(e)) continue;
            let name = this._displayName(e.id);
            let tip = plainText(e.proxy.tooltip_text);
            let label = name;
            if (tip && !name.toLowerCase().includes(tip.toLowerCase()) && !tip.toLowerCase().includes(name.toLowerCase())) {
                label += " — " + tip;
            }
            byId[e.id] = { id: e.id, label: truncate(label, 55), running: true };
        }

        // Hidden apps that aren't running - keep them listed so they can be
        // shown again or forgotten.
        for (let id of this._getList("hidden-list")) {
            if (!byId[id] && id !== UNTITLED && !isUnstableName(id)) {
                byId[id] = { id: id, label: truncate(this._displayName(id), 55), running: false };
            }
        }

        return Object.values(byId).sort((a, b) => GLib.utf8_collate(a.label.toLowerCase(), b.label.toLowerCase()));
    }

    _addAppOptions(subMenu, e, mainItem, items) {
        let rule = this._getRule(e.id);
        let popped = this._popped.has(e.id);
        if (popped) mainItem.setStatus(_("icon changed"));

        let action = (text, key, fn) => {
            let it = new ActionItem("      ↳ " + text);
            it.connect("activate", () => {
                fn();
                this._refillLater(subMenu, e.id + key);
            });
            subMenu.addMenuItem(it);
            items[e.id + key] = it;
        };

        if (!e.running) {
            action(_("Forget this app (remove from the list)"), "#forget", () => this._forgetId(e.id));
            if (!rule) return;      // keep the list short for apps that aren't running
        }

        let sw = new ToggleItem("      ↳ " + _("Show in panel when its icon changes"), !!rule, _("On"), _("Off"));
        sw.connect("toggled", (it, state) => {
            this._setRuleEnabled(e.id, state).catch(err => global.logError("Tray Overflow: " + err));
            this._refillLater(subMenu, e.id + "#rule");
        });
        subMenu.addMenuItem(sw);
        items[e.id + "#rule"] = sw;

        if (!rule) return;

        if (popped) {
            action(_("This look is normal (hide it again)"), "#normal", () => this._markCurrent(e.id, "normal"));
            action(_("Ignore this look (in-between state)"), "#ignore", () => this._markCurrent(e.id, "ignore"));
        } else if (e.running) {
            action(_("Re-learn: current look is normal"), "#relearn",
                   () => this._relearn(e.id).catch(err => global.logError("Tray Overflow: " + err)));
        }
    }

    _fillManageMenu(subMenu, focusKey) {
        subMenu.removeAll();
        let items = {};

        let entries = this._knownEntries();
        if (entries.length === 0) {
            subMenu.addMenuItem(new PopupMenu.PopupMenuItem(_("No tray icons found"), { reactive: false }));
            return;
        }

        for (let e of entries) {
            let item = new ToggleItem(e.label, !this._isHidden(e.id), _("Panel"), _("Hidden"));
            if (!e.running) item.setStatus(_("not running"));
            item.connect("toggled", (it, state) => {
                this._setHidden(e.id, !state);
                this._refillLater(subMenu, e.id);
            });
            subMenu.addMenuItem(item);
            items[e.id] = item;

            if (this._isHidden(e.id)) this._addAppOptions(subMenu, e, item, items);
        }

        subMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let addAction = (text, key, fn) => {
            let it = new ActionItem(text);
            it.connect("activate", () => {
                fn();
                this._refillLater(subMenu, key);
            });
            subMenu.addMenuItem(it);
            items[key] = it;
        };

        addAction(_("Show all in panel"), "#showall", () => this.on_show_all_clicked());

        if (entries.some(e => !e.running)) {
            addAction(_("Forget all apps that aren't running"), "#forgetall", () => {
                for (let e of entries) {
                    if (!e.running) this._forgetId(e.id);
                }
                this._placeAll();
            });
        }

        addAction(_("Hide all in overflow"), "#hideall", () => {
            let hiddenList = this._getList("hidden-list");
            for (let e of entries) {
                if (!hiddenList.includes(e.id)) hiddenList.push(e.id);
            }
            this.settings.setValue("hidden-list", hiddenList);
            this.settings.setValue("shown-list", this._getList("shown-list").filter(n => !hiddenList.includes(n)));
            this._placeAll();
        });

        if (focusKey && items[focusKey]) items[focusKey].actor.grab_key_focus();
    }

    /* ---------- lifecycle ---------- */

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        let vertical = orientation == St.Side.LEFT || orientation == St.Side.RIGHT;
        this.manager_container.vertical = vertical;
        this.manager_container.style = vertical ? VERTICAL_STYLE : HORIZONTAL_STYLE;
        if (this.menu.setOrientation) this.menu.setOrientation(orientation);
        this._refreshIcons();
    }

    on_applet_removed_from_panel() {
        this._removed = true;
        this._cancelHoverOpen();
        this._stopLeaveWatch();
        this._endHandOff();
        this.signals.disconnectAllSignals();

        for (let id of [this._resolveId, this._layoutId, this._scaleId]) {
            if (id) Mainloop.source_remove(id);
        }
        this._resolveId = this._layoutId = this._scaleId = 0;
        if (this._refillIds) {
            for (let id of this._refillIds.values()) Mainloop.source_remove(id);
            this._refillIds.clear();
        }
        for (let id of Object.keys(this._attnTimers)) this._cancelAttnTimer(id);

        for (let entry of Object.values(this.entries)) this._destroyEntry(entry);
        this.entries = {};

        if (this._recorder) {
            this._recorder.destroy();
            this._recorder = null;
        }
        this._chevronTooltip.destroy();
        this.monitor = null;
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new TrayOverflowApplet(metadata, orientation, panelHeight, instanceId);
}
