import { MAP_H, MAP_W } from "./constants";
import type { GameGrid } from "./grid";

/**
 * A* pathfinding over the tile grid.
 * Per-tile cost comes from caller-supplied PathRules so walls/buildings can be
 * passable or not depending on the moving team (e.g. enemies smash walls).
 */
export interface PathRules {
  /** cost multiplier for stepping onto a tile; Infinity = impassable */
  tileCost(tx: number, ty: number): number;
}

/**
 * Binary min-heap over (tileIndex, fScore) pairs.
 *
 * Backed by preallocated typed arrays: with epic armies the pathfinder runs
 * tens of thousands of pushes/pops per second and the plain-array version
 * showed up as ~10% of total sim time in the CPU profile. The comparison and
 * sift-down order are *identical* to the previous implementation, so A*
 * expands nodes in exactly the same order and produces byte-identical paths
 * (verified by scripts/perf-test.ts against recorded sim fingerprints).
 */
class MinHeap {
  private a: Int32Array;
  private f: Float64Array;
  private n = 0;

  constructor(cap = 4096) {
    const c = Math.max(64, cap | 0);
    this.a = new Int32Array(c);
    this.f = new Float64Array(c);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  private grow(): void {
    const cap = this.a.length * 2;
    const a = new Int32Array(cap);
    a.set(this.a);
    this.a = a;
    const f = new Float64Array(cap);
    f.set(this.f);
    this.f = f;
  }

  push(idx: number, fVal: number): void {
    if (this.n >= this.a.length) this.grow();
    const a = this.a;
    const f = this.f;
    let i = this.n++;
    a[i] = idx;
    f[i] = fVal;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[p] <= f[i]) break;
      const ta = a[p];
      a[p] = a[i];
      a[i] = ta;
      const tf = f[p];
      f[p] = f[i];
      f[i] = tf;
      i = p;
    }
  }

  pop(): number {
    const a = this.a;
    const f = this.f;
    const top = a[0];
    const lastI = a[--this.n];
    const lastF = f[this.n];
    if (this.n > 0) {
      a[0] = lastI;
      f[0] = lastF;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && f[l] < f[m]) m = l;
        if (r < this.n && f[r] < f[m]) m = r;
        if (m === i) break;
        const ta = a[m];
        a[m] = a[i];
        a[i] = ta;
        const tf = f[m];
        f[m] = f[i];
        f[i] = tf;
        i = m;
      }
    }
    return top;
  }
}

const SQ2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export class Pathfinder {
  private g: Float32Array;
  private came: Int32Array;
  private seenStamp: Int32Array;
  private closedStamp: Int32Array;
  private curStamp = 1;
  private heap: MinHeap;

  constructor(private grid: GameGrid) {
    const n = MAP_W * MAP_H;
    // A* can hold a large frontier on big maps; start close to that so the
    // typed arrays rarely have to regrow mid-search
    this.heap = new MinHeap(Math.max(1024, n >> 2));
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.seenStamp = new Int32Array(n);
    this.closedStamp = new Int32Array(n);
  }

  /** Nearest tile around (tx,ty) within radius r that rules consider walkable */
  nearestOpen(tx: number, ty: number, r: number, rules: PathRules): number {
    if (!this.grid.inBounds(tx, ty)) return -1;
    for (let rad = 0; rad <= r; rad++) {
      let best = -1;
      let bestD = 1e9;
      for (let y = ty - rad; y <= ty + rad; y++) {
        for (let x = tx - rad; x <= tx + rad; x++) {
          if (!this.grid.inBounds(x, y)) continue;
          if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) !== rad) continue;
          if (!isFinite(rules.tileCost(x, y))) continue;
          const dist = (x - tx) * (x - tx) + (y - ty) * (y - ty);
          if (dist < bestD) {
            bestD = dist;
            best = y * MAP_W + x;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  private heur(ax: number, ay: number, bx: number, by: number): number {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return dx + dy + (SQ2 - 2) * Math.min(dx, dy);
  }

  /**
   * A* from (sx,sy) to (gx,gy). Returns packed tile indices
   * (start excluded, goal included) or null if unreachable.
   */
  find(
    sx: number,
    sy: number,
    gx: number,
    gy: number,
    rules: PathRules,
    maxNodes = 12000,
  ): number[] | null {
    if (!this.grid.inBounds(sx, sy) || !this.grid.inBounds(gx, gy))
      return null;
    this.heap.clear();
    const start = sy * MAP_W + sx;
    const goal = gy * MAP_W + gx;
    if (start === goal) return [goal];

    const stamp = ++this.curStamp;
    const g = this.g;
    const came = this.came;
    const seen = this.seenStamp;
    const closed = this.closedStamp;
    const heap = this.heap;

    seen[start] = stamp;
    g[start] = 0;
    came[start] = -1;
    heap.push(start, this.heur(sx, sy, gx, gy));

    let expanded = 0;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed[cur] === stamp) continue;
      closed[cur] = stamp;
      if (cur === goal) {
        const rev: number[] = [];
        let c = goal;
        let guard = 0;
        while (c !== start && c !== -1 && guard++ < MAP_W * MAP_H) {
          rev.push(c);
          c = came[c];
        }
        if (c !== start) return null; // broken chain — never return garbage
        rev.reverse();
        return rev;
      }
      if (++expanded > maxNodes) return null;

      const cx = cur % MAP_W;
      const cy = (cur / MAP_W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (!this.grid.inBounds(nx, ny)) continue;
        const n = ny * MAP_W + nx;
        if (closed[n] === stamp) continue;
        const tc = rules.tileCost(nx, ny);
        if (!isFinite(tc)) continue;
        if (d >= 4) {
          // no diagonal corner-cutting
          if (!isFinite(rules.tileCost(cx + DX[d], cy))) continue;
          if (!isFinite(rules.tileCost(cx, cy + DY[d]))) continue;
        }
        const step = (d < 4 ? 1 : SQ2) * tc;
        const ng = g[cur] + step;
        if (seen[n] === stamp && ng >= g[n]) continue;
        seen[n] = stamp;
        g[n] = ng;
        came[n] = cur;
        heap.push(n, ng + this.heur(nx, ny, gx, gy));
      }
    }
    return null;
  }

  /** Bresenham line-of-sight walkability using rules */
  hasLOS(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    rules: PathRules,
  ): boolean {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (let i = 0; i < 4096; i++) {
      if (!isFinite(rules.tileCost(x, y))) return false;
      if (x === x1 && y === y1) return true;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
    return false;
  }

  /** String-pulling: drop waypoints when straight-line LOS is walkable */
  smooth(
    path: number[],
    sx: number,
    sy: number,
    rules: PathRules,
  ): number[] {
    if (path.length <= 2) return path;
    const pts: Array<[number, number]> = [[sx, sy]];
    for (const p of path) pts.push([p % MAP_W, (p / MAP_W) | 0]);
    const out: number[] = [];
    let anchor = 0;
    let i = 2;
    while (i < pts.length) {
      const [ax, ay] = pts[anchor];
      if (!this.hasLOS(ax, ay, pts[i][0], pts[i][1], rules)) {
        const prev = pts[i - 1];
        out.push(prev[1] * MAP_W + prev[0]);
        anchor = i - 1;
      }
      i++;
    }
    const last = pts[pts.length - 1];
    out.push(last[1] * MAP_W + last[0]);
    return out;
  }
}
