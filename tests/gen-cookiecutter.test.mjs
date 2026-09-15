import { suite, check, done } from './lib/assert.mjs';
import { conformance, ctx, defaults } from './lib/genconform.mjs';
import gen from '../js/gen/cookiecutter.js';
suite('gen cookiecutter');
conformance(gen, 'cookiecutter');
done();
