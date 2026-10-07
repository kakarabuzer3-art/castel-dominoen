// Deterministic RNG + value noise for map generation.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Seeded 2D value noise, returns 0..1 */
export function valueNoise(
  x: number,
  y: number,
  seed: number,
  freq: number,
): number {
  const fx = x * freq;
  const fy = y * freq;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const s = (a: number, b: number) => hash2(a + seed * 7919, b + seed * 104729);
  const v00 = s(x0, y0);
  const v10 = s(x0 + 1, y0);
  const v01 = s(x0, y0 + 1);
  const v11 = s(x0 + 1, y0 + 1);
  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  );
}

export function fbm(
  x: number,
  y: number,
  seed: number,
  freq: number,
  octaves = 2,
): number {
  let sum = 0;
  let amp = 0.5;
  let f = freq;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x, y, seed + i * 131, f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}
