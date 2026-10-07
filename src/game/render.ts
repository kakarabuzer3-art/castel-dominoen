import {
  BUILDING_DEFS,
  MAP_H,
  MAP_W,
  T_BRIDGE,
  T_DIRT,
  T_FORD,
  T_OASIS,
  T_ROCKY,
  T_WATER,
  TEAM_COLORS,
  TEAM_COLORS_DARK,
  TILE,
  UNIT_DEFS,
  UPGRADES,
  canAfford,
} from "./constants";

const CLEAR_COLORS = ["#2563eb", "#f97316"];
const CLEAR_COLORS_DARK = ["#1e40af", "#9a3412"];
import type { Game } from "./engine";
import { MinimapRenderer } from "./minimap";
import { hash2 } from "./rng";
import type { Building, RNode, Unit } from "./types";

/** 0 = day … 1 = deep night, 420s cycle */
function nightFactor(t: number): number {
  const c = (t % 420) / 420;
  if (c < 0.55) return 0;
  if (c < 0.65) return (c - 0.55) / 0.1;
  if (c < 0.9) return 1;
  return Math.max(0, 1 - (c - 0.9) / 0.1);
}

function dayTint(t: number): { r: number; g: number; b: number; a: number } {
  const c = (t % 420) / 420;
  if (c < 0.55) return { r: 0, g: 0, b: 0, a: 0 };
  if (c < 0.65) {
    const k = (c - 0.55) / 0.1;
    return { r: 255, g: 130, b: 50, a: 0.1 * Math.sin(k * Math.PI) };
  }
  if (c < 0.9) {
    const k = Math.min(1, (c - 0.65) / 0.08);
    return { r: 12, g: 20, b: 64, a: 0.46 * k };
  }
  const k = 1 - (c - 0.9) / 0.1;
  return { r: 255, g: 170, b: 90, a: 0.08 * k };
}

const CHUNK = 8; // tiles per chunk side
const CHUNK_PX = CHUNK * TILE;

// terrain palettes per biome
interface Pal {
  grass: string[];
  tuft: string;
  dirt: string[];
  rock: string[];
  water: string[];
  shore: string;
  oasis: string[];
  stoneLight: string;
  stoneMid: string;
  stoneDark: string;
  stoneTrim: string;
  stoneEdge: string;
}
const GREEN_PAL: Pal = {
  grass: ["#5b8f42", "#548a3d", "#62964a", "#4f843a"],
  tuft: "#47752f",
  dirt: ["#9c8254", "#94794c", "#a48a5c"],
  rock: ["#8b8578", "#827c70", "#948e80"],
  water: ["#3a6ea8", "#37699f", "#4076b0"],
  shore: "#c2ab7a",
  oasis: ["#5b8f42", "#548a3d", "#62964a", "#4f843a"],
  stoneLight: "#b0a898",
  stoneMid: "#8f887c",
  stoneDark: "#7c756a",
  stoneTrim: "#9a9387",
  stoneEdge: "#5f594e",
};
const DESERT_PAL: Pal = {
  grass: ["#d9c28c", "#d3ba82", "#dfc996", "#cfb47c"],
  tuft: "#b6a06a",
  dirt: ["#c9ad7c", "#c2a674", "#d0b484"],
  rock: ["#b09678", "#a68c6e", "#baa082"],
  water: ["#3f93a5", "#3a8b9d", "#469bad"],
  shore: "#e6d2a0",
  oasis: ["#69a844", "#61a03c", "#71b04c", "#5c9c38"],
  stoneLight: "#d8c092",
  stoneMid: "#bda274",
  stoneDark: "#a08659",
  stoneTrim: "#c8ae7e",
  stoneEdge: "#7a6547",
};

export class Renderer {
  kind = "2d" as const;
  private mmr = new MinimapRenderer();
  private ctx: CanvasRenderingContext2D;
  /**
   * Terrain chunk cache, in LRU order (a hit re-inserts the key, eviction
   * takes the oldest). The previous "clear everything above 300 entries"
   * policy thrashed on XL maps — 20x20 = 400 chunks — repainting terrain
   * every frame while panning.
   */
  private chunks = new Map<number, HTMLCanvasElement>();
  private chunkBytes = 0;
  /** ~48 MB of RGBA at 256x256 per chunk: enough to cache a whole XL map
   *  (400 chunks would be 105 MB) without endangering a 1 GiB sandbox */
  private static readonly CHUNK_BUDGET = 48 * 1024 * 1024;
  /** reusable cull/sort buffers — the frame loop must not allocate */
  private visUnits: Unit[] = [];
  private sortedBuildings: Building[] = [];
  private sortedRev = -1;
  /**
   * Whole-map low-resolution terrain plate (4 px per tile) used at kingdom
   * zoom. An XL map needs 400 full-res chunks (~105 MB) to cover the view,
   * which exceeds the chunk budget and made fit-zoom repaint terrain every
   * frame; one 640x640 plate replaces all of it with a single drawImage.
   */
  private overview: HTMLCanvasElement | null = null;
  private overviewKey = "";
  private static readonly OV_PX = 4;
  private static readonly OV_ZOOM = 0.5;
  private fogCv: HTMLCanvasElement | null = null;
  private fogVer = -1;
  private dpr = 1;

  constructor(
    private game: Game,
    private canvas: HTMLCanvasElement,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unsupported");
    this.ctx = ctx;
    this.autoResize();
  }

  setMinimap(el: HTMLCanvasElement | null): void {
    this.mmr.setCanvas(el);
  }

  reset(): void {
    this.chunks.clear();
    this.chunkBytes = 0;
    this.overview = null;
    this.overviewKey = "";
    this.sortedRev = -1;
    this.visUnits.length = 0;
    this.mmr.reset();
    this.fogCv = null;
    this.fogVer = -1;
  }

  stats(): { calls: number; tris: number; instances: number } {
    return { calls: 0, tris: 0, instances: 0 };
  }

  /** tile-resolution fog image for team 0 (rebuilt on vision refresh) */
  private fogImage(): HTMLCanvasElement | null {
    const g = this.game;
    if (!g.fogOn()) return null;
    const w = g.grid.w;
    const h = g.grid.h;
    if (!this.fogCv) {
      this.fogCv = document.createElement("canvas");
      this.fogCv.width = w;
      this.fogCv.height = h;
    }
    if (this.fogVer === g.fogVersion) return this.fogCv;
    this.fogVer = g.fogVersion;
    const ctx = this.fogCv.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    const vis = g.visible[g.myTeam];
    const exp = g.explored[g.myTeam];
    for (let i = 0; i < vis.length; i++) {
      const a = vis[i] ? 0 : exp[i] ? 120 : 255;
      img.data[i * 4] = 8;
      img.data[i * 4 + 1] = 10;
      img.data[i * 4 + 2] = 14;
      img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return this.fogCv;
  }

  dispose(): void {
    this.chunks.clear();
    this.ro?.disconnect();
    this.ro = null;
    if (this.onWinResize) window.removeEventListener("resize", this.onWinResize);
    this.onWinResize = null;
  }

  private ro: ResizeObserver | null = null;
  private onWinResize: (() => void) | null = null;

  private autoResize(): void {
    const doResize = () => {
      const r = this.canvas.getBoundingClientRect();
      this.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
    };
    doResize();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(doResize);
      this.ro.observe(this.canvas);
    } else {
      this.onWinResize = doResize;
      window.addEventListener("resize", doResize);
    }
  }

  resize(w: number, h: number, dpr: number): void {
    if (w <= 0 || h <= 0) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // game viewport in CSS px
    if (this.game.viewW !== w || this.game.viewH !== h) {
      this.game.viewW = w;
      this.game.viewH = h;
      this.game.clampCam();
    }
  }

  private pal(): Pal {
    return this.game.grid.theme === "desert" ? DESERT_PAL : GREEN_PAL;
  }

  teamColor(t: 0 | 1): string {
    return this.game.settings.clearColors ? CLEAR_COLORS[t] : TEAM_COLORS[t];
  }

  teamColorDark(t: 0 | 1): string {
    return this.game.settings.clearColors
      ? CLEAR_COLORS_DARK[t]
      : TEAM_COLORS_DARK[t];
  }

  private get st() {
    return this.game.settings;
  }

  // ── terrain chunks ─────────────────────────────────────────────────────────

  private chunk(cx: number, cy: number): HTMLCanvasElement {
    const key = cy * 32 + cx;
    let c = this.chunks.get(key);
    if (c) {
      this.chunks.delete(key); // refresh LRU position
      this.chunks.set(key, c);
      return c;
    }
    c = document.createElement("canvas");
    c.width = CHUNK_PX;
    c.height = CHUNK_PX;
    const g = c.getContext("2d")!;
    const grid = this.game.grid;
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        const wx = cx * CHUNK + tx;
        const wy = cy * CHUNK + ty;
        if (wx >= MAP_W || wy >= MAP_H) {
          g.fillStyle = "#101010";
          g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
          continue;
        }
        const i = wy * MAP_W + wx;
        const t = grid.terrain[i];
        const tone = grid.tone[i];
        const x0 = tx * TILE;
        const y0 = ty * TILE;
        const P = this.pal();
        const desert = grid.theme === "desert";
        if (t === T_WATER) {
          g.fillStyle = P.water[(tone * 3) | 0];
          g.fillRect(x0, y0, TILE, TILE);
          // shore edges
          g.fillStyle = P.shore;
          if (wy > 0 && grid.terrain[i - MAP_W] !== T_WATER)
            g.fillRect(x0, y0, TILE, 3);
          if (wy < MAP_H - 1 && grid.terrain[i + MAP_W] !== T_WATER)
            g.fillRect(x0, y0 + TILE - 3, TILE, 3);
          if (wx > 0 && grid.terrain[i - 1] !== T_WATER)
            g.fillRect(x0, y0, 3, TILE);
          if (wx < MAP_W - 1 && grid.terrain[i + 1] !== T_WATER)
            g.fillRect(x0 + TILE - 3, y0, 3, TILE);
          // ripples
          if (tone > 0.62) {
            g.strokeStyle = "rgba(255,255,255,0.14)";
            g.lineWidth = 1.5;
            g.beginPath();
            g.moveTo(x0 + 7, y0 + 12 + tone * 8);
            g.quadraticCurveTo(x0 + 16, y0 + 8 + tone * 8, x0 + 25, y0 + 13 + tone * 8);
            g.stroke();
          }
        } else if (t === T_DIRT) {
          g.fillStyle = P.dirt[(tone * 3) | 0];
          g.fillRect(x0, y0, TILE, TILE);
          if (tone > 0.7) {
            g.fillStyle = "rgba(0,0,0,0.08)";
            g.beginPath();
            g.arc(x0 + 10 + tone * 12, y0 + 8 + tone * 14, 3, 0, 7);
            g.fill();
          }
          if (desert && tone > 0.4 && tone < 0.55) {
            // scattered pebbles on dry paths
            g.fillStyle = "rgba(120,100,70,0.35)";
            g.fillRect(x0 + 8 + tone * 30, y0 + 20, 2, 2);
            g.fillRect(x0 + 20, y0 + 8 + tone * 20, 2, 2);
          }
        } else if (t === T_BRIDGE) {
          // wooden bridge planks over water
          g.fillStyle = P.water[1];
          g.fillRect(x0, y0, TILE, TILE);
          g.fillStyle = "#7a5a34";
          g.fillRect(x0, y0 + 3, TILE, TILE - 6);
          g.fillStyle = "#8f6b3e";
          for (let i = 0; i < 4; i++)
            g.fillRect(x0 + 1, y0 + 4 + i * 7, TILE - 2, 5);
          g.fillStyle = "#5c4023";
          g.fillRect(x0, y0 + 2, 3, TILE - 4);
          g.fillRect(x0 + TILE - 3, y0 + 2, 3, TILE - 4);
        } else if (t === T_FORD) {
          // shallow crossing: pale water + stepping stones
          g.fillStyle = desert ? "#6fb3bd" : "#79a8c4";
          g.fillRect(x0, y0, TILE, TILE);
          g.fillStyle = "rgba(255,255,255,0.25)";
          g.fillRect(x0 + 4, y0 + 8 + tone * 10, 10, 2);
          g.fillRect(x0 + 16, y0 + 18 + tone * 6, 12, 2);
          g.fillStyle = P.rock[1];
          g.beginPath();
          g.arc(x0 + 9, y0 + 14, 3, 0, 7);
          g.arc(x0 + 20, y0 + 22, 2.6, 0, 7);
          g.arc(x0 + 24, y0 + 9, 2.2, 0, 7);
          g.fill();
        } else if (t === T_OASIS) {
          g.fillStyle = P.oasis[(tone * 4) | 0];
          g.fillRect(x0, y0, TILE, TILE);
          if (tone > 0.8) {
            g.fillStyle = "#e87ea0";
            g.fillRect(x0 + 10 + tone * 14, y0 + 12, 2, 2);
          }
        } else if (t === T_ROCKY) {
          g.fillStyle = P.rock[(tone * 3) | 0];
          g.fillRect(x0, y0, TILE, TILE);
          g.fillStyle = "rgba(0,0,0,0.14)";
          g.beginPath();
          g.moveTo(x0 + 4 + tone * 8, y0 + 24);
          g.lineTo(x0 + 12 + tone * 8, y0 + 10);
          g.lineTo(x0 + 20 + tone * 8, y0 + 26);
          g.closePath();
          g.fill();
          g.fillStyle = "rgba(255,255,255,0.10)";
          g.fillRect(x0 + 6 + tone * 16, y0 + 5 + tone * 6, 4, 3);
        } else {
          g.fillStyle = P.grass[(tone * 4) | 0];
          g.fillRect(x0, y0, TILE, TILE);
          const h1 = hash2(wx * 13 + 5, wy * 7 + 3);
          if (desert && tone > 0.74) {
            // dune ridge highlight
            g.strokeStyle = "rgba(255,244,214,0.35)";
            g.lineWidth = 1.6;
            g.beginPath();
            g.moveTo(x0 + 3, y0 + 10 + h1 * 12);
            g.quadraticCurveTo(x0 + 16, y0 + 4 + h1 * 12, x0 + 29, y0 + 11 + h1 * 12);
            g.stroke();
            g.strokeStyle = "rgba(140,110,70,0.25)";
            g.beginPath();
            g.moveTo(x0 + 3, y0 + 13 + h1 * 12);
            g.quadraticCurveTo(x0 + 16, y0 + 7 + h1 * 12, x0 + 29, y0 + 14 + h1 * 12);
            g.stroke();
          }
          if (h1 > (desert ? 0.86 : 0.72)) {
            g.strokeStyle = P.tuft;
            g.lineWidth = 1.4;
            g.beginPath();
            const bx = x0 + 8 + h1 * 16;
            const by = y0 + 10 + h1 * 12;
            g.moveTo(bx, by);
            g.lineTo(bx - 2, by - 5);
            g.moveTo(bx + 3, by);
            g.lineTo(bx + 4, by - 6);
            g.stroke();
          }
          if (h1 < 0.06) {
            g.fillStyle = desert ? "#a89274" : "#7d7a70";
            g.beginPath();
            g.arc(x0 + 20, y0 + 20, 2.2, 0, 7);
            g.fill();
          }
        }
      }
    }
    this.chunks.set(key, c);
    this.chunkBytes += CHUNK_PX * CHUNK_PX * 4;
    while (this.chunkBytes > Renderer.CHUNK_BUDGET && this.chunks.size > 4) {
      const oldest = this.chunks.keys().next();
      if (oldest.done) break;
      this.chunks.delete(oldest.value);
      this.chunkBytes -= CHUNK_PX * CHUNK_PX * 4;
    }
    return c;
  }

  private static hexRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }

  /** build (once per map) the low-res terrain plate for kingdom zoom */
  private overviewPlate(): HTMLCanvasElement | null {
    const grid = this.game.grid;
    const key = `${grid.seed}:${grid.arch}:${grid.w}x${grid.h}`;
    if (this.overview && this.overviewKey === key) return this.overview;
    if (typeof document === "undefined") return null;
    const S = Renderer.OV_PX;
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, grid.w * S);
    cv.height = Math.max(1, grid.h * S);
    const g = cv.getContext("2d");
    if (!g) return null;
    const P = this.pal();
    const desert = grid.theme === "desert";
    const grass = P.grass.map(Renderer.hexRgb);
    const dirt = P.dirt.map(Renderer.hexRgb);
    const rock = P.rock.map(Renderer.hexRgb);
    const water = P.water.map(Renderer.hexRgb);
    const oasis = P.oasis.map(Renderer.hexRgb);
    const bridge = Renderer.hexRgb("#7a5a34");
    const ford = Renderer.hexRgb(desert ? "#6fb3bd" : "#79a8c4");
    const img = g.createImageData(cv.width, cv.height);
    const d = img.data;
    for (let ty = 0; ty < grid.h; ty++) {
      for (let tx = 0; tx < grid.w; tx++) {
        const i = ty * grid.w + tx;
        const t = grid.terrain[i];
        const tone = grid.tone[i];
        let c: [number, number, number];
        if (t === T_WATER) c = water[(tone * 3) | 0];
        else if (t === T_BRIDGE) c = bridge;
        else if (t === T_FORD) c = ford;
        else if (t === T_OASIS) c = oasis[(tone * 4) | 0];
        else if (t === T_ROCKY) c = rock[(tone * 3) | 0];
        else if (t === T_DIRT) c = dirt[(tone * 3) | 0];
        else c = grass[(tone * 4) | 0];
        const sh = 0.93 + tone * 0.14;
        const r = (c[0] * sh) | 0;
        const gg = (c[1] * sh) | 0;
        const b = (c[2] * sh) | 0;
        for (let py = 0; py < S; py++) {
          const row = ((ty * S + py) * cv.width + tx * S) * 4;
          for (let px = 0; px < S; px++) {
            const o = row + px * 4;
            d[o] = r;
            d[o + 1] = gg;
            d[o + 2] = b;
            d[o + 3] = 255;
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
    this.overview = cv;
    this.overviewKey = key;
    return cv;
  }

  /**
   * Kingdom-zoom resource nodes: three batched paths (wood / stone / gold)
   * instead of ~1300 individually drawn trees and ore rocks.
   */
  private drawNodesBatched(vb: { x0: number; y0: number; x1: number; y1: number }): void {
    const g = this.game;
    const ctx = this.ctx;
    const desert = g.grid.theme === "desert";
    const passes: Array<[RNode["kind"], string, number]> = [
      ["tree", desert ? "#3d6b2c" : "#2f6b2a", 7],
      ["rock", "#9a9488", 6],
      ["gold", "#e6b93c", 5],
    ];
    for (const [kind, color, rad] of passes) {
      ctx.beginPath();
      let any = false;
      for (const n of g.nodes) {
        if (n.kind !== kind) continue;
        const nx = n.tx * TILE + 16;
        const ny = n.ty * TILE + 16;
        if (nx < vb.x0 - 30 || nx > vb.x1 + 30 || ny < vb.y0 - 30 || ny > vb.y1 + 30)
          continue;
        if (!g.isExplored(g.myTeam, nx, ny)) continue;
        any = true;
        ctx.moveTo(nx + rad, ny - (kind === "tree" ? 6 : 0));
        ctx.arc(nx, ny - (kind === "tree" ? 6 : 0), rad, 0, 7);
      }
      if (!any) continue;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // ── main render ────────────────────────────────────────────────────────────

  render(
    tRaw: number,
    dragSel: { x0: number; y0: number; x1: number; y1: number } | null,
  ): void {
    const g = this.game;
    const t = g.settings.reducedMotion ? 0 : tRaw;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0d0f0a";
    ctx.fillRect(0, 0, w, h);
    if (w === 0 || h === 0) return;

    const zoom = g.cam.zoom;
    let shx = 0;
    let shy = 0;
    if (g.shakeT > 0 && this.st.screenShake && !this.st.reducedMotion) {
      const k = (g.shakeT / 0.35) * g.shakeMag;
      shx = (Math.random() - 0.5) * 2 * k;
      shy = (Math.random() - 0.5) * 2 * k;
    }
    ctx.setTransform(
      this.dpr * zoom,
      0,
      0,
      this.dpr * zoom,
      this.dpr * (g.viewW / 2 - (g.cam.x + shx) * zoom),
      this.dpr * (g.viewH / 2 - (g.cam.y + shy) * zoom),
    );

    const vb = g.viewBounds();
    const kingdom = zoom < Renderer.OV_ZOOM;
    if (kingdom) {
      const plate = this.overviewPlate();
      if (plate) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(plate, 0, 0, MAP_W * TILE, MAP_H * TILE);
        ctx.imageSmoothingEnabled = false;
      }
    }
    const cx0 = Math.max(0, Math.floor(vb.x0 / CHUNK_PX));
    const cy0 = Math.max(0, Math.floor(vb.y0 / CHUNK_PX));
    const cx1 = Math.min(Math.ceil(MAP_W / CHUNK), Math.ceil(vb.x1 / CHUNK_PX));
    const cy1 = Math.min(Math.ceil(MAP_H / CHUNK), Math.ceil(vb.y1 / CHUNK_PX));
    if (!kingdom)
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++)
          ctx.drawImage(this.chunk(cx, cy), cx * CHUNK_PX, cy * CHUNK_PX);

    // animated water shimmer — skipped when the governor has shed effects or
    // when zoomed out far enough that a 10x2 px highlight is sub-pixel
    const q = g.perf.state;
    if (this.st.waterFx && q.waterFx && !this.st.reducedMotion && zoom > 0.55) {
      const tx0 = Math.max(0, Math.floor(vb.x0 / TILE));
      const ty0 = Math.max(0, Math.floor(vb.y0 / TILE));
      const tx1 = Math.min(MAP_W - 1, Math.ceil(vb.x1 / TILE));
      const ty1 = Math.min(MAP_H - 1, Math.ceil(vb.y1 / TILE));
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (g.grid.terrain[ty * MAP_W + tx] !== T_WATER) continue;
          const h = hash2(tx * 7 + 1, ty * 13 + 5);
          if (h < 0.82) continue;
          const ph = (t * 0.7 + h * 9) % 3;
          if (ph > 1) continue;
          const a = Math.sin(ph * Math.PI);
          ctx.globalAlpha = 0.12 * a;
          ctx.fillRect(tx * TILE + 6 + h * 10, ty * TILE + 10 + h * 12, 10, 2);
        }
      }
      ctx.globalAlpha = 1;
    }

    // scorch marks from destroyed buildings
    for (const sc of g.scorches) {
      if (sc.x < vb.x0 - 80 || sc.x > vb.x1 + 80 || sc.y < vb.y0 - 80 || sc.y > vb.y1 + 80)
        continue;
      const grad = ctx.createRadialGradient(sc.x, sc.y, 2, sc.x, sc.y, sc.r);
      grad.addColorStop(0, "rgba(20,16,12,0.55)");
      grad.addColorStop(1, "rgba(20,16,12,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(sc.x, sc.y, sc.r, sc.r * 0.7, 0, 0, 7);
      ctx.fill();
    }

    // resource nodes (memory: shown once explored) — batched at kingdom zoom
    if (kingdom) {
      this.drawNodesBatched(vb);
    } else {
      for (const n of g.nodes) {
        const nx = n.tx * TILE + 16;
        const ny = n.ty * TILE + 16;
        if (nx < vb.x0 - 40 || nx > vb.x1 + 40 || ny < vb.y0 - 60 || ny > vb.y1 + 40)
          continue;
        if (!g.isExplored(g.myTeam, nx, ny)) continue;
        this.drawNode(n, t);
      }
    }

    // placement preview (ground)
    const prev = g.placementPreview();
    if (prev) this.drawPlacement(prev, g);

    // buildings: y-sorted, but the sort is cached until the building set
    // changes. Re-sorting (and re-allocating) every frame was pure overhead.
    if (this.sortedRev !== g.buildingsRev) {
      this.sortedRev = g.buildingsRev;
      this.sortedBuildings = g.buildings
        .slice()
        .sort((a, b) => a.ty + a.h - (b.ty + b.h));
    }
    const bSorted = this.sortedBuildings;
    for (const b of bSorted) {
      const bx = b.tx * TILE;
      const by = b.ty * TILE;
      const bw = b.w * TILE;
      const bh = b.h * TILE;
      if (bx + bw < vb.x0 - 20 || bx > vb.x1 + 20 || by + bh < vb.y0 - 60 || by > vb.y1 + 20)
        continue;
      if (b.team !== g.myTeam && !g.isVisibleTo(g.myTeam, bx + bw / 2, by + bh / 2)) continue;
      if (kingdom) this.drawBuildingFar(b);
      else this.drawBuilding(b, t);
    }

    // selection indicators under units
    ctx.lineWidth = 1.6;
    for (const b of g.buildings) {
      if (b.team !== 0 || g.selectedBuilding !== b.id) continue;
      const pulse = 0.65 + 0.3 * Math.sin(t * 4);
      ctx.strokeStyle = `rgba(140,255,140,${0.45 * pulse})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(b.tx * TILE + 1, b.ty * TILE + 1, b.w * TILE - 2, b.h * TILE - 2);
      ctx.strokeStyle = "rgba(190,255,190,0.95)";
      ctx.lineWidth = 2;
      const L = 7;
      const x0 = b.tx * TILE + 1;
      const y0 = b.ty * TILE + 1;
      const x1 = (b.tx + b.w) * TILE - 1;
      const y1 = (b.ty + b.h) * TILE - 1;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + L); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L, y0);
      ctx.moveTo(x1 - L, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + L);
      ctx.moveTo(x1, y1 - L); ctx.lineTo(x1, y1); ctx.lineTo(x1 - L, y1);
      ctx.moveTo(x0 + L, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - L);
      ctx.stroke();
      ctx.lineWidth = 1.6;
      if (b.built && BUILDING_DEFS[b.type].trains.length) {
        ctx.strokeStyle = "rgba(140,255,140,0.45)";
        ctx.beginPath();
        ctx.moveTo((b.tx + b.w / 2) * TILE, (b.ty + b.h / 2) * TILE);
        ctx.lineTo(b.rallyX, b.rallyY);
        ctx.stroke();
        ctx.fillStyle = "#8cff8c";
        ctx.beginPath();
        ctx.moveTo(b.rallyX, b.rallyY - 8);
        ctx.lineTo(b.rallyX + 7, b.rallyY - 5);
        ctx.lineTo(b.rallyX, b.rallyY - 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(b.rallyX - 1, b.rallyY - 8, 1.6, 10);
      }
    }

    // units (y-sorted) — culled into a reused buffer, then drawn through the
    // distance/tier LOD ladder: batched blobs when the whole kingdom is on
    // screen, a simplified sprite at mid zoom, full detail up close.
    const vis = this.visUnits;
    vis.length = 0;
    for (let i = 0; i < g.units.length; i++) {
      const u = g.units[i];
      if (
        u.x <= vb.x0 - 30 ||
        u.x >= vb.x1 + 30 ||
        u.y <= vb.y0 - 30 ||
        u.y >= vb.y1 + 40
      )
        continue;
      if (u.team !== g.myTeam && !g.isVisibleTo(g.myTeam, u.x, u.y)) continue;
      vis.push(u);
    }
    vis.sort((a, b) => a.y - b.y);
    const simple = q.unitDetail < 2 || zoom < 0.75;
    if (zoom < 0.5 && vis.length > 24) {
      this.drawUnitsBatched(vis, simple ? 0 : 1);
    } else if (simple) {
      for (let i = 0; i < vis.length; i++) this.drawUnitSimple(vis[i], t, q.unitDetail);
    } else {
      for (let i = 0; i < vis.length; i++) this.drawUnit(vis[i], t);
    }

    // projectiles (viewport culled — a massed archer duel can hold hundreds)
    for (let pi = 0; pi < g.projectiles.length; pi++) {
      const p = g.projectiles[pi];
      if (p.x < vb.x0 - 40 || p.x > vb.x1 + 40 || p.y < vb.y0 - 60 || p.y > vb.y1 + 40)
        continue;
      const tgt = g.byId.get(p.targetId);
      let ang = 0;
      if (tgt) {
        const tp = g.entPos(tgt);
        ang = Math.atan2(tp.y - p.y, tp.x - p.x);
      }
      if (p.kind === "rock") {
        ctx.fillStyle = "#8f897c";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.2, 0, 7);
        ctx.fill();
        ctx.fillStyle = "#6e675c";
        ctx.beginPath();
        ctx.arc(p.x - 1, p.y - 1, 1.4, 0, 7);
        ctx.fill();
      } else {
        ctx.strokeStyle = "#efe3c8";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(p.x - Math.cos(ang) * 7, p.y - Math.sin(ang) * 7);
        ctx.lineTo(p.x + Math.cos(ang) * 3, p.y + Math.sin(ang) * 3);
        ctx.stroke();
      }
    }

    // floating texts
    ctx.textAlign = "center";
    for (const f of g.floats) {
      if (f.x < vb.x0 - 60 || f.x > vb.x1 + 60 || f.y < vb.y0 - 40 || f.y > vb.y1 + 40)
        continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life / f.maxLife));
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillStyle = "#00000088";
      ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;

    // particles: culled to the viewport and capped by the adaptive draw
    // budget (the engine spawn budget is separate; see perf.ts)
    let pDrawn = 0;
    for (let pi = 0; pi < g.particles.length && pDrawn < q.particleDraw; pi++) {
      const pt = g.particles[pi];
      if (
        pt.x < vb.x0 - 60 ||
        pt.x > vb.x1 + 60 ||
        pt.y < vb.y0 - 60 ||
        pt.y > vb.y1 + 60
      )
        continue;
      pDrawn++;
      const a = Math.max(0, Math.min(1, pt.life / pt.maxLife));
      if (pt.kind === "ring") {
        ctx.globalAlpha = a * 0.6;
        ctx.strokeStyle = pt.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, 7);
        ctx.stroke();
      } else if (pt.kind === "smoke") {
        ctx.globalAlpha = a * 0.45;
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, 7);
        ctx.fill();
      } else if (pt.kind === "fire") {
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = a > 0.6 ? "#ffd166" : pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(0.4, pt.size), 0, 7);
        ctx.fill();
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // drifting cloud shadows (first thing the governor sheds)
    if (this.st.quality > 0 && q.clouds && !this.st.reducedMotion)
    for (let i = 0; i < 3; i++) {
      const cx = ((t * 9 + i * 1500) % (MAP_W * TILE + 900)) - 450;
      const cy =
        ((i * 1177 + Math.sin(t * 0.05 + i * 2) * 260) % (MAP_H * TILE)) ;
      if (cx < vb.x0 - 600 || cx > vb.x1 + 600 || cy < vb.y0 - 600 || cy > vb.y1 + 600)
        continue;
      const grad = ctx.createRadialGradient(cx, cy, 40, cx, cy, 380);
      grad.addColorStop(0, "rgba(10,14,8,0.10)");
      grad.addColorStop(1, "rgba(10,14,8,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 420, 260, 0.4, 0, 7);
      ctx.fill();
    }

    // torch glow at night around buildings (follows game time)
    const gt = g.time;
    const night = this.st.dayNight ? nightFactor(gt) : 0;
    if (night > 0.05 && q.glow) {
      // radial-gradient glows are expensive: at reduced tiers light every
      // second building, which reads the same at a glance
      const stride = q.tier <= 1 ? 2 : 1;
      let gi = 0;
      for (const b of g.buildings) {
        const bx = (b.tx + b.w / 2) * TILE;
        const by = (b.ty + b.h / 2) * TILE;
        if (bx < vb.x0 - 120 || bx > vb.x1 + 120 || by < vb.y0 - 120 || by > vb.y1 + 120)
          continue;
        if (stride > 1 && gi++ % stride !== 0) continue;
        const fl = 0.85 + Math.sin(t * 7 + b.id) * 0.15;
        const grad = ctx.createRadialGradient(bx, by - 8, 4, bx, by - 8, 90);
        grad.addColorStop(0, `rgba(255,176,80,${0.22 * night * fl})`);
        grad.addColorStop(1, "rgba(255,176,80,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(bx, by - 8, 90, 0, 7);
        ctx.fill();
      }
    }

    // fog of war overlay
    const fog = this.fogImage();
    if (fog) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fog, 0, 0, MAP_W * TILE, MAP_H * TILE);
      ctx.imageSmoothingEnabled = false;
    }

    // screen-space overlays
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // map-border frame: when zoomed out past the fit scale (Home / − key)
    // the void outside the play area reads as an intentional table edge
    {
      const rx = (0 - g.cam.x) * zoom + g.viewW / 2;
      const ry = (0 - g.cam.y) * zoom + g.viewH / 2;
      const rw = MAP_W * TILE * zoom;
      const rh = MAP_H * TILE * zoom;
      ctx.save();
      ctx.strokeStyle = "rgba(216,178,92,0.30)";
      ctx.lineWidth = 1.5;
      ctx.shadowColor = "rgba(0,0,0,0.85)";
      ctx.shadowBlur = 18;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.restore();
    }

    // desert: constant warm sunlight wash
    if (g.grid.theme === "desert" && this.st.dayNight) {
      ctx.fillStyle = "rgba(255,186,96,0.07)";
      ctx.fillRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    }
    // day / night atmosphere tint
    const tint = this.st.dayNight ? dayTint(gt) : { r: 0, g: 0, b: 0, a: 0 };
    if (tint.a > 0.004) {
      ctx.fillStyle = `rgba(${tint.r},${tint.g},${tint.b},${tint.a})`;
      ctx.fillRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    }
    if (dragSel) {
      const x = Math.min(dragSel.x0, dragSel.x1);
      const y = Math.min(dragSel.y0, dragSel.y1);
      const ww = Math.abs(dragSel.x1 - dragSel.x0);
      const hh = Math.abs(dragSel.y1 - dragSel.y0);
      if (ww > 4 || hh > 4) {
        ctx.fillStyle = "rgba(120,200,255,0.12)";
        ctx.fillRect(x, y, ww, hh);
        ctx.strokeStyle = "rgba(150,220,255,0.8)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, ww, hh);
      }
    }
    if (g.attackMoveMode) {
      ctx.strokeStyle = "rgba(255,90,70,0.9)";
      ctx.lineWidth = 2;
      const m = g.mouse;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 12, 0, 7);
      ctx.moveTo(m.x - 16, m.y);
      ctx.lineTo(m.x + 16, m.y);
      ctx.moveTo(m.x, m.y - 16);
      ctx.lineTo(m.x, m.y + 16);
      ctx.stroke();
    }

    this.renderMinimap();
  }

  // ── entities ───────────────────────────────────────────────────────────────

  /** kingdom-zoom building: footprint + team colour + height hint */
  private drawBuildingFar(b: Building): void {
    const ctx = this.ctx;
    const X = b.tx * TILE;
    const Y = b.ty * TILE;
    const W = b.w * TILE;
    const H = b.h * TILE;
    const own = b.team === this.game.myTeam;
    ctx.globalAlpha = b.built ? 1 : 0.55;
    ctx.fillStyle = own ? this.teamColorDark(b.team) : "#4a443c";
    ctx.fillRect(X + 2, Y + 2, W - 4, H - 4);
    ctx.fillStyle = this.teamColor(b.team);
    ctx.fillRect(X + 2, Y + 2, W - 4, Math.max(3, H * 0.35));
    ctx.strokeStyle = "rgba(12,12,10,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(X + 2, Y + 2, W - 4, H - 4);
    if (b.type === "keep") {
      ctx.fillStyle = "#e8e0cc";
      ctx.fillRect(X + W / 2 - 3, Y - 6, 6, 8);
    }
    ctx.globalAlpha = 1;
  }

  private drawNode(n: RNode, t: number): void {
    const ctx = this.ctx;
    const x = n.tx * TILE + 16;
    const y = n.ty * TILE + 16;
    const v = n.variant;
    if (n.kind === "tree") {
      const sway = Math.sin(t * 1.4 + v) * 0.8;
      if (this.game.grid.theme === "desert") {
        // palm tree
        ctx.fillStyle = "rgba(0,0,0,0.20)";
        ctx.beginPath();
        ctx.ellipse(x + 3, y + 9, 9, 3.6, 0, 0, 7);
        ctx.fill();
        ctx.strokeStyle = "#8a6a42";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, y + 8);
        ctx.quadraticCurveTo(x + 2 + sway, y - 4, x + 4 + sway, y - 14);
        ctx.stroke();
        ctx.strokeStyle = "#3f7a34";
        ctx.lineWidth = 2.2;
        for (let f = 0; f < 6; f++) {
          const a = -Math.PI / 2 + (f - 2.5) * 0.52 + sway * 0.02;
          ctx.beginPath();
          ctx.moveTo(x + 4 + sway, y - 14);
          ctx.quadraticCurveTo(
            x + 4 + sway + Math.cos(a) * 8,
            y - 14 + Math.sin(a) * 8 - 3,
            x + 4 + sway + Math.cos(a) * 13,
            y - 14 + Math.sin(a) * 13 + 1,
          );
          ctx.stroke();
        }
        ctx.fillStyle = "#6b4a2a";
        ctx.beginPath();
        ctx.arc(x + 3 + sway, y - 13, 1.6, 0, 7);
        ctx.arc(x + 6 + sway, y - 12, 1.6, 0, 7);
        ctx.fill();
        if (n.amount < n.maxAmount * 0.35) {
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = "#c9b076";
          ctx.beginPath();
          ctx.arc(x + 4 + sway, y - 14, 4, 0, 7);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        return;
      }
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(x + 2, y + 9, 9, 4, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#6b4a2a";
      ctx.fillRect(x - 2, y - 2, 4, 11);
      const g1 = v % 2 ? "#2f6b2a" : "#357a2e";
      const g2 = v % 2 ? "#3d8435" : "#43913a";
      ctx.fillStyle = g1;
      ctx.beginPath();
      ctx.arc(x - 4 + sway, y - 8, 7.5, 0, 7);
      ctx.arc(x + 5 + sway, y - 7, 6.5, 0, 7);
      ctx.fill();
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(x + sway, y - 13, 8, 0, 7);
      ctx.fill();
      // depletion hint
      if (n.amount < n.maxAmount * 0.35) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = "#7a5a30";
        ctx.beginPath();
        ctx.arc(x + sway, y - 12, 4, 0, 7);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    } else if (n.kind === "rock") {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(x, y + 8, 11, 4.5, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#8f897c";
      ctx.beginPath();
      ctx.moveTo(x - 11, y + 8);
      ctx.lineTo(x - 6, y - 7);
      ctx.lineTo(x + 3, y - 10);
      ctx.lineTo(x + 11, y + 2);
      ctx.lineTo(x + 8, y + 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#a8a294";
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 7);
      ctx.lineTo(x + 3, y - 10);
      ctx.lineTo(x + 5, y - 2);
      ctx.lineTo(x - 4, y + 1);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(x, y + 8, 11, 4.5, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#7e786c";
      ctx.beginPath();
      ctx.moveTo(x - 11, y + 8);
      ctx.lineTo(x - 5, y - 8);
      ctx.lineTo(x + 5, y - 9);
      ctx.lineTo(x + 11, y + 3);
      ctx.lineTo(x + 7, y + 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#e6b93c";
      const dots = [
        [x - 4, y - 2],
        [x + 3, y - 5],
        [x + 1, y + 2],
        [x - 6, y + 4],
        [x + 6, y + 1],
      ];
      for (const [dx, dy] of dots) {
        ctx.beginPath();
        ctx.arc(dx, dy, 1.8, 0, 7);
        ctx.fill();
      }
      ctx.fillStyle = "#ffe08a";
      ctx.beginPath();
      ctx.arc(x + 3, y - 5, 1, 0, 7);
      ctx.fill();
    }
  }

  private tGlobal = 0;

  private drawBuilding(b: Building, t: number): void {
    this.tGlobal = t;
    const ctx = this.ctx;
    const X = b.tx * TILE;
    const Y = b.ty * TILE;
    const W = b.w * TILE;
    const H = b.h * TILE;
    const team = this.teamColor(b.team);
    const teamDark = this.teamColorDark(b.team);

    if (!b.built) {
      // construction site
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(X + 2, Y + 2, W - 4, H - 4);
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.15 * Math.sin(t * 4);
      ctx.strokeStyle = "#d8b25c";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(X + 2.5, Y + 2.5, W - 5, H - 5);
      ctx.restore();
      // scaffold poles
      ctx.strokeStyle = "#8a6a3a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X + 6, Y + H - 6);
      ctx.lineTo(X + W / 2, Y + 8);
      ctx.lineTo(X + W - 6, Y + H - 6);
      ctx.stroke();
      // progress bar
      const prog = 1 - b.work / b.workMax;
      this.bar(X + 4, Y - 8, W - 8, 5, prog, "#d8b25c", "#3a2f1a");
      if (b.builders > 0) {
        ctx.fillStyle = "#e8dcc3";
        ctx.font = "bold 9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`${b.builders} builder${b.builders > 1 ? "s" : ""}`, X + W / 2, Y - 12);
      }
      return;
    }

    // shadow
    if (this.st.shadows) {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(X + W / 2 + 3, Y + H - 4, W * 0.48, H * 0.16, 0, 0, 7);
      ctx.fill();
    }

    const P = this.pal();
    if (b.type === "keep") this.drawKeep(b, X, Y, W, H, team, teamDark, P);
    else if (b.type === "house") this.drawHouse(X, Y, W, H, team);
    else if (b.type === "farm") this.drawFarm(X, Y, W, H, b);
    else if (b.type === "barracks") this.drawBarracks(X, Y, W, H, team, teamDark, P);
    else if (b.type === "wall") this.drawWall(b, X, Y, P);
    else if (b.type === "gate") this.drawGate(b, X, Y, P);
    else if (b.type === "tower") this.drawTower(b, X, Y, W, H, team, teamDark, P);
    else if (b.type === "lumbercamp") this.drawLumbercamp(X, Y, W, H);
    else if (b.type === "quarry") this.drawQuarry(X, Y, W, H);
    else if (b.type === "market") this.drawMarket(X, Y, W, H);
    else if (b.type === "shrine") this.drawShrine(X, Y, W, H);

    // destruction states: cracks & rubble as hp drops
    if (b.built && b.hp < b.maxHp * 0.55) {
      const P2 = this.pal();
      ctx.strokeStyle = P2.stoneEdge;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(X + W * 0.25, Y + H * 0.3);
      ctx.lineTo(X + W * 0.35, Y + H * 0.5);
      ctx.lineTo(X + W * 0.28, Y + H * 0.7);
      ctx.moveTo(X + W * 0.7, Y + H * 0.25);
      ctx.lineTo(X + W * 0.62, Y + H * 0.45);
      ctx.lineTo(X + W * 0.72, Y + H * 0.62);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (b.built && b.hp < b.maxHp * 0.28) {
      ctx.fillStyle = "rgba(90,80,66,0.8)";
      ctx.beginPath();
      ctx.moveTo(X + 3, Y + H - 3);
      ctx.lineTo(X + 10, Y + H - 10);
      ctx.lineTo(X + 17, Y + H - 3);
      ctx.closePath();
      ctx.moveTo(X + W - 17, Y + H - 3);
      ctx.lineTo(X + W - 9, Y + H - 12);
      ctx.lineTo(X + W - 3, Y + H - 3);
      ctx.closePath();
      ctx.fill();
    }
    // torches at night on keeps & towers
    const nightF = this.st.dayNight ? nightFactor(this.game.time) : 0;
    if (b.built && nightF > 0.25 && (b.type === "keep" || b.type === "tower")) {
      const spots: Array<[number, number]> =
        b.type === "keep"
          ? [
              [X + 10, Y + 20],
              [X + W - 10, Y + 20],
              [X + W / 2 - 12, Y + H - 18],
              [X + W / 2 + 12, Y + H - 18],
            ]
          : [
              [X + W / 2 - 12, Y - 24],
              [X + W / 2 + 12, Y - 24],
            ];
      for (const [fx2, fy2] of spots) {
        const fl = 0.7 + Math.sin(this.tGlobal * 11 + fx2) * 0.3;
        ctx.fillStyle = "#5c4a30";
        ctx.fillRect(fx2 - 0.8, fy2 - 3, 1.6, 5);
        ctx.fillStyle = `rgba(255,150,50,${0.85 * fl})`;
        ctx.beginPath();
        ctx.arc(fx2, fy2 - 5, 2.2 * fl, 0, 7);
        ctx.fill();
        ctx.fillStyle = `rgba(255,230,140,${0.9 * fl})`;
        ctx.beginPath();
        ctx.arc(fx2, fy2 - 5.6, 1.1 * fl, 0, 7);
        ctx.fill();
      }
    }

    // damage flash
    if (b.flash > 0) {
      ctx.globalAlpha = Math.min(0.5, b.flash * 4);
      ctx.fillStyle = "#ff5533";
      ctx.fillRect(X, Y - (b.type === "keep" ? 26 : 0), W, H + (b.type === "keep" ? 26 : 0));
      ctx.globalAlpha = 1;
    }

    // hp bar when damaged or selected
    const selected = this.game.selectedBuilding === b.id;
    if (b.hp < b.maxHp || selected) {
      const frac = Math.max(0, b.hp / b.maxHp);
      this.bar(X + 4, Y - 7, W - 8, 4, frac, frac > 0.5 ? "#69d44f" : frac > 0.25 ? "#e8c13c" : "#e0503e", "#1c140c");
    }
    // research progress
    if (b.research) {
      const def = UPGRADES.find((u) => u.id === b.research!.id);
      if (def)
        this.bar(X + 4, Y - 13, W - 8, 4, b.research.t / def.time, "#e8c877", "#1c140c");
    }
  }

  private drawKeep(
    b: Building,
    X: number,
    Y: number,
    W: number,
    H: number,
    team: string,
    teamDark: string,
    P: Pal,
  ): void {
    const ctx = this.ctx;
    void b;
    // curtain wall
    ctx.fillStyle = P.stoneMid;
    ctx.fillRect(X + 6, Y + 14, W - 12, H - 20);
    ctx.fillStyle = P.stoneDark;
    ctx.fillRect(X + 6, Y + 14, W - 12, 5);
    // battlements along the wall top
    ctx.fillStyle = P.stoneTrim;
    for (let i = 0; i < 7; i++)
      ctx.fillRect(X + 8 + i * ((W - 16) / 7), Y + 9, (W - 16) / 10, 6);
    // corner towers
    const towers: Array<[number, number]> = [
      [X + 4, Y + 10],
      [X + W - 26, Y + 10],
      [X + 4, Y + H - 30],
      [X + W - 26, Y + H - 30],
    ];
    for (const [tx, ty] of towers) {
      ctx.fillStyle = P.stoneLight;
      ctx.fillRect(tx, ty, 22, 26);
      ctx.fillStyle = P.stoneDark;
      ctx.fillRect(tx, ty, 22, 4);
      ctx.fillStyle = teamDark;
      ctx.beginPath();
      ctx.moveTo(tx - 2, ty);
      ctx.lineTo(tx + 11, ty - 10);
      ctx.lineTo(tx + 24, ty);
      ctx.closePath();
      ctx.fill();
    }
    // central donjon
    const dx = X + W / 2 - 24;
    const dy = Y + H / 2 - 24;
    ctx.fillStyle = P.stoneLight;
    ctx.fillRect(dx, dy, 48, 46);
    ctx.fillStyle = P.stoneMid;
    ctx.fillRect(dx, dy, 48, 5);
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.moveTo(dx - 3, dy);
    ctx.lineTo(dx + 24, dy - 20);
    ctx.lineTo(dx + 51, dy);
    ctx.closePath();
    ctx.fill();
    // gate
    ctx.fillStyle = "#4c3524";
    ctx.beginPath();
    ctx.moveTo(X + W / 2 - 9, Y + H - 6);
    ctx.lineTo(X + W / 2 - 9, Y + H - 22);
    ctx.quadraticCurveTo(X + W / 2, Y + H - 30, X + W / 2 + 9, Y + H - 22);
    ctx.lineTo(X + W / 2 + 9, Y + H - 6);
    ctx.closePath();
    ctx.fill();
    // flag
    const fx = dx + 24;
    const fy = dy - 20;
    ctx.strokeStyle = "#5c4a30";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(fx, fy - 14);
    ctx.stroke();
    const wv = Math.sin(this.tGlobal * 6 + b.id) * 1.6;
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.moveTo(fx, fy - 14);
    ctx.quadraticCurveTo(fx + 6, fy - 12.5 + wv, fx + 11, fy - 10.5 + wv);
    ctx.lineTo(fx, fy - 7);
    ctx.closePath();
    ctx.fill();
  }

  private drawHouse(X: number, Y: number, W: number, H: number, team: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#c7a06b";
    ctx.fillRect(X + 8, Y + 24, W - 16, H - 30);
    ctx.fillStyle = "#8f6f45";
    ctx.fillRect(X + 8, Y + 24, W - 16, 4);
    // roof
    ctx.fillStyle = "#96503a";
    ctx.beginPath();
    ctx.moveTo(X + 3, Y + 26);
    ctx.lineTo(X + W / 2, Y + 6);
    ctx.lineTo(X + W - 3, Y + 26);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#7d4231";
    ctx.beginPath();
    ctx.moveTo(X + W / 2, Y + 6);
    ctx.lineTo(X + W - 3, Y + 26);
    ctx.lineTo(X + W / 2, Y + 26);
    ctx.closePath();
    ctx.fill();
    // door + window
    ctx.fillStyle = "#54391f";
    ctx.fillRect(X + W / 2 - 5, Y + H - 18, 10, 12);
    ctx.fillStyle = "#ffe9a8";
    ctx.fillRect(X + 14, Y + 32, 7, 7);
    // team pennant
    ctx.fillStyle = team;
    ctx.fillRect(X + W / 2 - 1, Y + 1, 2, 7);
    ctx.beginPath();
    ctx.moveTo(X + W / 2 + 1, Y + 1);
    ctx.lineTo(X + W / 2 + 7, Y + 3);
    ctx.lineTo(X + W / 2 + 1, Y + 5.5);
    ctx.closePath();
    ctx.fill();
  }

  private drawFarm(X: number, Y: number, W: number, H: number, b: Building): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#7c5a34";
    ctx.fillRect(X + 2, Y + 2, W - 4, H - 4);
    ctx.fillStyle = "#6b4c2b";
    for (let i = 0; i < 4; i++) ctx.fillRect(X + 2, Y + 6 + i * 15, W - 4, 3);
    ctx.fillStyle = "#79a444";
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 5; j++) {
        const sw = Math.sin(this.tGlobal * 2 + i * 1.3 + j * 0.7) * 0.8;
        ctx.beginPath();
        ctx.arc(X + 10 + j * 11 + sw, Y + 14 + i * 15, 3.1, 0, 7);
        ctx.fill();
      }
    ctx.fillStyle = "#93bf57";
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 5; j++) {
        if ((i + j + b.id) % 3 === 0) continue;
        ctx.beginPath();
        ctx.arc(X + 10 + j * 11, Y + 13 + i * 15, 1.7, 0, 7);
        ctx.fill();
      }
    // little hut
    ctx.fillStyle = "#a37c4a";
    ctx.fillRect(X + W - 20, Y + 3, 17, 14);
    ctx.fillStyle = "#7d4231";
    ctx.beginPath();
    ctx.moveTo(X + W - 22, Y + 4);
    ctx.lineTo(X + W - 11.5, Y - 3);
    ctx.lineTo(X + W - 1, Y + 4);
    ctx.closePath();
    ctx.fill();
  }

  private drawBarracks(
    X: number,
    Y: number,
    W: number,
    H: number,
    team: string,
    teamDark: string,
    P: Pal,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = P.stoneMid;
    ctx.fillRect(X + 6, Y + 26, W - 12, H - 32);
    ctx.fillStyle = P.stoneDark;
    ctx.fillRect(X + 6, Y + 26, W - 12, 5);
    ctx.fillStyle = teamDark;
    ctx.beginPath();
    ctx.moveTo(X + 2, Y + 28);
    ctx.lineTo(X + W / 2, Y + 8);
    ctx.lineTo(X + W - 2, Y + 28);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.moveTo(X + 2, Y + 28);
    ctx.lineTo(X + W / 2, Y + 8);
    ctx.lineTo(X + W / 2, Y + 28);
    ctx.closePath();
    ctx.fill();
    // door
    ctx.fillStyle = "#40301e";
    ctx.fillRect(X + W / 2 - 8, Y + H - 22, 16, 16);
    // crossed swords emblem
    ctx.strokeStyle = "#e8dcc3";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X + W / 2 - 7, Y + 34);
    ctx.lineTo(X + W / 2 + 7, Y + 46);
    ctx.moveTo(X + W / 2 + 7, Y + 34);
    ctx.lineTo(X + W / 2 - 7, Y + 46);
    ctx.stroke();
    // banner pole
    ctx.strokeStyle = "#5c4a30";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(X + W - 10, Y + 20);
    ctx.lineTo(X + W - 10, Y + 2);
    ctx.stroke();
    ctx.fillStyle = team;
    ctx.fillRect(X + W - 9, Y + 2, 8, 6);
  }

  private drawWall(b: Building, X: number, Y: number, P: Pal): void {
    const ctx = this.ctx;
    ctx.fillStyle = P.stoneMid;
    ctx.fillRect(X + 1, Y + 1, TILE - 2, TILE - 2);
    ctx.fillStyle = P.stoneLight;
    ctx.fillRect(X + 1, Y + 1, TILE - 2, TILE - 7);
    ctx.fillStyle = P.stoneDark;
    // merlons on the top edge
    for (let i = 0; i < 3; i++)
      ctx.fillRect(X + 2 + i * 10, Y + 1, 6, 4);
    ctx.strokeStyle = P.stoneEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(X + 1.5, Y + 1.5, TILE - 3, TILE - 3);
    // moss near water
    const v = hash2(b.tx * 31 + 7, b.ty * 17 + 3);
    if (v > 0.8) {
      ctx.fillStyle = "rgba(90,130,70,0.5)";
      ctx.fillRect(X + 3 + v * 10, Y + TILE - 8, 5, 4);
    }
  }

  private drawGate(b: Building, X: number, Y: number, P: Pal): void {
    const ctx = this.ctx;
    void b;
    ctx.fillStyle = P.stoneMid;
    ctx.fillRect(X + 1, Y + 1, TILE - 2, TILE - 2);
    ctx.fillStyle = P.stoneLight;
    ctx.fillRect(X + 1, Y + 1, TILE - 2, TILE - 8);
    // wooden door
    ctx.fillStyle = "#5c4023";
    ctx.fillRect(X + 7, Y + 6, TILE - 14, TILE - 8);
    ctx.fillStyle = "#6d4d2b";
    ctx.fillRect(X + 9, Y + 8, TILE - 18, TILE - 12);
    ctx.strokeStyle = "#3c2a16";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(X + 8, Y + 12);
    ctx.lineTo(X + TILE - 8, Y + 12);
    ctx.moveTo(X + 8, Y + 20);
    ctx.lineTo(X + TILE - 8, Y + 20);
    ctx.stroke();
    // merlons
    ctx.fillStyle = P.stoneDark;
    for (let i = 0; i < 3; i++) ctx.fillRect(X + 2 + i * 10, Y + 1, 6, 4);
  }

  private drawTower(
    b: Building,
    X: number,
    Y: number,
    W: number,
    H: number,
    team: string,
    teamDark: string,
    P: Pal,
  ): void {
    const ctx = this.ctx;
    void b;
    // tall stone tower rising above its footprint
    const cx = X + W / 2;
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(cx + 2, Y + H - 3, W * 0.42, 6, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = P.stoneMid;
    ctx.fillRect(cx - 15, Y - 22, 30, H + 18);
    ctx.fillStyle = P.stoneDark;
    ctx.fillRect(cx - 15, Y - 22, 7, H + 18);
    // top platform + merlons
    ctx.fillStyle = P.stoneLight;
    ctx.fillRect(cx - 19, Y - 30, 38, 10);
    ctx.fillStyle = P.stoneDark;
    for (let i = 0; i < 4; i++) ctx.fillRect(cx - 18 + i * 10, Y - 36, 6, 7);
    // arrow slits
    ctx.fillStyle = "#2e2a24";
    ctx.fillRect(cx - 2, Y - 12, 4, 10);
    ctx.fillRect(cx - 2, Y + 8, 4, 10);
    // roof cone + flag
    ctx.fillStyle = teamDark;
    ctx.beginPath();
    ctx.moveTo(cx - 19, Y - 30);
    ctx.lineTo(cx, Y - 46);
    ctx.lineTo(cx + 19, Y - 30);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#5c4a30";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, Y - 46);
    ctx.lineTo(cx, Y - 56);
    ctx.stroke();
    const wv = Math.sin(this.tGlobal * 6 + b.id) * 1.4;
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.moveTo(cx, Y - 56);
    ctx.quadraticCurveTo(cx + 5, Y - 55 + wv, cx + 9, Y - 53 + wv);
    ctx.lineTo(cx, Y - 50);
    ctx.closePath();
    ctx.fill();
  }

  private drawLumbercamp(X: number, Y: number, W: number, H: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#6d4d2b";
    ctx.fillRect(X + 4, Y + H - 20, W - 8, 16);
    // log pile
    ctx.fillStyle = "#8a6a3a";
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(X + 14 + i * 12, Y + H - 12, 6, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = "#c9a06b";
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(X + 14 + i * 12, Y + H - 12, 3.4, 0, 7);
      ctx.fill();
    }
    // lean-to roof
    ctx.fillStyle = "#7d4231";
    ctx.beginPath();
    ctx.moveTo(X + 2, Y + 16);
    ctx.lineTo(X + W - 6, Y + 4);
    ctx.lineTo(X + W - 2, Y + 18);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#54391f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X + W - 8, Y + 6);
    ctx.lineTo(X + W - 8, Y + H - 4);
    ctx.stroke();
  }

  private drawQuarry(X: number, Y: number, W: number, H: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#6e675c";
    ctx.fillRect(X + 3, Y + 8, W - 6, H - 11);
    ctx.fillStyle = "#57524a";
    ctx.fillRect(X + 8, Y + 14, W - 16, H - 22);
    // cut stone blocks
    ctx.fillStyle = this.pal().stoneLight;
    ctx.fillRect(X + 6, Y + H - 14, 12, 8);
    ctx.fillRect(X + 20, Y + H - 14, 12, 8);
    ctx.fillRect(X + 13, Y + H - 22, 12, 8);
    ctx.strokeStyle = "#847d70";
    ctx.lineWidth = 1;
    ctx.strokeRect(X + 6.5, Y + H - 13.5, 11, 7);
    ctx.strokeRect(X + 20.5, Y + H - 13.5, 11, 7);
    // crane arm
    ctx.strokeStyle = "#6d4d2b";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(X + W - 10, Y + H - 6);
    ctx.lineTo(X + W - 14, Y + 2);
    ctx.lineTo(X + 10, Y + 6);
    ctx.stroke();
  }

  private drawMarket(X: number, Y: number, W: number, H: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#a37c4a";
    ctx.fillRect(X + 5, Y + 18, W - 10, H - 22);
    ctx.fillStyle = "#8a653c";
    ctx.fillRect(X + 5, Y + 18, W - 10, 4);
    // striped awning
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 ? "#c94f3f" : "#e8dcc3";
      const sw = Math.sin(this.tGlobal * 3 + i) * 0.7;
      ctx.beginPath();
      ctx.moveTo(X + 2 + i * ((W - 4) / 6), Y + 8);
      ctx.lineTo(X + 2 + (i + 1) * ((W - 4) / 6), Y + 8);
      ctx.lineTo(X + 2 + (i + 0.5) * ((W - 4) / 6) + sw, Y + 18);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "#7d4231";
    ctx.fillRect(X + 2, Y + 5, W - 4, 4);
    // crates
    ctx.fillStyle = "#c9a06b";
    ctx.fillRect(X + 8, Y + H - 12, 9, 8);
    ctx.fillRect(X + 20, Y + H - 12, 9, 8);
    ctx.strokeStyle = "#8a653c";
    ctx.lineWidth = 1;
    ctx.strokeRect(X + 8.5, Y + H - 11.5, 8, 7);
    ctx.strokeRect(X + 20.5, Y + H - 11.5, 8, 7);
    // gold coin hint
    ctx.fillStyle = "#e6b93c";
    ctx.beginPath();
    ctx.arc(X + W / 2, Y + H - 8, 2.6, 0, 7);
    ctx.fill();
  }

  private drawShrine(X: number, Y: number, W: number, H: number): void {
    const ctx = this.ctx;
    const P = this.pal();
    ctx.fillStyle = P.stoneMid;
    ctx.fillRect(X + 6, Y + H - 14, W - 12, 10);
    ctx.fillStyle = P.stoneLight;
    ctx.fillRect(X + 10, Y + 10, W - 20, H - 22);
    ctx.fillStyle = P.stoneTrim;
    ctx.fillRect(X + 12, Y + 6, W - 24, 6);
    // candles
    ctx.fillStyle = "#ffe08a";
    ctx.beginPath();
    ctx.arc(X + 9, Y + H - 17, 1.8, 0, 7);
    ctx.arc(X + W - 9, Y + H - 17, 1.8, 0, 7);
    ctx.fill();
    // emblem
    ctx.strokeStyle = "#e8c877";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(X + W / 2, Y + 18, 5, 0, 7);
    ctx.moveTo(X + W / 2, Y + 13);
    ctx.lineTo(X + W / 2, Y + 23);
    ctx.stroke();
  }

  /**
   * Far LOD (whole-kingdom zoom): every unit becomes a blob in one batched
   * path per team instead of ~25 canvas operations each. A 500-unit army at
   * fit zoom costs four fill/stroke calls rather than ~12,000 ops.
   * `weapons` = 1 adds the facing hint for detail tier 1+.
   */
  private drawUnitsBatched(list: Unit[], weapons: 0 | 1): void {
    const ctx = this.ctx;
    // keep a minimum on-screen size so a massed army still reads as a mass
    // when the whole kingdom fits on screen (3.4 world px would be sub-pixel)
    const z = this.game.cam.zoom;
    const R = Math.max(3.4, 2.2 / z);
    for (const team of [0, 1] as const) {
      for (const flash of [false, true]) {
        let any = false;
        ctx.beginPath();
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (u.team !== team || (u.flash > 0) !== flash) continue;
          any = true;
          ctx.moveTo(u.x + R, u.y);
          ctx.arc(u.x, u.y, R, 0, 7);
        }
        if (!any) continue;
        ctx.fillStyle = flash ? "#ffffff" : this.teamColor(team);
        ctx.globalAlpha = 0.95;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(12,12,10,0.5)";
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
      if (!weapons) continue;
      // facing hint: one short stroke per unit, still batched per team
      ctx.beginPath();
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (u.team !== team) continue;
        ctx.moveTo(u.x, u.y);
        ctx.lineTo(u.x + Math.cos(u.facing) * 5, u.y + Math.sin(u.facing) * 3);
      }
      ctx.strokeStyle = "rgba(20,18,14,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // selection stays readable at distance
    let sel = false;
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (!u.selected) continue;
      sel = true;
      ctx.moveTo(u.x + R + 1.8, u.y + 1);
      ctx.arc(u.x, u.y + 1, R + 1.8, 0, 7);
    }
    if (sel) {
      ctx.strokeStyle = "rgba(234,255,234,0.9)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  /**
   * Mid LOD: ~7 canvas operations instead of ~25 — silhouette, team colour,
   * head, weapon hint, health. Used when zoomed out or when the adaptive
   * governor has dropped unit detail.
   */
  private drawUnitSimple(u: Unit, t: number, detail: 0 | 1 | 2): void {
    const ctx = this.ctx;
    const team = this.teamColor(u.team);
    const x = u.x;
    const y = u.y;
    const big = u.type === "knight" || u.type === "catapult";
    const body = u.flash > 0 ? "#ffffff" : team;

    // ground ring (also the selection indicator)
    ctx.lineWidth = u.selected ? 1.8 : 1.1;
    ctx.strokeStyle = u.selected ? "#eaffea" : team;
    ctx.globalAlpha = u.selected ? 0.7 + 0.25 * Math.sin(t * 5) : 0.6;
    ctx.beginPath();
    ctx.ellipse(x, y + 4, big ? 9 : 7, big ? 4 : 3.2, 0, 0, 7);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // body
    ctx.fillStyle = body;
    ctx.beginPath();
    if (big) ctx.ellipse(x, y - 3, 7.4, 4.6, 0, 0, 7);
    else ctx.arc(x, y - 3.4, 5, 0, 7);
    ctx.fill();
    // legs/base shading keeps the silhouette from looking flat
    ctx.fillStyle = u.flash > 0 ? "#ffffff" : this.teamColorDark(u.team);
    ctx.beginPath();
    ctx.arc(x, y - 1.2, big ? 6 : 4.6, 0.25, Math.PI - 0.25);
    ctx.fill();
    // head
    ctx.fillStyle = u.flash > 0 ? "#ffffff" : "#e2b48d";
    ctx.beginPath();
    ctx.arc(x + Math.cos(u.facing) * 1.2, y - 8.6, 2.6, 0, 7);
    ctx.fill();

    if (detail > 0) {
      // one-stroke weapon hint, per class
      const fx = Math.cos(u.facing);
      const fy = Math.sin(u.facing) * 0.6;
      ctx.lineWidth = 1.5;
      if (u.type === "spearman") {
        ctx.strokeStyle = "#8a6a3a";
        ctx.beginPath();
        ctx.moveTo(x - fx * 4, y - 2 + fy * 2);
        ctx.lineTo(x + fx * 12, y - 8 + fy * 5);
        ctx.stroke();
      } else if (u.type === "archer") {
        ctx.strokeStyle = "#7a5a30";
        ctx.beginPath();
        ctx.arc(x + fx * 5.5, y - 5 + fy * 3, 4.2, u.facing - 1.1, u.facing + 1.1);
        ctx.stroke();
      } else if (u.type === "militia" || u.type === "knight") {
        ctx.strokeStyle = "#d8dde4";
        ctx.beginPath();
        ctx.moveTo(x + fx * 3.5, y - 5);
        ctx.lineTo(x + fx * 10, y - 9 + fy * 3);
        ctx.stroke();
      }
    }

    if (u.hp < u.maxHp || u.selected) {
      const frac = Math.max(0, u.hp / u.maxHp);
      this.bar(
        x - 7,
        y - 15,
        14,
        2.4,
        frac,
        frac > 0.5 ? "#69d44f" : frac > 0.25 ? "#e8c13c" : "#e0503e",
        "#14100a",
      );
    }
  }

  private drawUnit(u: Unit, t: number): void {
    const ctx = this.ctx;
    const team = this.teamColor(u.team);
    const moving =
      u.state === "move" || u.state === "attackMove" || (u.state === "attack" && !!u.path);
    const bob = moving ? Math.sin(u.anim * 2) * 1.3 : Math.sin(t * 2 + u.id) * 0.35;
    const x = u.x;
    const y = u.y + bob;
    const fx = Math.cos(u.facing);
    const fy = Math.sin(u.facing) * 0.6;

    // shadow
    if (this.st.shadows) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath();
      ctx.ellipse(u.x + 1, u.y + 5, 6.5, 2.8, 0, 0, 7);
      ctx.fill();
    }

    // ground ring (team / selection)
    ctx.lineWidth = u.selected ? 2 : 1.4;
    ctx.strokeStyle = u.selected ? "#eaffea" : team;
    ctx.globalAlpha = u.selected ? 0.7 + 0.25 * Math.sin(t * 5) : 0.75;
    ctx.beginPath();
    ctx.ellipse(u.x, u.y + 4, 8, 3.6, 0, 0, 7);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const skin = "#e2b48d";
    if (u.type === "spearman") {
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : team;
      ctx.beginPath();
      ctx.arc(x, y - 3.5, 5.8, 0, 7);
      ctx.fill();
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : this.teamColorDark(u.team);
      ctx.beginPath();
      ctx.arc(x, y - 1, 5.8, 0.2, Math.PI - 0.2);
      ctx.fill();
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : skin;
      ctx.beginPath();
      ctx.arc(x + fx * 1.4, y - 9.5, 3.2, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#7a8450";
      ctx.beginPath();
      ctx.arc(x + fx * 1.4, y - 10.3, 3.4, Math.PI, 0);
      ctx.fill();
      // long spear
      ctx.strokeStyle = "#8a6a3a";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(x - fx * 5, y - 2 + fy * 3);
      ctx.lineTo(x + fx * 14, y - 9 + fy * 6);
      ctx.stroke();
      ctx.strokeStyle = "#d8dde4";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x + fx * 14, y - 9 + fy * 6);
      ctx.lineTo(x + fx * 17, y - 10.5 + fy * 7);
      ctx.stroke();
      // small round shield
      ctx.fillStyle = "#b8ae9a";
      ctx.beginPath();
      ctx.arc(x - fx * 4 - fy * 2, y - 4 - fy * 3, 2.8, 0, 7);
      ctx.fill();
    } else if (u.type === "knight") {
      // horse body
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : "#6b4a2c";
      ctx.beginPath();
      ctx.ellipse(x - fx * 2, y - 4, 9, 4.6, Math.atan2(fy, fx) * 0.4, 0, 7);
      ctx.fill();
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : "#5a3d24";
      ctx.beginPath();
      ctx.ellipse(x + fx * 6, y - 6, 3.4, 2.6, Math.atan2(fy, fx), 0, 7);
      ctx.fill();
      // rider
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : team;
      ctx.beginPath();
      ctx.arc(x - fx * 1, y - 9, 4.4, 0, 7);
      ctx.fill();
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : skin;
      ctx.beginPath();
      ctx.arc(x + fx * 0.6, y - 13, 2.8, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#9aa0a8";
      ctx.beginPath();
      ctx.arc(x + fx * 0.6, y - 13.8, 3, Math.PI, 0);
      ctx.fill();
      // lance
      ctx.strokeStyle = "#8a6a3a";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(x - fx * 6, y - 8);
      ctx.lineTo(x + fx * 13, y - 10 + fy * 5);
      ctx.stroke();
      // pennant
      ctx.fillStyle = team;
      ctx.beginPath();
      ctx.moveTo(x + fx * 9, y - 10 + fy * 4);
      ctx.lineTo(x + fx * 9 + 4, y - 12 + fy * 4);
      ctx.lineTo(x + fx * 9, y - 13 + fy * 4);
      ctx.closePath();
      ctx.fill();
    } else if (u.type === "catapult") {
      // frame + wheels
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : "#6d4d2b";
      ctx.fillRect(x - 9, y - 6, 18, 7);
      ctx.fillStyle = "#4c3524";
      ctx.beginPath();
      ctx.arc(x - 6, y + 2, 3.4, 0, 7);
      ctx.arc(x + 6, y + 2, 3.4, 0, 7);
      ctx.fill();
      ctx.strokeStyle = "#3c2a16";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x - 6, y + 2, 1.4, 0, 7);
      ctx.arc(x + 6, y + 2, 1.4, 0, 7);
      ctx.stroke();
      // throwing arm
      const arm = u.atkCd > UNIT_DEFS.catapult.cd - 0.3 ? -0.9 : -0.35;
      ctx.strokeStyle = "#8a6a3a";
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(x - fx * 4, y - 5);
      ctx.lineTo(x - fx * 4 + Math.cos(arm) * 14 * (fx >= 0 ? 1 : 1), y - 5 + Math.sin(arm) * 14);
      ctx.stroke();
      ctx.fillStyle = "#8f897c";
      ctx.beginPath();
      ctx.arc(x - fx * 4 + Math.cos(arm) * 14, y - 5 + Math.sin(arm) * 14, 2.6, 0, 7);
      ctx.fill();
    } else if (u.type === "villager") {
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : "#b98d5f";
      ctx.beginPath();
      ctx.arc(x, y - 3, 5.4, 0, 7);
      ctx.fill();
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : skin;
      ctx.beginPath();
      ctx.arc(x + fx * 1.6, y - 9, 3.4, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#6e5130";
      ctx.beginPath();
      ctx.arc(x + fx * 1.6, y - 10.6, 3.5, Math.PI, 0);
      ctx.fill();
      // tool
      ctx.strokeStyle = "#8a6a3a";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x + fx * 3, y - 4);
      ctx.lineTo(x + fx * 8, y - 9 + (u.state === "harvest" || u.state === "build" ? Math.sin(u.anim * 6) * 3 : 0));
      ctx.stroke();
    } else if (u.type === "militia") {
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : team;
      ctx.beginPath();
      ctx.arc(x, y - 3.5, 6, 0, 7);
      ctx.fill();
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : this.teamColorDark(u.team);
      ctx.beginPath();
      ctx.arc(x, y - 1, 6, 0.2, Math.PI - 0.2);
      ctx.fill();
      // shield
      ctx.fillStyle = "#c9c2b4";
      ctx.beginPath();
      ctx.arc(x - fx * 4.5 - fy * 2, y - 3 - fy * 3, 3.1, 0, 7);
      ctx.fill();
      // head + helmet
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : skin;
      ctx.beginPath();
      ctx.arc(x + fx * 1.4, y - 9.5, 3.3, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#9aa0a8";
      ctx.beginPath();
      ctx.arc(x + fx * 1.4, y - 10.4, 3.4, Math.PI, 0);
      ctx.fill();
      // sword (swings through an arc right after striking)
      const cd = UNIT_DEFS.militia.cd;
      const ph = u.atkCd > cd - 0.28 ? 1 - (cd - u.atkCd) / 0.28 : 0;
      const ang = -0.9 + ph * 1.7;
      ctx.strokeStyle = "#d8dde4";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + fx * 4, y - 5);
      ctx.lineTo(
        x + fx * 4 + Math.cos(u.facing * 0.3 + ang) * 9,
        y - 8 + Math.sin(ang) * 5 + fy * 4,
      );
      ctx.stroke();
    } else {
      // archer
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : team;
      ctx.beginPath();
      ctx.arc(x, y - 3.5, 5.4, 0, 7);
      ctx.fill();
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : this.teamColorDark(u.team);
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 2);
      ctx.lineTo(x, y - 8);
      ctx.lineTo(x + 5, y - 2);
      ctx.closePath();
      ctx.fill();
      // hooded head
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : skin;
      ctx.beginPath();
      ctx.arc(x + fx * 1.4, y - 9.5, 3.1, 0, 7);
      ctx.fill();
      ctx.fillStyle = u.flash > 0 ? "#ffffff" : "#4a6b35";
      ctx.beginPath();
      ctx.arc(x + fx * 1.4, y - 10.2, 3.4, Math.PI * 0.9, Math.PI * 2.1);
      ctx.fill();
      // bow
      ctx.strokeStyle = "#7a5a30";
      ctx.lineWidth = 1.8;
      const bx = x + fx * 6.5;
      const by = y - 5 + fy * 4;
      ctx.beginPath();
      ctx.arc(bx, by, 5, u.facing - 1.2, u.facing + 1.2);
      ctx.stroke();
      const pull = u.atkCd < 0.35 ? (0.35 - u.atkCd) * 6 : 0;
      const s1x = bx + Math.cos(u.facing - 1.2) * 5;
      const s1y = by + Math.sin(u.facing - 1.2) * 5;
      const s2x = bx + Math.cos(u.facing + 1.2) * 5;
      const s2y = by + Math.sin(u.facing + 1.2) * 5;
      ctx.strokeStyle = "#e8e0cc";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(s1x, s1y);
      ctx.lineTo(bx - Math.cos(u.facing) * pull, by - Math.sin(u.facing) * pull);
      ctx.lineTo(s2x, s2y);
      ctx.stroke();
    }

    // hp bar
    if (u.hp < u.maxHp || u.selected) {
      const frac = Math.max(0, u.hp / u.maxHp);
      this.bar(x - 8, y - 17, 16, 2.6, frac, frac > 0.5 ? "#69d44f" : frac > 0.25 ? "#e8c13c" : "#e0503e", "#14100a");
    }
    // veterancy chevrons
    if (u.rank > 0) {
      ctx.strokeStyle = u.rank === 2 ? "#ffd166" : "#e8c877";
      ctx.lineWidth = 1.6;
      for (let r = 0; r < u.rank; r++) {
        const cy2 = y - 20 - r * 3.4;
        ctx.beginPath();
        ctx.moveTo(x - 3.5, cy2 + 2.4);
        ctx.lineTo(x, cy2);
        ctx.lineTo(x + 3.5, cy2 + 2.4);
        ctx.stroke();
      }
    }
  }

  private bar(
    x: number,
    y: number,
    w: number,
    h: number,
    frac: number,
    color: string,
    bg: string,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = bg;
    ctx.fillRect(x - 0.5, y - 0.5, w + 1, h + 1);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
  }

  private drawPlacement(
    prev: { type: keyof typeof BUILDING_DEFS; tiles: Array<{ x: number; y: number }> },
    g: Game,
  ): void {
    const ctx = this.ctx;
    for (const tl of prev.tiles) {
      const ok =
        g.canPlace(0, prev.type, tl.x, tl.y) &&
        canAfford(g.res[0], BUILDING_DEFS[prev.type].cost);
      ctx.fillStyle = ok ? "rgba(110,230,110,0.35)" : "rgba(235,80,60,0.4)";
      ctx.fillRect(tl.x * TILE, tl.y * TILE, TILE, TILE);
      ctx.strokeStyle = ok ? "rgba(150,255,150,0.8)" : "rgba(255,120,90,0.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(tl.x * TILE + 0.5, tl.y * TILE + 0.5, TILE - 1, TILE - 1);
    }
  }

  // ── minimap (shared painter) ───────────────────────────────────────────────

  private renderMinimap(): void {
    this.mmr.render(this.game);
  }
}
