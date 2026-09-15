// The title block.
//
// Bottom-right inside the viewport, drawn in hairlines with ink lettering,
// exactly where it sits on a real drawing. It is not decoration: the material,
// the scale and the mass appear nowhere else on the page, and it is what makes a
// screenshot of the viewport self-describing — which object, how big, how heavy,
// which revision.
//
// The revision ticks on every completed rebuild. That is the whole point of a
// revision: it is not the parameter hash, it is "how many times has this drawing
// changed since you opened it", and a person watching the corner of the screen
// can see that their change landed.

import { $, reducedMotion } from './dom.js';
import { size3, cm3, grams, scaleRatio, materialName } from './format.js';

export class TitleBlock {
  constructor(root) {
    this.root = root;
    this.rev = 0;
    this.f = {
      name: $('[data-tb-name]', root),
      rev: $('[data-tb-rev]', root),
      variant: $('[data-tb-variant]', root),
      material: $('[data-tb-material]', root),
      scale: $('[data-tb-scale]', root),
      size: $('[data-tb-size]', root),
      volume: $('[data-tb-volume]', root),
      mass: $('[data-tb-mass]', root),
    };
    this.state = {};
  }

  /** Called once per completed geometry rebuild. */
  tick() {
    this.rev++;
    const el = this.f.rev;
    if (!el) return this.rev;
    el.textContent = String(this.rev).padStart(3, '0');
    if (!reducedMotion()) {
      el.classList.remove('is-ticking');
      void el.offsetWidth;                 // restart the animation, not queue it
      el.classList.add('is-ticking');
    }
    return this.rev;
  }

  /**
   * @param {object} s {gen, variant, material, size, volume, mass, pxPerMm}
   */
  set(s) {
    Object.assign(this.state, s);
    const st = this.state;
    put(this.f.name, st.gen ? String(st.gen).toUpperCase() : '—');
    put(this.f.variant, st.variant ? String(st.variant).toUpperCase() : 'CUSTOM');
    put(this.f.material, materialName(st.material));
    put(this.f.scale, Number.isFinite(st.pxPerMm) && st.pxPerMm > 0 ? scaleRatio(st.pxPerMm) : '—');
    put(this.f.size, st.size ? size3(st.size) : '—');
    put(this.f.volume, Number.isFinite(st.volume) ? cm3(st.volume) : '—');
    put(this.f.mass, Number.isFinite(st.mass) ? grams(st.mass) : '—');
    return this;
  }

  /** Only the scale figure, which changes with every zoom and must not drag the
   *  rest of the block through a DOM write on every frame. */
  setScale(pxPerMm) {
    this.state.pxPerMm = pxPerMm;
    put(this.f.scale, Number.isFinite(pxPerMm) && pxPerMm > 0 ? scaleRatio(pxPerMm) : '—');
    return this;
  }

  text() {
    return this.root.innerText.replace(/\s+/g, ' ').trim();
  }
}

function put(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
