import { suite, check, done } from './lib/assert.mjs';
import { conformance, ctx, defaults } from './lib/genconform.mjs';
import gen from '../js/gen/qrplaque.js';
suite('gen qrplaque');
conformance(gen, 'qrplaque');
done();
