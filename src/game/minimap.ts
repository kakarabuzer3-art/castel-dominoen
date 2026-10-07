import { MAP_H, MAP_W, TEAM_COLORS, TILE } from "./constants";
import type { Game } from "./engine";

/** Shared 2D minimap painter used by both the Canvas2D and WebGL renderers. */
export class MinimapRenderer {
  private base: HTMLCanvasElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  setCanvas(el: HTMLCanvasElement | null): void {
    this.canvas = el;
    this.ctx = el ? el.getContext("2d") : null;
    this.base = null;
  }

  reset(): void {
    this.base = null;
  }

  render(g: Game): void {
    const mm = this.canvas;
    const ctx = this.ctx;
    if (!mm || !ctx) return;
    const size = mm.width;
    if (size === 0) return;
    const s = size / (MAP_W * TILE);

    if (!this.base || this.base.width !== MAP_W) {
      const base = document.createElement("canvas");
      base.width = MAP_W;
      base.height = MAP_H;
      const bc = base.getContext("2d")!;
      const img = bc.createImageData(MAP_W, MAP_H);
      const terr = g.grid.terrain;
      const desert = g.grid.theme === "desert";
      for (let i = 0; i < terr.length; i++) {
        const t = terr[i];
        let r = desert ? 217 : 77;
        let gg = desert ? 194 : 122;
        let b = desert ? 140 : 58;
        if (t === 1) {
          if (desert) {
            r = 63; gg = 147; b = 165;
          } else {
            r = 47; gg = 93; b = 158;
          }
        } else if (t === 4) {
          r = 105; gg = 168; b = 68;
        } else if (t === 2) {
          r = desert ? 201 : 122; gg = desert ? 173 : 106; b = desert ? 124 : 74;
        } else if (t === 3) {
          r = desert ? 176 : 125; gg = desert ? 150 : 119; b = desert ? 120 : 108;
        } else if (t === 5) {
          r = 122; gg = 90; b = 52;
        } else if (t === 6) {
          r = 121; gg = 168; b = 196;
        }
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = gg;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = 255;
      }
      bc.putImageData(img, 0, 0);
      this.base = base;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0, size, size);

    for (const n of g.nodes) {
      if (!g.isExplored(g.myTeam, n.tx * TILE, n.ty * TILE)) continue;
      ctx.fillStyle =
        n.kind === "tree"
          ? g.grid.theme === "desert"
            ? "#2f6b2a"
            : "#20401c"
          : n.kind === "rock"
            ? "#c8c2b6"
            : "#f0c840";
      ctx.fillRect(n.tx * TILE * s, n.ty * TILE * s, Math.max(2, 26 * s), Math.max(2, 26 * s));
    }
    for (const b of g.buildings) {
      if (b.team !== g.myTeam && !g.isExplored(g.myTeam, (b.tx + b.w / 2) * TILE, (b.ty + b.h / 2) * TILE))
        continue;
      ctx.fillStyle = g.renderer?.teamColor(b.team) ?? TEAM_COLORS[b.team];
      const bw = Math.max(3, b.w * TILE * s);
      const bh = Math.max(3, b.h * TILE * s);
      ctx.globalAlpha = b.built ? 1 : 0.5;
      ctx.fillRect(b.tx * TILE * s, b.ty * TILE * s, bw, bh);
      ctx.globalAlpha = 1;
    }
    if (g.fogOn() && this.fogImage(g)) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fogImage(g)!, 0, 0, size, size);
      ctx.imageSmoothingEnabled = false;
    }
    for (const u of g.units) {
      if (u.team !== g.myTeam && !g.isVisibleTo(g.myTeam, u.x, u.y)) continue;
      ctx.fillStyle = u.team === 0 ? "#8fb7ff" : "#ff9d8f";
      ctx.fillRect(u.x * s - 1, u.y * s - 1, 2.5, 2.5);
    }
    const vb = g.viewBounds();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(vb.x0 * s, vb.y0 * s, (vb.x1 - vb.x0) * s, (vb.y1 - vb.y0) * s);
  }

  private fogCv: HTMLCanvasElement | null = null;
  private fogVer = -1;
  private fogImage(g: Game): HTMLCanvasElement | null {
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
      img.data[i * 4] = 8;
      img.data[i * 4 + 1] = 10;
      img.data[i * 4 + 2] = 14;
      img.data[i * 4 + 3] = vis[i] ? 0 : exp[i] ? 120 : 255;
    }
    ctx.putImageData(img, 0, 0);
    return this.fogCv;
  }
}
