// The inspector's thread.
//
// A thin shell around inspect-core.js: take a message off the bus, run the
// pipeline, put the replies back. Parsing a 30 MB STL happens here so the page
// keeps painting; the same `handle` runs on the window thread when the browser
// has no module workers, so the two paths cannot drift.

import { handle } from './inspect-core.js';

self.onmessage = (ev) => {
  handle(ev.data || {}, (m, transfer) => self.postMessage(m, transfer || []));
};
