# Writing a generator

A generator is one file in `js/gen/`, a function from numbers to a watertight
solid, and a test file that proves it. Nothing else. If you find yourself needing
to touch the UI to add an object, something has gone wrong — the panel, the
catalogue card, the analysis column and the dimension callouts are all built from
the schema you declare.

## The shape of the file

```js
import { Mesh } from '../kernel/mesh.js';
import { roundRect, circle, boolean } from '../kernel/poly2d.js';
import { extrude, cylinder, roundedBox } from '../kernel/builders.js';

export default {
  id: 'coaster',                 // must equal the filename
  name: 'Coaster',
  category: 'Kitchen',           // Storage Utility Mechanism Lighting Decor Data Kitchen Toys
  blurb: 'A drinks coaster with a lip, in any shape you like.',
  description: 'Longer prose for the panel. Say what it is for and what the ' +
               'non-obvious parameters do.',
  version: 1,
  params: [
    { key: 'dia', label: 'Diameter', type: 'number', unit: 'mm',
      min: 40, max: 160, step: 1, def: 95, group: 'Size',
      help: 'Across the outside. A pint glass base is about 70 mm.' },
    { key: 'lip', label: 'Lip', type: 'bool', def: true, group: 'Shape',
      help: 'A raised rim that catches condensation.' },
  ],
  presets: [   // worked examples; the row shows "Custom" once any value diverges
    { name: 'Pint',   values: { dia: 95, lip: true } },
    { name: 'Mug',    values: { dia: 80, lip: false } },
    { name: 'Teapot', values: { dia: 150, lip: true } },
  ],
  build(p, ctx) { /* ... */ return mesh; },
  validate(p) { return []; },    // optional
  hints(p) { return { notes: [] } },  // optional
};
```

## A menu that carries values

An enum can declare `carries: (v, p) => ({ ...siblingValues })`. When the user
picks an option, the UI applies what it returns before rebuilding. Use it where
a choice implies other values a person would otherwise have to know — `pcbcase`'s
Board menu carries the board's port cutouts, tallest component and headroom.
Build the matching preset from the same function (`...boardCarries('pi4')`) so
the menu and the preset cannot drift apart. It fires only on a change the user
makes through the control; presets, reloads and the test hook `setParam` set
values without it. Return `{}` for an option that implies nothing (Custom).

## The four rules that are not negotiable

1. **Millimetres, Z up, counter-clockwise seen from outside.** `mesh.volume()`
   must come out positive. If it is negative your normals point inward and the
   slicer will produce something surprising.
2. **Return the mesh already placed**: centred in X/Y, base on `z = 0`. There is
   a `mesh.place()` that does exactly this; end your build with it.
3. **Watertight at every legal parameter value**, not just at the defaults. The
   test harness builds your generator at the minimum *and* maximum of every
   numeric parameter, and a leak at an extreme fails the same as a leak at
   the default.
4. **Deterministic.** No `Math.random()`, no `Date.now()`. If you want noise,
   take a `seed` parameter and use it.

## Build it, do not carve it

Prefer constructing geometry directly — a profile through `extrude` or `revolve`
— over subtracting shapes with `csg.js`. Direct construction is exact, produces
a tenth of the triangles, and cannot fail at a coplanar face. CSG is the escape
hatch for the cases where the shape genuinely is a difference of solids, and
every CSG result should still be checked by `analyze()`.

Where you do need a hole in a plate, cut it in **2D** with `poly2d.boolean` and
then extrude the result. That is a sweep of a 2D boolean, not a 3D one, and it is
both exact and fast.

## Do not redefine the small helpers

`clamp`, `num`, `segScale`, `DEG` and `RAD` live in `js/kernel/scalar.js`. Import
them:

```js
import { clamp, num, segScale, DEG } from '../kernel/scalar.js';
```

`TAU` comes from `mesh.js`, which already exports it.

They used to be copied into every generator — `clamp` into twelve files, `num`
into nine — and the copies were not all the same function. Two versions of `num`
disagreed about whether a numeric string counts as a number, which is invisible
through the interface and the CLI (both route parameters through `coerce()`
first) and reachable through the batch path in `tools/bluesheet.mjs`, which does not.
The surviving version parses strings.

Four helpers are deliberately still local to the generators that use them, and
should stay that way unless someone reconciles them on purpose: `lerp`, `int`,
`nseg` and `smoothstep`. Each exists in two or three forms that are not
equivalent — terrain's `lerp` is written `a * (1 - t) + b * t` because its tile
seams need the result to be exact at t = 0 and t = 1, and `a + (b - a) * t` is
not. Hoisting those would mean picking one and silently changing the others.

## Proving a refactor changed nothing

`node tools/mesh-snapshot.mjs write` fingerprints every generator at its defaults
and at every preset; `check` diffs a later run against that baseline. Use it any
time you touch shared code.

The suite answers "is this mesh still valid", which is a weaker question than "is
this the same mesh" — a generator can pass every conformance check while quietly
producing different geometry, and a rounding change in a shared helper does
exactly that. The fingerprints are the stronger question.

Take the same care with this tool that you would with a test. Its first version
read `mesh.vertices`, which does not exist — the field is `mesh.positions` — so
it recorded ninety-nine identical error strings, compared them to each other, and
reported IDENTICAL. It now refuses to write a baseline containing errors, and
counts an error on either side as a difference. Before trusting a clean result,
perturb something and confirm it comes back dirty.

## Quality, and what `ctx` is for

`ctx.segFactor` is 0.5 / 1 / 2 for draft / normal / fine. Multiply your segment
counts by it. Pick the normal-quality counts so the object looks right at about
40 mm across on screen; a 96-segment circle is smooth, a 24-segment one is a
visible polygon, and the difference in triangle count rarely matters.

## What `hints()` is really for

Not decoration. It is where you tell the person what this particular object needs
from the slicer, and why. A lithophane wants 100% infill and no top layers; a
vase wants spiral mode and five bottom layers; a hook wants to be printed on its
side so the load is not carried across the layers. Write it as advice a person
can act on:

```js
hints: (p) => ({
  profile: { layerH: 0.12, infill: 100, topLayers: 0, walls: 99 },
  supports: false,
  notes: [
    'Print with 100% infill and no top solid layers — a lithophane sliced ' +
    'normally has a solid skin over the image and will not glow.',
    `At ${p.layerH} mm layers this is ${Math.round(p.height / p.layerH)} layers.`,
  ],
})
```

## What `validate()` is really for

Catching the parameter combinations that produce an object which is technically a
solid and practically a failure. Walls thicker than half the box. A thread with a
negative clearance. A planetary gear set whose tooth counts cannot assemble. Say
which parameter is at fault and what the arithmetic is:

```js
validate: (p) => p.wall * 2 >= p.width
  ? [{ param: 'wall', severity: 'error',
       message: `Walls of ${p.wall} mm leave nothing inside a ${p.width} mm box — ` +
                `keep them under ${(p.width / 2 - 0.4).toFixed(1)} mm.` }]
  : []
```

## Dimension callouts

Return `{ mesh, meta: { dims: [...] } }` instead of a bare mesh and the viewer
will draw your dimensions onto the object in proper drawing style when the
matching parameter is focused:

```js
meta: { dims: [
  { param: 'dia', label: 'Ø', from: [-r, 0, h], to: [r, 0, h], offset: 8 },
  { param: 'wall', from: [ri, 0, h / 2], to: [ro, 0, h / 2], offset: [0, -1, 0] },
  { param: 'holes', label: 'holes', from: [0, 0, 0], to: [pitch, 0, 0], value: p.holes, unit: '' },
] }
```

The fields: `param` is the parameter the callout belongs to (it is drawn when
that parameter is focused). `from` and `to` are world millimetres on the built,
placed object — the same coordinates the mesh has after `place()`. `offset` is
how far the dimension line sits from the object, either a number of millimetres
(pushed away from the object's centre on screen) or a `[dx, dy, dz]` direction
to push it along. `value` overrides the figure written on it; leave it out and
the figure is the distance between the two points. `label` is the small caption
under the figure; `unit` defaults to millimetres.

The interface fills in what you do not declare: a number that is plainly one of
the three overall sizes gets that bounding-box edge dimensioned automatically,
and anything else — a count, an angle, a percentage — gets a leader note. So
declare callouts for the measurements the box cannot show: a wall thickness, a
lip height, a hole diameter, a pitch, a radius, a clearance. Put each one on the
feature it measures, in a place that reads from the default view.

This is checked. The conformance harness requires every generator to declare
at least one callout, requires at least one endpoint of each to lie on the object
(a radius is measured from a centre of curvature that is usually empty space), and
requires a callout that names a millimetre parameter (and declares no `value`)
to be exactly that many millimetres long — at the defaults and at every preset,
because a callout placed from the default geometry has a way of pointing at
nothing once the shape changes.

## Two colours: `meta.colourChangeZ`

A two-colour print by filament swap (a plate in one colour, raised work in
another) declares the height where the second colour starts:

```js
return { mesh, meta: { dims, colourChangeZ: plateThickness } };
```

That one number is the whole contract. Any build whose meta carries a finite
`colourChangeZ` gets two extra buttons under Download STL: **Bambu project
(.3mf)**, a Bambu Studio project with the A1 mini profile, two filaments and the
swap already on the layer slider (`js/kernel/bambu.js`), and **Open in Bambu
Studio**, which hands the same file to Bambu Studio by URL. Neither appears for a
build without it. Give the height of the boundary itself (the plate top), not the
first layer above it: the writer works out the layer from the profile's layer
height. Keep it a whole number of layers, or the swap waits for the next one.
`comic` and `qrplaque` declare it.

## The test file

```js
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance } from './lib/genconform.mjs';
import gen from '../js/gen/coaster.js';

suite('gen coaster');
conformance(gen, 'coaster');      // the whole shared contract, including the sweep

// then the checks only you can write: is it the RIGHT solid?
const m = gen.build({ dia: 100, lip: true }, ctx());
nearPct('a 100 mm coaster measures 100 mm across', m.bbox().size[0], 100, 0.5);
done();
```

`conformance()` proves it is *a* solid. Your own checks prove it is *the* solid.
Both halves are required; a suite that is only `conformance()` has tested that
your generator produces something, which is not the same as testing that it works.
