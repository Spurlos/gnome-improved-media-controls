import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ImprovedMediaControlsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._registerIconPath();

        window.add(this._buildGeneralPage(settings));
        window.add(this._buildDisplayPage(settings));
        window.add(this._buildPanelPage(settings));
        window.add(this._buildMousePage(settings));

        this._addAboutButton(window);
    }

    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Where to show'),
            description: _('Show the now-playing indicator in the top bar, enhance the media controls in notifications, or both'),
        });
        page.add(group);

        group.add(this._makeSwitchRow(settings, 'show-in-panel',
            _('Show in the top bar'),
            _('A now-playing label; click it to raise the player (configurable under Mouse)')));
        group.add(this._makeSwitchRow(settings, 'show-in-notifications',
            _('Enhance notifications'),
            _('Adds a seek bar, shuffle and loop to the native media controls in the date menu and lock screen')));

        return page;
    }

    _registerIconPath() {
        const display = Gdk.Display.get_default();
        if (!display) return;
        const iconTheme = Gtk.IconTheme.get_for_display(display);
        const iconDir = this.dir.get_child('icons').get_path();
        if (iconDir && !iconTheme.get_search_path().includes(iconDir))
            iconTheme.add_search_path(iconDir);
    }

    _addAboutButton(window) {
        const button = new Gtk.Button({
          icon_name: "info-outline-symbolic",
          tooltip_text: _("About Improved Media Controls"),
        });
        button.add_css_class('flat');
        button.connect('clicked', () => this._showAbout(window));

        const headerBar = this._findHeaderBar(window);
        if (headerBar)
            headerBar.pack_start(button);
    }

    _findHeaderBar(widget) {
        if (widget instanceof Adw.HeaderBar || widget instanceof Gtk.HeaderBar)
            return widget;
        let child = widget.get_first_child?.();
        while (child) {
            const found = this._findHeaderBar(child);
            if (found) return found;
            child = child.get_next_sibling();
        }
        return null;
    }

    _showAbout(parent) {
        const props = {
            application_name: _('Improved Media Controls'),
            application_icon: 'improved-media-controls',
            developer_name: 'POCOGuy',
            version: String(this.metadata.version ?? ''),
            comments: _('GNOME Shell extension that expands the native MPRIS implementation'),
            website: 'https://github.com/m-obeid/gnome-improved-media-controls',
            issue_url: 'https://github.com/m-obeid/gnome-improved-media-controls/issues',
            license_type: Gtk.License.MIT_X11,
        };

        const about = new Adw.AboutDialog(props);

        about.set_developers(['POCOGuy']);

        about.present(parent);
    }

    _buildDisplayPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Display'),
            icon_name: 'video-display-symbolic',
        });

        const iconGroup = new Adw.PreferencesGroup({ title: _('Icon') });
        page.add(iconGroup);

        const iconTypeRow = new Adw.ComboRow({
            title: _('Icon source'),
            subtitle: _('Show album art, app icon, or playback status icon'),
            model: this._makeStringList([_('App icon'), _('Album art'), _('Playing status')]),
            selected: settings.get_enum('icon-type'),
        });
        iconTypeRow.connect('notify::selected', () =>
            settings.set_enum('icon-type', iconTypeRow.selected));
        iconGroup.add(iconTypeRow);

        iconGroup.add(this._makeSpinRow(settings, 'icon-size',
            _('Icon size'), _('Size in pixels'), 8, 64, 1));
        iconGroup.add(this._makeSpinRow(settings, 'icon-spacing',
            _('Icon spacing'), _('Space between icon and text (px)'), 0, 32, 1));

        const textGroup = new Adw.PreferencesGroup({ title: _('Text') });
        page.add(textGroup);

        const separatorRow = new Adw.EntryRow({
            title: _('Separator'),
            text: settings.get_string('separator'),
        });
        separatorRow.connect('notify::text', () =>
            settings.set_string('separator', separatorRow.text));
        textGroup.add(separatorRow);

        textGroup.add(this._makeSpinRow(settings, 'max-text-width',
            _('Max text width'), _('Label width in pixels; longer text marquee-scrolls (0 = unlimited)'), 0, 1000, 10));

        const fieldsGroup = new Adw.PreferencesGroup({ title: _('Visible fields') });
        page.add(fieldsGroup);
        fieldsGroup.add(this._makeSwitchRow(settings, 'show-title', _('Show title')));
        fieldsGroup.add(this._makeSwitchRow(settings, 'show-artist', _('Show artist')));
        fieldsGroup.add(this._makeSwitchRow(settings, 'show-album', _('Show album')));

        return page;
    }

    _buildPanelPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Panel'),
            icon_name: 'view-grid-symbolic',
        });

        const group = new Adw.PreferencesGroup({ title: _('Position') });
        page.add(group);

        const positionRow = new Adw.ComboRow({
            title: _('Panel section'),
            subtitle: _('Which area of the top bar to place the indicator'),
            model: this._makeStringList([_('Left'), _('Center'), _('Right')]),
            selected: settings.get_enum('panel-position'),
        });
        positionRow.connect('notify::selected', () =>
            settings.set_enum('panel-position', positionRow.selected));
        group.add(positionRow);

        group.add(this._makeSpinRow(settings, 'panel-index',
            _('Position index'), _('Order within the panel section (0 = first)'), 0, 20, 1));

        return page;
    }

    _buildMousePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Mouse'),
            icon_name: 'input-mouse-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Click actions'),
            description: _('What happens when you click the media bar indicator'),
        });
        page.add(group);

        const actionModel = this._makeStringList([
            _('Nothing'), _('Raise player'), _('Play / Pause'), _('Open settings'),
            _('Next track'), _('Previous track'), _('Volume up'), _('Volume down'),
        ]);

        for (const [key, title, subtitle] of [
            ['left-click-action', _('Left click'), _('Action when left-clicking the indicator')],
            ['middle-click-action', _('Middle click'), _('Action when middle-clicking the indicator')],
            ['right-click-action', _('Right click'), _('Action when right-clicking the indicator')],
        ]) {
            group.add(this._makeComboRow(settings, key, title, subtitle, actionModel));
        }

        const scrollGroup = new Adw.PreferencesGroup({
            title: _('Scroll actions'),
            description: _('What happens when you scroll over the media bar indicator'),
        });
        page.add(scrollGroup);

        for (const [key, title, subtitle] of [
            ['scroll-up-action', _('Scroll up'), _('Action when scrolling up over the indicator')],
            ['scroll-down-action', _('Scroll down'), _('Action when scrolling down over the indicator')],
        ]) {
            scrollGroup.add(this._makeComboRow(settings, key, title, subtitle, actionModel));
        }

        return page;
    }

    _makeStringList(labels) {
        const model = new Gtk.StringList();
        for (const label of labels) model.append(label);
        return model;
    }

    _makeSpinRow(settings, key, title, subtitle, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower, upper, step_increment: step,
                value: settings.get_int(key),
            }),
        });
        row.connect('notify::value', () => settings.set_int(key, row.value));
        return row;
    }

    _makeSwitchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow(subtitle ? { title, subtitle } : { title });
        row.active = settings.get_boolean(key);
        row.connect('notify::active', () => settings.set_boolean(key, row.active));
        return row;
    }

    _makeComboRow(settings, key, title, subtitle, model) {
        const row = new Adw.ComboRow({ title, subtitle, model, selected: settings.get_enum(key) });
        row.connect('notify::selected', () => settings.set_enum(key, row.selected));
        return row;
    }
}
