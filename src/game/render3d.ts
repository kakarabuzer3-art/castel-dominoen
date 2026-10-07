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
  UNIT_DEFS,
} from "./constants";
import type { Game } from "./engine";
import { MinimapRenderer } from "./minimap";
import { hash2 } from "./rng";
import type { Building, Team } from "./types";

const FOG_H = 5.2; // above tallest building; screen-space offset compensated per frame
const CLEAR = ["#2563eb", "#f97316"];
const CLEAR_DARK = ["#1e40af", "#9a3412"];

/**
 * Merge axis-aligned box specs (size + offset) into one non-indexed geometry.
 * Used for worker tool props (handle + head) so each tool stays a single
 * instanced part with a recognisable silhouette.
 */
function mergeBoxes(
  specs: Array<{ s: [number, number, number]; p: [number, number, number] }>,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  for (const spec of specs) {
    const bg = new THREE.BoxGeometry(spec.s[0], spec.s[1], spec.s[2]);
    const ni = bg.toNonIndexed();
    const pp = ni.attributes.position.array as ArrayLike<number>;
    const nn = ni.attributes.normal.array as ArrayLike<number>;
    for (let i = 0; i < pp.length; i += 3) {
      pos.push(pp[i] + spec.p[0], pp[i + 1] + spec.p[1], pp[i + 2] + spec.p[2]);
      nor.push(nn[i], nn[i + 1], nn[i + 2]);
    }
    bg.dispose();
    ni.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** horse-leg table: [fore/aft offset, gait sign, lateral] — module const so the
 *  per-frame unit loop never allocates (allocation-free hot path rule) */
const HORSE_LEGS: ReadonlyArray<readonly [number, number, number]> = [
  [0.2, 1, -0.1],
  [0.2, 1, 0.1],
  [-0.2, -1, -0.1],
  [-0.2, -1, 0.1],
];
const LEG_SIDES: ReadonlyArray<readonly [-1 | 1]> = [[-1], [1]];

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
  /**
   * Camera elevation angle (radians above the ground plane). The original
   * camera hard-coded dir.y=0.95 against a horizontal radius of 90, i.e.
   * atan(85.5/90) ≈ 0.7598 rad — that stays the DEFAULT so every existing
   * test, screenshot and click mapping behaves exactly as before. Presets:
   * strategic (steep, ~68°), normal (43.5°), cinematic (low, ~28°).
   */
  private pitch = Math.atan(0.95);
  private pitchTarget = Math.atan(0.95);
  /** camera distance kept constant across pitches so scale feels stable */
  private static readonly CAM_DIST = Math.hypot(90, 85.5);
  private static readonly PITCH_MIN = 0.42; // ≈ 24° — still an RTS view
  private static readonly PITCH_MAX = 1.22; // ≈ 70° — strategic top-down
  private pitchMode = 1; // 0 strategic, 1 normal, 2 cinematic
  /** cooldown + off-screen gate for event framing (presentation only) */
  private cineCd = 0;
  private lastAlarmSeen = -999;
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
    this.uDummy.rotation.order = "YXZ";

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
    // presentation-only state from a previous match must not leak into the next
    this.corpses.length = 0;
    this.lastU.clear();
    this.seenU.clear();
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
  /** dedicated unit dummy: rotation order YXZ = yaw first, then limb/weapon
   *  pitch around the unit-local axis (the shared dummy must keep XYZ — flora
   *  and rocks rely on multi-axis Euler semantics) */
  private readonly uDummy = new THREE.Object3D();
  /** visible-unit id bookkeeping — presentation-only death detection (D4) */
  private readonly seenU = new Set<number>();
  private readonly lastU = new Map<number, { team: Team; x: number; y: number; ry: number }>();
  private readonly corpses: Array<{ team: Team; x: number; y: number; ry: number; born: number }> = [];

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
    const stoneL = mat("bstoneL", () => new THREE.MeshLambertMaterial({ color: 0xbdb4a4 }));
    const stoneD = mat("bstoneD", () => new THREE.MeshLambertMaterial({ color: 0x847d6f }));
    const woodM = mat("bwood", () => new THREE.MeshLambertMaterial({ color: 0xa37c4a }));
    const woodD = mat("bwoodD", () => new THREE.MeshLambertMaterial({ color: 0x6e512e }));
    const roofR = mat("broofR", () => new THREE.MeshLambertMaterial({ color: 0x96503a }));
    const plaster = mat("bplaster", () => new THREE.MeshLambertMaterial({ color: 0xd9cdae }));
    const soil = mat("soil", () => new THREE.MeshLambertMaterial({ color: 0x7c5a34 }));
    const crop = mat("crop", () => new THREE.MeshLambertMaterial({ color: 0x79a444 }));
    const cropRipe = mat("cropRipe", () => new THREE.MeshLambertMaterial({ color: 0xb9a04a }));
    const door = mat("door", () => new THREE.MeshLambertMaterial({ color: 0x4c3524 }));
    const dark = mat("bwin", () => new THREE.MeshLambertMaterial({ color: 0x2e2620 }));
    const ironM = mat("biron", () => new THREE.MeshLambertMaterial({ color: 0x6a6f76 }));
    const hayM = mat("bhay", () => new THREE.MeshLambertMaterial({ color: 0xc9a94f }));
    const flagM = mat(
      "bflag",
      () => new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    );
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
    /** wall-family neighbour occupancy — drives crenellation gaps (presentation) */
    const solidAt = (tx: number, ty: number) =>
      this.game.buildings.some(
        (o) =>
          (o.type === "wall" || o.type === "gate" || o.type === "tower") &&
          tx >= o.tx &&
          tx < o.tx + o.w &&
          ty >= o.ty &&
          ty < o.ty + o.h,
      );
    // keep — plinth, curtain wall, upper hold, corner turrets, gate
    P.push({ types: ["keep"], geo: box(4.9, 0.16, 4.9), mat: stoneD, off: (b) => [[cx(b), 0.08, cz(b), 1, 1, 1]] });
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
    P.push({ types: ["keep"], geo: box(1.1, 0.16, 0.26), mat: woodD, off: (b) => [[cx(b), 1.24, b.h - 0.08, 1, 1, 1]] });
    // crenellations along the curtain-wall top
    P.push({
      types: ["keep"],
      geo: box(0.26, 0.3, 0.26),
      mat: stoneL,
      off: (b) => {
        const xs = [cx(b) - 2, cx(b) - 1.33, cx(b) - 0.67, cx(b), cx(b) + 0.67, cx(b) + 1.33, cx(b) + 2];
        const zs = [cz(b) - 1.33, cz(b) - 0.67, cz(b), cz(b) + 0.67, cz(b) + 1.33];
        const out: Array<[number, number, number, number, number, number]> = [];
        for (const x of xs) out.push([x, 1.85, 0.32, 1, 1, 1], [x, 1.85, b.h - 0.32, 1, 1, 1]);
        for (const z of zs) out.push([0.32, 1.85, z, 1, 1, 1], [b.w - 0.32, 1.85, z, 1, 1, 1]);
        return out;
      },
    });
    // crenellations on the upper hold
    P.push({
      types: ["keep"],
      geo: box(0.24, 0.26, 0.24),
      mat: stoneL,
      off: (b) => {
        const cxp = cx(b);
        const czp = cz(b);
        return [
          [cxp - 0.8, 3.45, czp - 0.8, 1, 1, 1], [cxp, 3.45, czp - 0.8, 1, 1, 1], [cxp + 0.8, 3.45, czp - 0.8, 1, 1, 1],
          [cxp - 0.8, 3.45, czp + 0.8, 1, 1, 1], [cxp, 3.45, czp + 0.8, 1, 1, 1], [cxp + 0.8, 3.45, czp + 0.8, 1, 1, 1],
          [cxp - 0.8, 3.45, czp, 1, 1, 1], [cxp + 0.8, 3.45, czp, 1, 1, 1],
        ];
      },
    });
    // windows (N/S faces)
    P.push({
      types: ["keep"],
      geo: box(0.18, 0.3, 0.06),
      mat: dark,
      off: (b) => [
        [cx(b) - 1, 0.95, 0.17, 1, 1, 1],
        [cx(b), 0.95, 0.17, 1, 1, 1],
        [cx(b) + 1, 0.95, 0.17, 1, 1, 1],
        [cx(b) - 1.5, 0.95, b.h - 0.17, 1, 1, 1],
        [cx(b) + 1.5, 0.95, b.h - 0.17, 1, 1, 1],
      ],
    });
    // windows (E/W faces)
    P.push({
      types: ["keep"],
      geo: box(0.06, 0.3, 0.18),
      mat: dark,
      off: (b) => [
        [0.17, 0.95, cz(b) - 1, 1, 1, 1],
        [0.17, 0.95, cz(b), 1, 1, 1],
        [0.17, 0.95, cz(b) + 1, 1, 1, 1],
        [b.w - 0.17, 0.95, cz(b) - 1, 1, 1, 1],
        [b.w - 0.17, 0.95, cz(b), 1, 1, 1],
        [b.w - 0.17, 0.95, cz(b) + 1, 1, 1, 1],
      ],
    });
    // banner pole + flag above the keep roof
    P.push({ types: ["keep"], geo: cyl(0.03, 0.8), mat: ironM, off: (b) => [[cx(b), 4.75, cz(b), 1, 1, 1]] });
    P.push({
      types: ["keep"],
      geo: box(0.5, 0.3, 0.04),
      mat: flagM,
      teamTint: true,
      off: (b) => [[cx(b) + 0.28, 4.95, cz(b), 1, 1, 1]],
    });
    // house — plastered walls, timber frame, chimney, door, windows
    P.push({ types: ["house"], geo: box(1.5, 0.9, 1.5), mat: plaster, off: (b) => [[cx(b), 0.45, cz(b), 1, 1, 1]] });
    P.push({
      types: ["house"],
      geo: box(0.08, 0.9, 0.08),
      mat: woodD,
      off: (b) => [
        [0.79, 0.45, 0.79, 1, 1, 1],
        [b.w - 0.79, 0.45, 0.79, 1, 1, 1],
        [0.79, 0.45, b.h - 0.79, 1, 1, 1],
        [b.w - 0.79, 0.45, b.h - 0.79, 1, 1, 1],
      ],
    });
    P.push({ types: ["house"], geo: box(1.56, 0.12, 1.56), mat: woodD, off: (b) => [[cx(b), 0.84, cz(b), 1, 1, 1]] });
    P.push({ types: ["house"], geo: cone4(1.35, 0.9), mat: roofR, off: (b) => [[cx(b), 1.3, cz(b), 1, 1, 1]] });
    P.push({ types: ["house"], geo: box(0.16, 0.55, 0.16), mat: stoneD, off: (b) => [[cx(b) + 0.42, 1.5, cz(b) - 0.35, 1, 1, 1]] });
    P.push({ types: ["house"], geo: box(0.32, 0.5, 0.06), mat: door, off: (b) => [[cx(b), 0.25, b.h - 0.24, 1, 1, 1]] });
    P.push({
      types: ["house"],
      geo: box(0.2, 0.2, 0.05),
      mat: dark,
      off: (b) => [
        [cx(b) - 0.45, 0.55, b.h - 0.23, 1, 1, 1],
        [cx(b) + 0.45, 0.55, b.h - 0.23, 1, 1, 1],
      ],
    });
    // farm — soil, alternating crop rows, fence, scarecrow, hay bale
    P.push({ types: ["farm"], geo: box(1.9, 0.08, 1.9), mat: soil, off: (b) => [[cx(b), 0.05, cz(b), 1, 1, 1]] });
    P.push({
      types: ["farm"],
      geo: box(1.7, 0.16, 0.16),
      mat: crop,
      off: (b) => [
        [cx(b), 0.14, 0.3, 1, 1, 1],
        [cx(b), 0.14, 0.94, 1, 1, 1],
        [cx(b), 0.14, 1.58, 1, 1, 1],
      ],
    });
    P.push({
      types: ["farm"],
      geo: box(1.7, 0.16, 0.16),
      mat: cropRipe,
      off: (b) => [
        [cx(b), 0.14, 0.62, 1, 1, 1],
        [cx(b), 0.14, 1.26, 1, 1, 1],
      ],
    });
    P.push({
      types: ["farm"],
      geo: box(0.07, 0.42, 0.07),
      mat: woodD,
      off: (b) => [
        [0.1, 0.24, 0.1, 1, 1, 1], [1.0, 0.24, 0.1, 1, 1, 1], [b.w - 0.1, 0.24, 0.1, 1, 1, 1],
        [0.1, 0.24, b.h - 0.1, 1, 1, 1], [1.0, 0.24, b.h - 0.1, 1, 1, 1], [b.w - 0.1, 0.24, b.h - 0.1, 1, 1, 1],
        [0.1, 0.24, 1.0, 1, 1, 1], [b.w - 0.1, 0.24, 1.0, 1, 1, 1],
      ],
    });
    P.push({
      types: ["farm"],
      geo: box(1.9, 0.05, 0.05),
      mat: woodD,
      off: (b) => [
        [cx(b), 0.4, 0.1, 1, 1, 1],
        [cx(b), 0.4, b.h - 0.1, 1, 1, 1],
      ],
    });
    P.push({
      types: ["farm"],
      geo: box(0.05, 0.05, 1.9),
      mat: woodD,
      off: (b) => [
        [0.1, 0.4, cz(b), 1, 1, 1],
        [b.w - 0.1, 0.4, cz(b), 1, 1, 1],
      ],
    });
    // scarecrow + hay bale
    P.push({ types: ["farm"], geo: box(0.05, 0.5, 0.05), mat: woodD, off: () => [[0.4, 0.33, 1.55, 1, 1, 1]] });
    P.push({ types: ["farm"], geo: box(0.3, 0.05, 0.05), mat: woodD, off: () => [[0.4, 0.5, 1.55, 1, 1, 1]] });
    P.push({ types: ["farm"], geo: box(0.12, 0.12, 0.12), mat: hayM, off: () => [[0.4, 0.62, 1.55, 1, 1, 1]] });
    P.push({ types: ["farm"], geo: box(0.34, 0.26, 0.44), mat: hayM, off: () => [[1.5, 0.22, 1.45, 1, 1, 1]] });
    // barracks — great hall, training yard, weapon rack, banner poles
    P.push({ types: ["barracks"], geo: box(2.6, 1.2, 2.6), mat: stoneM, off: (b) => [[cx(b), 0.6, cz(b), 1, 1, 1]] });
    P.push({ types: ["barracks"], geo: cone4(1.7, 0.9), mat: roofR, teamTint: true, off: (b) => [[cx(b), 1.65, cz(b), 1, 1, 1]] });
    P.push({ types: ["barracks"], geo: box(0.5, 0.7, 0.08), mat: woodD, off: (b) => [[cx(b), 0.35, b.h - 0.2, 1, 1, 1]] });
    P.push({
      types: ["barracks"],
      geo: cyl(0.03, 1.9),
      mat: ironM,
      off: (b) => [
        [0.35, 0.95, b.h + 0.25, 1, 1, 1],
        [b.w - 0.35, 0.95, b.h + 0.25, 1, 1, 1],
      ],
    });
    P.push({
      types: ["barracks"],
      geo: box(0.42, 0.28, 0.04),
      mat: flagM,
      teamTint: true,
      off: (b) => [
        [0.58, 1.62, b.h + 0.25, 1, 1, 1],
        [b.w - 0.58, 1.62, b.h + 0.25, 1, 1, 1],
      ],
    });
    P.push({
      types: ["barracks"],
      geo: box(0.06, 0.55, 0.06),
      mat: woodD,
      off: (b) => [
        [cx(b) - 0.45, 0.275, b.h + 0.5, 1, 1, 1],
        [cx(b) + 0.45, 0.275, b.h + 0.5, 1, 1, 1],
      ],
    });
    P.push({ types: ["barracks"], geo: box(1.0, 0.06, 0.06), mat: woodD, off: (b) => [[cx(b), 0.55, b.h + 0.5, 1, 1, 1]] });
    P.push({
      types: ["barracks"],
      geo: box(0.05, 1.0, 0.05),
      mat: ironM,
      off: (b) => [
        [cx(b) - 0.3, 0.55, b.h + 0.5, 1, 1, 1],
        [cx(b), 0.55, b.h + 0.5, 1, 1, 1],
        [cx(b) + 0.3, 0.55, b.h + 0.5, 1, 1, 1],
      ],
    });
    // wall / gate — base, walkway, connectivity-aware crenellations, gatehouse
    P.push({ types: ["wall"], geo: box(0.96, 0.85, 0.96), mat: stoneM, off: (b) => [[cx(b), 0.42, cz(b), 1, 1, 1]] });
    P.push({ types: ["wall"], geo: box(0.9, 0.2, 0.9), mat: stoneD, off: (b) => [[cx(b), 0.94, cz(b), 1, 1, 1]] });
    P.push({ types: ["gate"], geo: box(0.96, 0.85, 0.96), mat: stoneM, off: (b) => [[cx(b), 0.42, cz(b), 1, 1, 1]] });
    P.push({ types: ["gate"], geo: box(0.5, 0.7, 1.02), mat: door, off: (b) => [[cx(b), 0.4, cz(b), 1, 1, 1]] });
    P.push({ types: ["gate"], geo: box(1.06, 0.16, 1.06), mat: stoneD, off: (b) => [[cx(b), 0.98, cz(b), 1, 1, 1]] });
    P.push({ types: ["gate"], geo: cone4(0.62, 0.55), mat: roofR, teamTint: true, off: (b) => [[cx(b), 1.35, cz(b), 1, 1, 1]] });
    P.push({
      types: ["wall", "gate"],
      geo: box(0.2, 0.24, 0.14),
      mat: stoneL,
      off: (b) => {
        const out: Array<[number, number, number, number, number, number]> = [];
        if (!solidAt(b.tx, b.ty - 1)) out.push([0.3, 1.16, 0.13, 1, 1, 1], [0.7, 1.16, 0.13, 1, 1, 1]);
        if (!solidAt(b.tx, b.ty + 1)) out.push([0.3, 1.16, 0.87, 1, 1, 1], [0.7, 1.16, 0.87, 1, 1, 1]);
        return out;
      },
    });
    P.push({
      types: ["wall", "gate"],
      geo: box(0.14, 0.24, 0.2),
      mat: stoneL,
      off: (b) => {
        const out: Array<[number, number, number, number, number, number]> = [];
        if (!solidAt(b.tx - 1, b.ty)) out.push([0.13, 1.16, 0.3, 1, 1, 1], [0.13, 1.16, 0.7, 1, 1, 1]);
        if (!solidAt(b.tx + 1, b.ty)) out.push([0.87, 1.16, 0.3, 1, 1, 1], [0.87, 1.16, 0.7, 1, 1, 1]);
        return out;
      },
    });
    // tower — shaft, parapet merlons, spire, pennant, door
    P.push({ types: ["tower"], geo: cyl(0.75, 2.6), mat: stoneM, off: (b) => [[cx(b), 1.3, cz(b), 1, 1, 1]] });
    P.push({ types: ["tower"], geo: cyl(0.95, 0.3), mat: stoneD, off: (b) => [[cx(b), 2.7, cz(b), 1, 1, 1]] });
    P.push({
      types: ["tower"],
      geo: box(0.2, 0.22, 0.2),
      mat: stoneL,
      off: (b) => {
        const r = 0.82;
        const out: Array<[number, number, number, number, number, number]> = [];
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          out.push([cx(b) + Math.cos(a) * r, 2.97, cz(b) + Math.sin(a) * r, 1, 1, 1]);
        }
        return out;
      },
    });
    P.push({ types: ["tower"], geo: cone4(0.55, 0.7), mat: roofR, teamTint: true, off: (b) => [[cx(b), 3.2, cz(b), 1, 1, 1]] });
    P.push({ types: ["tower"], geo: cyl(0.025, 0.5), mat: ironM, off: (b) => [[cx(b), 3.8, cz(b), 1, 1, 1]] });
    P.push({
      types: ["tower"],
      geo: box(0.34, 0.2, 0.04),
      mat: flagM,
      teamTint: true,
      off: (b) => [[cx(b) + 0.19, 3.88, cz(b), 1, 1, 1]],
    });
    P.push({ types: ["tower"], geo: box(0.28, 0.5, 0.06), mat: dark, off: (b) => [[cx(b), 0.25, cz(b) + 0.76, 1, 1, 1]] });
    // economy buildings — lumber yard with log stack + stump, quarry with
    // rock piles + tool shed, market with posts/awning/crates, shrine monument,
    // granary silo with bands, inn with sign + chimney
    P.push({ types: ["lumbercamp"], geo: box(1.4, 0.5, 1.0), mat: woodM, off: (b) => [[cx(b), 0.25, cz(b) - 0.2, 1, 1, 1]] });
    P.push({ types: ["lumbercamp"], geo: box(1.5, 0.1, 1.1), mat: woodD, off: (b) => [[cx(b), 0.57, cz(b) - 0.2, 1, 1, 1]] });
    P.push({
      types: ["lumbercamp"],
      geo: box(1.1, 0.15, 0.15),
      mat: woodD,
      off: (b) => [
        [cx(b), 0.075, cz(b) + 0.5, 1, 1, 1],
        [cx(b), 0.075, cz(b) + 0.68, 1, 1, 1],
        [cx(b), 0.21, cz(b) + 0.59, 1, 1, 1],
      ],
    });
    P.push({ types: ["lumbercamp"], geo: cyl(0.16, 0.18), mat: woodD, off: (b) => [[cx(b) - 0.6, 0.14, cz(b) + 0.6, 1, 1, 1]] });
    // quarry
    P.push({ types: ["quarry"], geo: box(1.6, 0.3, 1.6), mat: stoneD, off: (b) => [[cx(b), 0.1, cz(b), 1, 1, 1]] });
    P.push({ types: ["quarry"], geo: box(0.46, 0.4, 0.46), mat: stoneM, off: (b) => [[cx(b) - 0.4, 0.45, cz(b) - 0.3, 1, 1, 1]] });
    P.push({
      types: ["quarry"],
      geo: box(0.3, 0.3, 0.3),
      mat: stoneL,
      off: (b) => [
        [cx(b) + 0.35, 0.4, cz(b) + 0.3, 1, 1, 1],
        [cx(b) + 0.1, 0.4, cz(b) + 0.5, 1, 1, 1],
      ],
    });
    P.push({ types: ["quarry"], geo: box(0.5, 0.22, 0.34), mat: stoneL, off: (b) => [[cx(b) + 0.5, 0.36, cz(b) - 0.45, 1, 1, 1]] });
    P.push({ types: ["quarry"], geo: box(0.5, 0.44, 0.4), mat: woodM, off: (b) => [[cx(b) - 0.5, 0.22, cz(b) + 0.6, 1, 1, 1]] });
    P.push({ types: ["quarry"], geo: box(0.56, 0.08, 0.46), mat: woodD, off: (b) => [[cx(b) - 0.5, 0.48, cz(b) + 0.6, 1, 1, 1]] });
    // market
    P.push({ types: ["market"], geo: box(2.4, 0.8, 1.6), mat: woodM, off: (b) => [[cx(b), 0.4, cz(b), 1, 1, 1]] });
    P.push({ types: ["market"], geo: box(2.6, 0.12, 1.8), mat: roofR, teamTint: true, off: (b) => [[cx(b), 1.05, cz(b), 1, 1, 1]] });
    P.push({
      types: ["market"],
      geo: box(0.07, 1.0, 0.07),
      mat: woodD,
      off: (b) => [
        [cx(b) - 1.15, 0.5, cz(b) - 0.75, 1, 1, 1],
        [cx(b) + 1.15, 0.5, cz(b) - 0.75, 1, 1, 1],
        [cx(b) - 1.15, 0.5, cz(b) + 0.75, 1, 1, 1],
        [cx(b) + 1.15, 0.5, cz(b) + 0.75, 1, 1, 1],
      ],
    });
    P.push({
      types: ["market"],
      geo: box(0.3, 0.28, 0.3),
      mat: woodD,
      off: (b) => [
        [cx(b) - 0.35, 0.14, cz(b) + 0.9, 1, 1, 1],
        [cx(b) + 0.05, 0.14, cz(b) + 0.9, 1, 1, 1],
      ],
    });
    P.push({ types: ["market"], geo: cyl(0.13, 0.32), mat: woodM, off: (b) => [[cx(b) + 0.55, 0.16, cz(b) + 0.9, 1, 1, 1]] });
    P.push({
      types: ["market"],
      geo: box(0.3, 0.1, 0.24),
      mat: cropRipe,
      off: (b) => [
        [cx(b) - 0.5, 0.85, cz(b), 1, 1, 1],
        [cx(b) + 0.3, 0.85, cz(b), 1, 1, 1],
      ],
    });
    // shrine — plinth, monument, cross-arm
    P.push({ types: ["shrine"], geo: box(1.2, 0.5, 1.2), mat: stoneM, off: (b) => [[cx(b), 0.25, cz(b), 1, 1, 1]] });
    P.push({ types: ["shrine"], geo: box(0.4, 1.4, 0.4), mat: stoneD, off: (b) => [[cx(b), 1.1, cz(b), 1, 1, 1]] });
    P.push({ types: ["shrine"], geo: box(0.66, 0.1, 0.1), mat: stoneD, off: (b) => [[cx(b), 1.55, cz(b), 1, 1, 1]] });
    P.push({ types: ["shrine"], geo: box(1.4, 0.1, 1.4), mat: stoneL, off: (b) => [[cx(b), 0.05, cz(b), 1, 1, 1]] });
    // granary — silo with iron bands
    P.push({ types: ["granary"], geo: cyl(0.8, 1.4), mat: woodM, off: (b) => [[cx(b), 0.7, cz(b), 1, 1, 1]] });
    P.push({
      types: ["granary"],
      geo: cyl(0.84, 0.07),
      mat: woodD,
      off: (b) => [
        [cx(b), 0.45, cz(b), 1, 1, 1],
        [cx(b), 1.0, cz(b), 1, 1, 1],
      ],
    });
    P.push({ types: ["granary"], geo: cone4(1.0, 0.7), mat: roofR, off: (b) => [[cx(b), 1.7, cz(b), 1, 1, 1]] });
    // inn — signboard, chimney, windows
    P.push({ types: ["inn"], geo: box(1.6, 1.0, 1.4), mat: woodM, off: (b) => [[cx(b), 0.5, cz(b), 1, 1, 1]] });
    P.push({ types: ["inn"], geo: cone4(1.4, 0.8), mat: roofR, off: (b) => [[cx(b), 1.35, cz(b), 1, 1, 1]] });
    P.push({ types: ["inn"], geo: box(0.15, 0.5, 0.15), mat: stoneD, off: (b) => [[cx(b) + 0.45, 1.5, cz(b) - 0.3, 1, 1, 1]] });
    P.push({ types: ["inn"], geo: box(0.06, 1.1, 0.06), mat: woodD, off: (b) => [[cx(b) + 0.95, 0.55, cz(b) + 0.8, 1, 1, 1]] });
    P.push({ types: ["inn"], geo: box(0.3, 0.26, 0.05), mat: door, off: (b) => [[cx(b) + 0.95, 0.95, cz(b) + 0.8, 1, 1, 1]] });
    P.push({
      types: ["inn"],
      geo: box(0.18, 0.18, 0.05),
      mat: dark,
      off: (b) => [
        [cx(b) - 0.4, 0.55, cz(b) + 0.71, 1, 1, 1],
        [cx(b) + 0.4, 0.55, cz(b) + 0.71, 1, 1, 1],
      ],
    });
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
    // construction sites — foundation slab, rising shell, scaffold poles and a
    // translucent ghost of the finished massing (presentation-only staging)
    if (sites.length) {
      const gm = mat("siteGhost", () => new THREE.MeshLambertMaterial({ color: 0xd8b25c, transparent: true, opacity: 0.28 }));
      const fm = mat("siteFrame", () => new THREE.MeshLambertMaterial({ color: 0x8a6a3a }));
      const wm = mat("siteShell", () => new THREE.MeshLambertMaterial({ color: 0xb0a58c }));
      const boxGeo = geo("box1", () => new THREE.BoxGeometry(1, 1, 1));
      const ghost = this.addInst(this.siteParts, boxGeo, gm, sites.length, false);
      const slab = this.addInst(this.siteParts, boxGeo, fm, sites.length, false);
      const shell = this.addInst(this.siteParts, boxGeo, wm, sites.length, false);
      const poles = this.addInst(this.siteParts, boxGeo, fm, sites.length * 4, false);
      let ig = 0;
      let is = 0;
      let ih = 0;
      let ip = 0;
      for (const b of sites) {
        const prog = Math.max(0, Math.min(1, 1 - b.work / b.workMax));
        const sx = b.tx + b.w / 2;
        const sz = b.ty + b.h / 2;
        const fullH = 0.5 + Math.max(b.w, b.h) * 0.45;
        this.dummy.position.set(sx, fullH / 2 + 0.1, sz);
        this.dummy.scale.set(b.w * 0.9, fullH, b.h * 0.9);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.updateMatrix();
        ghost.setMatrixAt(ig++, this.dummy.matrix);
        this.dummy.position.set(sx, 0.05, sz);
        this.dummy.scale.set(b.w * 0.96, 0.1, b.h * 0.96);
        this.dummy.updateMatrix();
        slab.setMatrixAt(is++, this.dummy.matrix);
        const shellH = 0.12 + prog * fullH * 0.85;
        this.dummy.position.set(sx, shellH / 2, sz);
        this.dummy.scale.set(b.w * 0.82, shellH, b.h * 0.82);
        this.dummy.updateMatrix();
        shell.setMatrixAt(ih++, this.dummy.matrix);
        const poleH = 0.15 + Math.min(1, prog * 1.4) * (fullH + 0.3);
        for (const [ox, oz] of [
          [0.12, 0.12],
          [b.w - 0.12, 0.12],
          [0.12, b.h - 0.12],
          [b.w - 0.12, b.h - 0.12],
        ]) {
          this.dummy.position.set(b.tx + ox, poleH / 2, b.ty + oz);
          this.dummy.scale.set(0.06, poleH, 0.06);
          this.dummy.updateMatrix();
          poles.setMatrixAt(ip++, this.dummy.matrix);
        }
      }
      ghost.count = ig;
      slab.count = is;
      shell.count = ih;
      poles.count = ip;
      ghost.instanceMatrix.needsUpdate = true;
      slab.instanceMatrix.needsUpdate = true;
      shell.instanceMatrix.needsUpdate = true;
      poles.instanceMatrix.needsUpdate = true;
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
    // ── D4 silhouette parts: legs, helmet, shield, worker tools ───────────────
    const legG = geo("uleg", () => new THREE.BoxGeometry(0.07, 0.3, 0.07));
    const legM = mat("uleg", () => new THREE.MeshLambertMaterial({ color: 0x4a3a28 }));
    const helmG = geo("uhelm", () => new THREE.ConeGeometry(0.115, 0.17, 6));
    const shieldG = geo("ushield", () => new THREE.BoxGeometry(0.05, 0.3, 0.22));
    const axeG = geo("uaxe", () =>
      mergeBoxes([
        { s: [0.04, 0.3, 0.04], p: [0, 0, 0] },
        { s: [0.14, 0.1, 0.03], p: [0.07, 0.13, 0] },
      ]),
    );
    const pickG = geo("upick", () =>
      mergeBoxes([
        { s: [0.04, 0.3, 0.04], p: [0, 0, 0] },
        { s: [0.2, 0.05, 0.04], p: [0.06, 0.14, 0] },
      ]),
    );
    const hamG = geo("uham", () =>
      mergeBoxes([
        { s: [0.04, 0.28, 0.04], p: [0, 0, 0] },
        { s: [0.12, 0.09, 0.09], p: [0, 0.14, 0] },
      ]),
    );
    const sheafG = geo("usheaf", () => new THREE.BoxGeometry(0.15, 0.26, 0.13));
    const toolM = mat("utool", () => new THREE.MeshLambertMaterial({ color: 0x9a7b4f }));
    const hayM = mat("uhay", () => new THREE.MeshLambertMaterial({ color: 0xd8c069 }));
    this.addInst(this.uParts, legG, legM, MAXU * 3);
    this.addInst(this.uParts, helmG, weapM, MAXU);
    this.addInst(this.uParts, shieldG, bodyM, MAXU);
    this.addInst(this.uParts, axeG, toolM, MAXU, false);
    this.addInst(this.uParts, pickG, toolM, MAXU, false);
    this.addInst(this.uParts, hamG, toolM, MAXU, false);
    this.addInst(this.uParts, sheafG, hayM, MAXU, false);

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
    if (g.settings.reducedMotion) this.pitch = this.pitchTarget;
    else this.pitch += (this.pitchTarget - this.pitch) * 0.1;
    const tx = g.cam.x / TILE;
    const tz = g.cam.y / TILE;
    let shx = 0;
    let shz = 0;
    if (g.shakeT > 0 && g.settings.screenShake && !g.settings.reducedMotion) {
      const k = (g.shakeT / 0.35) * g.shakeMag * 0.06;
      shx = (Math.random() - 0.5) * 2 * k;
      shz = (Math.random() - 0.5) * 2 * k;
    }
    // pitch: constant-distance spherical placement (identical to the legacy
    // dir=(cos az, 0.95, sin az)*90 at the default angle)
    const cp = Math.cos(this.pitch) * Renderer3D.CAM_DIST;
    const sp = Math.sin(this.pitch) * Renderer3D.CAM_DIST;
    const dir = new THREE.Vector3(Math.cos(this.azimuth) * cp, sp, Math.sin(this.azimuth) * cp);
    this.cam.position.set(tx + shx + dir.x, dir.y, tz + shz + dir.z);
    this.cam.lookAt(tx + shx, 0, tz + shz);
    this.updateCameraFrustum();
    this.updateCinematic(g, tWall);

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

    // buildings versioning (includes a quantized construction-progress
    // signature so staged construction sites animate through rebuilds)
    const bver =
      g.buildings.length * 7 +
      g.buildings.reduce(
        (a, b) =>
          a +
          (b.built ? 1 : 0) +
          (b.hp < b.maxHp * 0.5 ? 2 : 0) +
          (b.built ? 0 : Math.floor((1 - b.work / b.workMax) * 6) * 13),
        0,
      );
    if (bver !== this.bVersion) {
      this.bVersion = bver;
      this.rebuildBuildings();
    }
    this.updateFogTexture();
    this.alignFogPlane();

    // units
    this.updateUnits(t, tWall);
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

  /** C cycles pitch presets: strategic → normal → cinematic → strategic */
  cyclePitch(): void {
    this.pitchMode = (this.pitchMode + 1) % 3;
    this.pitchTarget = [Renderer3D.PITCH_MAX, Math.atan(0.95), Renderer3D.PITCH_MIN][
      this.pitchMode
    ];
  }

  /** shift+wheel / HUD: fine-grained pitch, clamped to RTS-legible range */
  nudgePitch(delta: number): void {
    this.pitchTarget = Math.max(
      Renderer3D.PITCH_MIN,
      Math.min(Renderer3D.PITCH_MAX, this.pitchTarget + delta),
    );
    // leaving a preset band marks the mode as custom (C restarts at strategic)
    const presets = [Renderer3D.PITCH_MAX, Math.atan(0.95), Renderer3D.PITCH_MIN];
    this.pitchMode = presets.findIndex((p) => Math.abs(p - this.pitchTarget) < 0.02);
  }

  /**
   * Subtle event framing — presentation only, never locks input.
   * When the player's keep is hit while the camera is elsewhere, glide the
   * view toward the alarm once per 20 s. Any pan/zoom/click nulls camTarget
   * and immediately cancels the glide (engine sets camTarget=null on input).
   */
  private updateCinematic(g: Game, t: number): void {
    if (t < this.cineCd || g.settings.reducedMotion) return;
    const my = g.myTeam;
    const alarmAge = g.time - g.alarm[my];
    if (alarmAge < 0 || alarmAge > 2.5) return;
    if (g.alarm[my] === this.lastAlarmSeen) return;
    this.lastAlarmSeen = g.alarm[my];
    this.cineCd = t + 20;
    // only frame when the hit is meaningfully off-screen (else it's noise)
    const b = g.buildings.find((x) => x.team === my && x.hp < x.maxHp && g.time - g.alarm[my] < 2.5);
    const pos = b ? { x: (b.tx + b.w / 2) * TILE, y: (b.ty + b.h / 2) * TILE } : g.lastCombatPos;
    if (!pos) return;
    const vb = g.viewBounds();
    const m = TILE * 6;
    if (pos.x > vb.x0 + m && pos.x < vb.x1 - m && pos.y > vb.y0 + m && pos.y < vb.y1 - m) return;
    if (g.camTarget === null) g.camTarget = g.clampCamPoint({ x: pos.x, y: pos.y });
  }

  private viewBoundsTiles() {
    const g = this.game;
    const vb = g.viewBounds();
    // Lower pitch stretches the frustum footprint beyond the legacy screen→world
    // rect; pad the cull bounds so units near the top edge stay drawn.
    const hv = g.viewH / TILE / g.cam.zoom / 2;
    const legacy = Math.atan(0.95);
    const extra =
      hv * (1 / Math.max(0.2, Math.sin(this.pitch)) - 1 / Math.sin(legacy));
    const pad = 4 + Math.ceil(Math.max(0, extra));
    return {
      x0: vb.x0 / TILE - pad,
      x1: vb.x1 / TILE + pad,
      y0: vb.y0 / TILE - pad,
      y1: vb.y1 / TILE + pad,
    };
  }

  /**
   * Per-frame unit instances with state-driven procedural animation (D4):
   * stride legs, worker tool swings, melee chops, archer draws, siege-arm
   * release, mounted gait and a presentation-only death fall. The simulation
   * removes dead units immediately, so corpses are detected by diffing the
   * visible-id snapshots of the previous frame — pure presentation, never
   * simulation state.
   */
  private updateUnits(t: number, tWall = t): void {
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
    const seen = this.seenU;
    seen.clear();
    const ud = this.uDummy;
    const set = (
      pi: number,
      x: number,
      y: number,
      z: number,
      ry: number,
      sx: number,
      sy: number,
      sz: number,
      color?: string,
      pitch = 0,
    ) => {
      const mesh = this.uParts[pi];
      const i = counters[pi];
      if (i >= mesh.instanceMatrix.count) return;
      ud.position.set(x, y, z);
      ud.rotation.set(pitch, ry, 0);
      ud.scale.set(sx, sy, sz);
      ud.updateMatrix();
      mesh.setMatrixAt(i, ud.matrix);
      if (color) {
        this.col.set(color);
        mesh.setColorAt(i, this.col);
      }
      counters[pi] = i + 1;
    };
    // part index map — order fixed in buildDynamicSets()
    const P_BODY = 0;
    const P_HEAD = 1;
    const P_SWORD = 2;
    const P_SPEAR = 3;
    const P_BOW = 4;
    const P_HORSE = 5;
    const P_CATB = 6;
    const P_CATA = 7;
    const P_LEG = 8;
    const P_HELM = 9;
    const P_SHIELD = 10;
    const P_AXE = 11;
    const P_PICK = 12;
    const P_HAM = 13;
    const P_SHEAF = 14;
    for (const u of g.units) {
      const ux = u.x / TILE;
      const uz = u.y / TILE;
      if (ux < vb.x0 || ux > vb.x1 || uz < vb.y0 || uz > vb.y1) continue;
      if (u.team !== g.myTeam && !g.isVisibleTo(g.myTeam, u.x, u.y)) continue;
      seen.add(u.id);
      const y0 = this.heightAt(Math.floor(ux), Math.floor(uz));
      const moving = u.state === "move" || u.state === "attackMove" || (u.state === "attack" && !!u.path);
      const working = u.state === "harvest" || u.state === "build" || u.state === "repair";
      const bob = moving ? Math.abs(Math.sin(u.anim)) * 0.055 : Math.sin(t * 2 + u.id) * 0.015;
      const teamC = this.teamColor(u.team);
      const hit = u.flash > 0 ? "#ffffff" : undefined;
      const ry = -u.facing + Math.PI / 2;
      const fx = Math.sin(ry);
      const fz = Math.cos(ry);
      const rxv = Math.cos(ry);
      const rzv = -Math.sin(ry);
      const mounted = u.type === "knight";
      const siege = u.type === "catapult";
      const lean = moving ? 0.1 : 0;
      const teamOrHit = hit ?? teamC;

      if (siege) {
        if (fullDetail) {
          // wood frame + throwing arm; arm snaps through the arc on the strike
          // (same trigger window as the 2D renderer)
          const armPitch = u.atkCd > UNIT_DEFS.catapult.cd - 0.3 ? -0.9 : -0.35;
          set(P_CATB, ux, y0 + 0.25, uz, ry, 1, 1, 1, teamOrHit);
          set(P_CATA, ux + fx * 0.1, y0 + 0.5, uz + fz * 0.1, ry + 0.5, 1, 1, 1, undefined, armPitch);
        } else {
          // squat blob stand-in at low detail (was a floating capsule + head)
          set(P_BODY, ux, y0 + 0.18 + bob * 0.5, uz, ry, 0.9, 0.55, 0.9, teamOrHit);
        }
        if (u.selected) sel.push([ux, y0 + 0.03, uz]);
        continue;
      }
      // the mount itself — drawn at every detail so riders never float
      if (mounted) set(P_HORSE, ux, y0 + 0.32 + bob, uz, ry, 1, 1, 1, teamOrHit);

      // torso + head (a mounted rider sits above the horse)
      const torsoY = mounted ? y0 + 0.78 + bob : y0 + 0.32 + bob;
      const headY = mounted ? y0 + 1.1 + bob : y0 + 0.62 + bob;
      set(P_BODY, ux, torsoY, uz, ry, 1, mounted ? 1.15 : 1, 1, teamOrHit, lean);
      if (someDetail) set(P_HEAD, ux, headY, uz, ry, 1, 1, 1, undefined, lean);

      // stride legs — mounted units get a four-beat horse gait instead
      if (someDetail) {
        if (mounted) {
          const gait = moving ? Math.sin(u.anim) * 0.6 : 0;
          for (const [lf, gph, lat] of HORSE_LEGS) {
            const lift =
              moving ? Math.abs(Math.sin(u.anim + (gph > 0 ? 0 : Math.PI))) * 0.03 : 0;
            set(
              P_LEG,
              ux + rxv * lat + fx * lf,
              y0 + 0.14 + lift,
              uz + rzv * lat + fz * lf,
              ry,
              1, 1, 1,
              undefined,
              gait * gph,
            );
          }
        } else {
          const swing = moving
            ? Math.sin(u.anim) * 0.75
            : working
              ? Math.sin(u.anim * 6) * 0.12
              : 0;
          for (const [side] of LEG_SIDES) {
            set(
              P_LEG,
              ux + rxv * 0.07 * side,
              y0 + 0.15 + bob,
              uz + rzv * 0.07 * side,
              ry,
              1, 1, 1,
              undefined,
              swing * side,
            );
          }
        }
      }

      // helmet = immediate military read
      if (someDetail && u.type !== "villager")
        set(P_HELM, ux, headY + 0.16, uz, ry, 1, 1, 1, teamOrHit, lean);

      if (!fullDetail) {
        if (u.selected) sel.push([ux, y0 + 0.03, uz]);
        continue;
      }
      // off-hand shield (infantry silhouette)
      if (u.type === "militia" || u.type === "spearman") {
        set(
          P_SHIELD,
          ux - rxv * 0.24 + fx * 0.04,
          y0 + 0.42 + bob,
          uz - rzv * 0.24 + fz * 0.04,
          ry,
          1, 1, 1,
          teamOrHit,
        );
      }
      // strike window — same trigger the 2D renderer animates against
      const cd = UNIT_DEFS[u.type].cd;
      const ph = cd > 0 && u.atkCd > cd - 0.28 ? 1 - (cd - u.atkCd) / 0.28 : 0;
      if (u.type === "militia" || u.type === "knight") {
        // sword chop: rests high, sweeps down through the arc
        set(
          P_SWORD,
          ux + fx * 0.28 + rxv * 0.16,
          (mounted ? y0 + 0.88 : y0 + 0.45) + bob,
          uz + fz * 0.28 + rzv * 0.16,
          ry,
          1, 1, mounted ? 1.4 : 1,
          undefined,
          -0.9 + ph * 1.7 + lean,
        );
      } else if (u.type === "spearman") {
        // angled carry → levels out with a forward jab on the strike
        const jab = ph * 0.22;
        set(
          P_SPEAR,
          ux + fx * (0.3 + jab),
          y0 + 0.5 + bob - ph * 0.04,
          uz + fz * (0.3 + jab),
          ry,
          1, 1, 1,
          undefined,
          -0.55 - ph * 0.95 + lean,
        );
      } else if (u.type === "archer") {
        // draw pulls back before the loose, then snaps forward (2D parity)
        const draw = u.atkCd < 0.35 ? Math.min(1, (0.35 - u.atkCd) * 6) : 0;
        const loose = u.atkCd > cd - 0.12 ? 1 : 0;
        const back = draw * 0.07 - loose * 0.05;
        set(
          P_BOW,
          ux + fx * (0.26 - back) + rxv * 0.14,
          y0 + 0.48 + bob,
          uz + fz * (0.26 - back) + rzv * 0.14,
          ry + Math.PI / 2,
          1, 1, 1,
        );
      } else if (u.type === "villager") {
        // worker tool follows the task: tree→axe, rock/gold→pick,
        // farm→sheaf, build/repair→hammer (also shown while walking to it)
        let tool = -1;
        const tasked =
          u.state === "harvest" ||
          u.state === "build" ||
          u.state === "repair" ||
          (moving && u.taskId >= 0);
        if (tasked) {
          const task = u.taskId >= 0 ? g.byId.get(u.taskId) : undefined;
          const kind = task && "kind" in task ? String((task as { kind: unknown }).kind) : "";
          if (kind === "tree") tool = P_AXE;
          else if (kind === "rock" || kind === "gold") tool = P_PICK;
          else if (task && "w" in task && (task as Building).type === "farm") tool = P_SHEAF;
          else tool = P_HAM;
        }
        if (tool >= 0) {
          const toolPitch =
            tool === P_SHEAF
              ? -0.25
              : working
                ? -0.9 + Math.sin(u.anim * 6) * 1.2
                : moving
                  ? 0.55
                  : 0.15;
          set(
            tool,
            ux + fx * 0.26 + rxv * 0.18,
            y0 + 0.42 + bob,
            uz + fz * 0.26 + rzv * 0.18,
            ry,
            1, 1, 1,
            undefined,
            toolPitch + lean,
          );
        }
      }
      if (u.selected) sel.push([ux, y0 + 0.03, uz]);
    }
    // ── presentation-only deaths: diff last frame's visible-id snapshots ─────
    if (this.lastU.size > 0) {
      let died = 0;
      for (const id of this.lastU.keys()) {
        if (!seen.has(id) && !g.byId.has(id)) died++;
      }
      const allowCorpse = died > 0 && died <= 6;
      for (const id of this.lastU.keys()) {
        if (seen.has(id)) continue;
        const s = this.lastU.get(id);
        if (s && !g.byId.has(id) && allowCorpse && this.corpses.length < 24) {
          this.corpses.push({ team: s.team, x: s.x, y: s.y, ry: s.ry, born: tWall });
        }
        this.lastU.delete(id); // dead or left the view — drop the snapshot
      }
      if (died > 6) this.corpses.length = 0; // restart/load wipes, not combat
    }
    for (const u of g.units) {
      if (!seen.has(u.id)) continue;
      let s = this.lastU.get(u.id);
      if (!s) {
        s = { team: u.team, x: u.x, y: u.y, ry: 0 };
        this.lastU.set(u.id, s);
      }
      s.x = u.x;
      s.y = u.y;
      s.ry = -u.facing + Math.PI / 2;
    }
    // corpses fall, settle and sink — shared instance sets, darkened team tint
    for (let ci = this.corpses.length - 1; ci >= 0; ci--) {
      const c = this.corpses[ci];
      const age = tWall - c.born;
      if (age > 2.4) {
        this.corpses.splice(ci, 1);
        continue;
      }
      const cxp = c.x / TILE;
      const czp = c.y / TILE;
      if (cxp < vb.x0 || cxp > vb.x1 || czp < vb.y0 || czp > vb.y1) continue;
      const fall = Math.min(1, age / 0.45);
      const sink = age > 1.7 ? (age - 1.7) / 0.7 : 0;
      const yc = this.heightAt(Math.floor(cxp), Math.floor(czp));
      const lie = fall * ((Math.PI / 2) * 0.94);
      set(P_BODY, cxp, yc + 0.14 - sink * 0.24, czp, c.ry, 1, 1, 1, this.teamColorDark(c.team), lie);
      if (someDetail) {
        set(
          P_HEAD,
          cxp + Math.sin(c.ry) * 0.3 * fall,
          yc + 0.15 - sink * 0.24,
          czp + Math.cos(c.ry) * 0.3 * fall,
          c.ry,
          1, 1, 1,
          undefined,
          lie,
        );
      }
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


