import { AIController } from "./ai";
import {
  MISSIONS,
  campaignProgress as campaignProgressNow,
  setCampaignProgress,
  type MissionDef,
  type ObjectiveDef,
} from "./campaign";
import { sfx } from "./audio";
import {
  saveReplay,
  type ReplayEvent,
  type ReplaySave,
} from "./replay";
import {
  BUILDING_DEFS,
  COST_ENEMY_WALL,
  COST_OWN_WALL,
  COST_SIEGE,
  EPIC,
  POP,
  RATIONS,
  TAXES,
  MAP_H,
  MAP_W,
  MARKET,
  MAX_QUEUE,
  NODE_DEFS,
  POP_PER_UNIT,
  PROJECTILE_SPEED,
  RETALIATE_RANGE,
  START_RESOURCES,
  START_RES_MULT,
  setMapSize,
  LORDS,
  defaultMatchConfig,
  startPositions,
  type MatchConfig,
  TILE,
  TOWER,
  UNIT_DEFS,
  UPGRADES,
  ZOOM_MAX,
  ZOOM_MIN,
  WORK_RANGE,
  canAfford,
  payCost,
  zeroMods,
  type TeamMods,
  type UpgradeDef,
} from "./constants";
import { GameGrid, type MapTheme } from "./grid";
import {
  T_FORD,
  T_BRIDGE as T_BRIDGE_C,
  DIFFICULTIES,
} from "./constants";

const DIFF_NAMES = DIFFICULTIES.map((d) => d.name);
import {
  DEFAULT_SETTINGS,
  SPEED_MULT,
  type Settings,
} from "./settings";
import {
  T_DIRT as T_DIRT_C,
  T_OASIS as T_OASIS_C,
  T_WATER as T_WATER_C,
} from "./constants";
import { Pathfinder, type PathRules } from "./path";
import { PerfGovernor, tierFromQuality } from "./perf";
import { Renderer } from "./render";
import type { Renderer3D } from "./render3d";
import { mulberry32 } from "./rng";
import type {
  Building,
  BuildingType,
  FloatText,
  GameMessage,
  HudSnapshot,
  Phase,
  PopFactor,
  Projectile,
  ResKind,
  Resources,
  RNode,
  Team,
  TutorialFlags,
  Unit,
  UnitType,
} from "./types";
import { EMPTY_SNAPSHOT } from "./types";

export const STEP = 1 / 30;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1024)
    s += String.fromCharCode(...bytes.subarray(i, i + 1024));
  return typeof btoa === "function" ? btoa(s) : Buffer.from(bytes).toString("base64");
}

function unb64(str: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(str, "base64"));
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: "spark" | "smoke" | "fire" | "dust" | "chip" | "ring";
}



type Ent = Unit | Building | RNode;
type PathMode = "civ" | "mil" | "siege";

function isUnit(e: Ent): e is Unit {
  return (e as Unit).state !== undefined;
}
function isNode(e: Ent): e is RNode {
  return (e as RNode).kind !== undefined;
}
function isBuilding(e: Ent): e is Building {
  return !isUnit(e) && !isNode(e);
}

interface PathReq {
  unitId: number;
  gx: number;
  gy: number;
  siege: boolean;
}

export class Game {
  // ── world state ────────────────────────────────────────────────────────────
  grid!: GameGrid;
  finder!: Pathfinder;
  nodes: RNode[] = [];
  units: Unit[] = [];
  buildings: Building[] = [];
  projectiles: Projectile[] = [];
  floats: FloatText[] = [];
  messages: GameMessage[] = [];
  byId = new Map<number, Ent>();
  nodeById = new Map<number, RNode>();
  buildingById = new Map<number, Building>();
  keeps: [number, number] = [-1, -1];
  res: [Resources, Resources] = [
    { ...START_RESOURCES },
    { ...START_RESOURCES },
  ];
  popCur: [number, number] = [0, 0];
  popCap: [number, number] = [8, 8];
  mods: [TeamMods, TeamMods] = [zeroMods(), zeroMods()];
  upgrades: [string[], string[]] = [[], []];
  popularity: [number, number] = [POP.start, POP.start];
  grief: [number, number] = [0, 0];
  ration: [number, number] = [2, 2];
  tax: [number, number] = [1, 1];
  granary: [number, number] = [0, 0];
  famine: [boolean, boolean] = [false, false];
  innsActive: [number, number] = [0, 0];
  private immT: [number, number] = [0, 0];
  private emiT: [number, number] = [0, 0];
  /** last time a building of each team was hit — triggers call-to-arms */
  alarm: [number, number] = [-999, -999];
  kills = 0;
  losses = 0;
  /** absolute per-team death counters (seat-independent, for net hashes) */
  deaths: [number, number] = [0, 0];
  stats = {
    gathered: { wood: 0, stone: 0, gold: 0, food: 0 } as Resources,
    trained: 0,
    built: 0,
    researched: 0,
    peakPop: 0,
  };
  achievements: string[] = [];
  particles: Particle[] = [];
  scorches: Array<{ x: number; y: number; r: number }> = [];
  tut: TutorialFlags = {
    gather: false,
    house: false,
    farm: false,
    villager: false,
    barracks: false,
    military: false,
    wall: false,
    attack: false,
  };
  tutorialSkipped = false;
  groups: Array<number[]> = [[], [], [], [], []];
  lastCombatPos: { x: number; y: number; t: number } | null = null;
  muted = false;

  phase: Phase = "menu";
  time = 0;
  paused = false;
  speed = 1;

  // ── view / input ───────────────────────────────────────────────────────────
  cam = { x: 0, y: 0, zoom: 1 };
  zoomTarget = 1;
  camTarget: { x: number; y: number } | null = null;
  viewW = 1280;
  viewH = 720;
  mouse = { x: 0, y: 0, inCanvas: false };
  selection = new Set<number>();
  selectedBuilding = -1;
  placement: BuildingType | null = null;
  placeTiles: number[] = [];
  wallDragging = false;
  attackMoveMode = false;
  dragSel: { x0: number; y0: number; x1: number; y1: number } | null = null;

  // ── internals ──────────────────────────────────────────────────────────────
  private nextId = 1;
  private acc = 0;
  private lastFrame = 0;
  private raf = 0;
  private pathReqs: PathReq[] = [];
  private cellMap = new Map<number, number[]>();
  private ai!: AIController;
  private rnd: () => number = Math.random;
  private lastRaidMsg = -999;
  private autoBuildT = 1;
  private keys = new Set<string>();
  private panDrag: { x: number; y: number; cx: number; cy: number } | null =
    null;
  private clickAnchor: { x: number; y: number } | null = null;
  private lastClickTime = 0;
  private lastClickTile = -1;
  private edgePan = { dx: 0, dy: 0 };

  // ── HUD store ──────────────────────────────────────────────────────────────
  private snap: HudSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private hudDirty = true;
  private lastPublish = 0;
  private msgId = 1;

  renderer: Renderer | Renderer3D | null = null;
  perfTickMs = 0;
  perfFrameMs = 0;
  /**
   * Wall-clock time between rAF callbacks (EMA). This — not perfFrameMs — is
   * the honest frame cost: WebGL command submission returns long before the
   * GPU/software rasteriser finishes, so measuring only the JS side of
   * render() reported ~11 ms while the page actually ran at 4 fps. The
   * adaptive governor is driven by this value.
   */
  perfIntervalMs = 0;
  private lastRafNow = 0;
  /**
   * Adaptive quality governor. Presentation-only: it changes particle budgets,
   * DPR scale, effect toggles and level-of-detail — never simulation rules and
   * never the deterministic RNG (see src/game/perf.ts).
   */
  perf = new PerfGovernor();
  private lastPerfNow = 0;
  /** bumped whenever the building set changes, so renderers can cache sorts */
  buildingsRev = 0;
  /**
   * Reusable scratch buffers. Epic-army scenes (1000+ units) made per-tick
   * array allocation the single biggest GC source in the profile, so every
   * hot query/snapshot below writes into a buffer it owns. Each call site gets
   * its OWN buffer because several of them nest (catapult splash → retaliate →
   * call to arms), which would clobber a single shared array.
   */
  private qSeparate: Unit[] = [];
  private qAcquire: Unit[] = [];
  private qIntercept: Unit[] = [];
  private qArms: Unit[] = [];
  private qSplash: Unit[] = [];
  private qAggro: Unit[] = [];
  private qTower: Unit[] = [];
  private netDue: Array<{ i: number; team: Team; ev: ReplayEvent }> = [];
  private canvas: HTMLCanvasElement | null = null;
  private minimapEl: HTMLCanvasElement | null = null;
  private inputDisposers: Array<() => void> = [];
  private dead = false;

  private bindInputTracked(canvas: HTMLCanvasElement): void {
    for (const d of this.inputDisposers) d();
    const before = this.disposers.length;
    this.bindInput(canvas);
    this.inputDisposers = this.disposers.splice(before);
  }

  /** lazy-load the WebGL renderer and hot-swap it in place of the 2D one */
  private async upgradeTo3D(pref: "auto" | "3d"): Promise<void> {
    try {
      const m = await import("./render3d");
      if (this.dead || !this.canvas || this.renderer?.kind === "3d") return;
      if (!m.Renderer3D.supported()) {
        if (pref === "3d")
          this.msg("WebGL unavailable — staying on the 2D renderer.", "bad");
        return;
      }
      const old = this.canvas;
      const nc = document.createElement("canvas");
      nc.className = old.className;
      nc.style.cssText = old.style.cssText;
      old.parentNode?.insertBefore(nc, old);
      old.remove();
      this.canvas = nc;
      this.renderer?.dispose();
      const r3 = new m.Renderer3D(this, nc);
      this.renderer = r3;
      if (this.minimapEl) r3.setMinimap(this.minimapEl);
      this.bindInputTracked(nc);
      this.publish(true);
    } catch {
      if (pref === "3d")
        this.msg("3D renderer failed to start — using 2D.", "bad");
    }
  }
  private disposers: Array<() => void> = [];

  cfg: MatchConfig = defaultMatchConfig();
  settings: Settings = { ...DEFAULT_SETTINGS };
  shakeT = 0;
  shakeMag = 0;
  private eventT = 150;
  stormT = 0;
  // campaign
  mission: MissionDef | null = null;
  objectives: Array<ObjectiveDef & { done: boolean }> = [];
  missionEventIdx = 0;
  trainedBy: Partial<Record<UnitType, number>> = {};
  destroyedEnemy: Partial<Record<BuildingType, number>> = {};
  // ── multiplayer (lockstep intent relay) ───────────────────────────────────
  myTeam: Team = 0;
  netMode: { seat: 0 | 1; room: string } | null = null;
  netQueue: Array<{ i: number; team: Team; ev: ReplayEvent }> = [];
  onIntent: ((ev: ReplayEvent) => void) | null = null;
  netClient: unknown = null; // NetClient instance (UI-owned)
  netServerTick: number | null = null;
  netPing = 0;
  netConnected = false;
  tickCount = 0;

  enemyTeam(): Team {
    return (1 - this.myTeam) as Team;
  }

  isMine(t: Team): boolean {
    return t === this.myTeam;
  }

  private emitNet(ev: ReplayEvent): void {
    if (this.onIntent) this.onIntent(ev);
  }

  /** true when local player commands must be relayed instead of applied */
  private get relay(): boolean {
    return !!this.netMode && !this.recGuard;
  }

  // replay record/play
  private recLog: ReplayEvent[] | null = null;
  private recGuard = false;
  replayMode = false;
  private replayEvents: ReplayEvent[] = [];
  private replayIdx = 0;
  private replaySave: ReplaySave | null = null;
  replayCheckpoints: Array<{ tick: number; json: string }> = [];
  // fog of war
  explored: [Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0)];
  visible: [Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0)];
  fogVersion = 0;
  private fogT = 0;
  formation = 0; // 0 loose, 1 line, 2 column

  applySettings(s2: Settings): void {
    this.settings = { ...s2 };
    sfx.configure({
      sound: s2.sound,
      master: s2.masterVol,
      music: s2.musicVol,
      sfx: s2.sfxVol,
      ambient: s2.ambientVol,
      alerts: s2.alerts,
    });
    this.perf.setAuto(s2.qualityAuto);
    this.perf.setCap(tierFromQuality(s2.quality));
    this.markHud();
  }

  addShake(mag: number): void {
    if (!this.settings.screenShake || this.settings.reducedMotion) return;
    this.shakeMag = Math.min(7, Math.max(this.shakeMag, mag));
    this.shakeT = 0.35;
  }
  /** legacy helpers used by tests / old UI */
  get cfgTheme(): MapTheme {
    return this.grid.theme;
  }
  cfgPersonality = 4;

  constructor(
    canvas?: HTMLCanvasElement | null,
    seed?: number,
    personality?: number,
    settings?: Settings,
  ) {
    if (settings) this.settings = settings;
    const cfg = defaultMatchConfig();
    if (seed !== undefined) cfg.seed = seed;
    if (personality !== undefined && personality >= 0 && personality <= 2) {
      cfg.lord = personality; // map legacy 0-2 onto lords
    }
    this.init(cfg.seed, cfg);
    if (canvas) this.attachCanvas(canvas);
  }

  setTheme(t: MapTheme): void {
    if (this.phase === "menu")
      this.cfg.map = t === "desert" ? "desert" : "verdant";
  }

  setPersonality(p: number): void {
    if (this.phase === "menu") this.cfg.lord = p;
  }

  init(seed: number, cfg?: MatchConfig): void {
    if (cfg) this.cfg = { ...cfg, seed };
    else this.cfg.seed = seed;
    // resolve random choices INTO the config so saves/replays stay deterministic
    if (this.cfg.lord >= 4 || this.cfg.lord < 0)
      this.cfg.lord = (Math.random() * LORDS.length) | 0;
    this.cfgPersonality = LORDS[this.cfg.lord].personality;
    this.rnd = mulberry32(seed);
    this.grid = new GameGrid(seed, this.cfg.map, this.cfg.size, this.cfg.richness);
    this.cfg.map = this.grid.arch; // resolve "random" map archetype
    const n = this.grid.w * this.grid.h;
    this.explored = [new Uint8Array(n), new Uint8Array(n)];
    this.visible = [new Uint8Array(n), new Uint8Array(n)];
    this.fogVersion++;
    this.fogT = 0;
    this.finder = new Pathfinder(this.grid);
    this.nodes = [];
    this.units = [];
    this.buildings = [];
    this.buildingsRev++;
    this.projectiles = [];
    this.floats = [];
    this.messages = [];
    this.byId.clear();
    this.nodeById.clear();
    this.buildingById.clear();
    this.selection.clear();
    this.selectedBuilding = -1;
    this.pathReqs = [];
    // epic matches field far bigger armies, so both sides start richer
    const rm =
      START_RES_MULT[this.cfg.startRes] * (this.cfg.epic ? EPIC.startResMult : 1);
    const rmE = this.cfg.epic ? EPIC.startResMult : 1;
    this.res = [
      {
        wood: START_RESOURCES.wood * rm,
        stone: START_RESOURCES.stone * rm,
        gold: START_RESOURCES.gold * rm,
        food: START_RESOURCES.food * rm,
      },
      {
        wood: START_RESOURCES.wood * rmE,
        stone: START_RESOURCES.stone * rmE,
        gold: START_RESOURCES.gold * rmE,
        food: START_RESOURCES.food * rmE,
      },
    ];
    this.mods = [zeroMods(), zeroMods()];
    this.upgrades = [[], []];
    this.popularity = [POP.start, POP.start];
    this.grief = [0, 0];
    this.ration = [2, 2];
    this.tax = [1, 1];
    this.granary = [0, 0];
    this.famine = [false, false];
    this.innsActive = [0, 0];
    this.immT = [0, 0];
    this.emiT = [0, 0];
    this.alarm = [-999, -999];
    this.kills = 0;
    this.losses = 0;
    this.deaths = [0, 0];
    this.time = 0;
    this.paused = false;
    this.speed = 1;
    this.placement = null;
    this.placeTiles = [];
    this.attackMoveMode = false;
    this.lastRaidMsg = -999;
    this.autoBuildT = 1;
    this.nextId = 1;
    this.particles = [];
    this.scorches = [];
    this.buildingsRev++;
    this.mission = null;
    this.objectives = [];
    this.missionEventIdx = 0;
    this.trainedBy = {};
    this.destroyedEnemy = {};
    this.tut = {
      gather: false,
      house: false,
      farm: false,
      villager: false,
      barracks: false,
      military: false,
      wall: false,
      attack: false,
    };
    this.groups = [[], [], [], [], []];
    this.lastCombatPos = null;
    this.camTarget = null;
    this.recLog = [];
    this.replayIdx = 0;
    this.tickCount = 0;

    for (const n of this.grid.scatterNodes(this.nextId)) {
      this.nodes.push(n);
      this.nodeById.set(n.id, n);
      this.byId.set(n.id, n);
      this.grid.setOcc(n.tx, n.ty, n.id);
      this.nextId = n.id + 1;
    }

    const SP = startPositions();
    for (const team of [0, 1] as Team[]) {
      const p = SP[team];
      const keep = this.spawnBuilding(team, "keep", p.x - 2, p.y - 2, true);
      this.keeps[team] = keep.id;
      keep.rallyX = (p.x + (this.isMine(team) ? 3 : -3)) * TILE;
      keep.rallyY = (p.y + 3) * TILE;
      // spawn villagers in a row just outside the keep (front of the gate)
      for (let i = 0; i < 4; i++) {
        this.spawnUnit(
          team,
          "villager",
          (keep.tx + 1 + i) * TILE + TILE / 2,
          (keep.ty + keep.h + 1) * TILE + TILE / 2,
        );
      }
    }

    // campaign mission start state
    if (this.cfg.mode === "campaign") {
      const m = MISSIONS.find((x) => x.id === this.cfg.missionId) ?? null;
      this.mission = m;
      if (m) {
        this.objectives = m.objectives.map((o) => ({ ...o, done: false }));
        const p0 = SP[0];
        const p1 = SP[1];
        for (const [type, dx, dy] of m.playerStart?.buildings ?? [])
          this.spawnBuilding(0, type, p0.x + dx, p0.y + dy, true);
        for (const [type, dx, dy] of m.playerStart?.units ?? [])
          this.spawnUnit(0, type, (p0.x + dx) * TILE, (p0.y + dy) * TILE);
        const pr = m.playerStart?.res;
        if (pr) {
          this.res[0].wood += pr.wood ?? 0;
          this.res[0].stone += pr.stone ?? 0;
          this.res[0].gold += pr.gold ?? 0;
          this.res[0].food += pr.food ?? 0;
        }
        for (const [type, dx, dy] of m.enemyStart?.buildings ?? [])
          this.spawnBuilding(1, type, p1.x + dx, p1.y + dy, true);
        for (const [type, dx, dy] of m.enemyStart?.units ?? [])
          this.spawnUnit(1, type, (p1.x + dx) * TILE, (p1.y + dy) * TILE);
        const ek0 = this.buildingById.get(this.keeps[1]);
        if (ek0 && m.keepHpMult !== undefined) {
          ek0.maxHp = Math.round(ek0.maxHp * m.keepHpMult);
          ek0.hp = ek0.maxHp;
        }
      }
    }

    this.cam.x = SP[0].x * TILE;
    this.cam.y = SP[0].y * TILE;
    this.cam.zoom = this.settings.defaultZoom;
    this.zoomTarget = this.settings.defaultZoom;
    this.clampCam(); // never show out-of-map void on the first frame
    this.ai = new AIController(this, this.cfgPersonality, this.cfg.difficulty);

    // mode-specific setup
    if (this.cfg.mode === "siege") {
      const ek = this.buildingById.get(this.keeps[1]);
      if (ek) {
        ek.maxHp = ek.maxHp * 2;
        ek.hp = ek.maxHp;
        ek.work = 0;
      }
      const pk = this.buildingById.get(this.keeps[0]);
      if (pk) {
        for (const [t, dx, dy] of [
          ["barracks", -6, 6],
          ["tower", 6, -5],
          ["tower", -5, -5],
        ] as Array<[BuildingType, number, number]>) {
          const sp = this.findSpotNear(pk.tx + dx, pk.ty + dy, t, 0, 4);
          if (sp) this.spawnBuilding(0, t, sp.x, sp.y, true);
        }
        for (let i = 0; i < 6; i++)
          this.spawnUnit(0, "militia", (pk.tx + 2 + i) * TILE, (pk.ty + 7) * TILE);
        for (let i = 0; i < 4; i++)
          this.spawnUnit(0, "archer", (pk.tx + 2 + i) * TILE, (pk.ty + 8) * TILE);
        for (let i = 0; i < 2; i++)
          this.spawnUnit(0, "catapult", (pk.tx + 3 + i * 2) * TILE, (pk.ty + 9) * TILE);
        this.res[0].wood += 400;
        this.res[0].stone += 200;
        this.res[0].gold += 200;
        this.res[0].food += 300;
      }
    }
    this.phase = "menu";
    this.recomputePop();
    this.lastPerfNow = 0;
    this.perf.reset({
      auto: this.settings.qualityAuto,
      cap: tierFromQuality(this.settings.quality),
      load: this.expectedLoad(),
    });
    this.markHud();
  }

  /** presentation load right now (drives the adaptive ladder at runtime) */
  sceneLoad(): number {
    return (
      this.units.length +
      this.buildings.length * 2 +
      this.particles.length * 0.1 +
      (this.grid.w * this.grid.h) / 4000
    );
  }

  /** load the match is *expected* to reach — lets the governor start reduced
   *  on an epic army instead of waiting for a slideshow to be measured */
  private expectedLoad(): number {
    return (
      this.units.length +
      (this.grid.w * this.grid.h) / 4000 +
      (this.cfg.epic ? 780 : 0)
    );
  }

  private killsOrLosses(t: Team): number {
    return t === 0 ? this.kills : this.losses;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    const pref = this.settings.renderer;
    // boot on the tiny 2D renderer; the WebGL renderer is lazy-loaded and
    // swapped in so first paint never waits on the three.js chunk
    this.renderer = new Renderer(this, canvas);
    if (this.minimapEl) this.renderer.setMinimap(this.minimapEl);
    if (pref !== "2d") void this.upgradeTo3D(pref);
    this.bindInputTracked(canvas);
    if (typeof window !== "undefined") {
      const onBlur = () => {
        if (this.settings.pauseOnBlur && this.phase === "playing") {
          this.paused = true;
          this.publish(true);
        }
      };
      window.addEventListener("blur", onBlur);
      this.disposers.push(() => window.removeEventListener("blur", onBlur));
    }
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.frame(dt, now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setMinimapCanvas(el: HTMLCanvasElement | null): void {
    this.minimapEl = el;
    if (el) {
      const mm = (e: MouseEvent) => {
        const r = el.getBoundingClientRect();
        this.camTarget = this.clampCamPoint({
          x: ((e.clientX - r.left) / r.width) * MAP_W * TILE,
          y: ((e.clientY - r.top) / r.height) * MAP_H * TILE,
        });
      };
      const down = (e: MouseEvent) => {
        if (e.button === 0) mm(e);
      };
      const move = (e: MouseEvent) => {
        if (e.buttons === 1) mm(e);
      };
      el.addEventListener("mousedown", down);
      el.addEventListener("mousemove", move);
      this.disposers.push(() => {
        el.removeEventListener("mousedown", down);
        el.removeEventListener("mousemove", move);
      });
    }
    this.renderer?.setMinimap(el);
  }

  dispose(): void {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.disposers = [];
    this.renderer?.dispose();
    this.renderer = null;
    this.listeners.clear();
  }

  private record(ev: ReplayEvent): void {
    if (!this.recLog || this.replayMode || this.recGuard || this.netMode) return;
    if (this.recLog.length > 20000) return;
    this.recLog.push(ev);
  }

  private finishRecording(): void {
    if (!this.recLog || this.replayMode) return;
    const save: ReplaySave = {
      v: 1,
      date: Date.now(),
      seed: this.cfg.seed,
      cfg: this.cfg,
      result: this.phase,
      duration: this.time,
      kills: this.kills,
      losses: this.losses,
      mapName: this.grid.arch,
      lordName:
        this.cfg.lord >= 4
          ? "Random lord"
          : `${LORDS[this.cfg.lord]?.name ?? ""}`,
      events: this.recLog,
    };
    this.recLog = null;
    saveReplay(save);
  }

  /** build the replay save object without touching localStorage (tests) */
  dumpReplay(): ReplaySave | null {
    if (!this.recLog) return null;
    return {
      v: 1,
      date: 1,
      seed: this.cfg.seed,
      cfg: this.cfg,
      result: this.phase,
      duration: this.time,
      kills: this.kills,
      losses: this.losses,
      mapName: this.grid.arch,
      lordName: "",
      events: [...this.recLog],
    };
  }

  /** compact deterministic state fingerprint (replay verification) */
  stateHash(): string {
    let h = `${this.tickCount}|${this.deaths[0]}|${this.deaths[1]}|${this.units.length}|${this.buildings.length}`;
    for (const t of [0, 1] as const)
      for (const k of ["wood", "stone", "gold", "food"] as const)
        h += `|${Math.round(this.res[t][k])}`;
    return h;
  }

  loadReplay(r: ReplaySave): boolean {
    if (!r || r.v !== 1 || !Array.isArray(r.events)) return false;
    this.init(r.seed, r.cfg as MatchConfig);
    this.renderer?.reset();
    this.replayMode = true;
    this.replaySave = r;
    this.replayEvents = [...r.events].sort((a, b) => a.t - b.t);
    this.replayIdx = 0;
    this.replayCheckpoints = [];
    this.recLog = null;
    this.phase = "playing";
    this.msg("Replay playback — inputs disabled.", "info");
    this.publish(true);
    return true;
  }

  /** abandon a network match back to the menu */
  netAbort(): void {
    this.netMode = null;
    this.netServerTick = null;
    this.netQueue = [];
    this.onIntent = null;
    this.init((Math.random() * 1e9) | 0, this.cfg);
    this.renderer?.reset();
    this.phase = "menu";
    this.publish(true);
  }

  /** pump ticks toward the server tick without RAF (headless clients/tests) */
  netPump(max = 200): void {
    if (this.netServerTick === null) return;
    let n = 0;
    while (this.tickCount < this.netServerTick && n++ < max) this.tick(1 / 30);
  }

  exitReplay(): void {
    this.replayMode = false;
    this.replayEvents = [];
    this.init((Math.random() * 1e9) | 0, this.cfg);
    this.renderer?.reset();
    this.phase = "menu";
    this.publish(true);
  }

  applyReplayEvent(ev: ReplayEvent, team: Team = 0): void {
    this.recGuard = true;
    const prevTeam = this.myTeam;
    this.myTeam = team;
    try {
      this.applyReplayEventInner(ev, team);
    } finally {
      this.myTeam = prevTeam;
      this.recGuard = false;
    }
  }

  private applyReplayEventInner(ev: ReplayEvent, team: Team): void {
    switch (ev.k) {
      case "rc": {
        this.deselectAllUnits();
        for (const id of ev.sel) {
          const e = this.byId.get(id);
          if (e && isUnit(e)) {
            this.selection.add(id);
            (e as Unit).selected = true;
          }
        }
        this.selectedBuilding = ev.selB;
        this.rightClickCommand(ev.x, ev.y);
        break;
      }
      case "place":
        this.place(team, ev.type, ev.tx, ev.ty);
        break;
      case "train": {
        const b = this.buildingById.get(ev.bId);
        if (b) this.trainAt(b, ev.unit);
        break;
      }
      case "res": {
        const b = this.buildingById.get(ev.bId);
        if (b) this.startResearch(b, ev.up);
        break;
      }
      case "trade":
        this.exchange(team, ev.kind as "sellWood");
        break;
      case "form":
        this.formation = ev.v;
        break;
      case "move":
        this.cmdMove(this.idsToUnits(ev.ids, team), ev.x, ev.y);
        break;
      case "amove":
        this.cmdAttackMove(this.idsToUnits(ev.ids, team), ev.x, ev.y);
        break;
      case "atk":
        this.cmdAttack(this.idsToUnits(ev.ids, team), ev.target);
        break;
      case "harv":
        this.cmdHarvest(this.idsToUnits(ev.ids, team), ev.node);
        break;
      case "stop":
        this.cmdStop(this.idsToUnits(ev.ids, team));
        break;
    }
  }

  private idsToUnits(ids: number[], team: Team = 0): Unit[] {
    const out: Unit[] = [];
    for (const id of ids) {
      const e = this.byId.get(id);
      if (e && isUnit(e) && (e as Unit).team === team) out.push(e as Unit);
    }
    return out;
  }

  /** enqueue a relayed intent for tick-exact application */
  queueNetEvent(i: number, team: Team, ev: ReplayEvent): void {
    this.netQueue.push({ i, team, ev });
  }

  startMatch(cfg: MatchConfig): void {
    this.init(cfg.seed, cfg);
    this.renderer?.reset();
    this.replayMode = false;
    this.recLog = [];
    this.phase = "playing";
    const modeMsg: Record<string, string> = {
      skirmish: "Gather resources, build an army, destroy the enemy keep!",
      sandbox: "Free build: your neighbour is passive. Shape your realm!",
      siege: "Siege challenge: crack the doubled keep before time runs out!",
      survival: "Survival: endure the endless waves until the clock runs out!",
    };
    this.msg(modeMsg[this.cfg.mode], "info");
    this.publish(true);
  }

  startGame(): void {
    if (this.phase !== "menu") return;
    this.startMatch(this.cfg);
  }

  restart(): void {
    this.init((Math.random() * 1e9) | 0, this.cfg);
    this.renderer?.reset();
    this.phase = "playing";
    this.publish(true);
  }

  private frame(dt: number, now: number): void {
    if (this.phase === "playing" && !this.paused) {
      if (this.netMode && this.netServerTick !== null) {
        let guard = 0;
        while (this.tickCount < this.netServerTick && guard++ < 10)
          this.tick(STEP);
        this.postFrame(now);
        return;
      }
      this.acc += dt * SPEED_MULT[this.settings.gameSpeed] * this.speed;
      let guard = 0;
      const t0 =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      while (this.acc >= STEP && guard++ < 6) {
        this.tick(STEP);
        this.acc -= STEP;
      }
      const t1 =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      this.perfTickMs = this.perfTickMs * 0.9 + (t1 - t0) * 0.1;
      if (this.acc > STEP * 8) this.acc = 0;
    }
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      if (this.shakeT <= 0) this.shakeMag = 0;
    }
    this.postFrame(now);
  }

  private postFrame(now: number): void {
    const r0 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    this.updateCameraPan(1 / 60);
    this.maybeAutosave(1 / 60);
    this.renderer?.render(now / 1000, this.dragSel);
    const r1 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    this.perfFrameMs = this.perfFrameMs * 0.9 + (r1 - r0) * 0.1;
    // adaptive quality: measured cost → presentation ladder (never the sim)
    const dtS = this.lastPerfNow
      ? Math.min(0.25, (now - this.lastPerfNow) / 1000)
      : 1 / 60;
    this.lastPerfNow = now;
    const hidden = typeof document !== "undefined" && document.hidden;
    if (!hidden) {
      if (this.lastRafNow) {
        // clamp: tab-switch gaps are not a performance signal
        const iv = Math.min(250, Math.max(0, now - this.lastRafNow));
        this.perfIntervalMs = this.perfIntervalMs * 0.85 + iv * 0.15;
      }
      this.lastRafNow = now;
      this.perf.sample(
        dtS,
        Math.max(this.perfFrameMs, this.perfIntervalMs),
        this.perfTickMs,
        this.sceneLoad(),
      );
      // the last rung only makes sense with 3D actually on screen and the
      // player leaving the choice to us (short-circuit keeps the latch clean)
      if (
        this.renderer?.kind === "3d" &&
        this.settings.renderer === "auto" &&
        this.perf.shouldFallBackTo2D()
      )
        this.downgradeTo2D();
    }
    if (this.hudDirty && now - this.lastPublish > 90) this.publish(false);
  }

  /**
   * Last rung of the adaptive ladder: the machine cannot hold 3D even at
   * minimum detail, so hand the same canvas slot back to the 2D renderer.
   * Only ever reached when the player left Renderer on "auto".
   */
  private downgradeTo2D(): void {
    if (typeof document === "undefined") return;
    if (!this.canvas || this.renderer?.kind !== "3d") return;
    const old = this.canvas;
    const nc = document.createElement("canvas");
    nc.className = old.className;
    nc.style.cssText = old.style.cssText;
    old.parentNode?.insertBefore(nc, old);
    old.remove();
    this.canvas = nc;
    this.renderer?.dispose();
    this.renderer = new Renderer(this, nc);
    if (this.minimapEl) this.renderer.setMinimap(this.minimapEl);
    this.bindInputTracked(nc);
    this.msg("This machine struggled with 3D — switched to the 2D renderer.", "info");
    this.perf.clearFallbackLatch();
    this.publish(true);
  }

  /** capture a seek checkpoint while a replay plays (every 30 game-seconds) */
  private maybeCheckpoint(): void {
    if (!this.replayMode) return;
    if (this.tickCount % 900 !== 0 || this.tickCount === 0) return;
    if (this.replayCheckpoints.length >= 60) return;
    this.replayCheckpoints.push({ tick: this.tickCount, json: this.serialize() });
  }

  replayDuration(): number {
    return this.replaySave?.duration ?? this.time;
  }

  /** seek the replay to a game-time in seconds (checkpoints + re-sim) */
  replaySeek(seconds: number): void {
    if (!this.replayMode || !this.replaySave) return;
    const target = Math.max(
      0,
      Math.min(Math.round(seconds / STEP), Math.round(this.replaySave.duration / STEP)),
    );
    if (target >= this.tickCount) {
      let guard = 0;
      while (this.tickCount < target && guard++ < 200000) this.tick(STEP);
    } else {
      let cp: { tick: number; json: string } | null = null;
      for (const c of this.replayCheckpoints)
        if (c.tick <= target && (!cp || c.tick > cp.tick)) cp = c;
      if (cp) {
        this.loadFrom(cp.json);
        this.replayMode = true;
        this.replaySave = this.replaySave;
        this.replayEvents = [...(this.replaySave.events ?? [])].sort(
          (a, b) => a.t - b.t,
        );
        this.replayIdx = this.replayEvents.findIndex(
          (e) => e.t >= this.time,
        );
        if (this.replayIdx < 0) this.replayIdx = this.replayEvents.length;
      } else {
        const save = this.replaySave;
        this.loadReplay(save);
      }
      let guard = 0;
      while (this.tickCount < target && guard++ < 200000) this.tick(STEP);
    }
    this.publish(true);
  }

  /** headless stepping for tests */
  step(seconds: number): void {
    const n = Math.round(seconds / STEP);
    for (let i = 0; i < n; i++) {
      if (this.phase !== "playing") break;
      this.tick(STEP);
    }
  }

  // ── HUD store ──────────────────────────────────────────────────────────────

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): HudSnapshot => this.snap;

  markHud(): void {
    this.hudDirty = true;
  }

  publish(force: boolean): void {
    if (!force && !this.hudDirty) return;
    this.hudDirty = false;
    this.lastPublish =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    this.snap = this.buildSnapshot();
    for (const l of [...this.listeners]) l();
  }

  private buildSnapshot(): HudSnapshot {
    let villagers = 0;
    let army = 0;
    for (const u of this.units) {
      if (!this.isMine(u.team)) continue;
      if (u.type === "villager") villagers++;
      else army++;
    }
    return {
      phase: this.phase,
      paused: this.paused,
      speed: this.speed,
      time: this.time,
      mode: this.cfg.mode,
      lordName:
        this.cfg.lord >= 4
          ? "Random lord"
          : `${LORDS[this.cfg.lord]?.name ?? ""} ${LORDS[this.cfg.lord]?.title ?? ""}`,
      difficultyName: DIFF_NAMES[this.cfg.difficulty],
      timeLeft:
        this.cfg.mode === "survival"
          ? Math.max(0, (this.cfg.timeLimitMin || 15) * 60 - this.time)
          : this.cfg.timeLimitMin > 0
            ? Math.max(0, this.cfg.timeLimitMin * 60 - this.time)
            : 0,
      stats: {
        gathered: {
          wood: Math.floor(this.stats.gathered.wood),
          stone: Math.floor(this.stats.gathered.stone),
          gold: Math.floor(this.stats.gathered.gold),
          food: Math.floor(this.stats.gathered.food),
        },
        trained: this.stats.trained,
        built: this.stats.built,
        researched: this.stats.researched,
        peakPop: this.stats.peakPop,
      },
      achievements: [...this.achievements],
      popularity: Math.round(this.popularity[this.myTeam]),
      popFactors: this.popFactors(this.myTeam),
      ration: this.ration[this.myTeam],
      tax: this.tax[this.myTeam],
      granary: Math.round(this.granary[this.myTeam]),
      famine: this.famine[this.myTeam],
      innsActive: this.innsActive[this.myTeam],
      upgrades: [...this.upgrades[this.myTeam]],
      tut: { ...this.tut },
      tutorialSkipped:
        this.tutorialSkipped || !this.settings.tutorial || !!this.netMode,
      net: this.netMode
        ? {
            seat: this.netMode.seat,
            room: this.netMode.room,
            ping: Math.round(this.netPing),
            connected: this.netConnected,
            waiting: this.netServerTick === null,
          }
        : null,
      muted: this.muted,
      res: { ...this.res[this.myTeam] },
      popCur: this.popCur[this.myTeam],
      popCap: this.popCap[this.myTeam],
      villagers,
      army,
      kills: this.kills,
      losses: this.losses,
      sel: this.buildSelSummary(),
      placement: this.placement,
      attackMoveMode: this.attackMoveMode,
      formation: this.formation,
      replayMode: this.replayMode,
      replay: this.replayMode
        ? {
            time: this.time,
            duration: this.replayDuration(),
            paused: this.paused,
            speed: this.speed,
          }
        : null,
      missionName: this.mission?.name ?? "",
      objectives: this.objectives.map((o) => ({ label: o.label, done: o.done })),
      messages: this.messages.slice(-4),
    };
  }

  private buildSelSummary(): HudSnapshot["sel"] {
    if (this.selectedBuilding >= 0 && this.selection.size === 0) {
      const b = this.buildingById.get(this.selectedBuilding);
      if (b && this.isMine(b.team)) {
        const def = BUILDING_DEFS[b.type];
        let research: { id: string; t: number } | null = null;
        if (b.research) {
          const rid = b.research.id;
          const rt = b.research.t;
          const ud = UPGRADES.find((u) => u.id === rid);
          research = { id: rid, t: ud ? rt / ud.time : 0 };
        }
        return {
          kind: "building",
          count: 1,
          counts: {},
          bId: b.id,
          bType: b.type,
          bHp: b.hp,
          bMaxHp: b.maxHp,
          bBuilt: b.built,
          bProgress: b.workMax > 0 ? 1 - b.work / b.workMax : 1,
          bBuilders: b.builders,
          bQueue: [...b.queue],
          bQueueT: b.queue.length
            ? b.queueT / this.trainTime(b.team, UNIT_DEFS[b.queue[0]].trainTime)
            : 0,
          bResearch: research,
          canTrain: def.trains,
        };
      }
    }
    if (this.selection.size === 0) return null;
    const counts: Partial<Record<UnitType, number>> = {};
    let count = 0;
    let hasMilitary = false;
    let single: UnitType | undefined;
    for (const id of this.selection) {
      const e = this.byId.get(id);
      if (!e || !isUnit(e) || !this.isMine(e.team)) continue;
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      count++;
      if (UNIT_DEFS[e.type].military) hasMilitary = true;
      single = e.type;
    }
    if (count === 0) return null;
    const kinds = Object.keys(counts);
    return {
      kind: "units",
      count,
      counts,
      unitType: kinds.length === 1 ? single : undefined,
      hasMilitary,
    };
  }

  msg(text: string, kind: GameMessage["kind"]): void {
    // suppress duplicate spam (e.g. repeated "no idle villagers")
    const last = this.messages[this.messages.length - 1];
    if (last && last.text === text && this.time - last.born < 4) return;
    this.messages.push({ id: this.msgId++, text, kind, born: this.time });
    if (this.messages.length > 12)
      this.messages.splice(0, this.messages.length - 12);
    this.markHud();
  }

  // ── entity spawning ────────────────────────────────────────────────────────

  spawnUnit(team: Team, type: UnitType, x: number, y: number): Unit {
    const def = UNIT_DEFS[type];
    const hpBonus =
      type === "villager" ? this.mods[team].villagerHpAdd : 0;
    const u: Unit = {
      id: this.nextId++,
      team,
      type,
      x,
      y,
      hp: def.hp + hpBonus,
      maxHp: def.hp + hpBonus,
      state: "idle",
      path: null,
      pathI: 0,
      tx: x,
      ty: y,
      targetId: -1,
      taskId: -1,
      workT: 0,
      atkCd: 0,
      facing: this.isMine(team) ? -Math.PI / 4 : (Math.PI * 3) / 4,
      anim: this.rnd() * 10,
      acqT: this.rnd() * 0.3,
      raid: -1,
      kills: 0,
      rank: 0,
      lastAttacker: -1,
      repathT: 0,
      repathFails: 0,
      attackMoveResume: false,
      siegeResume: -1,
      stuckT: 0,
      wdX: x,
      wdY: y,
      wdT: 1,
      lastX: x,
      lastY: y,
      flash: 0,
      selected: false,
    };
    this.units.push(u);
    this.byId.set(u.id, u);
    return u;
  }

  spawnBuilding(
    team: Team,
    type: BuildingType,
    tx: number,
    ty: number,
    prebuilt: boolean,
  ): Building {
    const def = BUILDING_DEFS[type];
    const b: Building = {
      id: this.nextId++,
      team,
      type,
      tx,
      ty,
      w: def.w,
      h: def.h,
      hp: prebuilt ? def.hp : Math.ceil(def.hp * 0.4),
      maxHp: def.hp,
      built: prebuilt,
      work: def.work,
      workMax: Math.max(1, def.work),
      queue: [],
      queueT: 0,
      research: null,
      cdT: 0,
      rallyX: (tx + def.w / 2) * TILE,
      rallyY: (ty + def.h + 1.5) * TILE,
      builders: 0,
      flash: 0,
    };
    this.buildings.push(b);
    this.buildingsRev++;
    this.buildingById.set(b.id, b);
    this.byId.set(b.id, b);
    for (let y = ty; y < ty + def.h; y++)
      for (let x = tx; x < tx + def.w; x++) this.grid.setOcc(x, y, b.id);

    // invalidate paths that cross the new footprint (better pathfinding UX)
    for (const u of this.units) {
      if (!u.path) continue;
      for (let i = u.pathI; i < u.path.length; i++) {
        const px = u.path[i] % MAP_W;
        const py = (u.path[i] / MAP_W) | 0;
        if (px >= tx && px < tx + def.w && py >= ty && py < ty + def.h) {
          u.path = null;
          u.pathI = 0;
          u.repathT = 0;
          break;
        }
      }
    }
    return b;
  }

  private removeBuilding(b: Building): void {
    for (let y = b.ty; y < b.ty + b.h; y++)
      for (let x = b.tx; x < b.tx + b.w; x++)
        if (this.grid.occ[this.grid.idx(x, y)] === b.id) this.grid.clearOcc(x, y);
    this.buildingById.delete(b.id);
    this.byId.delete(b.id);
    const i = this.buildings.indexOf(b);
    if (i >= 0) this.buildings.splice(i, 1);
    this.buildingsRev++;
    if (this.selectedBuilding === b.id) this.selectedBuilding = -1;
    for (const u of this.units) {
      if (u.taskId === b.id) {
        u.taskId = -1;
        if (u.state === "build" || u.state === "harvest") u.state = "idle";
      }
      if (u.targetId === b.id) {
        u.targetId = -1;
        if (u.state === "attack") this.onAttackTargetLost(u);
      }
    }
  }

  private removeNode(n: RNode): void {
    this.nodeById.delete(n.id);
    this.byId.delete(n.id);
    this.grid.clearOcc(n.tx, n.ty);
    const i = this.nodes.indexOf(n);
    if (i >= 0) this.nodes.splice(i, 1);
    for (const u of this.units)
      if (u.taskId === n.id) {
        u.taskId = -1;
        if (u.state === "harvest") u.state = "idle";
      }
  }

  private removeUnit(u: Unit): void {
    this.byId.delete(u.id);
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
    this.selection.delete(u.id);
    u.selected = false;
    for (const other of this.units)
      if (other.targetId === u.id) {
        other.targetId = -1;
        if (other.state === "attack") this.onAttackTargetLost(other);
      }
  }

  // ── placement ──────────────────────────────────────────────────────────────

  canPlace(
    _team: Team,
    type: BuildingType,
    tx: number,
    ty: number,
    ignoreUnits = false,
  ): boolean {
    const def = BUILDING_DEFS[type];
    for (let y = ty; y < ty + def.h; y++) {
      for (let x = tx; x < tx + def.w; x++) {
        if (!this.grid.inBounds(x, y)) return false;
        if (this.grid.occ[this.grid.idx(x, y)] !== 0) return false;
        const tt = this.grid.terrain[this.grid.idx(x, y)];
        if (tt === T_FORD || tt === T_BRIDGE_C || tt === T_WATER_C) return false;
      }
    }
    if (!ignoreUnits) {
      for (const u of this.units) {
        const ux = Math.floor(u.x / TILE);
        const uy = Math.floor(u.y / TILE);
        if (ux >= tx && ux < tx + def.w && uy >= ty && uy < ty + def.h)
          return false;
      }
    }
    return true;
  }

  place(team: Team, type: BuildingType, tx: number, ty: number): Building | null {
    if (this.relay && team === this.myTeam) {
      this.emitNet({ t: 0, k: "place", type, tx, ty });
      return null;
    }
    const def = BUILDING_DEFS[type];
    if (!this.canPlace(team, type, tx, ty, team === 1)) return null;
    if (!canAfford(this.res[team], def.cost)) return null;
    payCost(this.res[team], def.cost);
    const b = this.spawnBuilding(team, type, tx, ty, false);
    if (this.isMine(team)) {
      this.record({ t: this.time, k: "place", type, tx, ty });
      this.stats.built++;
      if (this.stats.built >= 10) this.unlock("masterbuilder");
      sfx.play("place");
    }
    if (this.netMode || this.isMine(team)) {
      this.assignAutoBuilders(b, 2);
      if (b.builders === 0)
        this.msg(
          "No idle villagers — select villagers and right-click the site.",
          "info",
        );
    }
    this.markHud();
    return b;
  }

  private assignAutoBuilders(site: Building, max: number): void {
    const idle = this.units
      .filter(
        (u) =>
          u.team === site.team && u.type === "villager" && u.state === "idle",
      )
      .sort((a, b) => this.distToBuilding(a, site) - this.distToBuilding(b, site))
      .slice(0, max);
    for (const v of idle) this.assignBuild(v, site);
  }

  findSpotNearBuilding(
    b: Building,
    maxR = 3,
    rules?: PathRules,
  ): { x: number; y: number } | null {
    const r0 = rules ?? this.rulesFor(b.team, "civ");
    for (let r = 1; r <= maxR; r++) {
      const x0 = b.tx - r;
      const x1 = b.tx + b.w - 1 + r;
      const y0 = b.ty - r;
      const y1 = b.ty + b.h - 1 + r;
      for (let x = x0; x <= x1; x++) {
        if (this.grid.inBounds(x, y1) && isFinite(r0.tileCost(x, y1)))
          return { x, y: y1 };
      }
      for (let y = y0; y <= y1; y++) {
        if (this.grid.inBounds(x0, y) && isFinite(r0.tileCost(x0, y)))
          return { x: x0, y };
        if (this.grid.inBounds(x1, y) && isFinite(r0.tileCost(x1, y)))
          return { x: x1, y };
      }
      for (let x = x0; x <= x1; x++) {
        if (this.grid.inBounds(x, y0) && isFinite(r0.tileCost(x, y0)))
          return { x, y: y0 };
      }
    }
    return null;
  }

  // ── path rules ─────────────────────────────────────────────────────────────

  rulesFor(team: Team, mode: PathMode = "civ"): PathRules {
    const g = this.grid;
    const byId = this.byId;
    return {
      tileCost: (tx: number, ty: number): number => {
        if (!g.inBounds(tx, ty)) return Infinity;
        const o = g.occ[g.idx(tx, ty)];
        if (o === -1) return Infinity;
        if (o === 0) return g.terrain[g.idx(tx, ty)] === T_FORD ? 2.6 : 1;
        const ent = byId.get(o);
        if (!ent) return 1;
        if (isNode(ent)) return Infinity;
        if (isUnit(ent)) return Infinity;
        if (ent.type === "wall" || ent.type === "gate") {
          if (ent.team === team) return ent.type === "gate" ? 1 : COST_OWN_WALL;
          return mode === "civ" ? Infinity : COST_ENEMY_WALL;
        }
        if (ent.team === team) return Infinity;
        return mode === "siege" ? COST_SIEGE : Infinity;
      },
    };
  }

  unitRules(u: Unit, siege = false): PathRules {
    const mil = UNIT_DEFS[u.type].military;
    return this.rulesFor(u.team, siege ? "siege" : mil ? "mil" : "civ");
  }

  // ── commands ───────────────────────────────────────────────────────────────

  queuePath(u: Unit, gx: number, gy: number, siege = false): void {
    this.pathReqs.push({ unitId: u.id, gx, gy, siege });
  }

  pathNow(u: Unit, wx: number, wy: number, siege = false): boolean {
    const rules = this.unitRules(u, siege);
    const sx = Math.floor(u.x / TILE);
    const sy = Math.floor(u.y / TILE);
    const gx = Math.floor(wx / TILE);
    const gy = Math.floor(wy / TILE);
    let open = this.finder.nearestOpen(gx, gy, 3, rules);
    let useRules = rules;
    if (open < 0 && !siege && UNIT_DEFS[u.type].military) {
      const sRules = this.unitRules(u, true);
      open = this.finder.nearestOpen(gx, gy, 4, sRules);
      useRules = sRules;
    }
    if (open < 0) {
      u.path = null;
      return false;
    }
    // distance-adaptive search budget: cross-map orders need deeper searches
    const distT = Math.hypot(gx - sx, gy - sy);
    const budget = distT > 70 ? 60000 : distT > 40 ? 30000 : 12000;
    let p = this.finder.find(
      sx,
      sy,
      open % MAP_W,
      (open / MAP_W) | 0,
      useRules,
      budget,
    );
    if (!p && !siege && UNIT_DEFS[u.type].military) {
      const sRules = this.unitRules(u, true);
      const open2 = this.finder.nearestOpen(gx, gy, 4, sRules);
      if (open2 >= 0) {
        p = this.finder.find(sx, sy, open2 % MAP_W, (open2 / MAP_W) | 0, sRules);
        if (p) useRules = sRules;
      }
    }
    if (!p) {
      u.path = null;
      return false;
    }
    if (p.length > 2) p = this.finder.smooth(p, sx, sy, useRules);
    u.path = p;
    u.pathI = 0;
    u.repathFails = 0;
    return true;
  }

  cmdMove(units: Unit[], wx: number, wy: number): void {
    if (this.relay && units.length) {
      this.emitNet({ t: 0, k: "move", ids: units.map((u) => u.id), x: wx, y: wy });
      return;
    }
    if (units.some((u) => this.isMine(u.team)))
      this.record({
        t: this.time,
        k: "move",
        ids: units.filter((u) => this.isMine(u.team)).map((u) => u.id),
        x: wx,
        y: wy,
      });
    const n = units.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    // formation direction from centroid to target
    let cxm = 0;
    let cym = 0;
    for (const u of units) {
      cxm += u.x;
      cym += u.y;
    }
    cxm /= n || 1;
    cym /= n || 1;
    let dx = wx - cxm;
    let dy = wy - cym;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const px = -dy;
    const py = dx;
    let i = 0;
    for (const u of units) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      let ox = (col - (cols - 1) / 2) * 20;
      let oy = (row - (cols - 1) / 2) * 20;
      if (this.formation === 1 && n > 1) {
        ox = px * (i - (n - 1) / 2) * 24;
        oy = py * (i - (n - 1) / 2) * 24;
      } else if (this.formation === 2 && n > 1) {
        ox = -dx * (i - (n - 1) / 2) * 24;
        oy = -dy * (i - (n - 1) / 2) * 24;
      }
      let txw = wx + ox;
      let tyw = wy + oy;
      // clamp the order onto walkable ground (lakes, cliffs, buildings)
      const open = this.finder.nearestOpen(
        Math.floor(txw / TILE),
        Math.floor(tyw / TILE),
        3,
        this.unitRules(u),
      );
      if (open >= 0) {
        txw = (open % this.grid.w) * TILE + TILE / 2;
        tyw = ((open / this.grid.w) | 0) * TILE + TILE / 2;
      }
      u.tx = txw;
      u.ty = tyw;
      u.state = "move";
      u.targetId = -1;
      u.taskId = -1;
      u.stuckT = 0;
      u.repathFails = 0;
      u.raid = -1;
      i++;
      if (n <= 4) this.pathNow(u, u.tx, u.ty);
      else
        this.queuePath(u, Math.floor(u.tx / TILE), Math.floor(u.ty / TILE));
    }
    this.floatAt(wx, wy, "•", "#ffffff");
  }

  cmdAttackMove(units: Unit[], wx: number, wy: number): void {
    if (this.relay && units.length) {
      this.emitNet({ t: 0, k: "amove", ids: units.map((u) => u.id), x: wx, y: wy });
      return;
    }
    if (units.some((u) => this.isMine(u.team)))
      this.record({
        t: this.time,
        k: "amove",
        ids: units.filter((u) => this.isMine(u.team)).map((u) => u.id),
        x: wx,
        y: wy,
      });
    const mil = units.filter((u) => UNIT_DEFS[u.type].military);
    const list = mil.length ? mil : units;
    if (units.some((u) => this.isMine(u.team)) && mil.length >= 3) this.tutSet("attack");
    this.cmdMove(list, wx, wy);
    for (const u of list) {
      u.state = "attackMove";
      u.attackMoveResume = false;
    }
    this.floatAt(wx, wy, "!", "#ff6b57");
  }

  cmdAttack(units: Unit[], targetId: number): void {
    if (this.relay && units.length) {
      this.emitNet({ t: 0, k: "atk", ids: units.map((u) => u.id), target: targetId });
      return;
    }
    if (units.some((u) => this.isMine(u.team)))
      this.record({
        t: this.time,
        k: "atk",
        ids: units.filter((u) => this.isMine(u.team)).map((u) => u.id),
        target: targetId,
      });
    for (const u of units) {
      u.targetId = targetId;
      u.state = "attack";
      u.stuckT = 0;
      u.repathFails = 0;
      u.siegeResume = -1;
      const t = this.byId.get(targetId);
      if (t) {
        const tp = this.entPos(t);
        u.tx = tp.x;
        u.ty = tp.y;
        this.pathNow(u, tp.x, tp.y);
      }
    }
  }

  cmdHarvest(units: Unit[], nodeOrFarmId: number): void {
    if (this.relay && units.length) {
      this.emitNet({ t: 0, k: "harv", ids: units.map((u) => u.id), node: nodeOrFarmId });
      return;
    }
    if (units.some((u) => this.isMine(u.team)))
      this.record({
        t: this.time,
        k: "harv",
        ids: units.filter((u) => this.isMine(u.team)).map((u) => u.id),
        node: nodeOrFarmId,
      });
    for (const u of units) {
      if (u.type !== "villager") continue;
      this.assignHarvest(u, nodeOrFarmId);
    }
  }

  assignHarvest(u: Unit, id: number): void {
    u.taskId = id;
    u.targetId = -1;
    u.state = "harvest";
    u.workT = 0;
    u.stuckT = 0;
    u.repathFails = 0;
    const ent = this.byId.get(id);
    if (ent) this.pathToTarget(u, ent);
  }

  assignBuild(u: Unit, site: Building): void {
    u.taskId = site.id;
    u.targetId = -1;
    u.state = "build";
    u.workT = 0;
    u.stuckT = 0;
    u.repathFails = 0;
    this.pathToTarget(u, site);
  }

  private pathToTarget(u: Unit, t: Ent): void {
    if (isNode(t)) {
      u.tx = t.tx * TILE + TILE / 2;
      u.ty = t.ty * TILE + TILE / 2;
      const rules = this.unitRules(u);
      const open = this.finder.nearestOpen(t.tx, t.ty, 2, rules);
      if (open >= 0) this.queuePath(u, open % MAP_W, (open / MAP_W) | 0);
      else this.pathNow(u, u.tx, u.ty);
      return;
    }
    if (isBuilding(t)) {
      const p = this.entPos(t);
      u.tx = p.x;
      u.ty = p.y;
      const spot = this.findSpotNearBuilding(t, 3, this.unitRules(u));
      if (spot) this.queuePath(u, spot.x, spot.y);
      else this.pathNow(u, p.x, p.y);
    }
  }

  cmdStop(units: Unit[]): void {
    if (this.relay && units.length) {
      this.emitNet({ t: 0, k: "stop", ids: units.map((u) => u.id) });
      return;
    }
    if (units.some((u) => this.isMine(u.team)))
      this.record({
        t: this.time,
        k: "stop",
        ids: units.filter((u) => this.isMine(u.team)).map((u) => u.id),
      });
    for (const u of units) {
      u.state = "idle";
      u.path = null;
      u.targetId = -1;
      u.taskId = -1;
      u.stuckT = 0;
      u.attackMoveResume = false;
      u.siegeResume = -1;
      u.raid = -1;
    }
  }

  trainTime(team: Team, base: number): number {
    const h = this.popularity[team];
    const mult = h >= POP.highAt ? POP.highTrain : h <= POP.lowAt ? POP.lowTrain : 1;
    return base * mult;
  }

  trainAt(b: Building, type: UnitType): boolean {
    const team = b.team;
    if (this.relay && team === this.myTeam) {
      this.emitNet({ t: 0, k: "train", bId: b.id, unit: type });
      return false;
    }
    const def = UNIT_DEFS[type];
    if (!b.built || b.queue.length >= MAX_QUEUE) return false;
    if (!BUILDING_DEFS[b.type].trains.includes(type)) return false;
    let queued = 0;
    for (const ob of this.buildings)
      if (ob.team === team) queued += ob.queue.length;
    if (this.units.length >= EPIC.hardUnitCap) return false;
    if (this.popCur[team] + queued >= this.popCap[team]) {
      if (this.isMine(team)) {
        sfx.play("error");
        this.msg("Not enough housing — build a House.", "bad");
      }
      return false;
    }
    if (!canAfford(this.res[team], def.cost)) {
      if (this.isMine(team)) {
        sfx.play("error");
        this.msg("Not enough resources.", "bad");
      }
      return false;
    }
    payCost(this.res[team], def.cost);
    b.queue.push(type);
    if (this.isMine(team)) this.record({ t: this.time, k: "train", bId: b.id, unit: type });
    this.markHud();
    return true;
  }

  // ── upgrades / market ──────────────────────────────────────────────────────

  hasUpgrade(team: Team, id: string): boolean {
    return this.upgrades[team].includes(id);
  }

  startResearch(b: Building, upgradeId: string): boolean {
    if (this.relay && b.team === this.myTeam) {
      this.emitNet({ t: 0, k: "res", bId: b.id, up: upgradeId });
      return false;
    }
    const def = UPGRADES.find((u) => u.id === upgradeId);
    if (!def || !b.built || b.research || def.at !== b.type) return false;
    if (this.hasUpgrade(b.team, upgradeId)) return false;
    if (!canAfford(this.res[b.team], def.cost)) {
      if (this.isMine(b.team)) this.msg("Not enough resources.", "bad");
      return false;
    }
    payCost(this.res[b.team], def.cost);
    b.research = { id: upgradeId, t: 0 };
    if (this.isMine(b.team))
      this.record({ t: this.time, k: "res", bId: b.id, up: upgradeId });
    this.markHud();
    return true;
  }

  private applyUpgrade(team: Team, id: string): void {
    const m = this.mods[team];
    switch (id) {
      case "wheelbarrow":
        m.harvestMult *= 1.15;
        break;
      case "loom":
        m.villagerHpAdd += 20;
        for (const u of this.teamUnits(team, "villager")) {
          u.maxHp += 20;
          u.hp += 20;
        }
        break;
      case "iron_swords":
        m.meleeDmgAdd += 2;
        break;
      case "longbows":
        m.archerDmgAdd += 1;
        m.archerRangeAdd += 40;
        break;
      case "padded_armor":
        m.armorAdd += 1;
        break;
      case "siege_eng":
        m.siegeMult *= 1.3;
        break;
      case "town_watch":
        m.towerRangeAdd += 40;
        m.towerDmgAdd += 2;
        break;
    }
    this.upgrades[team].push(id);
  }

  uiResearch(upgradeId: string): void {
    const b = this.buildingById.get(this.selectedBuilding);
    if (b) this.startResearch(b, upgradeId);
    this.publish(true);
  }

  /** true when the team owns at least one completed market */
  hasMarket(team: Team): boolean {
    return this.teamBuildings(team, "market").some((m) => m.built);
  }

  exchange(team: Team, kind: keyof typeof MARKET): boolean {
    if (this.relay && team === this.myTeam) {
      this.emitNet({ t: 0, k: "trade", kind });
      return false;
    }
    if (!this.hasMarket(team)) return false;
    const deal = MARKET[kind];
    if (!canAfford(this.res[team], deal.give)) return false;
    payCost(this.res[team], deal.give);
    for (const k of Object.keys(deal.get) as ResKind[])
      this.res[team][k] += deal.get[k] ?? 0;
    return true;
  }

  uiExchange(kind: keyof typeof MARKET): void {
    const b = this.buildingById.get(this.selectedBuilding);
    if (!b || !this.isMine(b.team) || b.type !== "market" || !b.built) return;
    this.record({ t: this.time, k: "trade", kind });
    if (!canAfford(this.res[0], MARKET[kind].give)) {
      this.msg("Not enough resources to trade.", "bad");
      this.publish(true);
      return;
    }
    this.exchange(0, kind);
    const p = this.entPos(b);
    this.floatAt(p.x, p.y - 16, "+trade", "#ffd166");
    this.publish(true);
  }

  // ── combat stat helpers ────────────────────────────────────────────────────

  dmgOf(u: Unit): number {
    const def = UNIT_DEFS[u.type];
    const m = this.mods[u.team];
    let d = def.dmg * [1, 1.12, 1.25][u.rank];
    if (def.cls === "archer") d += m.archerDmgAdd;
    else if (def.cls === "infantry" || def.cls === "cavalry") d += m.meleeDmgAdd;
    return d;
  }

  rangeOf(u: Unit): number {
    const def = UNIT_DEFS[u.type];
    return def.range + (def.cls === "archer" ? this.mods[u.team].archerRangeAdd : 0);
  }

  armorOf(u: Unit): number {
    const def = UNIT_DEFS[u.type];
    return (
      def.armor +
      (def.military ? this.mods[u.team].armorAdd : 0) +
      (u.rank === 2 ? 1 : 0)
    );
  }

  private multVs(u: Unit, t: Ent): number {
    const def = UNIT_DEFS[u.type];
    if (isBuilding(t))
      return def.siegeMult * (def.cls === "siege" ? this.mods[u.team].siegeMult : 1);
    if (isUnit(t)) return def.bonusVs[UNIT_DEFS[t.type].cls] ?? 1;
    return 1;
  }

  /** harvest multiplier: aura buildings + happiness + upgrades */
  harvestMult(team: Team, x: number, y: number, res: ResKind): number {
    let mult = this.mods[team].harvestMult;
    if (this.stormT > 0) mult *= 0.7;
    const h = this.popularity[team];
    mult *= h >= POP.highAt ? POP.highHarvest : h <= POP.lowAt ? POP.lowHarvest : 1;
    for (const b of this.buildings) {
      if (b.team !== team || !b.built) continue;
      const aura = BUILDING_DEFS[b.type].aura;
      if (!aura || !aura.res.includes(res)) continue;
      const cx = (b.tx + b.w / 2) * TILE;
      const cy = (b.ty + b.h / 2) * TILE;
      if (Math.hypot(cx - x, cy - y) <= aura.radius * TILE) {
        mult *= aura.mult;
        break;
      }
    }
    return mult;
  }

  // ── main tick ──────────────────────────────────────────────────────────────

  private tick(dt: number): void {
    this.tickCount++;
    this.time += dt;
    this.maybeCheckpoint();
    if (this.netMode && this.netQueue.length) {
      const nq = this.netQueue;
      const due = this.netDue;
      due.length = 0;
      for (let i = 0; i < nq.length; i++)
        if (nq[i].i === this.tickCount) due.push(nq[i]);
      if (due.length) {
        let w = 0;
        for (let i = 0; i < nq.length; i++)
          if (nq[i].i !== this.tickCount) nq[w++] = nq[i];
        nq.length = w;
        for (let i = 0; i < due.length; i++)
          this.applyReplayEvent(due[i].ev, due[i].team);
        due.length = 0;
      }
    }
    if (this.replayMode) {
      while (
        this.replayIdx < this.replayEvents.length &&
        this.replayEvents[this.replayIdx].t < this.time
      ) {
        this.applyReplayEvent(this.replayEvents[this.replayIdx++]);
      }
    }
    if (this.fogOn()) {
      this.fogT -= dt;
      if (this.fogT <= 0) {
        this.fogT = 0.2;
        this.refreshVision();
      }
    }
    this.rebuildSpatial();
    this.processPathReqs();

    for (const b of this.buildings) b.builders = 0;
    for (const u of this.units)
      if (u.state === "build") {
        const site = this.buildingById.get(u.taskId);
        if (site) site.builders++;
      }

    // QoL: idle player villagers auto-help unattended construction sites
    this.autoBuildT -= dt;
    if (this.autoBuildT <= 0) {
      this.autoBuildT = 1;
      for (const b of this.buildings) {
        if (b.built || b.builders > 0) continue;
        // in multiplayer every peer must auto-staff BOTH sides identically
        if (!this.netMode && !this.isMine(b.team)) continue;
        this.assignAutoBuilders(b, 2);
      }
    }

    for (const u of this.units) this.updateUnit(u, dt);
    this.separate(dt);
    this.updateProjectiles(dt);
    this.updateBuildings(dt);
    this.updatePopularity(dt);
    if (this.cfg.mode === "campaign") this.updateCampaign(dt);
    else if (this.cfg.mode !== "multiplayer") this.updateEvents(dt);
    if (this.cfg.mode !== "multiplayer") this.ai.update(dt);

    // snapshot-then-iterate: kill/destroy mutate the live lists. The spread
    // copies are kept deliberately — V8's fast path makes [...arr] ~10x
    // cheaper than refilling a reused buffer with push() (measured, see
    // Checkpoint B notes); only the *filter* passes were made allocation-free.
    for (const u of [...this.units]) if (u.hp <= 0) this.killUnit(u);
    for (const b of [...this.buildings])
      if (b.hp <= 0) this.destroyBuilding(b);
    for (const n of [...this.nodes]) if (n.amount <= 0) this.removeNode(n);

    this.updateParticles(dt);
    for (const f of this.floats) {
      f.life -= dt;
      f.y -= 20 * dt;
    }
    if (this.floats.length) this.compact(this.floats, (f) => f.life > 0);

    const cutoff = this.time - 7;
    if (this.messages.length && this.messages[0].born < cutoff) {
      this.compact(this.messages, (m) => m.born >= cutoff);
      this.markHud();
    }

    this.recomputePop();

    // ── mode timers: survival victory & global time limit
    const limit =
      this.cfg.mode === "survival"
        ? (this.cfg.timeLimitMin || 15) * 60
        : this.cfg.timeLimitMin * 60;
    if (limit > 0 && this.time >= limit && this.phase === "playing") {
      if (this.cfg.mode === "survival") {
        this.phase = "victory";
        this.unlock("survivor");
        this.finishRecording();
        this.msg("You endured! The realm survives — VICTORY!", "good");
        sfx.play("victory");
        Game.clearSave();
      } else {
        const score = (t: Team) =>
          this.killsOrLosses(t) * 10 +
          this.popCur[t] * 5 +
          this.teamBuildings(t).length * 20;
        const p = score(0);
        const e = score(1);
        this.phase = p >= e ? "victory" : "defeat";
        this.msg(
          `Time! The crown judges the realms: you ${p} vs ${e} enemy.`,
          p >= e ? "good" : "bad",
        );
        sfx.play(p >= e ? "victory" : "defeat");
        this.finishRecording();
        Game.clearSave();
      }
      this.publish(true);
    }
    this.markHud();
  }

  /** per-minute popularity deltas per factor (also drives the simulation) */
  popFactors(team: Team): PopFactor[] {
    let shrines = 0;
    let inns = 0;
    for (const b of this.buildings) {
      if (b.team !== team || !b.built) continue;
      if (b.type === "shrine") shrines++;
      else if (b.type === "inn") inns++;
    }
    shrines = Math.min(shrines, POP.shrineCap);
    const activeInns = Math.min(
      inns,
      this.famine[team] ? 0 : inns,
    );
    const pop = this.popCur[team];
    const cap = this.popCap[team];
    return [
      { label: "Rations", value: RATIONS[this.ration[team]].pop },
      { label: "Taxes", value: TAXES[this.tax[team]].pop },
      {
        label: "Housing",
        value:
          pop > cap
            ? POP.crowding
            : pop > cap - 2
              ? POP.nearCrowding
              : POP.housingOk,
      },
      { label: "Religion", value: Math.round(shrines * POP.shrinePop * 10) / 10 },
      { label: "Ale & entertainment", value: this.innsActive[team] * POP.innPop },
      {
        label: "Fear",
        value:
          -Math.min(POP.fearCap, this.grief[team] * POP.fearWeight) === 0
            ? 0
            : Math.round(-Math.min(POP.fearCap, this.grief[team] * POP.fearWeight) * 10) / 10,
      },
      ...(this.famine[team] ? [{ label: "Famine!", value: POP.famine }] : []),
    ];
    void activeInns;
  }

  /**
   * Allocation-free mirror of `popFactors()` — same terms, same order, same
   * rounding, so the popularity curve is bit-identical (asserted by
   * scripts/perf-test.ts against the object-returning version).
   */
  popRatePerMin(team: Team): number {
    let shrines = 0;
    for (const b of this.buildings) {
      if (b.team === team && b.built && b.type === "shrine") shrines++;
    }
    shrines = Math.min(shrines, POP.shrineCap);
    const pop = this.popCur[team];
    const cap = this.popCap[team];
    const fearRaw = -Math.min(POP.fearCap, this.grief[team] * POP.fearWeight);
    let sum = RATIONS[this.ration[team]].pop + TAXES[this.tax[team]].pop;
    sum += pop > cap ? POP.crowding : pop > cap - 2 ? POP.nearCrowding : POP.housingOk;
    sum += Math.round(shrines * POP.shrinePop * 10) / 10;
    sum += this.innsActive[team] * POP.innPop;
    sum += fearRaw === 0 ? 0 : Math.round(fearRaw * 10) / 10;
    if (this.famine[team]) sum += POP.famine;
    return sum;
  }

  private updatePopularity(dt: number): void {
    for (const team of [0, 1] as Team[]) {
      this.grief[team] = Math.max(0, this.grief[team] - POP.griefDecay * dt);

      // ── food upkeep: stock → granary reserve → famine
      const upkeep =
        this.popCur[team] *
        POP.upkeepPerHead *
        RATIONS[this.ration[team]].mult *
        (this.cfg.epic ? EPIC.upkeepMult : 1);
      this.famine[team] = false;
      if (upkeep > 0) {
        let need = upkeep * dt;
        const fromStock = Math.min(this.res[team].food, need);
        this.res[team].food -= fromStock;
        need -= fromStock;
        if (need > 0) {
          const fromReserve = Math.min(this.granary[team], need);
          this.granary[team] -= fromReserve;
          need -= fromReserve;
          if (need > 0.0001) this.famine[team] = true;
        }
      }

      // ── granary stocking & inn brewing
      // one pass over the team's buildings (was two filtered scans per tick)
      let hasGranary = false;
      let inns = 0;
      for (const b of this.buildings) {
        if (b.team !== team || !b.built) continue;
        if (b.type === "granary") hasGranary = true;
        else if (b.type === "inn") inns++;
      }
      if (
        hasGranary &&
        this.granary[team] < POP.granaryReserve &&
        this.res[team].food > POP.granaryMinStock
      ) {
        const move = Math.min(
          POP.granaryFillRate * dt,
          POP.granaryReserve - this.granary[team],
          this.res[team].food - POP.granaryMinStock,
        );
        if (move > 0) {
          this.res[team].food -= move;
          this.granary[team] += move;
        }
      }
      let active = 0;
      for (let i = 0; i < inns; i++) {
        if (this.res[team].food > 5) {
          this.res[team].food = Math.max(0, this.res[team].food - POP.innBrew * dt);
          active++;
        }
      }
      this.innsActive[team] = Math.min(active, POP.innCap);

      // ── tax income
      this.res[team].gold +=
        this.popCur[team] * TAXES[this.tax[team]].rate * dt;

      // ── popularity drift from factors (per-minute values)
      const perMin = this.popRatePerMin(team);
      const targetDelta = (perMin / 60) * dt;
      const p = this.popularity[team];
      const np = p + targetDelta;
      this.popularity[team] = Math.max(0, Math.min(100, np));

      // ── population flow: peasants arrive / leave
      this.immT[team] -= dt;
      this.emiT[team] -= dt;
      if (
        this.immT[team] <= 0 &&
        this.popularity[team] >= POP.immigrateAt &&
        this.popCur[team] < this.popCap[team] &&
        this.units.length < EPIC.hardUnitCap &&
        this.res[team].food > 150 &&
        this.phase === "playing"
      ) {
        this.immT[team] = POP.immigrateEvery;
        const k = this.buildingById.get(this.keeps[team]);
        if (k) {
          const u = this.spawnUnit(
            team,
            "villager",
            (k.tx + k.w / 2) * TILE + (this.rnd() - 0.5) * 40,
            (k.ty + k.h + 1) * TILE,
          );
          void u;
          if (this.isMine(team)) {
            this.floatAt((k.tx + k.w / 2) * TILE, (k.ty + k.h) * TILE - 10, "+peasant", "#8ce08a");
            this.msg("A peasant joins your realm, drawn by your fame!", "good");
          }
        }
      }
      if (
        this.emiT[team] <= 0 &&
        this.popularity[team] <= POP.emigrateAt &&
        this.phase === "playing"
      ) {
        this.emiT[team] = POP.emigrateEvery;
        const idle = this.teamUnits(team, "villager").filter(
          (v) => v.state === "idle" || v.state === "harvest",
        );
        if (idle.length > 2) {
          const v = idle[(this.rnd() * idle.length) | 0];
          if (this.isMine(team)) {
            this.floatAt(v.x, v.y - 14, "leaves…", "#ff9d8f");
            this.msg("A peasant abandons your realm in despair…", "bad");
          }
          this.removeUnit(v);
        }
      }
    }
  }

  private recomputePop(): void {
    const c: [number, number] = [0, 0];
    for (const u of this.units) c[u.team] += POP_PER_UNIT;
    this.popCur = c;
    if (c[0] > this.stats.peakPop) this.stats.peakPop = c[0];
    const epic = this.cfg.epic;
    const base = epic ? EPIC.popBase : 8;
    const housePop = epic ? EPIC.housePop : BUILDING_DEFS.house.pop;
    const cap: [number, number] = [base, base];
    for (const b of this.buildings)
      if (b.built && b.type === "house") cap[b.team] += housePop;
    this.popCap = cap;
  }

  // ── spatial hash ───────────────────────────────────────────────────────────

  /**
   * In-place `filter` for hot per-tick lists: identical result and order, but
   * no new array (these lists were the top allocation source at epic scale).
   */
  private compact<T>(arr: T[], keep: (v: T) => boolean): void {
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (keep(v)) arr[w++] = v;
    }
    if (w !== arr.length) arr.length = w;
  }

  private cellKey(wx: number, wy: number): number {
    return (((wy / 64) | 0) << 11) | ((wx / 64) | 0);
  }

  private rebuildSpatial(): void {
    this.cellMap.clear();
    for (const u of this.units) {
      const k = this.cellKey(u.x, u.y);
      let arr = this.cellMap.get(k);
      if (!arr) this.cellMap.set(k, (arr = []));
      arr.push(u.id);
    }
  }

  queryUnits(x: number, y: number, r: number): Unit[] {
    const out: Unit[] = [];
    this.queryUnitsInto(out, x, y, r);
    return out;
  }

  /**
   * Same query, same cell order, no allocation: fills `out` and returns the
   * count. Callers own their buffer (see the q* scratch fields) because these
   * queries nest during combat resolution.
   */
  queryUnitsInto(out: Unit[], x: number, y: number, r: number): number {
    out.length = 0;
    const c0x = Math.floor((x - r) / 64);
    const c1x = Math.floor((x + r) / 64);
    const c0y = Math.floor((y - r) / 64);
    const c1y = Math.floor((y + r) / 64);
    const r2 = (r + 8) * (r + 8);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const arr = this.cellMap.get((cy << 11) | cx);
        if (!arr) continue;
        for (const id of arr) {
          const e = this.byId.get(id);
          if (!e || !isUnit(e)) continue;
          const dx = e.x - x;
          const dy = e.y - y;
          if (dx * dx + dy * dy <= r2) out.push(e);
        }
      }
    }
    return out.length;
  }

  // ── path queue ─────────────────────────────────────────────────────────────

  private processPathReqs(): void {
    let budget = 26;
    while (this.pathReqs.length && budget-- > 0) {
      const req = this.pathReqs.shift()!;
      const e = this.byId.get(req.unitId);
      if (!e || !isUnit(e) || e.hp <= 0) continue;
      this.pathNow(e, req.gx * TILE + 16, req.gy * TILE + 16, req.siege);
    }
    if (this.pathReqs.length > 500)
      this.pathReqs.splice(0, this.pathReqs.length - 500);
  }

  // ── unit update ────────────────────────────────────────────────────────────

  private updateUnit(u: Unit, dt: number): void {
    const def = UNIT_DEFS[u.type];
    const moving =
      u.state === "move" || u.state === "attackMove" || u.state === "attack";
    u.anim += dt * (moving ? 9 : 2.2);
    if (u.atkCd > 0) u.atkCd -= dt;
    if (u.flash > 0) u.flash -= dt;
    u.acqT -= dt;
    u.repathT -= dt;

    // net-displacement watchdog (1s window): immune to separation jitter
    u.wdT -= dt;
    if (u.wdT <= 0) {
      const net = Math.hypot(u.x - u.wdX, u.y - u.wdY);
      let working = false;
      if (
        u.state === "harvest" ||
        u.state === "build" ||
        u.state === "repair"
      ) {
        const task = this.byId.get(u.taskId);
        working = !!task && this.distToEnt(u, task) <= WORK_RANGE;
      }
      if (!working && net < 3 && u.state !== "idle" && u.state !== "attack")
        u.stuckT += 1;
      else u.stuckT = 0;
      u.wdX = u.x;
      u.wdY = u.y;
      u.wdT = 1;
    }
    if (u.stuckT >= 2) {
      {
        u.stuckT = 0;
        u.repathFails++;
        if (u.repathFails > 4) {
          this.giveUp(u);
        } else if (!this.pathNow(u, u.tx, u.ty)) {
          // wedged in a pocket (e.g. between own buildings): snap to the
          // nearest tile that actually has somewhere to step
          const rules = this.unitRules(u);
          const utx = Math.floor(u.x / TILE);
          const uty = Math.floor(u.y / TILE);
          for (let r = 1; r <= 3; r++) {
            const open = this.finder.nearestOpen(utx, uty, r, rules);
            if (open < 0) continue;
            const ox = open % this.grid.w;
            const oy = (open / this.grid.w) | 0;
            let freeNb = 0;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++)
                if (isFinite(rules.tileCost(ox + dx, oy + dy))) freeNb++;
            if (freeNb >= 4) {
              u.x = ox * TILE + TILE / 2;
              u.y = oy * TILE + TILE / 2;
              this.burst(u.x, u.y - 6, "dust", 4, "#c9b98e", 40, 0.4, 2);
              break;
            }
          }
        }
      }
    }
    const stepMoved = Math.hypot(u.x - u.lastX, u.y - u.lastY);
    u.lastX = u.x;
    u.lastY = u.y;

    // dust kicked up while marching on dry ground
    if (stepMoved > 0.6 && this.rnd() < dt * 2.4) {
      const txf = Math.floor(u.x / TILE);
      const tyf = Math.floor(u.y / TILE);
      if (this.grid.inBounds(txf, tyf)) {
        const terr = this.grid.terrain[this.grid.idx(txf, tyf)];
        const dry =
          this.grid.theme === "desert"
            ? terr !== T_WATER_C && terr !== T_OASIS_C
            : terr === T_DIRT_C;
        if (dry)
          this.spawnParticle({
            x: u.x - Math.cos(u.facing) * 5,
            y: u.y + 3,
            vx: (this.rnd() - 0.5) * 8,
            vy: -6,
            life: 0.5,
            size: 1.8,
            color: this.grid.theme === "desert" ? "#d8c09288" : "#b8a47c88",
            kind: "dust",
          });
      }
    }

    switch (u.state) {
      case "idle":
        if (def.military && u.acqT <= 0) {
          u.acqT = 0.35;
          if (!this.acquire(u, this.alarmBoost(u))) this.callToArms(u);
        }
        break;
      case "move":
      case "attackMove": {
        if (u.state === "attackMove" && def.military && u.acqT <= 0) {
          u.acqT = 0.35;
          if (this.acquire(u, 0)) break;
        }
        if (!u.path && u.repathT <= 0) {
          u.repathT = 1.0;
          this.pathNow(u, u.tx, u.ty);
        }
        if (this.followPath(u, dt)) {
          u.state = "idle";
          u.path = null;
        }
        break;
      }
      case "attack":
        this.updateAttack(u, dt);
        break;
      case "harvest":
        this.updateHarvest(u, dt);
        break;
      case "build":
        this.updateBuild(u, dt);
        break;
      case "repair":
        this.updateRepair(u, dt);
        break;
    }
  }

  assignRepair(u: Unit, b: Building): void {
    u.taskId = b.id;
    u.targetId = -1;
    u.state = "repair";
    u.workT = 0;
    u.repathFails = 0;
    this.pathToTarget(u, b);
  }

  private updateRepair(u: Unit, dt: number): void {
    const b = this.buildingById.get(u.taskId);
    if (!b || b.hp >= b.maxHp) {
      u.state = "idle";
      u.taskId = -1;
      return;
    }
    const d = this.distToBuilding(u, b);
    if (d <= WORK_RANGE) {
      u.path = null;
      u.repathFails = 0;
      const p = this.entPos(b);
      u.facing = Math.atan2(p.y - u.y, p.x - u.x);
      u.workT += dt;
      const stoneB = ["wall", "gate", "tower", "keep", "barracks"].includes(b.type);
      const wc = 0.9 * dt;
      const sc = stoneB ? 0.5 * dt : 0.15 * dt;
      const afford = this.res[u.team].wood >= wc && this.res[u.team].stone >= sc;
      const rate = afford ? 26 : 10;
      if (afford) {
        this.res[u.team].wood -= wc;
        this.res[u.team].stone -= sc;
      }
      b.hp = Math.min(b.maxHp, b.hp + rate * dt);
      if (u.workT > 0.8) {
        u.workT = 0;
        this.burst(p.x + (this.rnd() - 0.5) * b.w * TILE * 0.5, p.y, "spark", 1, "#ffd166", 40, 0.3, 1.5);
      }
      if (b.hp >= b.maxHp) {
        u.state = "idle";
        u.taskId = -1;
        if (this.isMine(u.team)) this.floatAt(p.x, p.y - 16, "Repaired", "#8ce08a");
      }
      return;
    }
    if (!u.path && u.repathT <= 0) {
      u.repathT = 1.0;
      u.repathFails++;
      if (u.repathFails > 5) {
        this.giveUp(u);
        return;
      }
      this.pathToTarget(u, b);
    }
    if (this.followPath(u, dt) && this.distToBuilding(u, b) > WORK_RANGE) {
      const p = this.entPos(b);
      const dx = p.x - u.x;
      const dy = p.y - u.y;
      const dd = Math.hypot(dx, dy) || 1;
      this.stepToward(u, dx / dd, dy / dd, UNIT_DEFS[u.type].speed * dt * 0.7);
    }
  }

  private giveUp(u: Unit): void {
    u.path = null;
    u.taskId = -1;
    u.targetId = -1;
    u.state = "idle";
    u.repathFails = 0;
    if (this.isMine(u.team)) this.floatAt(u.x, u.y - 14, "?", "#ffd166");
  }

  /** hard-block check for stepping onto a world position */
  private blockedFor(u: Unit, wx: number, wy: number): boolean {
    const tx = Math.floor(wx / TILE);
    const ty = Math.floor(wy / TILE);
    if (!this.grid.inBounds(tx, ty)) return true;
    const o = this.grid.occ[this.grid.idx(tx, ty)];
    if (o === -1) return true;
    if (o === 0) return false;
    // standing inside an entity's footprint? allow moving within/out of it
    const curTx = Math.floor(u.x / TILE);
    const curTy = Math.floor(u.y / TILE);
    if (
      this.grid.inBounds(curTx, curTy) &&
      this.grid.occ[this.grid.idx(curTx, curTy)] === o
    )
      return false;
    const ent = this.byId.get(o);
    if (!ent) return false;
    if (isNode(ent)) return true;
    if (isUnit(ent)) return false;
    if ((ent.type === "wall" || ent.type === "gate") && ent.team === u.team)
      return false;
    return true;
  }

  private stepToward(u: Unit, nx: number, ny: number, dist: number): void {
    const mx = nx * dist;
    const my = ny * dist;
    const bx = this.blockedFor(u, u.x + mx, u.y);
    const by = this.blockedFor(u, u.x, u.y + my);
    if (!bx) u.x += mx;
    if (!by) u.y += my;
    if (bx && by) {
      // axis-separated collision can freeze diagonal steps even on a valid
      // A* path (unit pressed against a wall edge): slide diagonally if the
      // destination tile itself is free
      if (!this.blockedFor(u, u.x + mx, u.y + my)) {
        u.x += mx;
        u.y += my;
      } else {
        // try sliding along the less-blocked axis with a nudge
        if (!this.blockedFor(u, u.x + mx, u.y + my * 0.2)) {
          u.x += mx;
          u.y += my * 0.2;
        } else if (!this.blockedFor(u, u.x + mx * 0.2, u.y + my)) {
          u.x += mx * 0.2;
          u.y += my;
        }
      }
    }
    u.facing = Math.atan2(ny, nx);
    u.x = Math.max(4, Math.min(MAP_W * TILE - 4, u.x));
    u.y = Math.max(4, Math.min(MAP_H * TILE - 4, u.y));
  }

  private followPath(u: Unit, dt: number): boolean {
    const def = UNIT_DEFS[u.type];
    if (!u.path || u.pathI >= u.path.length) {
      const dx = u.tx - u.x;
      const dy = u.ty - u.y;
      const d = Math.hypot(dx, dy);
      if (d < 7) return true;
      this.stepToward(u, dx / d, dy / d, def.speed * dt);
      return false;
    }
    const wp = u.path[u.pathI];
    const wx = (wp % MAP_W) * TILE + TILE / 2;
    const wy = ((wp / MAP_W) | 0) * TILE + TILE / 2;

    // Enemy wall/gate/building occupying the next waypoint → smash it (military)
    const occId = this.grid.inBounds((wx / TILE) | 0, (wy / TILE) | 0)
      ? this.grid.occ[wp]
      : 0;
    if (occId > 0 && def.military) {
      const ent = this.byId.get(occId);
      if (ent && isBuilding(ent) && ent.team !== u.team) {
        u.targetId = ent.id;
        u.state = "attack";
        const tp = this.entPos(ent);
        u.tx = tp.x;
        u.ty = tp.y;
        return false;
      }
    }

    const dx = wx - u.x;
    const dy = wy - u.y;
    const d = Math.hypot(dx, dy);
    const last = u.pathI === u.path.length - 1;
    if (d < (last ? 8 : 11)) {
      u.pathI++;
      if (u.pathI >= u.path.length) {
        u.path = null;
        return Math.hypot(u.tx - u.x, u.ty - u.y) < 12;
      }
      return false;
    }
    this.stepToward(u, dx / d, dy / d, def.speed * dt);
    return false;
  }

  entPos(t: Ent): { x: number; y: number } {
    if (isNode(t)) return { x: t.tx * TILE + 16, y: t.ty * TILE + 16 };
    if (isUnit(t)) return { x: t.x, y: t.y };
    return { x: (t.tx + t.w / 2) * TILE, y: (t.ty + t.h / 2) * TILE };
  }

  distToEnt(u: Unit, t: Ent): number {
    if (isNode(t)) {
      return (
        Math.hypot(u.x - (t.tx * TILE + 16), u.y - (t.ty * TILE + 16)) - 10
      );
    }
    if (isUnit(t)) {
      return Math.hypot(u.x - t.x, u.y - t.y) - UNIT_DEFS[t.type].radius;
    }
    return this.distToBuilding(u, t);
  }

  distToBuilding(u: Unit, b: Building): number {
    const minX = b.tx * TILE;
    const maxX = (b.tx + b.w) * TILE;
    const minY = b.ty * TILE;
    const maxY = (b.ty + b.h) * TILE;
    const dx = Math.max(minX - u.x, 0, u.x - maxX);
    const dy = Math.max(minY - u.y, 0, u.y - maxY);
    return Math.hypot(dx, dy);
  }

  private updateAttack(u: Unit, dt: number): void {
    const def = UNIT_DEFS[u.type];
    const t0 = this.byId.get(u.targetId);
    if (!t0 || isNode(t0) || t0.hp <= 0) {
      this.onAttackTargetLost(u);
      return;
    }
    const t = t0;
    // While besieging a building, intercept nearby enemy units first
    if (def.military && !def.siegeOnly && isBuilding(t) && u.acqT <= 0) {
      u.acqT = 0.45;
      let bestId = -1;
      let bestD = def.acq;
      const cand = this.qIntercept;
      this.queryUnitsInto(cand, u.x, u.y, def.acq);
      for (let ci = 0; ci < cand.length; ci++) {
        const o = cand[ci];
        if (o.team === u.team || o.hp <= 0) continue;
        const d = Math.hypot(o.x - u.x, o.y - u.y);
        if (d < bestD) {
          bestD = d;
          bestId = o.id;
        }
      }
      if (bestId >= 0) {
        u.siegeResume = t.id;
        u.targetId = bestId;
        const o = this.byId.get(bestId)!;
        const tp = this.entPos(o);
        u.tx = tp.x;
        u.ty = tp.y;
        this.pathNow(u, tp.x, tp.y);
        return;
      }
    }
    const reach =
      this.rangeOf(u) + (isUnit(t) ? UNIT_DEFS[t.type].radius + 4 : 6);
    const d = this.distToEnt(u, t);
    // siege engines keep their distance
    if (def.minRange > 0 && d < def.minRange) {
      const tp = this.entPos(t);
      const dx = u.x - tp.x;
      const dy = u.y - tp.y;
      const dd = Math.hypot(dx, dy) || 1;
      u.path = null;
      this.stepToward(u, dx / dd, dy / dd, def.speed * dt);
      return;
    }
    if (d <= reach) {
      u.path = null;
      const tp = this.entPos(t);
      u.facing = Math.atan2(tp.y - u.y, tp.x - u.x);
      if (u.atkCd <= 0) {
        u.atkCd = def.cd;
        this.fire(u, t);
      }
      return;
    }
    if (!u.path && u.repathT <= 0) {
      u.repathT = 0.6;
      const tp = this.entPos(t);
      u.tx = tp.x;
      u.ty = tp.y;
      this.pathNow(u, tp.x, tp.y);
    }
    this.followPath(u, dt);
  }

  private onAttackTargetLost(u: Unit): void {
    u.targetId = -1;
    if (u.state !== "attack") return;
    // resume a siege we paused to fight defenders
    if (u.siegeResume >= 0) {
      const b0 = this.byId.get(u.siegeResume);
      u.siegeResume = -1;
      const b = b0 && !isNode(b0) ? b0 : null;
      if (b && b.hp > 0) {
        u.targetId = b.id;
        const tp = this.entPos(b);
        u.tx = tp.x;
        u.ty = tp.y;
        this.pathNow(u, tp.x, tp.y);
        return;
      }
    }
    if (u.taskId >= 0) {
      const t = this.byId.get(u.taskId);
      if (t) {
        if (isNode(t)) {
          u.state = "harvest";
          return;
        }
        if (isBuilding(t)) {
          if (!t.built) {
            u.state = "build";
            return;
          }
          if (t.type === "farm") {
            u.state = "harvest";
            return;
          }
        }
      }
    }
    u.taskId = -1;
    if (u.attackMoveResume) {
      u.attackMoveResume = false;
      u.state = "attackMove";
      return;
    }
    u.state = "idle";
  }

  private fire(u: Unit, t: Ent): void {
    const def = UNIT_DEFS[u.type];
    const dmg = Math.max(1, Math.round(this.dmgOf(u) * this.multVs(u, t)));
    if (def.ranged) {
      const rock = u.type === "catapult";
      sfx.play(rock ? "explode" : "arrow");
      if (!rock) this.burst(u.x + Math.cos(u.facing) * 8, u.y - 8, "spark", 1, "#efe3c8", 30, 0.2, 1.2);
      this.projectiles.push({
        x: u.x,
        y: u.y - (rock ? 12 : 8),
        kind: rock ? "rock" : "arrow",
        targetId: t.id,
        team: u.team,
        dmg,
        speed: rock ? 240 : PROJECTILE_SPEED,
      });
    } else {
      const tp = this.entPos(t);
      this.burst(tp.x, tp.y - 8, "spark", 3, "#ffd8a1", 60, 0.3, 1.8);
      sfx.play("hit");
      this.damage(t, dmg, u.team, u.id);
    }
  }

  /** widened acquire radius shortly after a building of this team is hit */
  private alarmBoost(u: Unit): number {
    return this.time - this.alarm[u.team] < 8 ? 420 : 0;
  }

  /** alarm active and an enemy is near our base? march to defend */
  private callToArms(u: Unit): void {
    if (this.time - this.alarm[u.team] >= 8) return;
    const k = this.buildingById.get(this.keeps[u.team]);
    if (!k) return;
    const kp = this.entPos(k);
    if (Math.hypot(u.x - kp.x, u.y - kp.y) > 900) return;
    let best: Unit | null = null;
    let bestD = 520;
    const cand = this.qArms;
    this.queryUnitsInto(cand, kp.x, kp.y, 520);
    for (let ci = 0; ci < cand.length; ci++) {
      const o = cand[ci];
      if (o.team === u.team || o.hp <= 0) continue;
      const d = Math.hypot(o.x - kp.x, o.y - kp.y);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best) {
      u.targetId = best.id;
      u.state = "attack";
      u.repathFails = 0;
      u.siegeResume = -1;
      u.attackMoveResume = false;
      const tp = this.entPos(best);
      u.tx = tp.x;
      u.ty = tp.y;
      this.pathNow(u, tp.x, tp.y);
    }
  }

  private acquire(u: Unit, bonusRange = 0): boolean {
    const def = UNIT_DEFS[u.type];
    if (def.acq <= 0) return false;
    let bestId = -1;
    let bestD = def.acq + bonusRange;
    if (!def.siegeOnly) {
      const cand = this.qAcquire;
      this.queryUnitsInto(cand, u.x, u.y, def.acq);
      for (let ci = 0; ci < cand.length; ci++) {
        const o = cand[ci];
        if (o.team === u.team || o.hp <= 0) continue;
        if (!this.isVisibleTo(u.team, o.x, o.y)) continue;
        const d = Math.hypot(o.x - u.x, o.y - u.y);
        if (d < bestD) {
          bestD = d;
          bestId = o.id;
        }
      }
    }
    if (bestId < 0) {
      for (const b of this.buildings) {
        if (b.team === u.team || !b.built) continue;
        const d = this.distToBuilding(u, b);
        if (d < def.acq * 0.8 && d < bestD) {
          bestD = d;
          bestId = b.id;
        }
      }
    }
    if (bestId >= 0) {
      u.attackMoveResume = u.state === "attackMove";
      u.siegeResume = -1;
      u.targetId = bestId;
      u.state = "attack";
      u.repathFails = 0;
      const t = this.byId.get(bestId)!;
      const tp = this.entPos(t);
      u.tx = tp.x;
      u.ty = tp.y;
      this.pathNow(u, tp.x, tp.y);
      return true;
    }
    return false;
  }

  private updateHarvest(u: Unit, dt: number): void {
    const t = this.byId.get(u.taskId);
    if (!t) {
      u.state = "idle";
      u.taskId = -1;
      return;
    }
    const node = isNode(t) ? t : null;
    const farm =
      !node && isBuilding(t) && t.type === "farm" && t.built ? t : null;
    if (!node && !farm) {
      u.state = "idle";
      u.taskId = -1;
      return;
    }
    const d = this.distToEnt(u, t);
    if (d <= WORK_RANGE) {
      u.path = null;
      u.repathFails = 0;
      const p = this.entPos(t);
      u.facing = Math.atan2(p.y - u.y, p.x - u.x);
      const hdef = node
        ? UNIT_DEFS.villager.harvest[node.kind]!
        : UNIT_DEFS.villager.harvest.farm!;
      u.workT += dt;
      if (u.workT >= hdef.cycle) {
        u.workT -= hdef.cycle;
        const res: ResKind = node ? NODE_DEFS[node.kind].res : "food";
        const gain =
          hdef.yield * this.harvestMult(u.team, u.x, u.y, res);
        this.res[u.team][res] += gain;
        if (this.isMine(u.team)) {
          this.stats.gathered[res] += gain;
          if (this.stats.gathered.wood >= 1000) this.unlock("lumberlord");
        }
        if (node) node.amount -= gain;
        if (this.isMine(u.team)) this.tutSet("gather");
        const pp = this.entPos(t);
        if (res === "wood") {
          this.burst(pp.x, pp.y - 8, "chip", 3, "#8a6a3a", 50, 0.45, 2);
          sfx.play("chop");
        } else if (res === "food") {
          this.burst(pp.x, pp.y - 6, "chip", 2, "#93bf57", 40, 0.4, 1.6);
        } else {
          this.burst(pp.x, pp.y - 8, "chip", 3, res === "gold" ? "#e6b93c" : "#9aa0a8", 50, 0.45, 2);
          sfx.play("mine");
        }
        this.floatAt(
          p.x + (this.rnd() - 0.5) * 10,
          p.y - 16,
          `+${Math.round(gain)}`,
          res === "food"
            ? "#ffd166"
            : res === "wood"
              ? "#a3e07a"
              : res === "stone"
                ? "#cfd4dd"
                : "#ffe08a",
        );
        if (node && node.amount <= 0) {
          this.removeNode(node);
          u.state = "idle";
          u.taskId = -1;
        }
      }
      return;
    }
    if (!u.path && u.repathT <= 0) {
      u.repathT = 1.0;
      u.repathFails++;
      if (u.repathFails > 5) {
        this.giveUp(u);
        return;
      }
      this.pathToTarget(u, t);
    }
    if (this.followPath(u, dt) && this.distToEnt(u, t) > WORK_RANGE) {
      const p = this.entPos(t);
      const dx = p.x - u.x;
      const dy = p.y - u.y;
      const dd = Math.hypot(dx, dy) || 1;
      this.stepToward(u, dx / dd, dy / dd, UNIT_DEFS[u.type].speed * dt * 0.7);
    }
  }

  private updateBuild(u: Unit, dt: number): void {
    const site = this.buildingById.get(u.taskId);
    if (!site) {
      u.state = "idle";
      u.taskId = -1;
      return;
    }
    if (site.built) {
      u.state = "idle";
      u.taskId = -1;
      return;
    }
    const d = this.distToBuilding(u, site);
    if (d <= WORK_RANGE) {
      u.path = null;
      u.repathFails = 0;
      const p = this.entPos(site);
      u.facing = Math.atan2(p.y - u.y, p.x - u.x);
      u.workT += dt;
      site.work -= UNIT_DEFS[u.type].buildRate * dt;
      if (this.rnd() < dt * 2.2) {
        const p = this.entPos(site);
        this.burst(
          p.x + (this.rnd() - 0.5) * site.w * TILE * 0.6,
          p.y + (this.rnd() - 0.5) * site.h * TILE * 0.4,
          "spark",
          1,
          "#ffd166",
          40,
          0.35,
          1.6,
        );
      }
      if (site.work <= 0) this.completeBuilding(site);
      return;
    }
    if (!u.path && u.repathT <= 0) {
      u.repathT = 1.0;
      u.repathFails++;
      if (u.repathFails > 5) {
        this.giveUp(u);
        return;
      }
      this.pathToTarget(u, site);
    }
    if (this.followPath(u, dt) && this.distToBuilding(u, site) > WORK_RANGE) {
      const p = this.entPos(site);
      const dx = p.x - u.x;
      const dy = p.y - u.y;
      const dd = Math.hypot(dx, dy) || 1;
      this.stepToward(u, dx / dd, dy / dd, UNIT_DEFS[u.type].speed * dt * 0.7);
    }
  }

  private completeBuilding(b: Building): void {
    b.built = true;
    b.work = 0;
    b.hp = b.maxHp;
    const p = this.entPos(b);
    this.floatAt(p.x, p.y - 20, "Complete!", "#8ce08a");
    this.burst(p.x, p.y - 10, "spark", 10, "#e8c877", 60, 0.6, 2);
    sfx.play("complete");
    if (this.isMine(b.team)) {
      if (b.type === "house") this.tutSet("house");
      else if (b.type === "farm") this.tutSet("farm");
      else if (b.type === "barracks") this.tutSet("barracks");
      else if (b.type === "wall" || b.type === "gate") this.tutSet("wall");
    }
    for (const u of this.units)
      if (u.taskId === b.id && u.state === "build") {
        u.state = "idle";
        u.taskId = -1;
      }
    this.markHud();
  }

  // ── separation (soft collision between units) ─────────────────────────────

  private separate(dt: number): void {
    const k = Math.min(1, 10 * dt);
    for (const u of this.units) {
      let px = 0;
      let py = 0;
      const near = this.qSeparate;
      this.queryUnitsInto(near, u.x, u.y, 26);
      for (let ni = 0; ni < near.length; ni++) {
        const o = near[ni];
        if (o.id === u.id) continue;
        const dx = u.x - o.x;
        const dy = u.y - o.y;
        const d2 = dx * dx + dy * dy;
        const minD = UNIT_DEFS[u.type].radius + UNIT_DEFS[o.type].radius + 3;
        if (d2 < minD * minD) {
          if (d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = (minD - d) / d;
            px += dx * f;
            py += dy * f;
          } else {
            px += (this.rnd() - 0.5) * 6;
            py += (this.rnd() - 0.5) * 6;
          }
        }
      }
      if (px || py) {
        const nx = u.x + px * k;
        const ny = u.y + py * k;
        if (!this.blockedFor(u, nx, u.y)) u.x = nx;
        if (!this.blockedFor(u, u.x, ny)) u.y = ny;
      }
    }
  }

  // ── combat resolution ──────────────────────────────────────────────────────

  private updateProjectiles(dt: number): void {
    if (!this.projectiles.length) return;
    for (const p of this.projectiles) {
      const t0 = this.byId.get(p.targetId);
      if (!t0 || isNode(t0) || t0.hp <= 0) {
        p.speed = -1;
        continue;
      }
      const t = t0;
      const tp = this.entPos(t);
      const dx = tp.x - p.x;
      const dy = tp.y - 6 - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 10) {
        if (p.kind === "rock") {
          this.burst(tp.x, tp.y - 6, "dust", 10, "#b8ae9a", 70, 0.6, 3);
          this.burst(tp.x, tp.y - 8, "ring", 1, "#ffffff", 0, 0.35, 4);
          this.burst(tp.x, tp.y - 10, "fire", 4, "#ff9a3c", 30, 0.4, 3);
          sfx.play("explode");
        } else {
          this.burst(tp.x, tp.y - 8, "spark", 2, "#efe3c8", 45, 0.25, 1.4);
          sfx.play("hit");
        }
        this.damage(t, p.dmg, p.team, -1);
        if (p.kind === "rock") {
          const def = UNIT_DEFS.catapult;
          const splash = def.splash ?? 45;
          const hit = this.qSplash;
          this.queryUnitsInto(hit, tp.x, tp.y, splash);
          // index loop: damage() can kill, which nests other queries
          for (let hi = 0; hi < hit.length; hi++) {
            const o = hit[hi];
            if (o.team === p.team || o.id === t.id) continue;
            this.damage(o, Math.round(p.dmg * 0.5), p.team, -1);
          }
        }
        p.speed = -1;
        continue;
      }
      p.x += (dx / d) * p.speed * dt;
      p.y += (dy / d) * p.speed * dt;
    }
    this.compact(this.projectiles, (p) => p.speed > 0);
  }

  damage(t: Ent, dmg: number, _attackerTeam: Team, attackerId: number): void {
    if (isNode(t)) return;
    const armor = isUnit(t)
      ? this.armorOf(t)
      : BUILDING_DEFS[t.type].armor;
    t.hp -= Math.max(1, dmg - armor);
    t.flash = 0.12;
    if (isUnit(t)) {
      this.lastCombatPos = { x: t.x, y: t.y, t: this.time };
      if (attackerId >= 0) t.lastAttacker = attackerId;
    }

    if (isBuilding(t)) {
      this.alarm[t.team] = this.time;
      if (this.isMine(t.team) && this.time - this.lastRaidMsg > 12) {
        this.lastRaidMsg = this.time;
        this.msg(
          t.type === "keep"
            ? "Your keep is under attack!"
            : "Your buildings are under attack!",
          "bad",
        );
      }
    }

    if (isUnit(t) && attackerId >= 0) {
      const u = t;
      const aRef = this.byId.get(attackerId);
      const attackerRef = aRef && !isNode(aRef) ? aRef : null;
      if (
        u.state === "idle" ||
        u.state === "harvest" ||
        u.state === "build"
      ) {
        const att = attackerRef;
        if (att && att.hp > 0) {
          const ap = this.entPos(att);
          const near = Math.hypot(ap.x - u.x, ap.y - u.y) < RETALIATE_RANGE;
          // villagers flee military-grade attackers toward their keep
          if (u.type === "villager" && isUnit(att) && UNIT_DEFS[att.type].military) {
            const k = this.buildingById.get(this.keeps[u.team]);
            if (k) {
              u.taskId = -1;
              u.state = "move";
              u.tx = (k.tx + k.w / 2) * TILE;
              u.ty = (k.ty + k.h + 1.5) * TILE;
              this.pathNow(u, u.tx, u.ty);
            }
          } else if (near) {
            u.attackMoveResume = false;
            u.targetId = attackerId;
            u.state = "attack";
            u.repathFails = 0;
            u.tx = ap.x;
            u.ty = ap.y;
            this.pathNow(u, ap.x, ap.y);
          }
        }
      }
      // group aggro: idle military allies nearby join the fight
      if (attackerRef && isUnit(attackerRef)) {
        const allies = this.qAggro;
        this.queryUnitsInto(allies, u.x, u.y, 320);
        for (let ai2 = 0; ai2 < allies.length; ai2++) {
          const o = allies[ai2];
          if (o.team !== u.team || o.id === u.id || o.state !== "idle") continue;
          if (!UNIT_DEFS[o.type].military || UNIT_DEFS[o.type].siegeOnly) continue;
          o.attackMoveResume = false;
          o.siegeResume = -1;
          o.targetId = attackerId;
          o.state = "attack";
          o.repathFails = 0;
          const ap2 = this.entPos(attackerRef);
          o.tx = ap2.x;
          o.ty = ap2.y;
          this.pathNow(o, ap2.x, ap2.y);
        }
      }
    }
  }

  private promote(u: Unit): void {
    const old = u.rank;
    u.rank = u.kills >= 7 ? 2 : u.kills >= 3 ? 1 : 0;
    if (u.rank !== old) {
      const hpGain = u.rank === 2 ? 0.2 : 0.1;
      u.maxHp = Math.round(u.maxHp * (1 + hpGain));
      u.hp = Math.min(u.maxHp, u.hp + u.maxHp * hpGain);
      this.floatAt(
        u.x,
        u.y - 18,
        u.rank === 2 ? "Elite!" : "Veteran!",
        u.rank === 2 ? "#ffd166" : "#8ce08a",
      );
      this.burst(u.x, u.y - 10, "spark", 6, "#ffd166", 50, 0.5, 1.8);
    }
  }

  private killUnit(u: Unit): void {
    if (u.lastAttacker >= 0) {
      const att = this.byId.get(u.lastAttacker);
      if (att && isUnit(att) && att.team !== u.team && att.hp > 0) {
        att.kills++;
        this.promote(att);
      }
    }
    this.burst(u.x, u.y - 6, "dust", 6, this.isMine(u.team) ? "#8fb7ff" : "#ff9d8f", 50, 0.5, 2.4);
    this.burst(u.x, u.y - 6, "smoke", 2, "#55555588", 20, 0.8, 3);
    this.deaths[u.team]++;
    if (this.isMine(u.team)) this.losses++;
    else {
      this.kills++;
      if (this.kills === 1) this.unlock("firstblood");
    }
    this.grief[u.team] += POP.griefUnit;
    this.removeUnit(u);
    this.markHud();
  }

  private destroyBuilding(b: Building): void {
    if (b.team === 1)
      this.destroyedEnemy[b.type] = (this.destroyedEnemy[b.type] ?? 0) + 1;
    const p = this.entPos(b);
    this.floatAt(p.x, p.y - 24, "Destroyed!", "#ff7a5c");
    this.scorches.push({ x: p.x, y: p.y, r: Math.max(b.w, b.h) * TILE * 0.55 });
    this.burst(p.x, p.y - 12, "fire", 14, "#ff9a3c", 60, 0.7, 4);
    this.addShake(b.type === "keep" ? 7 : 5);
    this.burst(p.x, p.y - 14, "smoke", 8, "#44444488", 26, 1.4, 5);
    this.burst(p.x, p.y - 8, "dust", 10, "#8d8578", 80, 0.7, 3);
    this.addShake(4);
    sfx.play("explode");
    this.grief[b.team] += POP.griefBuilding;
    if (this.mission && b.team !== this.myTeam) {
      for (const o of this.objectives) {
        if (o.done) continue;
        if (o.kind === "destroyKeep" && b.type === "keep") o.done = true;
        else if (o.kind === "destroyType" && b.type === o.type)
          o.done = (this.destroyedEnemy[b.type] ?? 0) >= (o.n ?? 1);
      }
    }
    if (b.type === "keep") {
      this.phase = b.team === this.myTeam ? "defeat" : "victory";
      this.finishRecording();
      if (this.phase === "victory") {
        this.unlock("conqueror");
        if (this.grid.theme === "desert") this.unlock("desertlord");
        if (this.losses < 10) this.unlock("untouchable");
      }
      Game.clearSave();
      sfx.play(b.team === 1 ? "victory" : "defeat");
      this.msg(
        b.team === 1
          ? "The enemy keep has fallen — VICTORY!"
          : "Your keep has fallen… DEFEAT",
        b.team === 1 ? "good" : "bad",
      );
    } else if (this.isMine(b.team)) {
      this.msg(`${BUILDING_DEFS[b.type].name} destroyed!`, "bad");
    }
    this.removeBuilding(b);
    this.publish(true);
    this.markHud();
  }

  // ── buildings update (training, research, towers) ─────────────────────────

  private updateBuildings(dt: number): void {
    for (const b of this.buildings) {
      if (b.flash > 0) b.flash -= dt;
      // smoke & flames from heavily damaged buildings
      if (b.built && b.hp < b.maxHp * 0.45) {
        const p = this.entPos(b);
        const intensity = b.hp < b.maxHp * 0.22 ? 2 : 1;
        if (this.rnd() < dt * 4 * intensity)
          this.spawnParticle({
            x: p.x + (this.rnd() - 0.5) * b.w * TILE * 0.5,
            y: p.y - b.h * TILE * 0.3,
            vy: -26,
            vx: (this.rnd() - 0.5) * 10,
            life: 1.8,
            size: 5,
            color: "#2e2e2e",
            kind: "smoke",
          });
        if (intensity === 2 && this.rnd() < dt * 5)
          this.spawnParticle({
            x: p.x + (this.rnd() - 0.5) * b.w * TILE * 0.5,
            y: p.y - b.h * TILE * 0.2,
            vy: -30,
            life: 0.45,
            size: 3.4,
            color: "#ff9a3c",
            kind: "fire",
          });
      }

      // archer tower auto-fire
      if (b.built && b.type === "tower") {
        b.cdT -= dt;
        if (b.cdT <= 0) {
          const m = this.mods[b.team];
          const range = TOWER.range + m.towerRangeAdd;
          const cx = (b.tx + b.w / 2) * TILE;
          const cy = (b.ty + b.h / 2) * TILE;
          let best: Unit | null = null;
          let bestD = range;
          const cand = this.qTower;
          this.queryUnitsInto(cand, cx, cy, range);
          for (let ci = 0; ci < cand.length; ci++) {
            const o = cand[ci];
            if (o.team === b.team || o.hp <= 0) continue;
            const d = Math.hypot(o.x - cx, o.y - cy);
            if (d < bestD) {
              bestD = d;
              best = o;
            }
          }
          if (best) {
            b.cdT = TOWER.cd;
            this.projectiles.push({
              x: cx,
              y: cy - 34,
              kind: "arrow",
              targetId: best.id,
              team: b.team,
              dmg: TOWER.dmg + m.towerDmgAdd,
              speed: PROJECTILE_SPEED,
            });
          } else b.cdT = 0.2;
        }
      }

      // research progress
      if (b.built && b.research) {
        const rid = b.research.id;
        const def = UPGRADES.find((x) => x.id === rid);
        b.research.t += dt;
        if (def && b.research.t >= def.time) {
          const id = b.research.id;
          b.research = null;
          this.applyUpgrade(b.team, id);
          if (this.isMine(b.team)) this.stats.researched++;
          const p = this.entPos(b);
          this.floatAt(p.x, p.y - 22, "Upgrade!", "#e8c877");
          if (this.isMine(b.team))
            this.msg(`${def.name} researched.`, "good");
        }
        this.markHud();
      }

      // training queue
      if (!b.built || !b.queue.length) continue;
      b.queueT += dt;
      const need = this.trainTime(b.team, UNIT_DEFS[b.queue[0]].trainTime);
      if (b.queueT >= need) {
        b.queueT = 0;
        const type = b.queue.shift()!;
        if (this.isMine(b.team))
          this.trainedBy[type] = (this.trainedBy[type] ?? 0) + 1;
        const spot = this.findSpawnSpot(b);
        const u = this.spawnUnit(
          b.team,
          type,
          spot.x * TILE + TILE / 2,
          spot.y * TILE + TILE / 2,
        );
        if (Math.hypot(b.rallyX - u.x, b.rallyY - u.y) > 36) {
          u.tx = b.rallyX;
          u.ty = b.rallyY;
          u.state = "move";
          this.queuePath(u, Math.floor(b.rallyX / TILE), Math.floor(b.rallyY / TILE));
        }
        this.burst(u.x, u.y - 6, "dust", 4, "#c9b98e", 40, 0.4, 2);
        if (this.isMine(b.team)) {
          this.stats.trained++;
          sfx.play("train");
          if (type === "villager") this.tutSet("villager");
          else this.tutSet("military");
          this.markHud();
        }
      }
    }
  }

  findSpawnSpot(b: Building): { x: number; y: number } {
    const rules = this.rulesFor(b.team, "civ");
    const spot = this.findSpotNearBuilding(b, 2, rules);
    if (spot) return spot;
    return { x: b.tx, y: b.ty + b.h };
  }

  // ── campaign ───────────────────────────────────────────────────────────────

  private updateCampaign(dt: number): void {
    const m = this.mission;
    if (!m || this.phase !== "playing") return;
    void dt;
    // scripted events
    while (this.missionEventIdx < m.events.length && m.events[this.missionEventIdx].t <= this.time) {
      const ev = m.events[this.missionEventIdx++];
      if (ev.kind === "msg" && ev.text) this.msg(ev.text, "info");
      else if (ev.kind === "wave") {
        const ek = this.buildingById.get(this.keeps[1]);
        const pk = this.buildingById.get(this.keeps[0]);
        if (ek && pk) {
          const spawned: Unit[] = [];
          for (let i = 0; i < (ev.n ?? 0); i++) {
            const type = ev.types?.[i % ev.types.length] ?? "militia";
            spawned.push(
              this.spawnUnit(1, type, (ek.tx + 1 + (i % 4)) * TILE, (ek.ty + ek.h + 1 + ((i / 4) | 0)) * TILE),
            );
          }
          this.cmdAttackMove(spawned, (pk.tx + pk.w / 2) * TILE, (pk.ty + pk.h + 1) * TILE);
          sfx.play("horn");
          this.msg("Enemy wave incoming!", "bad");
        }
      } else if (ev.kind === "ford") {
        const cy = Math.round(this.grid.h / 2);
        let made = 0;
        for (let y = cy - 1; y <= cy + 1; y++)
          for (let x = 0; x < this.grid.w; x++) {
            const id = this.grid.idx(x, y);
            if (this.grid.terrain[id] === T_WATER_C) {
              this.grid.terrain[id] = T_FORD;
              this.grid.occ[id] = 0;
              made++;
            }
          }
        this.renderer?.reset();
        this.msg(ev.text ?? "A shallow crossing appears!", "good");
        void made;
      } else if (ev.kind === "attrition") {
        for (const o of this.teamUnits(1)) {
          if (!UNIT_DEFS[o.type].military) continue;
          o.hp = Math.max(1, Math.round(o.hp * 0.4));
          this.burst(o.x, o.y - 8, "smoke", 2, "#55555588", 18, 0.8, 3);
        }
        if (ev.text) this.msg(ev.text, "good");
      } else if (ev.kind === "reinforce") {
        const pk = this.buildingById.get(this.keeps[0]);
        if (pk) {
          for (let i = 0; i < (ev.n ?? 0); i++) {
            const type = ev.types?.[i % ev.types.length] ?? "militia";
            const u = this.spawnUnit(0, type, (pk.tx + 1 + i) * TILE, (pk.ty + pk.h + 1) * TILE);
            this.floatAt(u.x, u.y - 14, "reinforcements!", "#8ce08a");
          }
          this.msg("Reinforcements arrive from the homeland!", "good");
        }
      }
    }
    // objective progress
    let allDone = true;
    for (const o of this.objectives) {
      if (o.done) continue;
      let done = false;
      switch (o.kind) {
        case "destroyKeep":
          done = !this.buildingById.has(this.keeps[1]);
          break;
        case "destroyType":
          done = (this.destroyedEnemy[o.type as BuildingType] ?? 0) >= (o.n ?? 1);
          break;
        case "build":
          done = this.teamBuildings(0, o.type as BuildingType).filter((b) => b.built).length >= (o.n ?? 1);
          break;
        case "train":
          done = (this.trainedBy[o.type as UnitType] ?? 0) >= (o.n ?? 1);
          break;
        case "gather":
          done = this.stats.gathered[o.res as ResKind] >= (o.n ?? 1);
          break;
        case "kill":
          done = this.kills >= (o.n ?? 1);
          break;
        case "survive":
          done = this.time >= (o.n ?? 0);
          break;
      }
      if (done) {
        o.done = true;
        this.msg(`Objective complete: ${o.label}`, "good");
        sfx.play("complete");
        this.markHud();
      } else if (o.primary) allDone = false;
      if (!o.primary && !done) { /* optional */ }
    }
    if (allDone && this.objectives.some((o) => o.primary)) {
      this.phase = "victory";
      this.msg(`Mission complete: ${m.name}`, "good");
      sfx.play("victory");
      setCampaignProgress(Math.max(campaignProgressNow(), m.id + 1));
      this.finishRecording();
      Game.clearSave();
      this.publish(true);
    }
  }

  // ── fog of war ─────────────────────────────────────────────────────────────

  fogOn(): boolean {
    return this.settings.fog;
  }

  private visionRadius(u: Unit): number {
    const base =
      u.type === "villager" ? 5 : u.type === "archer" ? 8 : u.type === "catapult" ? 6 : 7;
    return base;
  }

  private stampVision(arr: Uint8Array, cx: number, cy: number, r: number): void {
    const w = this.grid.w;
    const h = this.grid.h;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) arr[y * w + x] = 1;
      }
    }
  }

  refreshVision(): void {
    if (!this.fogOn()) return;
    const v0 = this.visible[0];
    const v1 = this.visible[1];
    v0.fill(0);
    v1.fill(0);
    for (const u of this.units) {
      const r = this.visionRadius(u);
      this.stampVision(u.team === 0 ? v0 : v1, u.x / TILE, u.y / TILE, r);
    }
    for (const b of this.buildings) {
      const r =
        b.type === "keep" ? 10 : b.type === "tower" ? 9 : b.built ? 4 : 3;
      const cx = b.tx + b.w / 2;
      const cy = b.ty + b.h / 2;
      this.stampVision(b.team === 0 ? v0 : v1, cx, cy, r);
    }
    const e0 = this.explored[0];
    const e1 = this.explored[1];
    for (let i = 0; i < v0.length; i++) {
      if (v0[i]) e0[i] = 1;
      if (v1[i]) e1[i] = 1;
    }
    this.fogVersion++;
  }

  isVisibleTo(team: Team, wx: number, wy: number): boolean {
    if (!this.fogOn()) return true;
    const tx = Math.floor(wx / TILE);
    const ty = Math.floor(wy / TILE);
    if (!this.grid.inBounds(tx, ty)) return false;
    return this.visible[team][ty * this.grid.w + tx] === 1;
  }

  isExplored(team: Team, wx: number, wy: number): boolean {
    if (!this.fogOn()) return true;
    const tx = Math.floor(wx / TILE);
    const ty = Math.floor(wy / TILE);
    if (!this.grid.inBounds(tx, ty)) return false;
    return this.explored[team][ty * this.grid.w + tx] === 1;
  }

  cycleFormation(): void {
    if (this.relay) {
      this.emitNet({ t: 0, k: "form", v: (this.formation + 1) % 3 });
      return;
    }
    this.formation = (this.formation + 1) % 3;
    this.record({ t: this.time, k: "form", v: this.formation });
    this.msg(
      `Formation: ${["loose", "line", "column"][this.formation]}`,
      "info",
    );
    this.publish(true);
  }

  // ── random events ──────────────────────────────────────────────────────────

  private updateEvents(dt: number): void {
    if (this.stormT > 0) this.stormT -= dt;
    if (this.phase !== "playing" || this.cfg.mode === "sandbox") return;
    this.eventT -= dt;
    if (this.eventT > 0 || this.time < 240) return;
    this.eventT = 100 + this.rnd() * 70;
    const roll = this.rnd();
    if (roll < 0.18) {
      this.res[0].gold += 60;
      this.msg("A merchant caravan pays tribute: +60 gold.", "good");
    } else if (roll < 0.34) {
      this.res[0].food += 80;
      this.msg("A bountiful harvest: +80 food.", "good");
    } else if (roll < 0.5) {
      const k = this.buildingById.get(this.keeps[0]);
      if (k && this.popCur[0] < this.popCap[0]) {
        for (let i = 0; i < 2; i++)
          this.spawnUnit(
            0,
            "villager",
            (k.tx + 2 + i) * TILE,
            (k.ty + k.h + 1) * TILE,
          );
        this.msg("Refugees seek your protection: +2 villagers.", "good");
      }
    } else if (roll < 0.66) {
      // wildfire: burn a random tree cluster
      let burned = 0;
      for (let i = 0; i < this.nodes.length && burned < 7; i++) {
        const n = this.nodes[(this.rnd() * this.nodes.length) | 0];
        if (n.kind !== "tree" || n.amount <= 0) continue;
        const p = this.entPos(n);
        this.burst(p.x, p.y - 8, "fire", 6, "#ff9a3c", 40, 0.6, 3);
        this.burst(p.x, p.y - 10, "smoke", 3, "#2e2e2e", 20, 1.2, 4);
        n.amount = 0;
        burned++;
      }
      if (burned) this.msg("Wildfire! A grove burns to ash.", "bad");
    } else if (roll < 0.84 && this.time > 300) {
      // bandits raid a gathering spot
      const gatherers = this.teamUnits(0, "villager").filter(
        (v) => v.state === "harvest",
      );
      if (gatherers.length) {
        const v = gatherers[(this.rnd() * gatherers.length) | 0];
        for (let i = 0; i < 3; i++) {
          const b = this.spawnUnit(1, "militia", v.x + 60 + i * 18, v.y + 40);
          b.raid = this.time + 30;
          this.cmdAttack([b], v.id);
        }
        this.msg("Bandits raid your gatherers!", "bad");
        sfx.play("horn");
      }
    } else {
      this.stormT = 45;
      this.msg("A storm rolls in — gathering slowed for 45s.", "bad");
    }
    this.markHud();
  }

  // ── particles ──────────────────────────────────────────────────────────────

  private particleTick = 0;

  spawnParticle(p: Partial<Particle> & { x: number; y: number }): void {
    if (!this.settings.particles) return;
    this.particleTick++;
    if (this.settings.quality === 0 && this.particleTick % 2 === 0) return;
    if (this.settings.reducedFx && this.particleTick % 2 === 0) return;
    // budget comes from the adaptive governor (presentation-only; this path
    // must never consume the deterministic RNG — burst() already has)
    if (this.particles.length >= this.perf.state.particleCap) return;
    const life = p.life ?? 0.6;
    this.particles.push({
      vx: 0,
      vy: 0,
      size: 2,
      color: "#ffffff",
      kind: "spark",
      ...p,
      life,
      maxLife: life,
    });
  }

  burst(
    x: number,
    y: number,
    kind: Particle["kind"],
    n: number,
    color: string,
    speed = 40,
    life = 0.5,
    size = 2,
  ): void {
    for (let i = 0; i < n; i++) {
      const a = this.rnd() * Math.PI * 2;
      const v = speed * (0.4 + this.rnd() * 0.8);
      this.spawnParticle({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - (kind === "smoke" || kind === "fire" ? 26 : 0),
        life: life * (0.6 + this.rnd() * 0.7),
        size: size * (0.7 + this.rnd() * 0.7),
        color,
        kind,
      });
    }
  }

  private updateParticles(dt: number): void {
    if (!this.particles.length) return;
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "smoke") {
        p.vy -= 14 * dt;
        p.vx *= 1 - 0.6 * dt;
        p.size += 6 * dt;
      } else if (p.kind === "fire") {
        p.vy -= 34 * dt;
        p.size *= 1 - 1.4 * dt;
      } else if (p.kind === "chip" || p.kind === "dust") {
        p.vy += 90 * dt;
      } else if (p.kind === "ring") {
        p.size += 90 * dt;
      } else {
        p.vy += 60 * dt;
      }
    }
    this.compact(this.particles, (p) => p.life > 0 && p.size > 0.2);
  }

  static readonly ACHIEVEMENTS: Array<{ id: string; name: string; desc: string }> = [
    { id: "firstblood", name: "First Blood", desc: "Slay your first enemy soldier." },
    { id: "masterbuilder", name: "Master Builder", desc: "Raise 10 buildings in one match." },
    { id: "lumberlord", name: "Lumber Lord", desc: "Gather 1000 wood in one match." },
    { id: "conqueror", name: "Conqueror", desc: "Win a match." },
    { id: "desertlord", name: "Desert Lord", desc: "Win on a desert map." },
    { id: "untouchable", name: "Untouchable", desc: "Win with fewer than 10 losses." },
    { id: "survivor", name: "Unbroken", desc: "Win a Survival match." },
  ];

  unlock(id: string): void {
    if (this.netMode) return;
    if (this.achievements.includes(id)) return;
    this.achievements.push(id);
    try {
      if (typeof localStorage !== "undefined") {
        const key = "castle-dominion-achievements";
        const all = JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
        if (!all.includes(id)) {
          all.push(id);
          localStorage.setItem(key, JSON.stringify(all));
        }
      }
    } catch {
      /* ignore */
    }
    const def = Game.ACHIEVEMENTS.find((a) => a.id === id);
    if (def) {
      this.msg(`Achievement: ${def.name} — ${def.desc}`, "good");
      sfx.play("complete");
    }
    this.markHud();
  }

  private tutSet(key: keyof TutorialFlags): void {
    if (this.tut[key]) return;
    this.tut[key] = true;
    this.markHud();
    if (Object.values(this.tut).every(Boolean))
      this.msg("Tutorial complete — the realm is in your hands!", "good");
  }

  // ── floats ─────────────────────────────────────────────────────────────────

  floatAt(x: number, y: number, text: string, color: string): void {
    if (this.floats.length > 120) this.floats.shift();
    this.floats.push({ x, y, text, color, life: 1.1, maxLife: 1.1 });
  }

  // ── input ──────────────────────────────────────────────────────────────────

  private bindInput(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof WindowEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() =>
        target.removeEventListener(type, fn as EventListener, opts),
      );
    };

    on(canvas, "contextmenu", (e) => (e as MouseEvent).preventDefault());

    // double-click: focus the camera on the clicked spot (premium RTS feel)
    on(canvas, "dblclick", (e) => {
      const ev = e as MouseEvent;
      if (this.phase !== "playing" || this.replayMode) return;
      const rect = canvas.getBoundingClientRect();
      const w = this.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      this.camTarget = this.clampCamPoint(w);
    });

    on(canvas, "mousedown", (e) => {
      const ev = e as MouseEvent;
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      this.mouse.x = sx;
      this.mouse.y = sy;
      if (this.phase !== "playing" || this.replayMode) return;
      if (ev.button === 1) {
        this.panDrag = { x: sx, y: sy, cx: this.cam.x, cy: this.cam.y };
        ev.preventDefault();
        return;
      }
      if (ev.button === 2) {
        if (this.placement) {
          this.setPlacement(null);
          return;
        }
        const w = this.screenToWorld(sx, sy);
        this.rightClickCommand(w.x, w.y);
        this.publish(true);
        return;
      }
      if (ev.button === 0) {
        if (this.placement) {
          if (this.placement === "wall" || this.placement === "gate") {
            this.wallDragging = true;
            this.updatePlaceTiles(sx, sy);
          } else {
            this.tryPlaceAtCursor(sx, sy);
          }
          return;
        }
        if (this.attackMoveMode) {
          const w = this.screenToWorld(sx, sy);
          const sel = this.selUnits();
          if (sel.length) this.cmdAttackMove(sel, w.x, w.y);
          this.attackMoveMode = false;
          this.markHud();
          return;
        }
        this.clickAnchor = { x: sx, y: sy };
        this.dragSel = { x0: sx, y0: sy, x1: sx, y1: sy };
      }
    });

    on(window, "mousemove", (e) => {
      const ev = e as MouseEvent;
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      this.mouse.x = sx;
      this.mouse.y = sy;
      // hovering a real HUD control must never trigger edge-scroll
      const overHud =
        ev.target instanceof Element &&
        ev.target !== canvas &&
        ev.target.closest("[data-hud]") !== null;
      this.mouse.inCanvas =
        !overHud &&
        sx >= -40 && sy >= -40 && sx <= rect.width + 40 && sy <= rect.height + 40;
      if (this.panDrag) {
        this.camTarget = null;
        this.cam.x = this.panDrag.cx - (sx - this.panDrag.x) / this.cam.zoom;
        this.cam.y = this.panDrag.cy - (sy - this.panDrag.y) / this.cam.zoom;
        this.clampCam();
        return;
      }
      if (this.wallDragging && (this.placement === "wall" || this.placement === "gate")) {
        this.updatePlaceTiles(sx, sy);
        return;
      }
      if (this.clickAnchor && this.dragSel) {
        this.dragSel.x1 = sx;
        this.dragSel.y1 = sy;
      }
    });

    on(window, "mouseup", (e) => {
      const ev = e as MouseEvent;
      if (ev.button === 1) {
        this.panDrag = null;
        return;
      }
      if (ev.button !== 0) return;
      if (this.wallDragging) {
        this.wallDragging = false;
        this.commitWallDrag();
        return;
      }
      if (!this.clickAnchor || !this.dragSel) return;
      const dx = this.dragSel.x1 - this.dragSel.x0;
      const dy = this.dragSel.y1 - this.dragSel.y0;
      const isDrag = Math.hypot(dx, dy) > 7;
      if (this.phase === "playing") {
        if (isDrag) this.boxSelect(this.dragSel, ev.shiftKey);
        else this.clickSelect(this.dragSel.x0, this.dragSel.y0, ev.shiftKey);
      }
      this.clickAnchor = null;
      this.dragSel = null;
      this.publish(true);
    });

    on(
      canvas,
      "wheel",
      (e) => {
        const ev = e as WheelEvent;
        ev.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const before = this.screenToWorld(sx, sy);
        this.camTarget = null;
        const f = 0.08 + 0.1 * this.settings.zoomSpeed;
        const factor = ev.deltaY > 0 ? 1 / (1 + f) : 1 + f;
        this.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomTarget * factor));
        const after = this.screenToWorld(sx, sy);
        this.cam.x += before.x - after.x;
        this.cam.y += before.y - after.y;
        this.clampCam();
      },
      { passive: false },
    );

    on(window, "keydown", (e) => {
      const ev = e as KeyboardEvent;
      const k = ev.key.toLowerCase();
      this.keys.add(k);
      if (this.phase !== "playing" || this.replayMode) return;
      if (k === "escape") {
        if (this.placement) this.setPlacement(null);
        else if (this.attackMoveMode) {
          this.attackMoveMode = false;
          this.markHud();
        } else this.clearSelection();
      } else if (k === "a" && !ev.repeat) {
        if (this.selUnits().some((u) => UNIT_DEFS[u.type].military)) {
          this.attackMoveMode = !this.attackMoveMode;
          this.markHud();
        }
      } else if (k === "s" && !ev.repeat) {
        this.cmdStop(this.selUnits());
      } else if (k === "h" && !ev.repeat) {
        this.selectIdleVillagers();
      } else if (k === " " && !ev.repeat) {
        ev.preventDefault();
        this.centerOnSelection();
      } else if (k === "f" && !ev.repeat) {
        this.focusSelection();
      } else if (k === "home" && !ev.repeat) {
        this.fitKingdom();
      } else if ((k === "+" || k === "=") && !ev.repeat) {
        this.zoomBy(1.18);
      } else if (k === "-" && !ev.repeat) {
        this.zoomBy(1 / 1.18);
      } else if (k === "m" && !ev.repeat) {
        this.toggleMute();
      } else if (k === "z" && !ev.repeat) {
        if (this.renderer?.kind === "3d")
          (this.renderer as Renderer3D).rotateCamera(-1);
      } else if (k === "x" && !ev.repeat) {
        if (this.renderer?.kind === "3d")
          (this.renderer as Renderer3D).rotateCamera(1);
      } else if (k === "v" && !ev.repeat) {
        this.cycleFormation();
      } else if (k === "tab" && !ev.repeat) {
        ev.preventDefault();
        this.selectIdleVillagers();
      } else if (k === "f2" && !ev.repeat) {
        this.togglePause();
      } else if (!ev.repeat && k >= "1" && k <= "5" && (ev.ctrlKey || ev.metaKey)) {
        const gi = parseInt(k, 10) - 1;
        this.groups[gi] = [...this.selection];
        this.floatAt(this.cam.x, this.cam.y - 40, `Group ${gi + 1} set`, "#8ce08a");
      } else if (!ev.repeat && k >= "1" && k <= "5" && !ev.ctrlKey && !ev.metaKey) {
        const gi = parseInt(k, 10) - 1;
        const ids = this.groups[gi].filter((id) => {
          const e2 = this.byId.get(id);
          return e2 && isUnit(e2) && this.isMine((e2 as Unit).team);
        });
        if (ids.length) {
          if (!ev.shiftKey) this.deselectAllUnits();
          for (const id of ids) {
            this.selection.add(id);
            const e2 = this.byId.get(id);
            if (e2 && isUnit(e2)) (e2 as Unit).selected = true;
          }
          this.selectedBuilding = -1;
          this.centerOnSelection();
          this.publish(true);
        }
      } else if (!ev.repeat) {
        const bi = BUILD_LETTER_KEYS.indexOf(k);
        const bt = bi >= 0 ? BUILD_ORDER_KEYS[bi] : undefined;
        if (bt) this.setPlacement(bt);
      }
    });

    on(window, "keyup", (e) => {
      this.keys.delete((e as KeyboardEvent).key.toLowerCase());
    });

    on(window, "blur", () => this.keys.clear());

    // ── touch: tap select, drag box, long-press command, two-finger pan/pinch
    const touches = new Map<number, { x: number; y: number }>();
    let lpTimer: ReturnType<typeof setTimeout> | null = null;
    let lpFired = false;
    let pinch: { d: number; zoom: number; mx: number; my: number } | null = null;
    const pos = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    on(canvas, "pointerdown", (e) => {
      const ev = e as PointerEvent;
      if (ev.pointerType !== "touch" || this.replayMode) return;
      ev.preventDefault();
      const p = pos(ev);
      touches.set(ev.pointerId, p);
      if (touches.size === 2) {
        if (lpTimer) clearTimeout(lpTimer);
        lpTimer = null;
        this.dragSel = null;
        this.clickAnchor = null;
        const [a, b] = [...touches.values()];
        pinch = {
          d: Math.hypot(a.x - b.x, a.y - b.y),
          zoom: this.cam.zoom,
          mx: (a.x + b.x) / 2,
          my: (a.y + b.y) / 2,
        };
        return;
      }
      if (touches.size === 1) {
        lpFired = false;
        this.clickAnchor = { x: p.x, y: p.y };
        this.dragSel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        lpTimer = setTimeout(() => {
          lpFired = true;
          this.dragSel = null;
          this.clickAnchor = null;
          const w = this.screenToWorld(p.x, p.y);
          this.rightClickCommand(w.x, w.y);
          this.publish(true);
        }, 480);
      }
    });
    on(window, "pointermove", (e) => {
      const ev = e as PointerEvent;
      if (ev.pointerType !== "touch") return;
      const cur = touches.get(ev.pointerId);
      if (!cur) return;
      const p = pos(ev);
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (pinch.d > 10) {
          this.zoomTarget = Math.max(
            ZOOM_MIN,
            Math.min(ZOOM_MAX, pinch.zoom * (d / pinch.d)),
          );
          this.cam.zoom = this.zoomTarget;
        }
        this.cam.x -= (mx - pinch.mx) / this.cam.zoom;
        this.cam.y -= (my - pinch.my) / this.cam.zoom;
        pinch.mx = mx;
        pinch.my = my;
        pinch.d = d;
        this.clampCam();
        touches.set(ev.pointerId, p);
        return;
      }
      touches.set(ev.pointerId, p);
      if (Math.hypot(p.x - cur.x, p.y - cur.y) > 12 && lpTimer) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
      if (this.dragSel && this.clickAnchor) {
        this.dragSel.x1 = p.x;
        this.dragSel.y1 = p.y;
      }
    });
    const endTouch = (e: Event) => {
      const ev = e as PointerEvent;
      if (ev.pointerType !== "touch") return;
      const had = touches.delete(ev.pointerId);
      if (lpTimer) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
      if (pinch && touches.size < 2) pinch = null;
      if (!had || lpFired) {
        lpFired = false;
        return;
      }
      if (this.dragSel && this.clickAnchor) {
        const dx = this.dragSel.x1 - this.dragSel.x0;
        const dy = this.dragSel.y1 - this.dragSel.y0;
        if (Math.hypot(dx, dy) > 10) this.boxSelect(this.dragSel, false);
        else this.clickSelect(this.dragSel.x0, this.dragSel.y0, false);
        this.dragSel = null;
        this.clickAnchor = null;
        this.publish(true);
      }
    };
    on(window, "pointerup", endTouch);
    on(window, "pointercancel", endTouch);
  }

  private updateCameraPan(dt: number): void {
    // smooth zoom easing
    if (Math.abs(this.zoomTarget - this.cam.zoom) > 0.002) {
      const wk = this.settings.cameraSmoothing
        ? Math.min(1, 14 * dt * this.settings.zoomSpeed)
        : 1;
      const before = { x: this.cam.x, y: this.cam.y };
      this.cam.zoom += (this.zoomTarget - this.cam.zoom) * wk;
      // keep the world point under the screen center stable while easing
      void before;
      this.clampCam();
    }
    // smooth glide toward a camera target (minimap / Space / F)
    if (this.camTarget) {
      const k = this.settings.cameraSmoothing ? Math.min(1, 10 * dt) : 1;
      this.cam.x += (this.camTarget.x - this.cam.x) * k;
      this.cam.y += (this.camTarget.y - this.cam.y) * k;
      if (
        Math.hypot(this.camTarget.x - this.cam.x, this.camTarget.y - this.cam.y) <
        8
      )
        this.camTarget = null;
      this.clampCam();
    }
    let dx = 0;
    let dy = 0;
    if (this.keys.has("arrowup")) dy -= 1;
    if (this.keys.has("arrowdown")) dy += 1;
    if (this.keys.has("arrowleft")) dx -= 1;
    if (this.keys.has("arrowright")) dx += 1;

    this.edgePan.dx = 0;
    this.edgePan.dy = 0;
    if (this.mouse.inCanvas && this.phase === "playing" && !this.panDrag) {
      const m = 12;
      if (this.mouse.x < m) this.edgePan.dx = -1;
      else if (this.mouse.x > this.viewW - m) this.edgePan.dx = 1;
      if (this.mouse.y < m) this.edgePan.dy = -1;
      else if (this.mouse.y > this.viewH - m) this.edgePan.dy = 1;
    }
    dx += this.edgePan.dx;
    dy += this.edgePan.dy;
    if (dx || dy) {
      this.camTarget = null;
      const sp = (780 * this.settings.panSpeed) / this.cam.zoom;
      const len = Math.hypot(dx, dy) || 1;
      this.cam.x += (dx / len) * sp * dt;
      this.cam.y += (dy / len) * sp * dt;
      this.clampCam();
    }
  }

  clampCam(): void {
    const hw = this.viewW / 2 / this.cam.zoom;
    const hh = this.viewH / 2 / this.cam.zoom;
    const ww = MAP_W * TILE;
    const wh = MAP_H * TILE;
    this.cam.x = ww / 2 < hw ? ww / 2 : Math.max(hw, Math.min(ww - hw, this.cam.x));
    this.cam.y = wh / 2 < hh ? wh / 2 : Math.max(hh, Math.min(wh - hh, this.cam.y));
  }

  /** clamp a world point into the region the camera can actually reach */
  clampCamPoint(p: { x: number; y: number }): { x: number; y: number } {
    const hw = this.viewW / 2 / this.cam.zoom;
    const hh = this.viewH / 2 / this.cam.zoom;
    const ww = MAP_W * TILE;
    const wh = MAP_H * TILE;
    return {
      x: ww / 2 < hw ? ww / 2 : Math.max(hw, Math.min(ww - hw, p.x)),
      y: wh / 2 < hh ? wh / 2 : Math.max(hh, Math.min(wh - hh, p.y)),
    };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewW / 2) / this.cam.zoom + this.cam.x,
      y: (sy - this.viewH / 2) / this.cam.zoom + this.cam.y,
    };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.cam.x) * this.cam.zoom + this.viewW / 2,
      y: (wy - this.cam.y) * this.cam.zoom + this.viewH / 2,
    };
  }

  resize(w: number, h: number, dpr: number): void {
    this.viewW = w;
    this.viewH = h;
    this.renderer?.resize(w, h, dpr);
    this.clampCam();
  }

  // ── selection ─────────────────────────────────────────────────────────────

  selUnits(): Unit[] {
    const out: Unit[] = [];
    for (const id of this.selection) {
      const e = this.byId.get(id);
      if (e && isUnit(e) && this.isMine(e.team)) out.push(e);
    }
    return out;
  }

  clearSelection(): void {
    for (const id of this.selection) {
      const e = this.byId.get(id);
      if (e && isUnit(e)) e.selected = false;
    }
    this.selection.clear();
    this.selectedBuilding = -1;
    this.markHud();
    this.publish(true);
  }

  private pickUnitAt(wx: number, wy: number, team?: Team): Unit | null {
    let best: Unit | null = null;
    let bestD = 18 / this.cam.zoom + 8;
    for (const u of this.queryUnits(wx, wy, bestD)) {
      if (team !== undefined && u.team !== team) continue;
      if (!this.isMine(u.team) && !this.isVisibleTo(this.myTeam, u.x, u.y)) continue;
      const d = Math.hypot(u.x - wx, u.y - wy);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private deselectAllUnits(): void {
    for (const id of this.selection) {
      const e = this.byId.get(id);
      if (e && isUnit(e)) e.selected = false;
    }
    this.selection.clear();
    this.selectedBuilding = -1;
  }

  private clickSelect(sx: number, sy: number, shift: boolean): void {
    const w = this.screenToWorld(sx, sy);
    const txf = Math.floor(w.x / TILE);
    const tyf = Math.floor(w.y / TILE);
    const tile = tyf * MAP_W + txf;
    const u = this.pickUnitAt(w.x, w.y, this.myTeam);
    const now = performance.now();
    const dbl =
      now - this.lastClickTime < 320 && this.lastClickTile === tile && !!u;
    this.lastClickTime = now;
    this.lastClickTile = tile;

    if (!shift) this.deselectAllUnits();

    if (dbl && u) {
      const b = this.viewBounds();
      for (const o of this.units) {
        if (!this.isMine(o.team) || o.type !== u.type) continue;
        if (o.x >= b.x0 && o.x <= b.x1 && o.y >= b.y0 && o.y <= b.y1) {
          this.selection.add(o.id);
          o.selected = true;
        }
      }
      return;
    }

    if (u) {
      if (shift && this.selection.has(u.id)) {
        this.selection.delete(u.id);
        u.selected = false;
      } else {
        this.selection.add(u.id);
        u.selected = true;
      }
      return;
    }

    if (this.grid.inBounds(txf, tyf)) {
      const occId = this.grid.occ[this.grid.idx(txf, tyf)];
      if (occId > 0) {
        const ent = this.byId.get(occId);
        if (ent && isBuilding(ent) && this.isMine(ent.team)) {
          this.selectedBuilding = ent.id;
        }
      }
    }
  }

  private boxSelect(
    rect: { x0: number; y0: number; x1: number; y1: number },
    shift: boolean,
  ): void {
    const a = this.screenToWorld(
      Math.min(rect.x0, rect.x1),
      Math.min(rect.y0, rect.y1),
    );
    const b = this.screenToWorld(
      Math.max(rect.x0, rect.x1),
      Math.max(rect.y0, rect.y1),
    );
    if (!shift) this.deselectAllUnits();
    for (const u of this.units) {
      if (!this.isMine(u.team)) continue;
      if (u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y) {
        this.selection.add(u.id);
        u.selected = true;
      }
    }
  }

  viewBounds(): { x0: number; y0: number; x1: number; y1: number } {
    const a = this.screenToWorld(0, 0);
    const b = this.screenToWorld(this.viewW, this.viewH);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }

  centerOnSelection(): void {
    const sel = this.selUnits();
    if (sel.length) {
      let x = 0;
      let y = 0;
      for (const u of sel) {
        x += u.x;
        y += u.y;
      }
      this.cam.x = x / sel.length;
      this.cam.y = y / sel.length;
    } else if (this.selectedBuilding >= 0) {
      const b = this.buildingById.get(this.selectedBuilding);
      if (b) {
        const p = this.entPos(b);
        this.cam.x = p.x;
        this.cam.y = p.y;
      }
    }
    this.clampCam();
  }

  /** smooth camera glide onto the current selection (F key / HUD button) */
  focusSelection(): void {
    const sel = this.selUnits();
    if (sel.length) {
      let x = 0;
      let y = 0;
      for (const u of sel) {
        x += u.x;
        y += u.y;
      }
      this.camTarget = { x: x / sel.length, y: y / sel.length };
      return;
    }
    if (this.selectedBuilding >= 0) {
      const b = this.buildingById.get(this.selectedBuilding);
      if (b) {
        const p = this.entPos(b);
        this.camTarget = { x: p.x, y: p.y };
        return;
      }
    }
    // no selection → fall back to the most recent combat (last 20 s)
    if (this.lastCombatPos && this.time - this.lastCombatPos.t < 20)
      this.camTarget = { x: this.lastCombatPos.x, y: this.lastCombatPos.y };
  }

  /** multiplicative zoom step used by the +/- HUD buttons and keys */
  zoomBy(f: number): void {
    this.camTarget = null;
    this.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomTarget * f));
  }

  /** zoom out until the whole kingdom fits the viewport (Home key) */
  fitKingdom(): void {
    const z = Math.min(
      this.viewW / (MAP_W * TILE),
      this.viewH / (MAP_H * TILE),
    );
    this.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    this.camTarget = { x: (MAP_W * TILE) / 2, y: (MAP_H * TILE) / 2 };
  }

  selectIdleVillagers(): void {
    this.deselectAllUnits();
    for (const u of this.units)
      if (this.isMine(u.team) && u.type === "villager" && u.state === "idle") {
        this.selection.add(u.id);
        u.selected = true;
      }
    this.publish(true);
  }

  // ── right-click intelligence ───────────────────────────────────────────────

  rightClickCommand(wx: number, wy: number): void {
    if (this.relay) {
      this.emitNet({
        t: 0,
        k: "rc",
        x: wx,
        y: wy,
        sel: [...this.selection],
        selB: this.selectedBuilding,
      });
      return;
    }
    this.record({
      t: this.time,
      k: "rc",
      x: wx,
      y: wy,
      sel: [...this.selection],
      selB: this.selectedBuilding,
    });
    this.recGuard = true;
    this.rcInner(wx, wy);
    this.recGuard = false;
  }

  private rcInner(wx: number, wy: number): void {
    const tx = Math.floor(wx / TILE);
    const ty = Math.floor(wy / TILE);

    if (this.selectedBuilding >= 0 && this.selection.size === 0) {
      const b = this.buildingById.get(this.selectedBuilding);
      if (b && this.isMine(b.team) && b.built && BUILDING_DEFS[b.type].trains.length) {
        b.rallyX = wx;
        b.rallyY = wy;
        this.floatAt(wx, wy, "!", "#7dd37d");
        return;
      }
    }

    const sel = this.selUnits();
    if (!sel.length) return;

    const enemy = this.pickUnitAt(wx, wy, this.enemyTeam());
    if (enemy) {
      this.cmdAttack(sel, enemy.id);
      return;
    }
    if (this.grid.inBounds(tx, ty)) {
      const occId = this.grid.occ[this.grid.idx(tx, ty)];
      if (occId > 0) {
        const ent = this.byId.get(occId);
        if (ent) {
          if (isNode(ent)) {
            const villagers = sel.filter((u) => u.type === "villager");
            if (villagers.length) this.cmdHarvest(villagers, occId);
            else this.cmdMove(sel, wx, wy);
            return;
          }
          if (isBuilding(ent)) {
            if (!this.isMine(ent.team)) {
              this.cmdAttack(sel, ent.id);
              return;
            }
            const villagers = sel.filter((u) => u.type === "villager");
            if (!ent.built) {
              if (villagers.length) {
                for (const v of villagers) this.assignBuild(v, ent);
                return;
              }
            } else if (ent.hp < ent.maxHp && villagers.length) {
              for (const v of villagers) this.assignRepair(v, ent);
              return;
            } else if (ent.type === "farm" && villagers.length) {
              this.cmdHarvest(villagers, ent.id);
              return;
            }
          }
        }
      }
    }
    this.cmdMove(sel, wx, wy);
  }

  // ── placement (UI-driven) ──────────────────────────────────────────────────

  setPlacement(type: BuildingType | null): void {
    this.placement = type;
    this.placeTiles = [];
    this.wallDragging = false;
    if (type) this.attackMoveMode = false;
    if (this.canvas)
      this.canvas.style.cursor = type ? "crosshair" : "default";
    this.markHud();
    this.publish(true);
  }

  private updatePlaceTiles(sx: number, sy: number): void {
    const w = this.screenToWorld(sx, sy);
    const tx = Math.floor(w.x / TILE);
    const ty = Math.floor(w.y / TILE);
    if (this.placement === "wall" || this.placement === "gate") {
      const packed = ty * MAP_W + tx;
      if (!this.placeTiles.length) {
        this.placeTiles.push(packed);
        return;
      }
      if (this.placeTiles[this.placeTiles.length - 1] === packed) return;
      const last = this.placeTiles[this.placeTiles.length - 1];
      const lx = last % MAP_W;
      const ly = (last / MAP_W) | 0;
      const steps = Math.max(Math.abs(tx - lx), Math.abs(ty - ly));
      for (let i = 1; i <= steps; i++) {
        const px = Math.round(lx + ((tx - lx) * i) / steps);
        const py = Math.round(ly + ((ty - ly) * i) / steps);
        const pp = py * MAP_W + px;
        if (this.placeTiles[this.placeTiles.length - 1] !== pp)
          this.placeTiles.push(pp);
      }
      if (this.placeTiles.length > 80)
        this.placeTiles.splice(0, this.placeTiles.length - 80);
    } else if (this.placement) {
      const def = BUILDING_DEFS[this.placement];
      this.placeTiles = [];
      for (let y = ty; y < ty + def.h; y++)
        for (let x = tx; x < tx + def.w; x++) this.placeTiles.push(y * MAP_W + x);
    }
  }

  private tryPlaceAtCursor(sx: number, sy: number): void {
    if (!this.placement || this.placement === "wall" || this.placement === "gate")
      return;
    const w = this.screenToWorld(sx, sy);
    const tx = Math.floor(w.x / TILE);
    const ty = Math.floor(w.y / TILE);
    const type = this.placement;
    const def = BUILDING_DEFS[type];
    if (!this.canPlace(this.myTeam, type, tx, ty)) {
      sfx.play("error");
      this.msg("Cannot build here.", "bad");
      this.publish(true);
      return;
    }
    if (!canAfford(this.res[this.myTeam], def.cost)) {
      this.msg("Not enough resources.", "bad");
      this.publish(true);
      return;
    }
    this.place(this.myTeam, type, tx, ty);
    this.setPlacement(null);
  }

  private commitWallDrag(): void {
    const type = this.placement;
    if ((type !== "wall" && type !== "gate") || !this.placeTiles.length) return;
    let placed = 0;
    let skipped = 0;
    for (const packed of this.placeTiles) {
      const tx = packed % MAP_W;
      const ty = (packed / MAP_W) | 0;
      if (
        this.canPlace(this.myTeam, type, tx, ty) &&
        canAfford(this.res[this.myTeam], BUILDING_DEFS[type].cost)
      ) {
        if (this.place(this.myTeam, type, tx, ty)) placed++;
      } else skipped++;
    }
    if (placed === 0 && skipped > 0) {
      this.msg("Cannot build there.", "bad");
      this.publish(true);
    }
    this.placeTiles = [];
    this.setPlacement(null);
  }

  placementPreview(): {
    type: BuildingType;
    tiles: Array<{ x: number; y: number }>;
  } | null {
    if (!this.placement) return null;
    if (this.placement === "wall" || this.placement === "gate") {
      return {
        type: this.placement,
        tiles: this.placeTiles.map((p) => ({
          x: p % MAP_W,
          y: (p / MAP_W) | 0,
        })),
      };
    }
    const w = this.screenToWorld(this.mouse.x, this.mouse.y);
    const tx = Math.floor(w.x / TILE);
    const ty = Math.floor(w.y / TILE);
    const def = BUILDING_DEFS[this.placement];
    const tiles: Array<{ x: number; y: number }> = [];
    for (let y = ty; y < ty + def.h; y++)
      for (let x = tx; x < tx + def.w; x++) tiles.push({ x, y });
    return { type: this.placement, tiles };
  }

  // ── UI actions ─────────────────────────────────────────────────────────────

  uiTrain(type: UnitType): void {
    if (this.selectedBuilding < 0) return;
    const b = this.buildingById.get(this.selectedBuilding);
    if (b) this.trainAt(b, type);
    this.publish(true);
  }

  uiStop(): void {
    this.cmdStop(this.selUnits());
  }

  uiAttackMove(): void {
    if (this.selUnits().some((u) => UNIT_DEFS[u.type].military)) {
      this.attackMoveMode = !this.attackMoveMode;
      this.markHud();
      this.publish(true);
    }
  }

  togglePause(): void {
    if (this.phase !== "playing") return;
    this.paused = !this.paused;
    this.publish(true);
  }

  toggleSpeed(): void {
    this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
    this.publish(true);
  }

  setRation(tier: number): void {
    this.ration[0] = Math.max(0, Math.min(3, tier));
    this.markHud();
    this.publish(true);
  }

  setTax(tier: number): void {
    this.tax[0] = Math.max(0, Math.min(3, tier));
    this.markHud();
    this.publish(true);
  }

  skipTutorial(): void {
    this.tutorialSkipped = true;
    this.publish(true);
  }

  saveNow(): void {
    try {
      if (typeof localStorage !== "undefined")
        localStorage.setItem(Game.SAVE_KEY, this.serialize());
    } catch {
      /* ignore */
    }
  }

  continueSave(): boolean {
    try {
      const s =
        typeof localStorage !== "undefined"
          ? localStorage.getItem(Game.SAVE_KEY)
          : null;
      if (!s) return false;
      return this.loadFrom(s);
    } catch {
      return false;
    }
  }

  toggleMute(): void {
    this.muted = !this.muted;
    sfx.setEnabled(!this.muted);
    this.publish(true);
  }

  // ── save / load ────────────────────────────────────────────────────────────

  static readonly SAVE_KEY = "castle-dominion-save-v1";

  static hasSave(): boolean {
    try {
      return (
        typeof localStorage !== "undefined" &&
        !!localStorage.getItem(Game.SAVE_KEY)
      );
    } catch {
      return false;
    }
  }

  static clearSave(): void {
    try {
      if (typeof localStorage !== "undefined")
        localStorage.removeItem(Game.SAVE_KEY);
    } catch {
      /* ignore */
    }
  }

  serialize(): string {
    return JSON.stringify({
      v: 2,
      cfg: this.cfg,
      theme: this.grid.theme,
      aiPersonality: this.ai.personality,
      popularity: this.popularity,
      ration: this.ration,
      tax: this.tax,
      granary: this.granary,
      seed: this.grid.seed,
      time: this.time,
      res: this.res,
      mods: this.mods,
      upgrades: this.upgrades,
      grief: this.grief,
      kills: this.kills,
      losses: this.losses,
      // absolute per-team death counters: they are part of stateHash(), so a
      // save that dropped them restored into a different fingerprint
      deaths: this.deaths,
      speed: this.speed,
      tut: this.tut,
      tutorialSkipped: this.tutorialSkipped,
      cam: { ...this.cam },
      keeps: this.keeps,
      ai: this.ai.serialize(),
      explored0: this.fogOn() ? b64(this.explored[0]) : null,
      nodes: this.nodes.map((n) => [n.id, Math.round(n.amount)]),
      buildings: this.buildings.map((b) => ({
        id: b.id,
        team: b.team,
        type: b.type,
        tx: b.tx,
        ty: b.ty,
        built: b.built,
        hp: b.hp,
        work: b.work,
        queue: b.queue,
        research: b.research,
        rallyX: b.rallyX,
        rallyY: b.rallyY,
      })),
      units: this.units.map((u) => ({
        id: u.id,
        team: u.team,
        type: u.type,
        x: u.x,
        y: u.y,
        hp: u.hp,
        maxHp: u.maxHp,
        state: u.state === "attack" || u.state === "attackMove" ? "idle" : u.state,
        tx: u.tx,
        ty: u.ty,
        taskId: u.taskId,
        facing: u.facing,
        raid: u.raid,
      })),
    });
  }

  loadFrom(json: string): boolean {
    let d: ReturnType<typeof JSON.parse>;
    try {
      d = JSON.parse(json);
    } catch {
      return false;
    }
    if (!d || d.v !== 2) return false;
    this.init(d.seed as number, {
      ...defaultMatchConfig(),
      ...(d.cfg as MatchConfig),
      seed: d.seed as number,
    });
    // wipe auto-generated entities, then restore exactly
    this.units = [];
    for (const b of [...this.buildings]) this.removeBuilding(b);
    for (const n of [...this.nodes]) this.removeNode(n);
    this.byId.clear();

    // Nodes: same ids regenerate from the same seed, but the temporary grid
    // must be built with the *saved* archetype/size/richness — it defaults to
    // M/verdant, which regenerated the wrong node set for an XL or desert
    // save. It also calls setMapSize() as a side effect, so the live match's
    // dimensions are restored right afterwards (the 2D renderer, pathfinder
    // and minimap all read those module-level values).
    const cfg2 = {
      ...defaultMatchConfig(),
      ...(d.cfg as MatchConfig),
      seed: d.seed as number,
    };
    const grid2 = new GameGrid(
      d.seed as number,
      cfg2.map,
      cfg2.size,
      cfg2.richness,
    );
    const savedNodes = new Map<number, number>(
      (d.nodes as Array<[number, number]>).map((x) => [x[0], x[1]]),
    );
    for (const n of grid2.scatterNodes(1)) {
      // A regenerated node absent from the save was depleted and removed in
      // the live match: restoring it at full amount would hand the loaded
      // game phantom resources plus a stale occupancy mark on its tile.
      const saved = savedNodes.get(n.id);
      if (saved === undefined) continue;
      n.amount = saved;
      if (n.amount <= 0) continue;
      this.nodes.push(n);
      this.nodeById.set(n.id, n);
      this.byId.set(n.id, n);
      this.grid.setOcc(n.tx, n.ty, n.id);
      this.nextId = n.id + 1;
    }
    setMapSize(this.grid.w, this.grid.h);
    // buildings in saved id order
    const bs = [...(d.buildings as Array<Record<string, never>>)].sort(
      (a, b) => (a.id as number) - (b.id as number),
    );
    for (const sb of bs) {
      const rec = sb as unknown as {
        id: number;
        team: Team;
        type: BuildingType;
        tx: number;
        ty: number;
        built: boolean;
        hp: number;
        work: number;
        queue: UnitType[];
        research: { id: string; t: number } | null;
        rallyX: number;
        rallyY: number;
      };
      this.nextId = rec.id;
      const b = this.spawnBuilding(rec.team, rec.type, rec.tx, rec.ty, rec.built);
      b.hp = rec.hp;
      b.work = rec.work;
      b.queue = [...rec.queue];
      b.research = rec.research;
      b.rallyX = rec.rallyX;
      b.rallyY = rec.rallyY;
      this.nextId = rec.id + 1;
    }
    // units
    for (const su of d.units as Array<Record<string, number | string>>) {
      const rec = su as unknown as {
        id: number;
        team: Team;
        type: UnitType;
        x: number;
        y: number;
        hp: number;
        maxHp: number;
        state: Unit["state"];
        tx: number;
        ty: number;
        taskId: number;
        facing: number;
        raid: number;
      };
      this.nextId = Math.max(this.nextId, rec.id + 1);
      const u = this.spawnUnit(rec.team, rec.type, rec.x, rec.y);
      const realId = u.id;
      void realId;
      // spawnUnit used nextId; force the saved id
      this.byId.delete(u.id);
      u.id = rec.id;
      this.byId.set(u.id, u);
      u.hp = rec.hp;
      u.maxHp = rec.maxHp;
      u.state = rec.state;
      u.tx = rec.tx;
      u.ty = rec.ty;
      u.facing = rec.facing;
      u.raid = rec.raid;
      // re-link harvest/build tasks only if the target still exists
      if (rec.taskId >= 0 && this.byId.has(rec.taskId)) {
        const t = this.byId.get(rec.taskId)!;
        if (isNode(t) || (isBuilding(t) && (t.type === "farm" || !t.built))) {
          u.taskId = rec.taskId;
          if (u.state === "harvest" || u.state === "build") {
            /* keep state */
          } else u.state = "idle";
        }
      }
      this.nextId = Math.max(this.nextId, rec.id + 1);
    }
    this.keeps = [...(d.keeps as [number, number])];
    this.res = d.res;
    this.mods = d.mods;
    this.upgrades = d.upgrades;
    this.grief = d.grief;
    this.kills = d.kills ?? 0;
    this.losses = d.losses ?? 0;
    this.deaths = Array.isArray(d.deaths)
      ? [Number(d.deaths[0]) || 0, Number(d.deaths[1]) || 0]
      : [0, 0];
    this.speed = d.speed ?? 1;
    this.popularity = d.popularity ?? [POP.start, POP.start];
    this.ration = d.ration ?? [2, 2];
    this.tax = d.tax ?? [1, 1];
    this.granary = d.granary ?? [0, 0];
    this.tut = { ...this.tut, ...(d.tut ?? {}) };
    this.tutorialSkipped = !!d.tutorialSkipped;
    this.time = d.time ?? 0;
    this.tickCount = Math.round(this.time / STEP);
    this.cam = { ...d.cam };
    this.zoomTarget = this.cam.zoom;
    this.clampCam(); // saves from older builds may hold unclamped cameras
    this.ai.deserialize(d.ai);
    if (d.explored0 && this.fogOn()) {
      const bytes = unb64(d.explored0 as string);
      if (bytes.length === this.explored[0].length) this.explored[0].set(bytes);
    }
    this.refreshVision();
    this.renderer?.reset();
    this.recomputePop();
    this.phase = "playing";
    this.clampCam();
    this.markHud();
    this.publish(true);
    return true;
  }

  /** autosave hook (browser only) */
  private saveT = 30;
  maybeAutosave(dt: number): void {
    if (typeof localStorage === "undefined") return;
    if (this.phase !== "playing" || !this.settings.autosave || this.netMode) return;
    this.saveT -= dt;
    if (this.saveT > 0) return;
    this.saveT = 30;
    try {
      localStorage.setItem(Game.SAVE_KEY, this.serialize());
    } catch {
      /* ignore quota errors */
    }
  }

  // ── helpers used by the AI ─────────────────────────────────────────────────

  teamUnits(team: Team, type?: UnitType): Unit[] {
    return this.units.filter(
      (u) => u.team === team && (type === undefined || u.type === type),
    );
  }

  teamBuildings(team: Team, type?: BuildingType): Building[] {
    return this.buildings.filter(
      (b) => b.team === team && (type === undefined || b.type === type),
    );
  }

  nearestNode(kind: ResKind | null, x: number, y: number, maxD: number): RNode | null {
    let best: RNode | null = null;
    let bestD = maxD * maxD;
    for (const n of this.nodes) {
      if (kind && NODE_DEFS[n.kind].res !== kind) continue;
      if (n.amount <= 0) continue;
      const dx = n.tx * TILE - x;
      const dy = n.ty * TILE - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  findSpotNear(
    cx: number,
    cy: number,
    type: BuildingType,
    team: Team,
    maxR = 14,
  ): { x: number; y: number } | null {
    const def = BUILDING_DEFS[type];
    const ox = (def.w / 2) | 0;
    const oy = (def.h / 2) | 0;
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = cx + dx - ox;
          const ty = cy + dy - oy;
          if (this.canPlace(team, type, tx, ty, true)) return { x: tx, y: ty };
        }
      }
    }
    return null;
  }
}

const BUILD_ORDER_KEYS: Array<BuildingType | undefined> = [
  "house",
  "farm",
  "barracks",
  "wall",
  "tower",
  "gate",
  "lumbercamp",
  "quarry",
  "market",
  "shrine",
];
const BUILD_LETTER_KEYS = ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]"];

export type { Ent, UpgradeDef };
export { isUnit, isNode, isBuilding };
