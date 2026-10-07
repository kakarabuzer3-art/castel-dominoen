// ── Castle Dominion — shared types ──────────────────────────────────────────

export type Team = 0 | 1; // 0 = player (blue), 1 = enemy (red)
export type ResKind = "wood" | "stone" | "gold" | "food";
export type UnitType =
  | "villager"
  | "militia"
  | "spearman"
  | "archer"
  | "knight"
  | "catapult";
export type BuildingType =
  | "keep"
  | "house"
  | "farm"
  | "barracks"
  | "wall"
  | "gate"
  | "tower"
  | "lumbercamp"
  | "quarry"
  | "market"
  | "shrine"
  | "granary"
  | "inn";

export type UnitClass = "villager" | "infantry" | "archer" | "cavalry" | "siege";
export type NodeType = "tree" | "rock" | "gold";
export type Phase = "menu" | "playing" | "victory" | "defeat";

export interface Resources {
  wood: number;
  stone: number;
  gold: number;
  food: number;
}

export type UnitState =
  | "idle"
  | "move"
  | "attackMove"
  | "harvest"
  | "build"
  | "repair"
  | "attack";

export interface Unit {
  id: number;
  team: Team;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: UnitState;
  path: number[] | null; // list of packed tile indices (waypoints)
  pathI: number;
  tx: number; // final world target x
  ty: number;
  targetId: number; // combat / retaliate target
  taskId: number; // harvest / build task entity id
  workT: number; // work cycle timer
  atkCd: number;
  facing: number; // radians
  anim: number; // walk cycle phase
  acqT: number; // auto-acquire scan timer
  raid: number; // >0: raid retreat deadline; -2 = raid done; -1 none
  kills: number;
  rank: 0 | 1 | 2;
  lastAttacker: number;
  repathT: number;
  repathFails: number;
  attackMoveResume: boolean;
  siegeResume: number;
  stuckT: number;
  wdX: number;
  wdY: number;
  wdT: number;
  lastX: number;
  lastY: number;
  flash: number; // damage flash timer
  selected: boolean;
}

export interface Building {
  id: number;
  team: Team;
  type: BuildingType;
  tx: number; // tile coords (top-left)
  ty: number;
  w: number; // footprint in tiles
  h: number;
  hp: number;
  maxHp: number;
  built: boolean;
  work: number; // construction work remaining
  workMax: number;
  queue: UnitType[];
  queueT: number;
  research: { id: string; t: number } | null;
  cdT: number; // tower fire cooldown
  rallyX: number;
  rallyY: number;
  builders: number; // cached count (recomputed each tick)
  flash: number;
}

export interface RNode {
  id: number;
  kind: NodeType;
  tx: number;
  ty: number;
  amount: number;
  maxAmount: number;
  variant: number; // deterministic art variant
}

export interface Projectile {
  x: number;
  y: number;
  kind: "arrow" | "rock";
  targetId: number;
  team: Team;
  dmg: number;
  speed: number;
}

export interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

export interface GameMessage {
  id: number;
  text: string;
  kind: "info" | "good" | "bad";
  born: number;
}

// ── HUD snapshot (consumed by React) ────────────────────────────────────────

export interface TutorialFlags {
  gather: boolean;
  house: boolean;
  farm: boolean;
  villager: boolean;
  barracks: boolean;
  military: boolean;
  wall: boolean;
  attack: boolean;
}

export interface SelSummary {
  kind: "units" | "building";
  unitType?: UnitType;
  counts: Partial<Record<UnitType, number>>;
  count: number;
  bId?: number;
  bType?: BuildingType;
  bHp?: number;
  bMaxHp?: number;
  bBuilt?: boolean;
  bProgress?: number; // 0..1 construction
  bBuilders?: number;
  bQueue?: UnitType[];
  bQueueT?: number; // 0..1 progress of current training
  bResearch?: { id: string; t: number } | null;
  canTrain?: UnitType[];
  hasMilitary?: boolean;
}

export interface PopFactor {
  label: string;
  value: number; // per-minute popularity delta
}

export interface EndStats {
  gathered: Resources;
  trained: number;
  built: number;
  researched: number;
  peakPop: number;
}

export interface HudSnapshot {
  phase: Phase;
  paused: boolean;
  speed: number;
  time: number;
  mode: string;
  lordName: string;
  difficultyName: string;
  timeLeft: number;
  stats: EndStats;
  achievements: string[];
  popularity: number;
  popFactors: PopFactor[];
  ration: number;
  tax: number;
  granary: number;
  famine: boolean;
  innsActive: number;
  upgrades: string[];
  tut: TutorialFlags;
  tutorialSkipped: boolean;
  muted: boolean;
  res: Resources;
  popCur: number;
  popCap: number;
  villagers: number;
  army: number;
  kills: number;
  losses: number;
  sel: SelSummary | null;
  placement: BuildingType | null;
  attackMoveMode: boolean;
  formation: number;
  replayMode: boolean;
  replay: { time: number; duration: number; paused: boolean; speed: number } | null;
  net: {
    seat: number;
    room: string;
    ping: number;
    connected: boolean;
    waiting: boolean;
  } | null;
  missionName: string;
  objectives: Array<{ label: string; done: boolean }>;
  messages: GameMessage[];
}

export const EMPTY_SNAPSHOT: HudSnapshot = {
  phase: "menu",
  paused: false,
  speed: 1,
  time: 0,
  mode: "skirmish",
  lordName: "",
  difficultyName: "Normal",
  timeLeft: 0,
  stats: {
    gathered: { wood: 0, stone: 0, gold: 0, food: 0 },
    trained: 0,
    built: 0,
    researched: 0,
    peakPop: 0,
  },
  achievements: [],
  popularity: 50,
  popFactors: [],
  ration: 2,
  tax: 1,
  granary: 0,
  famine: false,
  innsActive: 0,
  upgrades: [],
  tut: {
    gather: false,
    house: false,
    farm: false,
    villager: false,
    barracks: false,
    military: false,
    wall: false,
    attack: false,
  },
  tutorialSkipped: false,
  muted: false,
  res: { wood: 0, stone: 0, gold: 0, food: 0 },
  popCur: 0,
  popCap: 0,
  villagers: 0,
  army: 0,
  kills: 0,
  losses: 0,
  sel: null,
  placement: null,
  attackMoveMode: false,
  formation: 0,
  replayMode: false,
  replay: null,
  net: null,
  missionName: "",
  objectives: [],
  messages: [],
};
