import {
  MAPS,
  MAP_DIMS,
  mapAreaScale,
  MAP_H,
  MAP_W,
  NODE_DEFS,
  RICHNESS_MULT,
  T_BRIDGE,
  T_DIRT,
  T_FORD,
  T_GRASS,
  T_OASIS,
  T_ROCKY,
  T_WATER,
  setMapSize,
  type MapArch,
  type MapSize,
} from "./constants";
import { fbm, hash2, mulberry32 } from "./rng";
import type { NodeType, RNode } from "./types";

/**
 * Static terrain + dynamic occupancy grid.
 * occ[i] = 0 empty, -1 water/impassable terrain, >0 entity id occupying tile.
 *
 * Every method indexes with `this.w`/`this.h` rather than the module-level
 * MAP_W/MAP_H, so a second grid can exist without corrupting the first: the
 * setup screen builds a preview grid while a finished match's grid is still on
 * screen, and mixed sizes (preview M over a played XL) used to scramble
 * idx()/connected(). The constructor still publishes the size through
 * setMapSize() for the modules that render and pathfind the *live* match.
 */
export type MapTheme = "green" | "desert";

export class GameGrid {
  w = MAP_W;
  h = MAP_H;
  theme: MapTheme = "green";
  terrain: Uint8Array;
  occ: Int32Array;
  /** Distance-to-water-ish shading & precomputed per-tile tone, used by renderer */
  tone: Float32Array;

  arch: MapArch = "verdant";
  richness = 1;

  constructor(
    public seed: number,
    arch: MapArch = "verdant",
    size: MapSize = "M",
    richness = 1,
  ) {
    let a = arch;
    if (a === "random") {
      const pool: MapArch[] = [
        "verdant",
        "desert",
        "oasis",
        "riverlands",
        "mountain",
        "twin",
      ];
      a = pool[(Math.random() * pool.length) | 0];
    }
    this.arch = a;
    this.richness = richness;
    const dim = MAP_DIMS[size];
    setMapSize(dim, dim);
    this.w = dim;
    this.h = dim;
    this.theme = MAPS.find((m) => m.id === a)?.theme === "desert" ? "desert" : "green";
    this.terrain = new Uint8Array(dim * dim);
    this.occ = new Int32Array(dim * dim);
    this.tone = new Float32Array(dim * dim);
    this.generate();
  }

  /**
   * Keep positions for *this* grid. Mirrors constants.startPositions() (which
   * reads the module-level MAP_W/MAP_H and is therefore only correct for the
   * live match grid) so generation and node scattering stay self-contained.
   */
  starts(): Array<{ x: number; y: number }> {
    return [
      { x: Math.round(this.w * 0.125), y: Math.round(this.h * 0.875) },
      { x: Math.round(this.w * 0.875), y: Math.round(this.h * 0.125) },
    ];
  }

  idx(tx: number, ty: number): number {
    return ty * this.w + tx;
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }

  isWater(tx: number, ty: number): boolean {
    return this.terrain[this.idx(tx, ty)] === T_WATER;
  }

  /** Blocked by terrain or entity (walls are handled separately by pathing) */
  isBlocked(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    return this.occ[this.idx(tx, ty)] !== 0;
  }

  setOcc(tx: number, ty: number, id: number): void {
    if (this.inBounds(tx, ty)) this.occ[this.idx(tx, ty)] = id;
  }

  clearOcc(tx: number, ty: number): void {
    if (this.inBounds(tx, ty)) this.occ[this.idx(tx, ty)] = 0;
  }

  // ── generation ─────────────────────────────────────────────────────────────

  private generate(): void {
    const seed = this.seed;
    const T = this.terrain;

    // Base elevation → water / grass / rocky (theme-tuned thresholds)
    const desert = this.theme === "desert";
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const e = fbm(x, y, seed, 0.045, 3);
        const m = fbm(x + 500, y - 300, seed + 17, 0.08, 2);
        let t: number = T_GRASS;
        if (e < (desert ? 0.3 : 0.34)) t = T_WATER;
        else if (e > (desert ? 0.6 : 0.66) && m > (desert ? 0.4 : 0.45)) t = T_ROCKY;
        else if (m < (desert ? 0.42 : 0.32)) t = T_DIRT;
        T[y * this.w + x] = t;
        this.tone[y * this.w + x] = hash2(x * 3 + 11, y * 5 + 7);
      }
    }
    if (desert) this.carveOases(this.arch === "oasis" ? 16 : 8);

    // archetype features
    if (this.arch === "riverlands") this.carveRiver();
    else if (this.arch === "twin") this.carveTwinLakes();
    else if (this.arch === "mountain") this.carveRidge();

    // Flatten & dry the two castle areas
    for (const p of this.starts()) {
      this.flatten(p.x, p.y, 8);
    }

    // Carve a guaranteed dry corridor between the two keeps
    this.carveCorridor();

    // Remove isolated water pockets smaller than 12 tiles (visual cleanliness)
    this.cleanSmallLakes();

    // Water marks occ as permanently blocked
    for (let i = 0; i < T.length; i++) {
      if (T[i] === T_WATER) this.occ[i] = -1;
    }

    // final safety: guarantee connectivity with a ford line if needed
    const [fa, fb] = this.starts();
    if (!this.connected(fa.x, fa.y, fb.x, fb.y)) {
      const steps = 200;
      for (let i = 0; i <= steps; i++) {
        const x = Math.round(fa.x + ((fb.x - fa.x) * i) / steps);
        const y = Math.round(fa.y + ((fb.y - fa.y) * i) / steps);
        for (let dy = -1; dy <= 1; dy++) {
          if (!this.inBounds(x, y + dy)) continue;
          const id = this.idx(x, y + dy);
          if (this.terrain[id] === T_WATER) {
            this.terrain[id] = T_FORD;
            this.occ[id] = 0;
          }
        }
      }
    }
  }

  // ── archetype features ─────────────────────────────────────────────────────

  private riverX(y: number): number {
    return (
      this.w / 2 +
      Math.sin(y * 0.07 + (this.seed % 7)) * 4 +
      Math.sin(y * 0.021) * 6
    );
  }

  private carveRiver(): void {
    const T = this.terrain;
    for (let y = 0; y < this.h; y++) {
      const cx = this.riverX(y);
      for (let x = Math.floor(cx - 2); x <= Math.ceil(cx + 2); x++) {
        if (!this.inBounds(x, y)) continue;
        if (Math.abs(x - cx) <= 1.6) T[this.idx(x, y)] = T_WATER;
      }
    }
    for (const f of [0.24, 0.5, 0.76]) {
      const y = Math.round(this.h * f);
      const cx = Math.round(this.riverX(y));
      for (let x = cx - 3; x <= cx + 3; x++)
        for (const dy of [0, -1, 1])
          if (this.inBounds(x, y + dy) && T[this.idx(x, y + dy)] === T_WATER)
            T[this.idx(x, y + dy)] = T_BRIDGE;
    }
    for (const f of [0.37, 0.63]) {
      const y = Math.round(this.h * f);
      const cx = Math.round(this.riverX(y));
      for (let x = cx - 1; x <= cx + 1; x++)
        if (this.inBounds(x, y)) T[this.idx(x, y)] = T_FORD;
    }
  }

  private carveTwinLakes(): void {
    const T = this.terrain;
    const cy = Math.round(this.h / 2);
    for (let y = cy - 3; y <= cy + 3; y++) {
      for (let x = 6; x < this.w - 6; x++) {
        const causeway =
          Math.abs(x - this.w * 0.22) < 2.5 || Math.abs(x - this.w * 0.78) < 2.5;
        if (!causeway) T[this.idx(x, y)] = T_WATER;
      }
    }
  }

  private carveRidge(): void {
    const T = this.terrain;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const t = x / this.w;
        const ly = this.h * (0.78 - 0.56 * t);
        const d = Math.abs(y - ly);
        if (d < 4.2) {
          const pass =
            Math.hypot(x - this.w * 0.3, y - this.h * (0.78 - 0.56 * 0.3)) < 5 ||
            Math.hypot(x - this.w * 0.72, y - this.h * (0.78 - 0.56 * 0.72)) < 5;
          if (!pass) T[this.idx(x, y)] = T_ROCKY;
        }
      }
    }
  }

  /** desert: small oasis lakes ringed by lush grass and palms */
  private carveOases(count?: number): void {
    const rnd = mulberry32(this.seed * 31 + 7);
    const oases = count ?? 7 + ((rnd() * 4) | 0);
    for (let i = 0; i < oases; i++) {
      const cx = 10 + rnd() * (this.w - 20);
      const cy = 10 + rnd() * (this.h - 20);
      const r = 2 + rnd() * 2.2;
      for (let y = Math.floor(cy - r - 3); y <= cy + r + 3; y++) {
        for (let x = Math.floor(cx - r - 3); x <= cx + r + 3; x++) {
          if (!this.inBounds(x, y)) continue;
          const d = Math.hypot(x - cx, y - cy);
          const id = this.idx(x, y);
          if (d <= r * (0.75 + rnd() * 0.4)) this.terrain[id] = T_WATER;
          else if (d <= r + 2.2) this.terrain[id] = T_OASIS;
        }
      }
    }
  }

  private flatten(cx: number, cy: number, r: number): void {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (!this.inBounds(x, y)) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r) {
          const i = this.idx(x, y);
          // keep oasis water near bases? flatten clears everything to grass/sand base
          this.terrain[i] = this.theme === "desert" && d > r - 2 ? T_DIRT : T_GRASS;
        }
      }
    }
  }

  private carveCorridor(): void {
    const [a, b] = this.starts();
    const steps = 260;
    const wob = (t: number, s: number) =>
      Math.sin(t * 5.1 + s) * 5 + Math.sin(t * 11.7 + s * 2) * 3;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Perpendicular wobble so the road is not a straight line
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const nx = -(b.y - a.y);
      const ny = b.x - a.x;
      const len = Math.hypot(nx, ny) || 1;
      const off = wob(t, this.seed * 0.013);
      const cx = Math.round(px + (nx / len) * off);
      const cy = Math.round(py + (ny / len) * off);
      for (let y = cy - 3; y <= cy + 3; y++) {
        for (let x = cx - 3; x <= cx + 3; x++) {
          if (!this.inBounds(x, y)) continue;
          if (Math.hypot(x - cx, y - cy) <= 3) {
            const id = this.idx(x, y);
            // rivers/lakes keep their water: bridges & causeways are the crossings
            const keepWater =
              this.arch === "riverlands" || this.arch === "twin";
            if (this.terrain[id] === T_WATER && !keepWater)
              this.terrain[id] = T_DIRT;
          }
        }
      }
    }
  }

  private cleanSmallLakes(): void {
    const seen = new Uint8Array(this.w * this.h);
    for (let i = 0; i < seen.length; i++) {
      if (seen[i] || this.terrain[i] !== T_WATER) continue;
      // flood fill this lake
      const cells: number[] = [i];
      seen[i] = 1;
      let head = 0;
      while (head < cells.length) {
        const c = cells[head++];
        const cx = c % this.w;
        const cy = (c / this.w) | 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.inBounds(nx, ny)) continue;
          const n = this.idx(nx, ny);
          if (!seen[n] && this.terrain[n] === T_WATER) {
            seen[n] = 1;
            cells.push(n);
          }
        }
      }
      if (cells.length < 14) {
        for (const c of cells) this.terrain[c] = T_GRASS;
      }
    }
  }

  // ── connectivity check ─────────────────────────────────────────────────────

  /** True if b is reachable from a over non-water tiles */
  connected(ax: number, ay: number, bx: number, by: number): boolean {
    const seen = new Uint8Array(this.w * this.h);
    const q: number[] = [this.idx(ax, ay)];
    seen[q[0]] = 1;
    let head = 0;
    const goal = this.idx(bx, by);
    while (head < q.length) {
      const c = q[head++];
      if (c === goal) return true;
      const cx = c % this.w;
      const cy = (c / this.w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.inBounds(nx, ny)) continue;
          const n = this.idx(nx, ny);
          if (!seen[n] && this.terrain[n] !== T_WATER) {
            seen[n] = 1;
            q.push(n);
          }
        }
      }
    }
    return false;
  }

  // ── resource node scattering ───────────────────────────────────────────────

  scatterNodes(idStart: number): RNode[] {
    const RM = RICHNESS_MULT[this.richness] ?? 1;
    const rnd = mulberry32(this.seed * 7 + 13);
    const nodes: RNode[] = [];
    let nid = idStart;
    const occupied = new Uint8Array(this.w * this.h);
    // mark water + corridor + keep zones as no-node areas
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.terrain[this.idx(x, y)] === T_WATER)
          occupied[this.idx(x, y)] = 1;
      }
    }
    for (const p of this.starts()) {
      for (let y = p.y - 5; y <= p.y + 5; y++)
        for (let x = p.x - 5; x <= p.x + 5; x++)
          if (this.inBounds(x, y)) occupied[this.idx(x, y)] = 1;
    }

    const place = (tx: number, ty: number, kind: NodeType, force = false): boolean => {
      if (!this.inBounds(tx, ty)) return false;
      const i = this.idx(tx, ty);
      if (occupied[i]) return false;
      if (kind === "tree" && this.terrain[i] === T_ROCKY) return false;
      if (kind !== "tree" && this.terrain[i] !== T_ROCKY && !force && rnd() < 0.85)
        return false; // ores mostly on rocky ground
      if (kind !== "tree" && force && this.terrain[i] !== T_ROCKY)
        this.terrain[i] = T_ROCKY; // visual consistency for forced starter ores
      occupied[i] = 1;
      const def = NODE_DEFS[kind];
      const amount = Math.round(def.amount * RM);
      nodes.push({
        id: nid++,
        kind,
        tx,
        ty,
        amount,
        maxAmount: amount,
        variant: (rnd() * 1000) | 0,
      });
      return true;
    };

    const placeCluster = (
      cx: number,
      cy: number,
      count: number,
      spread: number,
      kind: NodeType,
      force = false,
    ) => {
      let placed = 0;
      let guard = 0;
      while (placed < count && guard++ < count * 12) {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rnd()) * spread;
        if (
          place(
            Math.round(cx + Math.cos(a) * r),
            Math.round(cy + Math.sin(a) * r),
            kind,
            force,
          )
        )
          placed++;
      }
    };

    // Forest clusters (bias using noise); desert gets sparse palm groves
    const desert = this.theme === "desert";
    // Density scaling. S/M/L keep the historical linear term exactly (their
    // terrain+node fingerprints are regression-tested); XL — 2.4x the area of
    // L — uses true area scaling so forests do not thin out on the big map.
    const areaK = this.w > 128 ? mapAreaScale(this.w) : 1;
    const sizeTerm = this.w > 128 ? areaK : this.w / 104;
    const clusters = Math.round(
      (desert ? 60 : 90) * sizeTerm * (0.7 + RM * 0.3),
    );
    for (let i = 0; i < clusters; i++) {
      const cx = 4 + rnd() * (this.w - 8);
      const cy = 4 + rnd() * (this.h - 8);
      const forest = fbm(cx, cy, this.seed + 91, 0.05, 2);
      if (forest < (desert ? 0.5 : 0.42)) continue;
      const here = this.terrain[this.idx(Math.round(cx), Math.round(cy))];
      if (desert && here !== T_OASIS && here !== T_DIRT && rnd() < 0.7) continue;
      placeCluster(
        cx,
        cy,
        (desert ? 3 : 5) + (((forest - (desert ? 0.5 : 0.42)) * (desert ? 12 : 24)) | 0),
        desert ? 3 : 4.5,
        "tree",
      );
    }
    if (desert) {
      // palm rings around every oasis
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          if (this.terrain[this.idx(x, y)] !== T_OASIS) continue;
          if (rnd() < 0.16) place(x, y, "tree", true);
        }
      }
    }

    // Stone + gold on rocky areas (attempt count scales with XL area)
    const oreTries = Math.round(70 * areaK);
    for (let i = 0; i < oreTries; i++) {
      const cx = 4 + rnd() * (this.w - 8);
      const cy = 4 + rnd() * (this.h - 8);
      if (this.terrain[this.idx(Math.round(cx), Math.round(cy))] !== T_ROCKY)
        continue;
      placeCluster(cx, cy, 3 + (rnd() * 4) | 0, 2.6, "rock");
      if (rnd() < 0.45) placeCluster(cx + 2, cy + 2, 2 + (rnd() * 2) | 0, 2, "gold");
    }

    // Guaranteed starter resources near each keep (reachable ring)
    for (const p of this.starts()) {
      const dirs = [
        [9, 3],
        [7, -6],
        [-4, 8],
        [10, -2],
        [-7, -5],
        [3, 10],
      ];
      for (const [dx, dy] of dirs) {
        placeCluster(p.x + dx, p.y + dy, 4, 2.2, "tree", desert);
      }
      placeCluster(p.x - 9, p.y + 6, 3, 1.8, "rock", true);
      placeCluster(p.x + 6, p.y + 9, 3, 1.8, "rock", true);
      placeCluster(p.x - 8, p.y - 7, 2, 1.5, "gold", true);
      placeCluster(p.x + 9, p.y - 8, 2, 1.5, "gold", true);
    }

    // global safety nets so neither side can be starved of stone/gold.
    // Counters are maintained incrementally (XL scatters ~3x the nodes, and an
    // O(n) recount per guard iteration showed up in the profile).
    let nRock = 0;
    let nGold = 0;
    for (const nd of nodes) {
      if (nd.kind === "rock") nRock++;
      else if (nd.kind === "gold") nGold++;
    }
    const minRock = Math.round(16 * areaK);
    const minGold = Math.round(10 * areaK);
    const guardMax = Math.round(40 * areaK);
    let guard = 0;
    while (nRock < minRock && guard++ < guardMax) {
      const before = nodes.length;
      placeCluster(
        8 + rnd() * (this.w - 16),
        8 + rnd() * (this.h - 16),
        3,
        2.2,
        "rock",
        true,
      );
      for (let i = before; i < nodes.length; i++) nRock++;
    }
    guard = 0;
    while (nGold < minGold && guard++ < guardMax) {
      const p = this.starts()[guard % 2];
      const a = rnd() * Math.PI * 2;
      const before = nodes.length;
      placeCluster(
        p.x + Math.cos(a) * (12 + rnd() * 6),
        p.y + Math.sin(a) * (12 + rnd() * 6),
        2,
        1.8,
        "gold",
        true,
      );
      for (let i = before; i < nodes.length; i++) nGold++;
    }

    return nodes;
  }
}
