// landing.js: scroll-driven jet fly-in -- a faithful vanilla port of the
// framer-motion ScrollFlyIn component (hero-section-3), same math, no deps:
//   x        = lerp(-5*W, +2.5*W) over scrollYProgress 0.1 -> 0.8
//   opacity  = keyframes [0,1,1,0] at [0.1, 0.25, 0.7, 0.8]
// The jet crosses the screen once per scroll; hidden again afterwards.
'use strict';

const W = () => window.innerWidth;
const jet = document.getElementById('jet');
const target = document.getElementById('flyin-target');

// linear interpolation of scroll progress p (0..1) between a and b
const lerp = (p, a, b) => a + (b - a) * p;

// framer-motion useTransform equivalent: piecewise linear over keyframes
function transform(p, stops, values) {
  if (p <= stops[0]) return values[0];
  for (let i = 1; i < stops.length; i++) {
    if (p <= stops[i]) {
      const t = (p - stops[i - 1]) / (stops[i] - stops[i - 1]);
      return lerp(t, values[i - 1], values[i]);
    }
  }
  return values[values.length - 1];
}

// scrollYProgress: 0 when the section's top hits the viewport bottom, 1 when
// its bottom passes the viewport top (same offsets as the original hook).
function progress() {
  const rect = target.getBoundingClientRect();
  const vh = window.innerHeight;
  const total = rect.height + vh;
  const passed = vh - rect.top;
  return Math.min(1, Math.max(0, passed / total));
}

function onScroll() {
  const p = progress();
  const x = transform(p, [0.1, 0.8], [-5 * W(), 2.5 * W()]);
  const opacity = transform(p, [0.1, 0.25, 0.7, 0.8], [0, 1, 1, 0]);
  jet.style.transform = `translateX(${x}px)`;
  jet.style.opacity = String(opacity);
}

// rAF throttle: at most one style write per frame
let ticking = false;
window.addEventListener('scroll', () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(() => { onScroll(); ticking = false; });
  }
}, { passive: true });
onScroll();
