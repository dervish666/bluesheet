import { suite, check, done } from './lib/assert.mjs';
import { conformance, ctx, defaults } from './lib/genconform.mjs';
import gen from '../js/gen/pcbcase.js';
suite('gen pcbcase');
conformance(gen, 'pcbcase');
done();
