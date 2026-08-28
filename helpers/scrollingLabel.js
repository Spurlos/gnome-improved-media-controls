import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

const SCROLL_SPEED = 30;      // pixels per second
const GAP = '     ';          // spacer between repeats while scrolling
const PAUSE_MS = 1500;        // pause at the start of each cycle

/**
 * A label that marquee-scrolls its text when it exceeds `maxWidth`, instead of
 * ellipsizing. When the text fits, it behaves like a normal fixed/!fixed label.
 * Adapted (simplified) from the media-controls extension's ScrollingLabel.
 */
export const ScrollingLabel = GObject.registerClass({
    GTypeName: 'ImprovedMediaControlsScrollingLabel',
}, class ScrollingLabel extends St.ScrollView {
    _init(maxWidth) {
        super._init({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._maxWidth = maxWidth || 0;
        this._transition = null;
        this._adjustmentChangedId = 0;
        this._pauseTimerId = 0;

        this._box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        this.label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
        });
        this._box.add_child(this.label);
        this.add_child(this._box);
    }

    setMaxWidth(maxWidth) {
        if (this._maxWidth === maxWidth) return;
        this._maxWidth = maxWidth || 0;
        this._relayout();
    }

    setText(text) {
        const next = text || '';
        // No-op on unchanged text: callers re-push the same title on every
        // players-changed, and restarting would reset the scroll to the start
        // every time, so it never appeared to move.
        if (next === this._baseText) return;
        this._stop();
        this._baseText = next;
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.label.text = this._baseText;
        // Re-evaluate once the label has a natural width on stage.
        if (this.label.is_mapped() && this.get_stage())
            this._relayout();
        else
            this._deferRelayout();
    }

    _deferRelayout() {
        if (this._mappedId) return;
        this._mappedId = this.connect('notify::mapped', () => {
            if (this.is_mapped() && this.get_stage()) {
                this.disconnect(this._mappedId);
                this._mappedId = 0;
                this._relayout();
            }
        });
    }

    _relayout() {
        this._stop();
        const natWidth = this.label.get_preferred_width(-1)[1];
        const max = this._maxWidth;

        if (max > 0 && natWidth > max) {
            this._box.width = max;
            this._startScrolling();
        } else {
            this._box.width = -1;
            this.label.text = this._baseText;
            this.label.x_align = Clutter.ActorAlign.START;
        }
    }

    _startScrolling() {
        const adjustment = this.get_hadjustment();
        const looped = `${this._baseText}${GAP}`;
        this.label.text = `${looped}${looped}`;

        if (this._adjustmentChangedId)
            adjustment.disconnect(this._adjustmentChangedId);
        this._adjustmentChangedId = adjustment.connect('changed', () => {
            if (adjustment.upper <= adjustment.page_size) return;
            adjustment.disconnect(this._adjustmentChangedId);
            this._adjustmentChangedId = 0;
            this._animate(adjustment);
        });
        // Force a 'changed' emission by querying.
        adjustment.upper; // eslint-disable-line no-unused-expressions
    }

    _animate(adjustment) {
        // Scroll across exactly one "looped" copy, then snap back and repeat.
        const halfWidth = this.label.get_preferred_width(-1)[1] / 2;
        const interval = new Clutter.Interval({
            value_type: GObject.TYPE_DOUBLE,
            initial: 0,
            final: halfWidth,
        });
        const duration = Math.max(1, (halfWidth / SCROLL_SPEED) * 1000);
        this._transition = new Clutter.PropertyTransition({
            property_name: 'value',
            progress_mode: Clutter.AnimationMode.LINEAR,
            repeat_count: 0,
            // Keep the transition attached to the adjustment after it completes;
            // otherwise Clutter auto-removes it and the `start()` we call to loop
            // the next cycle drives nothing, so scrolling stops after one pass.
            remove_on_complete: false,
            duration,
            interval,
        });
        this._transition.connect('completed', () => {
            this._transition?.rewind();
            if (this._pauseTimerId)
                GLib.source_remove(this._pauseTimerId);
            this._pauseTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAUSE_MS, () => {
                this._pauseTimerId = 0;
                this._transition?.start();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._pauseTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAUSE_MS, () => {
            this._pauseTimerId = 0;
            adjustment.add_transition('scroll', this._transition);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stop() {
        if (this._pauseTimerId) {
            GLib.source_remove(this._pauseTimerId);
            this._pauseTimerId = 0;
        }
        if (this._transition) {
            this.get_hadjustment().remove_transition('scroll');
            this._transition = null;
        }
        if (this._adjustmentChangedId) {
            this.get_hadjustment().disconnect(this._adjustmentChangedId);
            this._adjustmentChangedId = 0;
        }
    }

    vfunc_scroll_event() {
        // Let scroll events bubble to the panel button (volume control etc.).
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this._stop();
        if (this._mappedId) {
            this.disconnect(this._mappedId);
            this._mappedId = 0;
        }
        super.destroy();
    }
});
