import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import St from "gi://St";

import { MediaMessage } from "resource:///org/gnome/shell/ui/messageList.js";

import { guard } from "./util.js";

/* The shell stacks *notification* groups but leaves every media player as its
 * own full-height message. These metrics are the ones messageList.js uses for
 * its own stacks, copied verbatim so our media stack looks native. */
const GROUP_EXPANSION_TIME = 200;
const MAX_VISIBLE_STACKED_MESSAGES = 3;
const ADDITIONAL_BOTTOM_MARGIN_EXPANDED_GROUP = 15;
const WIDTH_OFFSET_STACKED = 6;
const HEIGHT_OFFSET_STACKED = 10;
const HEIGHT_OFFSET_REDUCTION_STACKED = 1.4;

/**
 * Stacking layout for MediaGroup, ported from the shell's (unexported)
 * MessageGroupExpanderLayout. `expansion` drives the collapsed<->expanded
 * animation: at 0 only the top message is fully visible with the rest peeking
 * out below it, at 1 every message is laid out end to end.
 *
 * Child order is [top, cover, ...rest, header] - see MediaGroup.
 */
const MediaGroupLayout = GObject.registerClass(
  {
    GTypeName: "ImprovedMediaControlsMediaGroupLayout",
    Properties: {
      expansion: GObject.ParamSpec.double(
        "expansion",
        null,
        null,
        GObject.ParamFlags.READWRITE,
        0,
        1,
        0,
      ),
    },
  },
  class MediaGroupLayout extends Clutter.LayoutManager {
    constructor(cover, header) {
      super();
      this._cover = cover;
      this._header = header;
      this._expansion = 0;
    }

    get expansion() {
      return this._expansion;
    }

    set expansion(v) {
      v = Math.clamp(v, 0, 1);
      if (v === this._expansion) return;
      this._expansion = v;
      this.notify("expansion");
      this.layout_changed();
    }

    /** The message children only, in stack order (top first). */
    _stack(container) {
      return container
        .get_children()
        .filter((c) => c !== this._cover && c !== this._header && c.visible);
    }

    getExpandedHeight(container, forWidth) {
      let min = 0;
      let nat = 0;

      for (const child of container.get_children()) {
        // The cover sits on top of the stack; it never adds height.
        if (child === this._cover) continue;
        const [minChild, natChild] = child.get_preferred_height(forWidth);
        min += minChild;
        nat += natChild;
      }

      // Add additional spacing after an expanded group
      return [
        min + ADDITIONAL_BOTTOM_MARGIN_EXPANDED_GROUP,
        nat + ADDITIONAL_BOTTOM_MARGIN_EXPANDED_GROUP,
      ];
    }

    vfunc_get_preferred_width(container, forHeight) {
      let min = 0;
      let nat = 0;

      for (const child of container.get_children()) {
        if (child === this._cover || !child.visible) continue;
        const [minChild, natChild] = child.get_preferred_width(forHeight);
        min = Math.max(min, minChild);
        nat = Math.max(nat, natChild);
      }

      return [min, nat];
    }

    vfunc_get_preferred_height(container, forWidth) {
      let offset = HEIGHT_OFFSET_STACKED;
      let min = 0;
      let nat = 0;
      let visibleCount = MAX_VISIBLE_STACKED_MESSAGES;

      for (const child of this._stack(container)) {
        // The first message is always fully shown; the ones behind it only
        // contribute the sliver of themselves that peeks out.
        if (min === 0 || nat === 0) {
          [min, nat] = child.get_preferred_height(forWidth);
        } else {
          min += offset;
          nat += offset;
          offset /= HEIGHT_OFFSET_REDUCTION_STACKED;
        }

        if (--visibleCount === 0) break;
      }

      const [minExpanded, natExpanded] = this.getExpandedHeight(
        container,
        forWidth,
      );

      return [
        min + this._expansion * (minExpanded - min),
        nat + this._expansion * (natExpanded - nat),
      ];
    }

    vfunc_allocate(container, box) {
      const childWidth = box.x2 - box.x1;
      const fullY2 = box.y2;

      if (this._cover.visible) this._cover.allocate(box);

      if (this._header.visible) {
        const [min] = this._header.get_preferred_height(childWidth);
        box.y2 = box.y1 + min;
        this._header.allocate(box);
        box.y1 += this._expansion * (box.y2 - box.y1);
      }

      const [top, ...rest] = this._stack(container);
      if (!top) return;

      const [topMin] = top.get_preferred_height(childWidth);
      box.y2 = box.y1 + topMin;
      top.allocate(box);

      let heightOffset = HEIGHT_OFFSET_STACKED;
      for (const child of rest) {
        const [min] = child.get_preferred_height(childWidth);

        // Inset each deeper card a little further when collapsed.
        const widthOffset = (1.0 - this._expansion) * WIDTH_OFFSET_STACKED;
        box.x1 += widthOffset;
        box.x2 -= widthOffset;

        box.y2 += heightOffset + this._expansion * (min - heightOffset);
        // Ensure messages are not placed outside the widget
        if (box.y2 > fullY2) box.y2 = fullY2;
        else heightOffset /= HEIGHT_OFFSET_REDUCTION_STACKED;
        box.y1 = box.y2 - min;

        child.allocate(box);
      }
    }
  },
);

/**
 * A stack of MediaMessages that behaves like one of the shell's notification
 * groups: collapsed it shows the top player with the others peeking out behind
 * it, and clicking it expands the stack. It is duck-type compatible with
 * NotificationMessageGroup so MessageView._setExpandedGroup() can drive it -
 * which is what gives us the dimming overlay, the scroll-to-group and the
 * click-outside-to-collapse behaviour for free.
 */
export const MediaGroup = GObject.registerClass(
  {
    GTypeName: "ImprovedMediaControlsMediaGroup",
    Properties: {
      expanded: GObject.ParamSpec.boolean(
        "expanded",
        null,
        null,
        GObject.ParamFlags.READABLE,
        false,
      ),
    },
    Signals: {
      "expand-toggle-requested": {},
      "messages-changed": {},
      "message-focused": { param_types: [Clutter.Actor.$gtype] },
    },
  },
  class MediaGroup extends St.Widget {
    constructor() {
      // A widget that covers stacked messages so that they don't receive events
      const cover = new St.Widget({
        name: "cover",
        reactive: true,
      });

      const header = new St.BoxLayout({
        style_class: "message-group-header",
        x_expand: true,
        visible: false,
      });

      // Clutter.ClickGesture is what the shell uses on 49+; fall back to the
      // older action so this still loads on the earlier shells we support.
      const useGesture = !!Clutter.ClickGesture;
      const clicker = useGesture
        ? new Clutter.ClickGesture()
        : new Clutter.ClickAction();

      super({
        style_class: "message-notification-group mci-media-group",
        x_expand: true,
        layout_manager: new MediaGroupLayout(cover, header),
        actions: clicker,
        reactive: true,
      });

      // The cover is always the second child to prevent interaction
      // with stacked messages when collapsed.
      this._cover = cover;
      // The headerBox will always be the last child
      this._headerBox = header;

      this._messages = [];
      this._expanded = false;
      this._focusChild = null;

      header.add_child(
        new St.Label({
          style_class: "message-group-title",
          text: "Media",
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );

      this._unexpandButton = new St.Button({
        style_class: "message-collapse-button",
        icon_name: "group-collapse-symbolic",
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
      });
      this._unexpandButton.connect("clicked", () =>
        this.emit("expand-toggle-requested"),
      );
      header.add_child(this._unexpandButton);

      clicker.connect(useGesture ? "recognize" : "clicked", () =>
        this.emit("expand-toggle-requested"),
      );

      this.add_child(header);
      this.add_child(cover);
    }

    get expanded() {
      // Consider this group to be expanded when it has only one message
      return this._expanded || this._messages.length === 1;
    }

    /** The tracked MediaMessages, top of the stack first. */
    get messages() {
      return [...this._messages];
    }

    get expandedHeight() {
      const [min] = this.layoutManager.getExpandedHeight(this, -1);
      return min;
    }

    get focusChild() {
      return this._focusChild;
    }

    canClose() {
      return false;
    }

    addMessage(message) {
      this._messages.unshift(message);

      message.connectObject(
        "key-focus-in",
        () => {
          this._focusChild = message;
          this.emit("message-focused", message);
        },
        "clicked",
        () => {
          // Collapsed, the whole card is the group's expand affordance;
          // raising the player would hide the stack the user is reaching
          // for. (Its own buttons still handle their own clicks.)
          if (!this.expanded) {
            GObject.signal_stop_emission_by_name(message, "clicked");
            this.emit("expand-toggle-requested");
          }
        },
        this,
      );

      this.insert_child_at_index(message, 0);
      this._ensureCoverPosition();
      this._updateStackedMessagesFade();
      this.emit("messages-changed");
    }

    removeMessage(message) {
      const index = this._messages.indexOf(message);
      if (index < 0) return;

      this._messages.splice(index, 1);
      if (this._focusChild === message) this._focusChild = null;
      message.disconnectObject(this);
      message.destroy();

      this._ensureCoverPosition();
      this._updateStackedMessagesFade();

      // Nothing left to expand into.
      if (this._expanded && this._messages.length <= 1)
        this.emit("expand-toggle-requested");
      this.emit("messages-changed");
    }

    /** Bring `message` to the front of the stack (it just started playing). */
    moveToTop(message) {
      const index = this._messages.indexOf(message);
      if (index <= 0) return;

      this._messages.splice(index, 1);
      this._messages.unshift(message);
      this.set_child_at_index(message, 0);
      this._ensureCoverPosition();
      this._updateStackedMessagesFade();
    }

    async expand() {
      if (this._expanded) return;

      this._headerBox.show();
      this._expanded = true;
      this._updateStackedMessagesFade();
      this.notify("expanded");
      this._cover.hide();

      await this.ease_property_async("@layout.expansion", 1, {
        progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        duration: GROUP_EXPANSION_TIME,
      }).catch(() => {});
    }

    async collapse() {
      if (!this._expanded) return;

      // Give focus to the fully visible message
      if (this._focusChild?.has_key_focus())
        this._messages[0]?.grab_key_focus();

      this._expanded = false;
      this.notify("expanded");
      this._cover.show();
      this._updateStackedMessagesFade();

      await this.ease_property_async("@layout.expansion", 0, {
        progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        duration: GROUP_EXPANSION_TIME,
      }).catch(() => {});

      this._headerBox.hide();
    }

    // Ensure that the cover is still below the top most message
    _ensureCoverPosition() {
      if (this.get_n_children() > 2) this.set_child_at_index(this._cover, 1);
    }

    /** Darken the cards behind the top one, the way the shell's stacks do. */
    _updateStackedMessagesFade() {
      const pseudoClasses = ["second-in-stack", "lower-in-stack"];

      // A message may have moved, so clear the classes from all of them first.
      for (const message of this._messages) {
        for (const name of pseudoClasses)
          message.remove_style_pseudo_class(name);
      }

      if (this.expanded) return;

      const [, second, ...lower] = this._messages;
      second?.add_style_pseudo_class(pseudoClasses[0]);
      // Use the same class for the third message and all messages after that,
      // since they won't be visible anyways
      for (const message of lower)
        message.add_style_pseudo_class(pseudoClasses[1]);
    }

    vfunc_paint(paintContext) {
      // Invert the paint order, so that messages are collapsed with the
      // newest message (the first child) on top of the stack
      for (const child of this.get_children().reverse())
        child.paint(paintContext);
    }

    vfunc_pick(pickContext) {
      // Invert the pick order, so that messages are collapsed with the
      // newest message (the first child) on top of the stack
      for (const child of this.get_children().reverse())
        child.pick(pickContext);
    }

    vfunc_get_focus_chain() {
      if (this.expanded) return this.get_children();
      const top = this._messages[0];
      return top ? [top] : [];
    }
  },
);

/**
 * Replaces MessageView's flat "one message per player" list with a single
 * MediaGroup holding them all.
 *
 * It does that by shadowing the view's own _addPlayer/_removePlayer - the only
 * two places the shell creates or drops a MediaMessage - so add and remove stay
 * in one pair of hands and the view's `messages` array never disagrees with what
 * is actually on screen. Restoring is a matter of dropping the two own
 * properties and handing every player back.
 */
export const MediaGrouping = GObject.registerClass(
  {
    GTypeName: "ImprovedMediaControlsMediaGrouping",
    Signals: {
      "messages-changed": {},
    },
  },
  class MediaGrouping extends GObject.Object {
    _init(messageView) {
      super._init();

      this._view = messageView;
      this._group = null;
      this._messages = new Map(); // shell MprisPlayer -> MediaMessage

      // Take back whatever the shell has already put in the list, then re-add
      // it through our own path.
      const existing = [...messageView._playerToMessage.keys()];
      for (const player of existing)
        guard(
          () => messageView._removePlayer(player),
          "ungrouping player failed",
        );

      messageView._addPlayer = (player) =>
        guard(() => this._addPlayer(player), "grouped player add failed");
      messageView._removePlayer = (player) =>
        guard(() => this._removePlayer(player), "grouped player remove failed");

      for (const player of existing)
        guard(() => this._addPlayer(player), "grouped player add failed");
    }

    get messages() {
      return this._group ? this._group.messages : [];
    }

    _addPlayer(player) {
      if (this._messages.has(player)) return;

      const message = new MediaMessage(player);
      this._messages.set(player, message);

      player.connectObject(
        "changed",
        () => guard(() => this._ensureBestOnTop(), "player change failed"),
        this,
      );

      this._ensureGroup();
      this._group.addMessage(message);
      this._ensureBestOnTop();
      this._syncViewMap();
    }

    _removePlayer(player) {
      const message = this._messages.get(player);
      if (!message) return;

      this._messages.delete(player);
      player.disconnectObject(this);
      this._group?.removeMessage(message);

      if (this._messages.size === 0) this._dropGroup();
      this._ensureBestOnTop();
      this._syncViewMap();
    }

    /**
     * Keep the card the panel label is describing on top of the stack: the
     * playing player wins over a paused one, the same rule MprisManager's
     * getBestPlayer() uses. Collapsed, the top card is the only one you see, so
     * a paused video in a browser tab must not hide the music that's actually
     * playing.
     *
     * Only reorders while collapsed (expanded, every card is visible anyway and
     * moving one would shuffle the list under the pointer), and only when the
     * top card isn't already playing - so a steady state never churns.
     */
    _ensureBestOnTop() {
      const group = this._group;
      if (!group || group.expanded) return;

      const stack = group.messages;
      if (stack.length < 2) return;

      // The player is closed out from under its message when its bus name
      // drops, and reading status then throws.
      const isPlaying = (message) => {
        try {
          return message._player?.status === "Playing";
        } catch (_) {
          return false;
        }
      };

      if (isPlaying(stack[0])) return;

      const best = stack.find(isPlaying);
      if (best) group.moveToTop(best);
    }

    _ensureGroup() {
      if (this._group) return;

      const group = new MediaGroup();
      this._group = group;

      group.connectObject(
        "expand-toggle-requested",
        () =>
          guard(() => {
            const target = this._view.expandedGroup === group ? null : group;
            this._view._setExpandedGroup(target).catch(logError);
          }, "group expand toggle failed"),
        "messages-changed",
        () => this.emit("messages-changed"),
        // Playback can change while the stack is open, and we deliberately
        // don't reorder then; re-sort as it closes so the card that ends up
        // on top is the right one.
        "notify::expanded",
        () =>
          guard(() => this._ensureBestOnTop(), "reorder on collapse failed"),
        "message-focused",
        (_g, actor) => this._view.emit("message-focused", actor),
        this,
      );

      this._view._addMessageAtIndex(group, 0);
    }

    _dropGroup() {
      const group = this._group;
      if (!group) return;

      this._group = null;
      group.disconnectObject(this);
      if (this._view.expandedGroup === group) this._view.collapse();
      // _removeMessage() animates the group out and destroys it (and, with it,
      // any message still inside).
      guard(() => this._view._removeMessage(group), "group removal failed");
      this.emit("messages-changed");
    }

    /** MessageView reads `_playerToMessage.size` to know how many media messages
     *  sit above the notification groups. With grouping that is 1 (the group) or
     *  0 - not the player count - so keep it honest. */
    _syncViewMap() {
      const map = this._view._playerToMessage;
      map.clear();
      if (this._group) map.set(this._group, this._group);
    }

    destroy() {
      const view = this._view;
      if (!view) return;

      delete view._addPlayer;
      delete view._removePlayer;

      const players = [...this._messages.keys()];
      for (const player of players) player.disconnectObject(this);
      this._messages.clear();

      this._dropGroup();
      view._playerToMessage.clear();
      this._view = null;

      // Hand every player back to the shell's own flat list.
      for (const player of players)
        guard(() => view._addPlayer(player), "restoring player failed");
    }
  },
);
