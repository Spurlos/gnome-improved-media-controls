/** Run `fn`, swallowing and logging any exception. Our timer/signal callbacks
 *  run inside GLib sources where an uncaught exception is FATAL,it aborts the
 *  whole shell so nothing here may ever be allowed to throw out. */
export function guard(fn, label) {
  try {
    return fn();
  } catch (e) {
    logError(e, `ImprovedMediaControls: ${label}`);
    return undefined;
  }
}
