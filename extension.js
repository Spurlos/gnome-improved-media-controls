import GLib from "gi://GLib";
import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { ExtensionSettings } from "./helpers/settings.js";
import { MprisManager } from "./helpers/mprisManager.js";
import { Indicator } from "./helpers/indicator.js";
import { MediaEnhancer } from "./helpers/mediaEnhancer.js";

const PANEL_POSITIONS = ["left", "center", "right"];

export default class ImprovedMediaControlsExtension extends Extension {
  enable() {
    this._preferences = new ExtensionSettings(this);
    this._mprisManager = new MprisManager();
    this._indicator = null;
    this._enhancer = null;
    this._enableIdleId = null;

    this._preferences.connectObject(
      "changed::panel-position",
      () => this._updateIndicatorPosition(),
      "changed::panel-index",
      () => this._updateIndicatorPosition(),
      "changed::show-in-panel",
      () => this._syncIndicator(),
      "changed::show-in-notifications",
      () => this._syncEnhancer(),
      this,
    );

    // Re-assert our panel position after session changes (unlock / login),
    // when another extension that manages the top bar may have moved us.
    this._sessionUpdatedId = Main.sessionMode.connect("updated", () =>
      this._reapplyPositionSoon(),
    );
    this._reapplyTimers = [];

    this._enableIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._syncIndicator();
      this._syncEnhancer();
      this._enableIdleId = null;
      return GLib.SOURCE_REMOVE;
    });
  }

  _reapplyPositionSoon() {
    // Re-assert our configured position shortly after enable / session change.
    // NOTE: an extension that manages the top bar (e.g. top-bar-organizer) can
    // still pin us elsewhere - in that case position is owned by *that*
    // extension and should be changed there.
    this._clearReapplyTimers();
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
      this._reapplyTimers = this._reapplyTimers.filter((t) => t !== id);
      this._updateIndicatorPosition();
      return GLib.SOURCE_REMOVE;
    });
    this._reapplyTimers.push(id);
  }

  _clearReapplyTimers() {
    for (const id of this._reapplyTimers) GLib.Source.remove(id);
    this._reapplyTimers = [];
  }

  _syncIndicator() {
    if (!this._preferences || !this._mprisManager) return;

    if (this._preferences.showInPanel) {
      if (this._indicator) return;
      const position =
        PANEL_POSITIONS[this._preferences.panelPosition] ?? "right";
      const index = this._preferences.panelIndex || 0;
      this._indicator = new Indicator(
        this._preferences,
        this,
        this._mprisManager,
      );
      Main.panel.addToStatusArea(this.uuid, this._indicator, index, position);
      // Force the saved position in case addToStatusArea / a reorderer
      // placed it elsewhere.
      this._reapplyPositionSoon();
    } else if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }

  _syncEnhancer() {
    if (!this._preferences || !this._mprisManager) return;

    if (this._preferences.showInNotifications) {
      if (this._enhancer) return;
      this._enhancer = new MediaEnhancer(this._mprisManager, this._preferences);
    } else if (this._enhancer) {
      this._enhancer.destroy();
      this._enhancer = null;
    }
  }

  _updateIndicatorPosition() {
    if (!this._indicator) return;

    const positionName =
      PANEL_POSITIONS[this._preferences.panelPosition] ?? "right";
    const index = this._preferences.panelIndex || 0;

    // If top-bar-organizer is managing the top bar it will otherwise pin us to
    // whichever box it has us listed in, overriding this setting. Cooperate by
    // writing our chosen box into its own order lists.
    this._syncTopBarOrganizer(positionName);

    const boxes = {
      left: Main.panel._leftBox,
      center: Main.panel._centerBox,
      right: Main.panel._rightBox,
    };
    const targetBox = boxes[positionName];
    if (!targetBox) return;

    const container = this._indicator.container ?? this._indicator;
    const currentParent = container.get_parent();
    if (currentParent === targetBox) {
      currentParent.set_child_at_index(container, index);
      return;
    }
    if (currentParent) currentParent.remove_child(container);
    targetBox.insert_child_at_index(container, index);
  }

  /**
   * Best-effort cooperation with top-bar-organizer: put our uuid in its
   * <box>-box-order list matching `boxName` and remove it from the others, so
   * it places (and keeps) us where the user asked instead of reverting us.
   * No-ops cleanly if the extension isn't installed.
   */
  _syncTopBarOrganizer(boxName) {
    try {
      const TBO = "top-bar-organizer@julian.gse.jsts.xyz";
      const schemaDir = GLib.build_filenamev([
        GLib.get_home_dir(),
        ".local/share/gnome-shell/extensions",
        TBO,
        "schemas",
      ]);
      if (!Gio.File.new_for_path(schemaDir).query_exists(null)) return;

      const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir,
        Gio.SettingsSchemaSource.get_default(),
        false,
      );
      const schema = source.lookup(
        "org.gnome.shell.extensions.top-bar-organizer",
        true,
      );
      if (!schema) return;

      const tbo = new Gio.Settings({ settings_schema: schema });
      const keys = {
        left: "left-box-order",
        center: "center-box-order",
        right: "right-box-order",
      };
      const uuid = this.uuid;

      for (const [box, key] of Object.entries(keys)) {
        let arr = tbo.get_strv(key);
        if (box === boxName) {
          if (!arr.includes(uuid)) {
            arr.push(uuid);
            tbo.set_strv(key, arr);
          }
        } else if (arr.includes(uuid)) {
          tbo.set_strv(
            key,
            arr.filter((x) => x !== uuid),
          );
        }
      }
    } catch (e) {
      logError(e, "ImprovedMediaControls: top-bar-organizer sync failed");
    }
  }

  disable() {
    if (this._enableIdleId) {
      GLib.Source.remove(this._enableIdleId);
      this._enableIdleId = null;
    }

    this._clearReapplyTimers();

    if (this._sessionUpdatedId) {
      Main.sessionMode.disconnect(this._sessionUpdatedId);
      this._sessionUpdatedId = 0;
    }

    this._preferences.disconnectObject(this);

    if (this._enhancer) {
      this._enhancer.destroy();
      this._enhancer = null;
    }

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    if (this._mprisManager) {
      this._mprisManager.destroy();
      this._mprisManager = null;
    }

    this._preferences = null;
  }
}
