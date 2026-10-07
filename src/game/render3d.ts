import * as THREE from "three";
import {
  TEAM_COLORS,
  TEAM_COLORS_DARK,
  TILE,
  T_BRIDGE,
  T_DIRT,
  T_FORD,
  T_OASIS,
  T_ROCKY,
  T_WATER,
} from "./constants";
import type { Game } from "./engine";
import { MinimapRenderer } from "./minimap";
import { hash2 } from "./rng";
import type { Building } from "./types";

const FOG_H = 5.2; // above tallest building; screen-space offset compensated per frame
const CLEAR = ["#2563eb", "#f97316"];
const CLEAR_DARK = ["#1e40af", "#9a3412"];

interface Pal {
  grass: [number, number, number][];
  dirt: [number, number, number][];
  rock: [number, number, number][];
  water: [number, number, number];
  oasis: [number, number, number][];
  sand: boolean;
}
const GREEN: Pal = {
  grass: [
    [0.36, 0.56, 0.26],
    [0.33, 0.54, 0.24],
    [0.38, 0.59, 0.29],
    [0.31, 0.52, 0.23],
  ],
  dirt: [
    [0.61, 0.51, 0.33],
    [0.58, 0.47, 0.3],
    [0.64, 0.54, 0.36],
  ],
  rock: [
    [0.55, 0.52, 0.47],
    [0.51, 0.49, 0.44],
    [0.58, 0.56, 0.5],
  ],
  water: [0.15, 0.35, 0.62],
  oasis: [
    [0.36, 0.56, 0.26],
    [0.33, 0.54, 0.24],
  ],
  sand: false,
};
const DESERT: Pal = {
  grass: [
    [0.85, 0.76, 0.55],
    [0.83, 0.73, 0.51],
    [0.87, 0.79, 0.59],
    [0.81, 0.71, 0.49],
  ],
  dirt: [
    [0.79, 0.68, 0.49],
    [0.76, 0.65, 0.46],
    [0.82, 0.71, 0.52],
  ],
  rock: [
    [0.69, 0.59, 0.47],
    [0.65, 0.55, 0.43],
    [0.73, 0.63, 0.51],
  ],
  water: [0.17, 0.52, 0.6],
  oasis: [
    [0.41, 0.66, 0.27],
    [0.38, 0.63, 0.24],
  ],
  sand: true,
};

/** shared geometry cache */
const GEO: Record<string, THREE.BufferGeometry> = {};
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  if (!GEO[key]) GEO[key] = make();
  return GEO[key];
}
const MAT: Record<string, THREE.Material> = {};
function mat(key: string, make: () => THREE.Material): THREE.Material {
  if (!MAT[key]) MAT[key] = make();
  return MAT[key];
}

export class Renderer3D {
  kind = "3d" as const;
  private r3: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam: THREE.OrthographicCamera;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private mm = new MinimapRenderer();
  private dpr = 1;
  private azimuth = Math.PI / 4;
  private azimuthTarget = Math.PI / 4;
  private terrain!: THREE.Mesh;
  private water!: THREE.Mesh;
  private fogPlane!: THREE.Mesh;
  private fogTex!: THREE.CanvasTexture;
  private fogCv: HTMLCanvasElement;
  private fogVer = -1;
  // instanced sets
  private flora: THREE.InstancedMesh[] = [];
  private bParts: THREE.InstancedMesh[] = [];
  private siteParts: THREE.InstancedMesh[] = [];
  private uParts: THREE.InstancedMesh[] = [];
  private projMesh!: THREE.InstancedMesh;
  private rockMesh!: THREE.InstancedMesh;
  private ringMesh!: THREE.InstancedMesh;
  private ghostMesh!: THREE.InstancedMesh;
  private decalMesh!: THREE.InstancedMesh;
  private torchMesh!: THREE.InstancedMesh;
  private torchGlow!: THREE.InstancedMesh;
  private points!: THREE.Points;
  /** last applied adaptive-quality tier (effects are re-applied on change) */
  private appliedTier = -1;
  private appliedTerrainLod = -1;
  private appliedShadows: boolean | null = null;
  private skirt: THREE.Mesh | null = null;
  private colCache = new Map<string, THREE.Color>();
  private pointsAdd!: THREE.Points;
  private bVersion = -1;
  private disposed = false;

  static supported(): boolean {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      return false;
    }
  }

  constructor(
    private game: Game,
    private canvas: HTMLCanvasElement,
  ) {
    this.r3 = new THREE.WebGLRenderer({
      canvas,
      antialias: game.settings.quality > 0,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.r3.setPixelRatio(1);
    this.r3.shadowMap.enabled =
      game.settings.shadows && game.settings.quality > 0;
    this.r3.shadowMap.type = THREE.PCFShadowMap;
    this.cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
    this.hemi = new THREE.HemisphereLight(0xcfe4ff, 0x6b6046, 0.85);
    this.sun = new THREE.DirectionalLight(0xfff2d0, 1.15);
    this.sun.position.set(60, 90, 40);
    this.sun.castShadow = this.r3.shadowMap.enabled;
    const sc = this.sun.shadow;
    sc.mapSize.set(
      game.settings.quality === 2 ? 2048 : 1024,
      game.settings.quality === 2 ? 2048 : 1024,
    );
    sc.camera.left = -80;
    sc.camera.right = 80;
    sc.camera.top = 80;
    sc.camera.bottom = -80;
    sc.bias = -0.0006;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.background = new THREE.Color(0x0d0f0a);

    this.overlay = document.createElement("canvas");
    this.overlay.style.cssText =
      "position:absolute;inset:0;pointer-events:none;width:100%;height:100%";
    canvas.parentNode?.insertBefore(this.overlay, canvas.nextSibling);
    const oc = this.overlay.getContext("2d");
    if (!oc) throw new Error("overlay ctx");
    this.octx = oc;
    this.fogCv = document.createElement("canvas");

    this.buildTerrain();
    this.buildStaticSets();
    this.buildDynamicSets();
    this.autoResize();
  }

  teamColor(t: 0 | 1): string {
    return this.game.settings.clearColors ? CLEAR[t] : TEAM_COLORS[t];
  }
  teamColorDark(t: 0 | 1): string {
    return this.game.settings.clearColors ? CLEAR_DARK[t] : TEAM_COLORS_DARK[t];
  }

  setMinimap(el: HTMLCanvasElement | null): void {
    this.mm.setCanvas(el);
  }

  reset(): void {
    // wipe scene groups and rebuild
    for (const m of [...this.flora, ...this.bParts, ...this.siteParts])
      this.scene.remove(m);
    this.flora = [];
    this.bParts = [];
    this.siteParts = [];
    this.rebuildGround();
    this.buildStaticSets();
    this.bVersion = -1;
    this.mm.reset();
  }

  dispose(): void {
    this.disposed = true;
    this.ro?.disconnect();
    this.overlay.remove();
    this.r3.dispose();
  }

  private ro: ResizeObserver | null = null;
  private autoResize(): void {
    const doIt = () => {
      const r = this.canvas.getBoundingClientRect();
      this.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
    };
    doIt();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(doIt);
      this.ro.observe(this.canvas);
    }
  }

  resize(w: number, h: number, dpr: number): void {
    if (w <= 0 || h <= 0) return;
    const base =
      this.game.settings.quality === 0
        ? 1
        : Math.min(dpr, this.game.settings.quality === 2 ? 2 : 1.5);
    // adaptive governor may render at a fraction of the device pixel ratio —
    // the cheapest big win on a struggling GPU
    this.dpr = Math.max(0.6, base * this.game.perf.state.dprScale);
    this.r3.setPixelRatio(this.dpr);
    this.r3.setSize(w, h, false);
    this.overlay.width = Math.round(w * this.dpr);
    this.overlay.height = Math.round(h * this.dpr);
    if (this.game.viewW !== w || this.game.viewH !== h) {
      this.game.viewW = w;
      this.game.viewH = h;
      this.game.clampCam();
    }
    this.updateCameraFrustum();
  }

  private updateCameraFrustum(): void {
    const w = this.game.viewW / TILE / this.game.cam.zoom;
    const h = this.game.viewH / TILE / this.game.cam.zoom;
    this.cam.left = -w / 2;
    this.cam.right = w / 2;
    this.cam.top = h / 2;
    this.cam.bottom = -h / 2;
    this.cam.updateProjectionMatrix();
  }

  // ── terrain ────────────────────────────────────────────────────────────────
  private heightAt(tx: number, ty: number): number {
    const g = this.game.grid;
    if (!g.inBounds(tx, ty)) return 0;
    const t = g.terrain[g.idx(tx, ty)];
    if (t === T_WATER) return -0.4;
    if (t === T_FORD) return -0.14;
    if (t === T_BRIDGE) return 0.12;
    if (t === T_ROCKY) {
      // smoothed hill
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (g.inBounds(tx + dx, ty + dy) && g.terrain[g.idx(tx + dx, ty + dy)] === T_ROCKY) {
            s++;
          }
          n++;
        }
      return 0.18 + 0.3 * (s / n);
    }
    if (t === T_DIRT) return 0.02;
    return 0;
  }

  /**
   * Dispose and rebuild the ground meshes (terrain, skirt, water, fog plane).
   * Used by reset() and by the adaptive ladder when terrain tessellation
   * changes; disposing here also fixes a long-standing skirt-mesh leak on
   * every restart.
   */
  private rebuildGround(): void {
    for (const m of [this.terrain, this.skirt, this.water, this.fogPlane]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) for (const x of mat) x.dispose();
      else mat.dispose();
    }
    this.skirt = null;
    this.fogTex?.dispose();
    this.fogVer = -1;
    this.buildTerrain();
  }

  private buildTerrain(): void {
    const g = this.game.grid;
    const w = g.w;
    const h = g.h;
    const pal = g.theme === "desert" ? DESERT : GREEN;
    // Tessellation LOD: one vertex per tile normally, half that at the bottom
    // of the adaptive ladder (an XL map is 161x161 = 51k triangles otherwise).
    const lod = this.game.perf.state.terrainLod;
    const seg = lod ? Math.max(8, Math.ceil(w / 2)) : w;
    const segY = lod ? Math.max(8, Math.ceil(h / 2)) : h;
    const geom = new THREE.PlaneGeometry(w, h, seg, segY);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    for (let iy = 0; iy <= segY; iy++) {
      for (let ix = 0; ix <= seg; ix++) {
        const i = iy * (seg + 1) + ix;
        const tx = Math.min(w - 1, Math.round((ix * w) / seg));
        const ty = Math.min(h - 1, Math.round((iy * h) / segY));
        const t = g.terrain[g.idx(tx, ty)];
        const tone = g.tone[g.idx(tx, ty)];
        pos.setY(i, this.heightAt(tx, ty));
        let c: [number, number, number];
        if (t === T_WATER) c = pal.water;
        else if (t === T_FORD) c = [pal.water[0] + 0.2, pal.water[1] + 0.2, pal.water[2] + 0.15];
        else if (t === T_BRIDGE) c = [0.45, 0.33, 0.2];
        else if (t === T_ROCKY) c = pal.rock[(tone * 3) | 0];
        else if (t === T_DIRT) c = pal.dirt[(tone * 3) | 0];
        else if (t === T_OASIS) c = pal.oasis[(tone * 2) | 0];
        else c = pal.grass[(tone * 4) | 0];
        const shade = 0.94 + hash2(tx * 3 + 11, ty * 5 + 7) * 0.12;
        colors[i * 3] = c[0] * shade;
        colors[i * 3 + 1] = c[1] * shade;
        colors[i * 3 + 2] = c[2] * shade;
      }
    }
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.terrain = new THREE.Mesh(geom, m);
    this.terrain.position.set(w / 2, 0, h / 2);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);

    // skirt plane hides out-of-map void
    const skirt = new THREE.Mesh(
      geo("skirt", () => new THREE.PlaneGeometry(600, 600)).clone(),
      mat("skirt", () =>
        new THREE.MeshLambertMaterial({
          color: pal.sand ? 0x6a5a40 : 0x3a4a30,
        }),
      ),
    );
    skirt.geometry.rotateX(-Math.PI / 2);
    skirt.position.set(w / 2, -0.75, h / 2);
    this.skirt = skirt;
    this.scene.add(skirt);

    // water sheet
    const wg = new THREE.PlaneGeometry(w, h, 1, 1);
    wg.rotateX(-Math.PI / 2);
    const wm = new THREE.MeshLambertMaterial({
      color: new THREE.Color(...pal.water),
      transparent: true,
      opacity: 0.82,
    });
    this.water = new THREE.Mesh(wg, wm);
    this.water.position.set(w / 2, -0.16, h / 2);
    this.scene.add(this.water);

    // fog plane
    this.fogCv.width = w;
    this.fogCv.height = h;
    this.fogTex = new THREE.CanvasTexture(this.fogCv);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    const fm = new THREE.MeshBasicMaterial({
      map: this.fogTex,
      transparent: true,
      depthWrite: false,
    });
    const fg = new THREE.PlaneGeometry(w, h, 1, 1);
    fg.rotateX(-Math.PI / 2);
    this.fogPlane = new THREE.Mesh(fg, fm);
    this.fogPlane.position.set(w / 2, FOG_H, h / 2);
    this.fogPlane.visible = this.game.fogOn();
    this.scene.add(this.fogPlane);
  }

  /** shift the elevated fog plane along the ground so its projection matches terrain tiles */
  private alignFogPlane(): void {
    const g = this.game;
    this.cam.updateMatrixWorld();
    const e = this.cam.matrixWorld.elements;
    const rx = e[0], rz = e[2];
    const ux = e[4], uy = e[5], uz = e[6];
    // horizontal ground direction with zero screen-x contribution
    let fx = e[8] === 0 ? 1 : 0;
    // forward on ground plane = camera view dir projected & normalized
    const vx = -e[8], vz = -e[10];
    const vl = Math.hypot(vx, vz) || 1;
    fx = vx / vl;
    const fz = vz / vl;
    const upF = ux * fx + uz * fz;
    if (Math.abs(upF) < 1e-4) return;
    const a = (-FOG_H * uy) / upF;
    this.fogPlane.position.set(g.grid.w / 2 + fx * a, FOG_H, g.grid.h / 2 + fz * a);
    void rx;
    void rz;
  }

  private updateFogTexture(): void {
    const g = this.game;
    this.fogPlane.visible = g.fogOn();
    if (!g.fogOn() || this.fogVer === g.fogVersion) return;
    this.fogVer = g.fogVersion;
    const ctx = this.fogCv.getContext("2d")!;
    const w = g.grid.w;
    const h = g.grid.h;
    const img = ctx.createImageData(w, h);
    const vis = g.visible[g.myTeam];
    const exp = g.explored[g.myTeam];
    for (let i = 0; i < vis.length; i++) {
      img.data[i * 4] = 8;
      img.data[i * 4 + 1] = 10;
      img.data[i * 4 + 2] = 14;
      img.data[i * 4 + 3] = vis[i] ? 0 : exp[i] ? 130 : 255;
    }
    ctx.putImageData(img, 0, 0);
    this.fogTex.needsUpdate = true;
  }

  // ── instanced static sets ──────────────────────────────────────────────────
  private dummy = new THREE.Object3D();
  private col = new THREE.Color();

  private addInst(
    list: THREE.InstancedMesh[],
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    count: number,
    cast = true,
  ): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    m.count = 0;
    m.castShadow = cast && this.r3.shadowMap.enabled;
    m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // three caches InstancedMesh.boundingSphere at the first frustum check and
    // never recomputes it, so dynamic sets (units, projectiles, rings...) get
    // culled against a stale sphere from the menu preview and vanish mid-match.
    // These are single batched draw calls; per-set culling is all-or-nothing,
    // so skip it (same treatment as the particle Points below).
    m.frustumCulled = false;
    this.scene.add(m);
    list.push(m);
    return m;
  }

  private buildStaticSets(): void {
    const wood = mat("wood", () => new THREE.MeshLambertMaterial({ color: 0x7a5a34 }));
    const leaf = mat("leaf", () => new THREE.MeshLambertMaterial({ color: 0x3f7a34 }));
    const leafD = mat("leafD", () => new THREE.MeshLambertMaterial({ color: 0x2f6b2a }));
    const stone = mat("stone", () => new THREE.MeshLambertMaterial({ color: 0x8f897c }));
    const goldM = mat("gold", () => new THREE.MeshLambertMaterial({ color: 0xe6b93c }));
    const trunkG = geo("trunk", () => new THREE.CylinderGeometry(0.09, 0.13, 0.7, 5));
    const coneG = geo("cone", () => new THREE.ConeGeometry(0.42, 0.95, 6));
    const rockG = geo("rock", () => new THREE.DodecahedronGeometry(0.34, 0));
    const goldG = geo("goldBit", () => new THREE.DodecahedronGeometry(0.16, 0));

    const g = this.game;
    const desert = g.grid.theme === "desert";
    const trees = g.nodes.filter((n) => n.kind === "tree");
    const rocks = g.nodes.filter((n) => n.kind === "rock");
    const golds = g.nodes.filter((n) => n.kind === "gold");
    const t1 = this.addInst(this.flora, trunkG, wood, trees.length);
    const t2 = this.addInst(this.flora, coneG, desert ? leafD : leaf, trees.length);
    let i = 0;
    for (const n of trees) {
      const x = n.tx + 0.5;
      const z = n.ty + 0.5;
      const y = this.heightAt(n.tx, n.ty);
      const s = 0.85 + (n.variant % 100) / 300;
      if (desert) {
        this.dummy.position.set(x + 0.08, y + 0.55, z);
        this.dummy.rotation.set(0, 0, 0.12);
        this.dummy.scale.set(1, s, 1);
      } else {
        this.dummy.position.set(x, y + 0.35, z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1, s, 1);
      }
      this.dummy.updateMatrix();
      t1.setMatrixAt(i, this.dummy.matrix);
      if (desert) {
        this.dummy.position.set(x + 0.14, y + 1.12, z);
        this.dummy.rotation.set(0, n.variant, 0);
        this.dummy.scale.set(1.25, 0.8, 1.25);
      } else {
        this.dummy.position.set(x, y + 0.95 + 0.15 * s, z);
        this.dummy.rotation.set(0, n.variant, 0);
        this.dummy.scale.set(s, s, s);
      }
      this.dummy.updateMatrix();
      t2.setMatrixAt(i, this.dummy.matrix);
      i++;
    }
    t1.count = i;
    t2.count = i;
    t1.instanceMatrix.needsUpdate = true;
    t2.instanceMatrix.needsUpdate = true;

    const r1 = this.addInst(this.flora, rockG, stone, rocks.length);
    i = 0;
    for (const n of rocks) {
      this.dummy.position.set(n.tx + 0.5, this.heightAt(n.tx, n.ty) + 0.2, n.ty + 0.5);
      this.dummy.rotation.set(n.variant % 3, n.variant % 5, 0);
      const s = 0.8 + (n.variant % 70) / 100;
      this.dummy.scale.set(s, s * 0.8, s);
      this.dummy.updateMatrix();
      r1.setMatrixAt(i++, this.dummy.matrix);
    }
    r1.count = i;
    r1.instanceMatrix.needsUpdate = true;

    const g1 = this.addInst(this.flora, rockG, stone, golds.length);
    const g2 = this.addInst(this.flora, goldG, goldM, golds.length * 3, false);
    i = 0;
    let j = 0;
    for (const n of golds) {
      const y = this.heightAt(n.tx, n.ty);
      this.dummy.position.set(n.tx + 0.5, y + 0.18, n.ty + 0.5);
      this.dummy.rotation.set(0, n.variant % 6, 0);
      this.dummy.scale.set(0.9, 0.7, 0.9);
      this.dummy.updateMatrix();
      g1.setMatrixAt(i, this.dummy.matrix);
      for (let k = 0; k < 3; k++) {
        this.dummy.position.set(
          n.tx + 0.3 + ((n.variant >> k) % 5) * 0.1,
          y + 0.34,
          n.ty + 0.3 + ((n.variant >> (k + 2)) % 5) * 0.1,
        );
        this.dummy.scale.setScalar(0.9);
        this.dummy.updateMatrix();
        g2.setMatrixAt(j++, this.dummy.matrix);
      }
      i++;
    }
    g1.count = i;
    g2.count = j;
    g1.instanceMatrix.needsUpdate = true;
    g2.instanceMatrix.needsUpdate = true;

    // bridges already in terrain height/color; add plank rails
    const railG = geo("rail", () => new THREE.BoxGeometry(1, 0.08, 0.08));
    const bridges: Array<{ x: number; y: number }> = [];
    for (let ty = 0; ty < g.grid.h; ty++)
      for (let tx = 0; tx < g.grid.w; tx++)
        if (g.grid.terrain[g.grid.idx(tx, ty)] === T_BRIDGE) bridges.push({ x: tx, y: ty });
    const rail = this.addInst(this.flora, railG, wood, bridges.length * 2, false);
    i = 0;
    for (const b of bridges) {
      for (const dz of [-0.45, 0.45]) {
        this.dummy.position.set(b.x + 0.5, 0.2, b.y + 0.5 + dz);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        rail.setMatrixAt(i++, this.dummy.matrix);
      }
    }
    rail.count = i;
    rail.instanceMatrix.needsUpdate = true;
  }

  // ── buildings ─────────────────────────────────────────────────────────────
  private buildPartsDef(): Array<{
    types: string[];
    geo: THREE.BufferGeometry;
    mat: THREE.Material;
    teamTint?: boolean;
    off: (b: Building) => Array<[number, number, number, number, number, number]>;
  }> {
    const stoneM = mat("bstone", () => new THREE.MeshLambertMaterial({ color: 0xa29a8c }));
    const stoneD = mat("bstoneD", () => new THREE.MeshLambertMaterial({ color: 0x847d6f }));
    const woodM = mat("bwood", () => new THREE.MeshLambertMaterial({ color: 0xa37c4a }));
    const roofR = mat("broofR", () => new THREE.MeshLambertMaterial({ color: 0x96503a }));
    const soil = mat("soil", () => new THREE.MeshLambertMaterial({ color: 0x7c5a34 }));
    const crop = mat("crop", () => new THREE.MeshLambertMaterial({ color: 0x79a444 }));
    const door = mat("door", () => new THREE.MeshLambertMaterial({ color: 0x4c3524 }));
    const box = (w: number, h: number, d: number) =>
      geo(`box${w}_${h}_${d}`, () => new THREE.BoxGeometry(w, h, d));
    const cone4 = (r: number, h: number) =>
      geo(`cone4_${r}_${h}`, () => new THREE.ConeGeometry(r, h, 4));
    const cyl = (r: number, h: number) =>
      geo(`cyl_${r}_${h}`, () => new THREE.CylinderGeometry(r, r, h, 8));

    const P: Array<{
      types: string[];
      geo: THREE.BufferGeometry;
      mat: THREE.Material;
      teamTint?: boolean;
      off: (b: Building) => Array<[number, number, number, number, number, number]>;
    }> = [];
    const cx = (b: Building) => b.w / 2;
    const cz = (b: Building) => b.h / 2;
    // keep
    P.push({ types: ["keep"], geo: box(4.6, 1.7, 4.6), mat: stoneM, off: (b) => [[cx(b), 0.85, cz(b), 1, 1, 1]] });
    P.push({ types: ["keep"], geo: box(1.8, 2.4, 1.8), mat: stoneM, off: (b) => [[cx(b), 2.1, cz(b), 1, 1, 1]] });
    P.push({ types: ["keep"], geo: cone4(1.5, 1.2), mat: roofR, teamTint: true, off: (b) => [[cx(b), 3.8, cz(b), 1, 1, 1]] });
    P.push({
      types: ["keep"],
      geo: cyl(0.55, 2.4),
      mat: stoneD,
      off: (b) => [
        [0.5, 1.2, 0.5, 1, 1, 1],
        [b.w - 0.5, 1.2, 0.5, 1, 1, 1],
        [0.5, 1.2, b.h - 0.5, 1, 1, 1],
        [b.w - 0.5, 1.2, b.h - 0.5, 1, 1, 1],
      ],
    });
    P.push({
      types: ["keep"],
      geo: cone4(0.75, 0.9),
      mat: roofR,
      teamTint: true,
      off: (b) => [
        [0.5, 2.8, 0.5, 1, 1, 1],
        [b.w - 0.5, 2.8, 0.5, 1, 1, 1],
        [0.5, 2.8, b.h - 0.5, 1, 1, 1],
        [b.w - 0.5, 2.8, b.h - 0.5, 1, 1, 1],
      ],
    });
    P.push({ types: ["keep"], geo: box(0.9, 1.1, 0.2), mat: door, off: (b) => [[cx(b), 0.6, b.h - 0.05, 1, 1, 1]] });
    // house
    P.push({ types: ["house"], geo: box(1.5, 0.9, 1.5), mat: woodM, off: (b) => [[cx(b), 0.45, cz(b), 1, 1, 1]] });
    P.push({ types: ["house"], geo: cone4(1.35, 0.9), mat: roofR, off: (b) => [[cx(b), 1.3, cz(b), 1, 1, 1]] });
    // farm
    P.push({ types: ["farm"], geo: box(1.9, 0.08, 1.9), mat: soil, off: (b) => [[cx(b), 0.05, cz(b), 1, 1, 1]] });
    P.push({
      types: ["farm"],
      geo: box(1.7, 0.16, 0.18),
      mat: crop,
      off: (b) => [
        [cx(b), 0.14, 0.5, 1, 1, 1],
        [cx(b), 0.14, 1.0, 1, 1, 1],
        [cx(b), 0.14, 1.5, 1, 1, 1],
      ],
    });
    // barracks
    P.push({ types: ["barracks"], geo: box(2.6, 1.2, 2.6), mat: stoneM, off: (b) => [[cx(b), 0.6, cz(b), 1, 1, 1]] });
    P.push({ types: ["barracks"], geo: cone4(2.0, 1.0), mat: roofR, teamTint: true, off: (b) => [[cx(b), 1.6, cz(b), 1, 1, 1]] });
    // wall / gate
    P.push({ types: ["wall"], geo: box(0.96, 0.85, 0.96), mat: stoneM, off: (b) => [[cx(b), 0.42, cz(b), 1, 1, 1]] });
    P.push({ types: ["wall"], geo: box(0.9, 0.2, 0.9), mat: stoneD, off: (b) => [[cx(b), 0.94, cz(b), 1, 1, 1]] });
    P.push({ types: ["gate"], geo: box(0.96, 0.85, 0.96), mat: stoneM, off: (b) => [[cx(b), 0.42, cz(b), 1, 1, 1]] });
    P.push({ types: ["gate"], geo: box(0.5, 0.7, 1.02), mat: door, off: (b) => [[cx(b), 0.4, cz(b), 1, 1, 1]] });
    // tower
    P.push({ types: ["tower"], geo: cyl(0.75, 2.6), mat: stoneM, off: (b) => [[cx(b), 1.3, cz(b), 1, 1, 1]] });
    P.push({ types: ["tower"], geo: cyl(0.95, 0.3), mat: stoneD, off: (b) => [[cx(b), 2.7, cz(b), 1, 1, 1]] });
    P.push({ types: ["tower"], geo: cone4(1.1, 0.9), mat: roofR, teamTint: true, off: (b) => [[cx(b), 3.3, cz(b), 1, 1, 1]] });
    // economy buildings
    P.push({ types: ["lumbercamp"], geo: box(1.4, 0.5, 1.0), mat: woodM, off: (b) => [[cx(b), 0.25, cz(b), 1, 1, 1]] });
    P.push({
      types: ["lumbercamp"],
      geo: cyl(0.16, 1.2),
      mat: woodM,
      off: (b) => [
        [cx(b) - 0.4, 0.6, cz(b) + 0.2, 1, 1, 1],
        [cx(b) + 0.1, 0.6, cz(b) + 0.3, 1, 1, 1],
      ],
    });
    P.push({ types: ["quarry"], geo: box(1.6, 0.3, 1.6), mat: stoneD, off: (b) => [[cx(b), 0.1, cz(b), 1, 1, 1]] });
    P.push({
      types: ["quarry"],
      geo: box(0.4, 0.35, 0.4),
      mat: stoneM,
      off: (b) => [
        [cx(b) - 0.4, 0.35, cz(b) - 0.3, 1, 1, 1],
        [cx(b) + 0.3, 0.35, cz(b) + 0.3, 1, 1, 1],
      ],
    });
    P.push({ types: ["market"], geo: box(2.4, 0.8, 1.6), mat: woodM, off: (b) => [[cx(b), 0.4, cz(b), 1, 1, 1]] });
    P.push({ types: ["market"], geo: box(2.6, 0.12, 1.8), mat: roofR, off: (b) => [[cx(b), 1.05, cz(b), 1, 1, 1]] });
    P.push({ types: ["shrine"], geo: box(1.2, 0.5, 1.2), mat: stoneM, off: (b) => [[cx(b), 0.25, cz(b), 1, 1, 1]] });
    P.push({ types: ["shrine"], geo: box(0.4, 1.4, 0.4), mat: stoneD, off: (b) => [[cx(b), 1.1, cz(b), 1, 1, 1]] });
    P.push({ types: ["granary"], geo: cyl(0.8, 1.4), mat: woodM, off: (b) => [[cx(b), 0.7, cz(b), 1, 1, 1]] });
    P.push({ types: ["granary"], geo: cone4(1.0, 0.7), mat: roofR, off: (b) => [[cx(b), 1.7, cz(b), 1, 1, 1]] });
    P.push({ types: ["inn"], geo: box(1.6, 1.0, 1.4), mat: woodM, off: (b) => [[cx(b), 0.5, cz(b), 1, 1, 1]] });
    P.push({ types: ["inn"], geo: cone4(1.4, 0.8), mat: roofR, off: (b) => [[cx(b), 1.35, cz(b), 1, 1, 1]] });
    return P;
  }

  private rebuildBuildings(): void {
    for (const m of this.bParts) this.scene.remove(m);
    for (const m of this.siteParts) this.scene.remove(m);
    this.bParts = [];
    this.siteParts = [];
    const g = this.game;
    const defs = this.buildPartsDef();
    const built = g.buildings.filter((b) => b.built && (b.team === g.myTeam || g.isVisibleTo(g.myTeam, (b.tx + b.w / 2) * TILE, (b.ty + b.h / 2) * TILE)));
    const sites = g.buildings.filter((b) => !b.built);
    for (const def of defs) {
      const mine = built.filter((b) => def.types.includes(b.type));
      if (!mine.length) continue;
      let count = 0;
      for (const b of mine) count += def.off(b).length;
      const mesh = this.addInst(this.bParts, def.geo, def.mat, count);
      let i = 0;
      for (const b of mine) {
        const y0 = this.heightAt(b.tx, b.ty);
        for (const [ox, oy, oz, sx, sy, sz] of def.off(b)) {
          this.dummy.position.set(b.tx + ox, y0 + oy, b.ty + oz);
          this.dummy.rotation.set(0, 0, 0);
          this.dummy.scale.set(sx, sy, sz);
          this.dummy.updateMatrix();
          mesh.setMatrixAt(i, this.dummy.matrix);
          if (def.teamTint)
            this.col.set(this.teamColor(b.team));
          else {
            const dmg = b.hp / b.maxHp;
            this.col.setRGB(1 - (1 - dmg) * 0.35, 1 - (1 - dmg) * 0.4, 1 - (1 - dmg) * 0.4);
          }
          mesh.setColorAt(i, this.col);
          i++;
        }
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    // construction sites: translucent scaffold box scaled by progress
    if (sites.length) {
      const sm = mat("site", () =>
        this.r3.shadowMap.enabled
          ? new THREE.MeshLambertMaterial({ color: 0xd8b25c, transparent: true, opacity: 0.35 })
          : new THREE.MeshLambertMaterial({ color: 0xd8b25c, transparent: true, opacity: 0.35 }),
      );
      const mesh = this.addInst(this.siteParts, geo("box1", () => new THREE.BoxGeometry(1, 1, 1)), sm, sites.length, false);
      let i = 0;
      for (const b of sites) {
        const prog = 1 - b.work / b.workMax;
        this.dummy.position.set(b.tx + b.w / 2, 0.1 + prog * 0.5, b.ty + b.h / 2);
        this.dummy.scale.set(b.w * 0.9, 0.2 + prog * 0.9, b.h * 0.9);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i++, this.dummy.matrix);
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ── dynamic sets ───────────────────────────────────────────────────────────
  private buildDynamicSets(): void {
    const bodyM = mat("ubody", () => new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const headM = mat("uhead", () => new THREE.MeshLambertMaterial({ color: 0xe2b48d }));
    const weapM = mat("uweap", () => new THREE.MeshLambertMaterial({ color: 0xd8dde4 }));
    const horseM = mat("uhorse", () => new THREE.MeshLambertMaterial({ color: 0x6b4a2c }));
    const bodyG = geo("ubody", () => new THREE.CapsuleGeometry(0.16, 0.26, 3, 6));
    const headG = geo("uhead", () => new THREE.SphereGeometry(0.12, 8, 6));
    const weapG = geo("uweap", () => new THREE.BoxGeometry(0.05, 0.05, 0.55));
    const spearG = geo("uspear", () => new THREE.BoxGeometry(0.04, 0.04, 0.95));
    const bowG = geo("ubow", () => new THREE.TorusGeometry(0.16, 0.02, 4, 8, Math.PI));
    const horseG = geo("uhorse", () => new THREE.BoxGeometry(0.3, 0.28, 0.6));
    const catG = geo("ucat", () => new THREE.BoxGeometry(0.5, 0.22, 0.7));
    const armG = geo("uarm", () => new THREE.BoxGeometry(0.06, 0.6, 0.06));
    // instance capacity follows the match: an epic army can field 1000+ units
    // and an XL map has room for many more torches/scorches
    const MAXU = this.game.cfg.epic ? 1100 : 400;
    this.uParts = [];
    this.addInst(this.uParts, bodyG, bodyM, MAXU);
    this.addInst(this.uParts, headG, headM, MAXU);
    this.addInst(this.uParts, weapG, weapM, MAXU, false);
    this.addInst(this.uParts, spearG, weapM, MAXU, false);
    this.addInst(this.uParts, bowG, weapM, MAXU, false);
    this.addInst(this.uParts, horseG, horseM, MAXU);
    this.addInst(this.uParts, catG, mat("ucat", () => new THREE.MeshLambertMaterial({ color: 0x6d4d2b })), MAXU);
    this.addInst(this.uParts, armG, weapM, MAXU, false);

    this.projMesh = this.addInst([], geo("arrow", () => new THREE.BoxGeometry(0.04, 0.04, 0.4)), mat("arrow", () => new THREE.MeshBasicMaterial({ color: 0xefe3c8 })), 200, false);
    this.rockMesh = this.addInst([], geo("rockp", () => new THREE.SphereGeometry(0.14, 6, 5)), mat("rockp", () => new THREE.MeshBasicMaterial({ color: 0x8f897c })), 60, false);
    this.ringMesh = this.addInst([], geo("ring", () => new THREE.RingGeometry(0.26, 0.34, 20)), mat("ring", () => new THREE.MeshBasicMaterial({ color: 0xeaffea, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })), 300, false);
    this.ghostMesh = this.addInst([], geo("ghost", () => new THREE.BoxGeometry(1, 0.06, 1)), mat("ghost", () => new THREE.MeshBasicMaterial({ color: 0x6ee06e, transparent: true, opacity: 0.4, depthWrite: false })), 120, false);
    const BIG = this.game.grid.w > 128 || this.game.cfg.epic;
    this.decalMesh = this.addInst([], geo("decal", () => new THREE.CircleGeometry(1, 14)), mat("decal", () => new THREE.MeshBasicMaterial({ color: 0x14100c, transparent: true, opacity: 0.5, depthWrite: false })), BIG ? 220 : 60, false);
    this.torchMesh = this.addInst([], geo("torch", () => new THREE.SphereGeometry(0.13, 6, 5)), mat("torch", () => new THREE.MeshBasicMaterial({ color: 0xffb050 })), BIG ? 260 : 80, false);
    this.torchGlow = this.addInst([], geo("tglow", () => new THREE.CircleGeometry(1.5, 16)), mat("tglow", () => new THREE.MeshBasicMaterial({ color: 0xff9840, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })), BIG ? 260 : 80, false);

    // particles
    const mkPoints = (additive: boolean) => {
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute("position", new THREE.BufferAttribute(new Float32Array(512 * 3), 3));
      g2.setAttribute("color", new THREE.BufferAttribute(new Float32Array(512 * 3), 3));
      const m2 = new THREE.PointsMaterial({
        size: 0.16,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const p = new THREE.Points(g2, m2);
      p.frustumCulled = false;
      this.scene.add(p);
      return p;
    };
    this.points = mkPoints(false);
    this.pointsAdd = mkPoints(true);
  }

  // ── frame ──────────────────────────────────────────────────────────────────
  render(tWall: number, dragSel: { x0: number; y0: number; x1: number; y1: number } | null): void {
    if (this.disposed) return;
    const g = this.game;
    const t = g.settings.reducedMotion ? 0 : tWall;
    // camera
    if (g.settings.quality > 0) {
      this.azimuthTarget += 0; // rotated via rotateCamera()
    }
    this.azimuth += (this.azimuthTarget - this.azimuth) * 0.12;
    const tx = g.cam.x / TILE;
    const tz = g.cam.y / TILE;
    let shx = 0;
    let shz = 0;
    if (g.shakeT > 0 && g.settings.screenShake && !g.settings.reducedMotion) {
      const k = (g.shakeT / 0.35) * g.shakeMag * 0.06;
      shx = (Math.random() - 0.5) * 2 * k;
      shz = (Math.random() - 0.5) * 2 * k;
    }
    const dir = new THREE.Vector3(Math.cos(this.azimuth), 0.95, Math.sin(this.azimuth));
    this.cam.position.set(tx + shx + dir.x * 90, dir.y * 90, tz + shz + dir.z * 90);
    this.cam.lookAt(tx + shx, 0, tz + shz);
    this.updateCameraFrustum();

    // day/night lighting
    const c = ((g.time % 420) / 420);
    let night = 0;
    if (g.settings.dayNight) {
      if (c >= 0.65 && c < 0.9) night = Math.min(1, (c - 0.65) / 0.08);
      else if (c >= 0.9) night = Math.max(0, 1 - (c - 0.9) / 0.1);
    }
    this.sun.intensity = 1.15 - night * 0.92;
    this.sun.color.setRGB(1, 0.95 - night * 0.35, 0.82 - night * 0.5);
    this.hemi.intensity = 0.85 - night * 0.62;
    this.hemi.color.setRGB(0.81 - night * 0.62, 0.89 - night * 0.62, 1 - night * 0.45);
    const bg = this.scene.background as THREE.Color;
    bg.setRGB(0.05 + 0.02 * (1 - night), 0.06 + 0.02 * (1 - night), 0.04 + 0.05 * night);
    this.sun.position.set(tx + 60, 90, tz + 40);
    this.sun.target.position.set(tx, 0, tz);
    this.sun.target.updateMatrixWorld();

    this.applyTier();

    // water bob
    if (g.settings.waterFx && g.perf.state.waterFx && !g.settings.reducedMotion)
      this.water.position.y = -0.16 + Math.sin(t * 1.2) * 0.012;

    // buildings versioning
    const bver = g.buildings.length * 7 + g.buildings.reduce((a, b) => a + (b.built ? 1 : 0) + (b.hp < b.maxHp * 0.5 ? 2 : 0), 0);
    if (bver !== this.bVersion) {
      this.bVersion = bver;
      this.rebuildBuildings();
    }
    this.updateFogTexture();
    this.alignFogPlane();

    // units
    this.updateUnits(t);
    this.updateProjectiles();
    this.updateParticles();
    this.updateDecals();
    this.updateTorches(night, t);
    this.updateGhost();

    this.r3.render(this.scene, this.cam);
    this.drawOverlay(dragSel);
    this.mm.render(g);
  }

  /**
   * Push the adaptive governor's tier into the WebGL scene. Only runs on an
   * actual transition: DPR is re-applied, shadow casting is toggled (with a
   * material refresh, since three caches the shadow program) and terrain
   * tessellation is halved at the bottom rungs.
   */
  private applyTier(): void {
    const q = this.game.perf.state;
    if (q.tier !== this.appliedTier) {
      this.appliedTier = q.tier;
      const r = this.canvas.getBoundingClientRect();
      this.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
    }
    const wantShadows =
      this.game.settings.shadows && this.game.settings.quality > 0 && q.shadows3d;
    if (wantShadows !== this.appliedShadows) {
      this.appliedShadows = wantShadows;
      this.r3.shadowMap.enabled = wantShadows;
      this.sun.castShadow = wantShadows;
      this.r3.shadowMap.needsUpdate = true;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as
          | THREE.Material
          | THREE.Material[]
          | undefined;
        if (!m) return;
        if (Array.isArray(m)) for (const x of m) x.needsUpdate = true;
        else m.needsUpdate = true;
      });
    }
    if (q.terrainLod !== this.appliedTerrainLod && this.appliedTerrainLod !== -1) {
      // rebuild the ground at the new tessellation (skipped on the first frame)
      this.rebuildGround();
    }
    this.appliedTerrainLod = q.terrainLod;
  }

  rotateCamera(dir: number): void {
    this.azimuthTarget += dir * (Math.PI / 4);
  }

  private viewBoundsTiles() {
    const g = this.game;
    const vb = g.viewBounds();
    return {
      x0: vb.x0 / TILE - 4,
      x1: vb.x1 / TILE + 4,
      y0: vb.y0 / TILE - 4,
      y1: vb.y1 / TILE + 4,
    };
  }

  private updateUnits(t: number): void {
    const g = this.game;
    const vb = this.viewBoundsTiles();
    // distance LOD: at kingdom zoom a unit is a few pixels tall, so the
    // weapon/horse instances are pure fill-rate. detail 0 sheds them earlier.
    const q = g.perf.state;
    const zoom = g.cam.zoom;
    const fullDetail = q.unitDetail === 2 && zoom >= 0.62;
    const someDetail = q.unitDetail >= 1 && zoom >= 0.42;
    const counters = new Array(this.uParts.length).fill(0);
    const sel: Array<[number, number, number]> = [];
    for (const u of g.units) {
      const ux = u.x / TILE;
      const uz = u.y / TILE;
      if (ux < vb.x0 || ux > vb.x1 || uz < vb.y0 || uz > vb.y1) continue;
      if (u.team !== g.myTeam && !g.isVisibleTo(g.myTeam, u.x, u.y)) continue;
      const y0 = this.heightAt(Math.floor(ux), Math.floor(uz));
      const moving = u.state === "move" || u.state === "attackMove" || (u.state === "attack" && !!u.path);
      const bob = moving ? Math.abs(Math.sin(u.anim)) * 0.06 : Math.sin(t * 2 + u.id) * 0.015;
      const teamC = this.teamColor(u.team);
      const flash = u.flash > 0;
      const set = (pi: number, x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number, color?: string) => {
        const mesh = this.uParts[pi];
        const i = counters[pi];
        if (i >= mesh.instanceMatrix.count) return;
        this.dummy.position.set(x, y, z);
        this.dummy.rotation.set(0, ry, 0);
        this.dummy.scale.set(sx, sy, sz);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
        if (color) this.col.set(color);
        mesh.setColorAt(i, this.col);
        counters[pi] = i + 1;
      };
      const ry = -u.facing + Math.PI / 2;
      // body + head for all
      set(0, ux, y0 + 0.32 + bob, uz, ry, 1, 1, 1, flash ? "#ffffff" : teamC);
      if (someDetail)
        set(1, ux, y0 + 0.62 + bob, uz, ry, 1, 1, 1, flash ? "#ffffff" : undefined);
      if (!fullDetail) {
        if (u.selected) sel.push([ux, y0 + 0.03, uz]);
        continue;
      }
      if (u.type === "villager") {
        set(2, ux + Math.sin(ry) * 0.2, y0 + 0.4 + bob, uz + Math.cos(ry) * 0.2, ry, 0.8, 0.8, 0.8);
      } else if (u.type === "militia") {
        set(2, ux + Math.sin(ry) * 0.28, y0 + 0.45 + bob, uz + Math.cos(ry) * 0.28, ry, 1, 1, 1);
      } else if (u.type === "spearman") {
        set(3, ux + Math.sin(ry) * 0.3, y0 + 0.5 + bob, uz + Math.cos(ry) * 0.3, ry, 1, 1, 1);
      } else if (u.type === "archer") {
        set(4, ux + Math.sin(ry) * 0.26, y0 + 0.45 + bob, uz + Math.cos(ry) * 0.26, ry + Math.PI / 2, 1, 1, 1);
      } else if (u.type === "knight") {
        set(5, ux, y0 + 0.42 + bob, uz, ry, 1, 1, 1);
        set(2, ux + Math.sin(ry) * 0.34, y0 + 0.72 + bob, uz + Math.cos(ry) * 0.34, ry, 1, 1, 1.4);
      } else if (u.type === "catapult") {
        set(6, ux, y0 + 0.25, uz, ry, 1, 1, 1);
        set(7, ux, y0 + 0.55, uz, ry + 0.5, 1, 1, 1);
      }
      if (u.selected) sel.push([ux, y0 + 0.03, uz]);
    }
    for (let pi = 0; pi < this.uParts.length; pi++) {
      const m = this.uParts[pi];
      m.count = counters[pi];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    // selection rings
    let ri = 0;
    for (const [x, y, z] of sel) {
      if (ri >= this.ringMesh.instanceMatrix.count) break;
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(-Math.PI / 2, 0, 0);
      this.dummy.scale.setScalar(1 + Math.sin(t * 5) * 0.06);
      this.dummy.updateMatrix();
      this.ringMesh.setMatrixAt(ri, this.dummy.matrix);
      this.col.set(this.teamColor(g.myTeam));
      this.ringMesh.setColorAt(ri, this.col);
      ri++;
    }
    this.ringMesh.count = ri;
    this.ringMesh.instanceMatrix.needsUpdate = true;
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
  }

  private updateProjectiles(): void {
    const g = this.game;
    let ai = 0;
    let ri = 0;
    for (const p of g.projectiles) {
      const tgt = g.byId.get(p.targetId);
      let ang = 0;
      if (tgt) {
        const tp = g.entPos(tgt);
        ang = Math.atan2(tp.x - p.x, tp.y - p.y);
      }
      const x = p.x / TILE;
      const z = p.y / TILE;
      const y = this.heightAt(Math.floor(x), Math.floor(z)) + 0.5;
      if (p.kind === "arrow") {
        if (ai < this.projMesh.instanceMatrix.count) {
          this.dummy.position.set(x, y, z);
          this.dummy.rotation.set(0, -ang + Math.PI / 2, 0);
          this.dummy.scale.set(1, 1, 1);
          this.dummy.updateMatrix();
          this.projMesh.setMatrixAt(ai++, this.dummy.matrix);
        }
      } else if (ri < this.rockMesh.instanceMatrix.count) {
        this.dummy.position.set(x, y + 0.3, z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        this.rockMesh.setMatrixAt(ri++, this.dummy.matrix);
      }
    }
    this.projMesh.count = ai;
    this.rockMesh.count = ri;
    this.projMesh.instanceMatrix.needsUpdate = true;
    this.rockMesh.instanceMatrix.needsUpdate = true;
  }

  private updateParticles(): void {
    const g = this.game;
    if (!g.settings.particles) {
      this.points.geometry.setDrawRange(0, 0);
      this.pointsAdd.geometry.setDrawRange(0, 0);
      return;
    }
    let n = 0;
    let na = 0;
    const pos = this.points.geometry.attributes.position as THREE.BufferAttribute;
    const colA = this.points.geometry.attributes.color as THREE.BufferAttribute;
    const posA = this.pointsAdd.geometry.attributes.position as THREE.BufferAttribute;
    const colAA = this.pointsAdd.geometry.attributes.color as THREE.BufferAttribute;
    const budget = g.perf.state.particleDraw;
    for (const p of g.particles) {
      if (n + na >= budget) break;
      const a = Math.max(0, Math.min(1, p.life / p.maxLife));
      const x = p.x / TILE;
      const z = p.y / TILE;
      const y = this.heightAt(Math.floor(x), Math.floor(z)) + 0.2 + (p.kind === "smoke" ? (1 - a) * 0.8 : 0);
      // cached colour objects: this ran once per particle per frame before
      let c = this.colCache.get(p.color);
      if (!c) {
        c = new THREE.Color(p.color.slice(0, 7));
        this.colCache.set(p.color, c);
      }
      const additive = p.kind === "fire" || p.kind === "spark";
      if (additive && na < 512) {
        posA.setXYZ(na, x, y, z);
        colAA.setXYZ(na, c.r * a, c.g * a, c.b * a);
        na++;
      } else if (!additive && n < 512) {
        pos.setXYZ(n, x, y, z);
        colA.setXYZ(n, c.r * a, c.g * a, c.b * a);
        n++;
      }
    }
    this.points.geometry.setDrawRange(0, n);
    this.pointsAdd.geometry.setDrawRange(0, na);
    pos.needsUpdate = true;
    colA.needsUpdate = true;
    posA.needsUpdate = true;
    colAA.needsUpdate = true;
  }

  private updateDecals(): void {
    const g = this.game;
    let i = 0;
    for (const sc of g.scorches) {
      if (i >= this.decalMesh.instanceMatrix.count) break;
      this.dummy.position.set(sc.x / TILE, 0.03, sc.y / TILE);
      this.dummy.rotation.set(-Math.PI / 2, 0, 0);
      this.dummy.scale.setScalar(sc.r / TILE);
      this.dummy.updateMatrix();
      this.decalMesh.setMatrixAt(i++, this.dummy.matrix);
    }
    this.decalMesh.count = i;
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  private updateTorches(night: number, t: number): void {
    const g = this.game;
    let i = 0;
    if (night > 0.2 && g.settings.dayNight) {
      for (const b of g.buildings) {
        if (!b.built || (b.type !== "keep" && b.type !== "tower")) continue;
        const spots: Array<[number, number]> =
          b.type === "keep"
            ? [
                [b.tx + 0.6, b.ty + 0.6],
                [b.tx + b.w - 0.6, b.ty + 0.6],
                [b.tx + 0.6, b.ty + b.h - 0.6],
                [b.tx + b.w - 0.6, b.ty + b.h - 0.6],
              ]
            : [
                [b.tx + 0.3, b.ty + 0.3],
                [b.tx + b.w - 0.3, b.ty + 0.3],
              ];
        for (const [sx, sz] of spots) {
          if (i >= this.torchMesh.instanceMatrix.count) break;
          const fl = 0.8 + Math.sin(t * 11 + sx * 7) * 0.25;
          this.dummy.position.set(sx, this.heightAt(b.tx, b.ty) + 1.1, sz);
          this.dummy.scale.setScalar(fl * night);
          this.dummy.rotation.set(0, 0, 0);
          this.dummy.updateMatrix();
          this.torchMesh.setMatrixAt(i, this.dummy.matrix);
          if (i < this.torchGlow.instanceMatrix.count) {
            this.dummy.position.set(sx, this.heightAt(b.tx, b.ty) + 0.06, sz);
            this.dummy.rotation.set(-Math.PI / 2, 0, 0);
            this.dummy.scale.setScalar(0.8 + fl * 0.35);
            this.dummy.updateMatrix();
            this.torchGlow.setMatrixAt(i, this.dummy.matrix);
          }
          i++;
        }
      }
    }
    this.torchMesh.count = i;
    this.torchMesh.instanceMatrix.needsUpdate = true;
    this.torchGlow.count = Math.min(i, this.torchGlow.instanceMatrix.count);
    this.torchGlow.instanceMatrix.needsUpdate = true;
  }

  private updateGhost(): void {
    const prev = this.game.placementPreview();
    let i = 0;
    if (prev) {
      for (const tl of prev.tiles) {
        if (i >= this.ghostMesh.instanceMatrix.count) break;
        const ok =
          this.game.canPlace(this.game.myTeam, prev.type, tl.x, tl.y) &&
          this.game.res[this.game.myTeam].wood >= 0;
        this.dummy.position.set(tl.x + 0.5, 0.08, tl.y + 0.5);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.ghostMesh.setMatrixAt(i, this.dummy.matrix);
        this.col.set(ok ? 0x6ee06e : 0xe05040);
        this.ghostMesh.setColorAt(i, this.col);
        i++;
      }
    }
    this.ghostMesh.count = i;
    this.ghostMesh.instanceMatrix.needsUpdate = true;
    if (this.ghostMesh.instanceColor) this.ghostMesh.instanceColor.needsUpdate = true;
  }

  /** world(px) → screen(px) for overlay drawing */
  project(wx: number, wy: number, wz = 0): { x: number; y: number } {
    const v = new THREE.Vector3(wx / TILE, wz, wy / TILE);
    v.project(this.cam);
    return {
      x: ((v.x + 1) / 2) * this.game.viewW,
      y: ((1 - v.y) / 2) * this.game.viewH,
    };
  }

  private drawOverlay(dragSel: { x0: number; y0: number; x1: number; y1: number } | null): void {
    const g = this.game;
    const ctx = this.octx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width / this.dpr, this.overlay.height / this.dpr);
    const vb = this.viewBoundsTiles();
    // hp bars + veterancy
    ctx.textAlign = "center";
    for (const u of g.units) {
      const ux = u.x / TILE;
      const uz = u.y / TILE;
      if (ux < vb.x0 || ux > vb.x1 || uz < vb.y0 || uz > vb.y1) continue;
      if (u.team !== g.myTeam && !g.isVisibleTo(g.myTeam, u.x, u.y)) continue;
      if (u.hp >= u.maxHp && !u.selected) continue;
      const p = this.project(u.x, u.y, this.heightAt(Math.floor(ux), Math.floor(uz)) + 0.85);
      const w = 22;
      const frac = Math.max(0, u.hp / u.maxHp);
      ctx.fillStyle = "#14100a";
      ctx.fillRect(p.x - w / 2 - 1, p.y - 2, w + 2, 4);
      ctx.fillStyle = frac > 0.5 ? "#69d44f" : frac > 0.25 ? "#e8c13c" : "#e0503e";
      ctx.fillRect(p.x - w / 2, p.y - 1, w * frac, 2.5);
      if (u.rank > 0) {
        ctx.strokeStyle = u.rank === 2 ? "#ffd166" : "#e8c877";
        ctx.lineWidth = 1.4;
        for (let r = 0; r < u.rank; r++) {
          ctx.beginPath();
          ctx.moveTo(p.x - 4, p.y - 6 - r * 4);
          ctx.lineTo(p.x, p.y - 9 - r * 4);
          ctx.lineTo(p.x + 4, p.y - 6 - r * 4);
          ctx.stroke();
        }
      }
    }
    // floats
    for (const f of g.floats) {
      const p = this.project(f.x, f.y, 0.8);
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life / f.maxLife));
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.fillStyle = "#00000088";
      ctx.fillText(f.text, p.x + 1, p.y + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
    // drag select rect
    if (dragSel) {
      const x = Math.min(dragSel.x0, dragSel.x1);
      const y = Math.min(dragSel.y0, dragSel.y1);
      const w = Math.abs(dragSel.x1 - dragSel.x0);
      const h = Math.abs(dragSel.y1 - dragSel.y0);
      if (w > 4 || h > 4) {
        ctx.fillStyle = "rgba(120,200,255,0.12)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(150,220,255,0.8)";
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
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
  }

  /** profiler info */
  stats(): { calls: number; tris: number; instances: number } {
    const info = this.r3.info.render;
    let instances = 0;
    for (const m of this.uParts) instances += m.count;
    for (const m of this.bParts) instances += m.count;
    for (const m of this.flora) instances += m.count;
    return { calls: info.calls, tris: info.triangles, instances };
  }
}


