/**
 * Shared statistical helpers (`src/util/stats.js`).
 * Zero external dependencies.
 */

/**
 * Computes the `p`-th percentile (`p` in `[0, 1]`) of an already-sorted ascending
 * numeric array or TypedArray (O(1), zero copy).
 * Returns `0` for empty input.
 *
 * @param {ArrayLike<number>} sorted
 * @param {number} p
 * @returns {number}
 */
export function percentileSorted(sorted, p) {
  if (!sorted || sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Computes the `p`-th percentile (`p` in `[0, 1]`) of a numeric array or TypedArray
 * (sorted or unsorted; never mutates the input).
 * Returns `0` for empty input.
 *
 * @param {ArrayLike<number>} values
 * @param {number} p
 * @returns {number}
 */
export function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  let isSorted = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) {
      isSorted = false;
      break;
    }
  }
  if (isSorted) return percentileSorted(values, p);
  const copy = Array.from(values).sort((a, b) => a - b);
  return percentileSorted(copy, p);
}

/**
 * Computes the exact median of a numeric array or TypedArray (never mutates the input).
 * Returns `0` for empty input.
 *
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
export function median(values) {
  if (!values || values.length === 0) return 0;
  const copy = Array.from(values).sort((a, b) => a - b);
  const mid = copy.length >> 1;
  return (copy.length & 1) === 1 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}
