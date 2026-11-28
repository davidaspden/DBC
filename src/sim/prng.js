/**
 * Shared deterministic PRNG utilities (`src/sim/prng.js`).
 * Zero external dependencies; never uses `Math.random`.
 */

/**
 * Deterministic mulberry32 PRNG returning floats in [0, 1).
 *
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x6d2b79f5;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
