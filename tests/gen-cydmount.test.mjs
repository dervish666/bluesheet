import { suite, check, done } from './lib/assert.mjs';
import { conformance, ctx, defaults } from './lib/genconform.mjs';
import gen from '../js/gen/cydmount.js';
suite('gen cydmount');
conformance(gen, 'cydmount');
done();
