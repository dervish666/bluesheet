// The geometry thread.
//
// A thin shell around build-core.js: take a message off the bus, run the
// pipeline, put the replies back. The pipeline itself is shared with
// build-local.js so that the fallback path and the fast path cannot drift.

import { handle } from './build-core.js';

self.onmessage = (ev) => {
  handle(ev.data || {}, (m, transfer) => self.postMessage(m, transfer || []));
};
