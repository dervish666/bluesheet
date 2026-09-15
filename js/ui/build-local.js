// The window-thread fallback.
//
// Used when the browser has no module workers, or when the worker failed to
// start. It runs exactly the same pipeline — build-core.js — so the fallback is
// not a second, less-tested implementation of the same protocol.
//
// It cannot stop a generator's synchronous build() from holding the thread, so
// it does the two things it can: yield to the event loop first, so the page has
// painted the busy state before the stall begins, and drop the transfer list,
// because transferring a buffer here would detach the only copy of it.

import { handle } from './build-core.js';

/** Yield to the browser: a paint, then a task. */
function yieldToPaint() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}

export async function run(msg, post) {
  await yieldToPaint();
  // build-core awaits what the mesh reply returns, so returning a promise here
  // is what puts a paint between the new object and the checks that follow it.
  await handle(msg, (m) => {
    post(m);
    return m.type === 'mesh' ? yieldToPaint() : undefined;
  });
}
