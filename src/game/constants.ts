import type {
  BuildingType,
  NodeType,
  ResKind,
  Resources,
  UnitClass,
  UnitType,
} from "./types";

// ── World ────────────────────────────────────────────────────────────────────
export const TILE = 32;
/** camera zoom bounds — ZOOM_MIN is low enough for "fit kingdom" on big maps */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** live map dimensions (set per match by GameGrid) */
export let MAP_W = 104;
export let MAP_H = 104;
export function setMapSize(w: number, h: number): void {
  MAP_W = w;
  MAP_H = h;
}

// Terrain ids
export const T_GRASS = 0;
export const T_WATER = 1;
export const T_DIRT = 2;
export const T_ROCKY = 3;
export const T_OASIS = 4;
export const T_BRIDGE = 5;
export const T_FORD = 6;

export type MapSize = "S" | "M" | "L" | "XL";
/**
 * XL is opt-in "extra large": 2.4x the tiles of L. It is never required — the
 * default stays M — and the renderers scale their budgets with the map so a
 * weak machine can still play (see src/game/perf.ts).
 */
export const MAP_DIMS: Record<MapSize, number> = {
  S: 84,
  M: 104,
  L: 128,
  XL: 160,
};
/** map area relative to the reference size (M = 104) — drives node density */
export function mapAreaScale(w: number): number {
  const k = w / 104;
  return k * k;
}

export function startPositions(): Array<{ x: number; y: number }> {
  return [
    { x: Math.round(MAP_W * 0.125), y: Math.round(MAP_H * 0.875) },
    { x: Math.round(MAP_W * 0.875), y: Math.round(MAP_H * 0.125) },
  ];
}

// ── match setup: maps, lords, difficulties, modes ────────────────────────────
export type MapArch =
  | "verdant"
  | "desert"
  | "oasis"
  | "riverlands"
  | "mountain"
  | "twin"
  | "random";

export interface MapMeta {
  id: MapArch;
  name: string;
  theme: "green" | "desert";
  desc: string;
  notes: string;
}

export const MAPS: MapMeta[] = [
  {
    id: "verdant",
    name: "Verdant Valley",
    theme: "green",
    desc: "Rolling forests, lakes and rocky hills. The classic realm.",
    notes: "Balanced wood/stone; open flanks reward tower lines.",
  },
  {
    id: "desert",
    name: "Desert Siege",
    theme: "desert",
    desc: "Sun-scorched sands, mesas and sparse palm groves.",
    notes: "Stone is plentiful near mesas; watch oasis wood pockets.",
  },
  {
    id: "oasis",
    name: "Oasis Crossroads",
    theme: "desert",
    desc: "A dry waste stitched together by life-giving oases.",
    notes: "Fights concentrate around water; claim oases early.",
  },
  {
    id: "riverlands",
    name: "Riverlands",
    theme: "green",
    desc: "A great river splits the realm — crossed by bridges and fords.",
    notes: "Bridges are chokepoints: wall or tower them.",
  },
  {
    id: "mountain",
    name: "Mountain Pass",
    theme: "green",
    desc: "A stony ridge divides the map with two narrow passes.",
    notes: "Rich ore veins; defend the passes with gates and towers.",
  },
  {
    id: "twin",
    name: "Twin Fortresses",
    theme: "green",
    desc: "Two plateau keeps separated by a central lake and two causeways.",
    notes: "Causeway battles decide the war; siege engines shine.",
  },
  {
    id: "random",
    name: "Random Map",
    theme: "green",
    desc: "Fate chooses the battlefield.",
    notes: "Adapt or die.",
  },
];

export type GameMode =
  | "skirmish"
  | "sandbox"
  | "siege"
  | "survival"
  | "campaign"
  | "multiplayer";

export const MODES: Array<{
  id: GameMode;
  name: string;
  desc: string;
}> = [
  { id: "skirmish", name: "Skirmish", desc: "Classic duel: raze the enemy keep." },
  { id: "sandbox", name: "Free Build", desc: "A passive neighbour. Build your dream kingdom." },
  { id: "siege", name: "Siege Challenge", desc: "Start with an army; crack a doubled keep before time runs out." },
  { id: "survival", name: "Survival", desc: "Endless escalating waves. Survive the clock to win." },
];

export interface LordDef {
  id: number;
  name: string;
  title: string;
  emblem: string;
  desc: string;
  style: string;
  personality: number; // index into PERSONALITIES (ai.ts)
}

export const LORDS: LordDef[] = [
  {
    id: 0,
    name: "Lord Vharek",
    title: "the Ember",
    emblem: "🔥",
    desc: "Burns his own fields to feed the war. Strikes early, strikes often.",
    style: "Early raids · knight-heavy waves · thin walls",
    personality: 0,
  },
  {
    id: 1,
    name: "Lady Morwen",
    title: "Stoneveil",
    emblem: "🛡",
    desc: "A patient widow who lets enemies break on her towers.",
    style: "Tower webs · deep walls · counter-attacks in force",
    personality: 1,
  },
  {
    id: 2,
    name: "Count Alderic",
    title: "Goldbale",
    emblem: "⚖",
    desc: "Buys his victories: markets, upgrades, then an endless army.",
    style: "Economic boom · upgrades first · late-game overwhelm",
    personality: 2,
  },
  {
    id: 3,
    name: "Master Torvald",
    title: "Breakstone",
    emblem: "⚙",
    desc: "A siege engineer who regards walls as invitations.",
    style: "Catapult trains · building-first targets · methodical pushes",
    personality: 3,
  },
];

export type Difficulty = 0 | 1 | 2 | 3;
export const DIFFICULTIES: Array<{
  id: Difficulty;
  name: string;
  desc: string;
  capMult: number;
  villMult: number;
  waveMult: number;
  incomeMult: number;
}> = [
  { id: 0, name: "Easy", desc: "A courteous opponent. Learning pace.", capMult: 0.75, villMult: 0.8, waveMult: 0.8, incomeMult: 0.85 },
  { id: 1, name: "Normal", desc: "A fair fight between equals.", capMult: 1, villMult: 1, waveMult: 1, incomeMult: 1 },
  { id: 2, name: "Hard", desc: "Efficient, ruthless, well-fed.", capMult: 1.15, villMult: 1.1, waveMult: 1.15, incomeMult: 1.12 },
  { id: 3, name: "Brutal", desc: "The realm trembles. Perfect economy, endless steel.", capMult: 1.3, villMult: 1.2, waveMult: 1.3, incomeMult: 1.25 },
];

export interface MatchConfig {
  mode: GameMode;
  map: MapArch;
  size: MapSize;
  richness: 0 | 1 | 2;
  startRes: 0 | 1 | 2;
  lord: number; // 0-3 or 4 = random
  difficulty: Difficulty;
  noRushMin: number;
  timeLimitMin: number;
  missionId: number;
  /**
   * Optional "Epic Army" capacity: a much higher population ceiling plus a
   * richer start, for players who want 500+ unit battles. Off by default and
   * never forced — the adaptive quality governor keeps it playable, and the
   * simulation stays deterministic because the flag is part of the match
   * config (recorded in saves/replays and sent to multiplayer peers).
   */
  epic: boolean;
  seed: number;
}

export const defaultMatchConfig = (): MatchConfig => ({
  mode: "skirmish",
  map: "verdant",
  size: "M",
  richness: 1,
  startRes: 1,
  lord: 4,
  difficulty: 1,
  noRushMin: 0,
  timeLimitMin: 0,
  missionId: -1,
  epic: false,
  seed: (Math.random() * 1e9) | 0,
});

/**
 * Tuning for the optional Epic Army capacity. Everything here is derived from
 * cfg.epic, so a match without it behaves exactly as before.
 */
export const EPIC = {
  /** starting population ceiling (normal: 8, i.e. the keep alone) */
  popBase: 26,
  /** population provided per house (normal: BUILDING_DEFS.house.pop = 6) */
  housePop: 18,
  /** extra starting resources so a big army can actually be fielded */
  startResMult: 1.6,
  /** food upkeep multiplier — huge armies would otherwise starve instantly */
  upkeepMult: 0.72,
  /** hard safety valve: the sim refuses to exceed this many units total */
  hardUnitCap: 1400,
} as const;

export const RICHNESS_MULT = [0.7, 1, 1.4] as const;
export const START_RES_MULT = [0.6, 1, 1.6] as const;

export const START_RESOURCES: Resources = {
  wood: 260,
  stone: 120,
  gold: 120,
  food: 220,
};

// ── Units ────────────────────────────────────────────────────────────────────
export interface UnitDef {
  name: string;
  cls: UnitClass;
  bonusVs: Partial<Record<UnitClass, number>>;
  siegeMult: number; // damage multiplier vs buildings
  minRange: number;
  siegeOnly: boolean; // only auto-acquires buildings
  hp: number;
  speed: number; // px/s
  dmg: number;
  cd: number; // seconds between attacks
  range: number; // px, edge-to-edge
  radius: number; // body radius px
  acq: number; // auto-acquire radius (0 = never auto-attacks)
  armor: number;
  cost: Partial<Resources>;
  trainTime: number;
  military: boolean;
  ranged: boolean;
  buildRate: number; // construction work per second
  harvest: Partial<Record<NodeType | "farm", { cycle: number; yield: number }>>;
  desc: string;
  splash?: number; // rock splash radius (px)
}

export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  villager: {
    name: "Villager",
    cls: "villager",
    bonusVs: {},
    siegeMult: 1,
    minRange: 0,
    siegeOnly: false,
    hp: 35,
    speed: 66,
    dmg: 2,
    cd: 1.0,
    range: 20,
    radius: 6,
    acq: 0,
    armor: 0,
    cost: { food: 50 },
    trainTime: 7,
    military: false,
    ranged: false,
    buildRate: 16,
    harvest: {
      tree: { cycle: 2.4, yield: 5 },
      rock: { cycle: 2.8, yield: 5 },
      gold: { cycle: 3.0, yield: 4 },
      farm: { cycle: 2.6, yield: 6 },
    },
    desc: "Gathers resources and constructs buildings.",
  },
  militia: {
    name: "Militia",
    cls: "infantry",
    bonusVs: { siege: 2 },
    siegeMult: 1.2,
    minRange: 0,
    siegeOnly: false,
    hp: 75,
    speed: 70,
    dmg: 9,
    cd: 1.05,
    range: 22,
    radius: 7,
    acq: 150,
    armor: 2,
    cost: { food: 60, gold: 20 },
    trainTime: 10,
    military: true,
    ranged: false,
    buildRate: 0,
    harvest: {},
    desc: "Sturdy melee fighter. Strong against buildings.",
  },
  spearman: {
    name: "Spearman",
    cls: "infantry",
    bonusVs: { cavalry: 3 },
    siegeMult: 1,
    minRange: 0,
    siegeOnly: false,
    hp: 60,
    speed: 68,
    dmg: 6,
    cd: 1.0,
    range: 22,
    radius: 7,
    acq: 150,
    armor: 1,
    cost: { food: 45, wood: 20 },
    trainTime: 8,
    military: true,
    ranged: false,
    buildRate: 0,
    harvest: {},
    desc: "Cheap pikeline. Shreds cavalry (x3).",
  },
  archer: {
    name: "Archer",
    cls: "archer",
    bonusVs: { infantry: 1.4 },
    siegeMult: 1,
    minRange: 0,
    siegeOnly: false,
    hp: 48,
    speed: 68,
    dmg: 7,
    cd: 1.35,
    range: 160,
    radius: 6.5,
    acq: 230,
    armor: 0,
    cost: { food: 45, gold: 35 },
    trainTime: 9,
    military: true,
    ranged: true,
    buildRate: 0,
    harvest: {},
    desc: "Ranged attacker. Deadly in groups, fragile up close.",
  },
  knight: {
    name: "Knight",
    cls: "cavalry",
    bonusVs: { archer: 2, villager: 1.8, siege: 2 },
    siegeMult: 1.1,
    minRange: 0,
    siegeOnly: false,
    hp: 115,
    speed: 96,
    dmg: 12,
    cd: 1.15,
    range: 24,
    radius: 8,
    acq: 170,
    armor: 3,
    cost: { food: 80, gold: 60 },
    trainTime: 14,
    military: true,
    ranged: false,
    buildRate: 0,
    harvest: {},
    desc: "Fast heavy cavalry. Raids archers and workers; fears spears.",
  },
  catapult: {
    name: "Catapult",
    cls: "siege",
    bonusVs: { siege: 2 },
    siegeMult: 5,
    minRange: 70,
    siegeOnly: true,
    hp: 110,
    speed: 40,
    dmg: 14,
    splash: 45,
    cd: 3.2,
    range: 220,
    radius: 9,
    acq: 260,
    armor: 2,
    cost: { wood: 140, gold: 90 },
    trainTime: 20,
    military: true,
    ranged: true,
    buildRate: 0,
    harvest: {},
    desc: "Slow siege engine. x5 damage vs buildings. Keep it escorted.",
  },
};

export const POP_PER_UNIT = 1;

// ── Buildings ────────────────────────────────────────────────────────────────
export interface BuildingDef {
  name: string;
  aura?: { res: ResKind[]; mult: number; radius: number };
  happiness?: number;
  w: number;
  h: number;
  hp: number;
  armor: number;
  cost: Partial<Resources>;
  work: number; // construction work needed
  pop: number; // population provided
  trains: UnitType[];
  harvestable: boolean; // villagers can work it for food
  desc: string;
}

export const BUILDING_DEFS: Record<BuildingType, BuildingDef> = {
  keep: {
    name: "Castle Keep",
    w: 5,
    h: 5,
    hp: 2400,
    armor: 2,
    cost: {},
    work: 0,
    pop: 8,
    trains: ["villager"],
    harvestable: false,
    desc: "Heart of your realm. Trains villagers. Lose it and all is lost.",
  },
  house: {
    name: "House",
    w: 2,
    h: 2,
    hp: 550,
    armor: 0,
    cost: { wood: 50 },
    work: 55,
    pop: 6,
    trains: [],
    harvestable: false,
    desc: "+6 population capacity.",
  },
  farm: {
    name: "Farm",
    w: 2,
    h: 2,
    hp: 400,
    armor: 0,
    cost: { wood: 40 },
    work: 45,
    pop: 0,
    trains: [],
    harvestable: true,
    desc: "Villagers work farms for a steady food supply.",
  },
  barracks: {
    name: "Barracks",
    w: 3,
    h: 3,
    hp: 1400,
    armor: 1,
    cost: { wood: 120, stone: 40 },
    work: 130,
    pop: 0,
    trains: ["militia", "spearman", "archer", "knight", "catapult"],
    harvestable: false,
    desc: "Trains Militia and Archers.",
  },
  gate: {
    name: "Gate",
    w: 1,
    h: 1,
    hp: 750,
    armor: 2,
    cost: { wood: 30, stone: 10 },
    work: 30,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "Your units pass freely; enemies must smash it. Fits in walls.",
  },
  tower: {
    name: "Archer Tower",
    aura: undefined,
    w: 2,
    h: 2,
    hp: 1300,
    armor: 3,
    cost: { wood: 40, stone: 70 },
    work: 120,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "Auto-fires arrows at nearby enemies. Anchors your defense.",
  },
  lumbercamp: {
    name: "Lumber Camp",
    aura: { res: ["wood"], mult: 1.3, radius: 7 },
    w: 2,
    h: 2,
    hp: 500,
    armor: 0,
    cost: { wood: 60 },
    work: 50,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "+30% wood yield for villagers working within 7 tiles.",
  },
  quarry: {
    name: "Quarry Shed",
    aura: { res: ["stone", "gold"], mult: 1.3, radius: 7 },
    w: 2,
    h: 2,
    hp: 500,
    armor: 0,
    cost: { wood: 70 },
    work: 60,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "+30% stone & gold yield for villagers working within 7 tiles.",
  },
  market: {
    name: "Market",
    w: 3,
    h: 2,
    hp: 700,
    armor: 0,
    cost: { wood: 100, stone: 30 },
    work: 90,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "Trade resources for gold (select it to trade).",
  },
  granary: {
    name: "Granary",
    w: 2,
    h: 2,
    hp: 600,
    armor: 0,
    cost: { wood: 80, stone: 20 },
    work: 70,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "Stores a 400-food reserve that feeds your people through famines.",
  },
  inn: {
    name: "Inn",
    w: 2,
    h: 2,
    hp: 550,
    armor: 0,
    cost: { wood: 90 },
    work: 80,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "Brews ale from food (0.05/s). Each active inn raises popularity.",
  },
  shrine: {
    name: "Shrine",
    happiness: 8,
    w: 2,
    h: 2,
    hp: 450,
    armor: 0,
    cost: { wood: 60, stone: 40 },
    work: 70,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "+8 happiness for your kingdom (stacks up to 3).",
  },
  wall: {
    name: "Stone Wall",
    w: 1,
    h: 1,
    hp: 700,
    armor: 2,
    cost: { stone: 12 },
    work: 34,
    pop: 0,
    trains: [],
    harvestable: false,
    desc: "Blocks and slows enemy attacks. Drag to place a line.",
  },
};

export const BUILD_ORDER: BuildingType[] = [
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
  "granary",
  "inn",
];

// ── tower combat ─────────────────────────────────────────────────────────────
export const TOWER = { range: 170, dmg: 7, cd: 1.3 };

// ── market exchange rates ────────────────────────────────────────────────────
export const MARKET: Record<
  "sellWood" | "sellFood" | "buyWood",
  { give: Partial<Resources>; get: Partial<Resources>; label: string }
> = {
  sellWood: { give: { wood: 100 }, get: { gold: 55 }, label: "Sell 100 wood → 55 gold" },
  sellFood: { give: { food: 100 }, get: { gold: 45 }, label: "Sell 100 food → 45 gold" },
  buyWood: { give: { gold: 60 }, get: { wood: 100 }, label: "Buy 100 wood for 60 gold" },
};

// ── upgrades ─────────────────────────────────────────────────────────────────
export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  cost: Partial<Resources>;
  time: number;
  at: BuildingType;
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: "wheelbarrow",
    name: "Wheelbarrow",
    desc: "Villagers gather 15% faster.",
    cost: { food: 120, gold: 80 },
    time: 25,
    at: "keep",
  },
  {
    id: "loom",
    name: "Loom",
    desc: "Villagers +20 HP (current and future).",
    cost: { food: 100, gold: 50 },
    time: 20,
    at: "keep",
  },
  {
    id: "iron_swords",
    name: "Iron Swords",
    desc: "Melee units +2 damage.",
    cost: { food: 110, gold: 110 },
    time: 30,
    at: "barracks",
  },
  {
    id: "longbows",
    name: "Longbows",
    desc: "Archers +40 range and +1 damage.",
    cost: { wood: 110, gold: 80 },
    time: 30,
    at: "barracks",
  },
  {
    id: "padded_armor",
    name: "Padded Armor",
    desc: "All military units +1 armor.",
    cost: { food: 130, gold: 60 },
    time: 30,
    at: "barracks",
  },
  {
    id: "siege_eng",
    name: "Siege Engineering",
    desc: "Catapults deal +30% damage.",
    cost: { wood: 120, gold: 120 },
    time: 35,
    at: "barracks",
  },
  {
    id: "town_watch",
    name: "Town Watch",
    desc: "Archer Towers +40 range, +2 damage.",
    cost: { wood: 80, gold: 90 },
    time: 25,
    at: "keep",
  },
];

export interface TeamMods {
  meleeDmgAdd: number;
  archerDmgAdd: number;
  archerRangeAdd: number;
  armorAdd: number;
  siegeMult: number;
  harvestMult: number;
  villagerHpAdd: number;
  towerRangeAdd: number;
  towerDmgAdd: number;
}

export const zeroMods = (): TeamMods => ({
  meleeDmgAdd: 0,
  archerDmgAdd: 0,
  archerRangeAdd: 0,
  armorAdd: 0,
  siegeMult: 1,
  harvestMult: 1,
  villagerHpAdd: 0,
  towerRangeAdd: 0,
  towerDmgAdd: 0,
});

// ── popularity (Stronghold-style factors, per-minute deltas) ─────────────────
export const RATIONS = [
  { id: 0, name: "None", mult: 0, pop: -10, desc: "No food issued. People starve and revolt." },
  { id: 1, name: "Half", mult: 0.5, pop: -4, desc: "Half rations. Cheap, but unpopular." },
  { id: 2, name: "Normal", mult: 1, pop: 2, desc: "Standard rations for everyone." },
  { id: 3, name: "Extra", mult: 1.5, pop: 6, desc: "Generous rations. Costly, but beloved." },
] as const;

export const TAXES = [
  { id: 0, name: "None", rate: 0, pop: 6, desc: "No taxes. The people cheer." },
  { id: 1, name: "Low", rate: 0.02, pop: 1, desc: "A modest tithe per head." },
  { id: 2, name: "Medium", rate: 0.05, pop: -5, desc: "A solid income, grumbling rises." },
  { id: 3, name: "High", rate: 0.09, pop: -10, desc: "Heavy taxes. Gold flows, love fades." },
] as const;

export const POP = {
  start: 50,
  upkeepPerHead: 0.045, // food per second per unit at normal rations
  granaryReserve: 400,
  granaryFillRate: 12, // food/sec moved into reserve while stocking
  granaryMinStock: 120, // don't stock below this open stock
  innBrew: 0.05, // food/sec per active inn
  shrineCap: 3,
  shrinePop: 2.5,
  innCap: 2,
  innPop: 4,
  crowding: -10,
  nearCrowding: -4,
  housingOk: 3,
  famine: -12,
  fearWeight: 0.6,
  fearCap: 12,
  griefUnit: 4,
  griefBuilding: 8,
  griefDecay: 0.8,
  rate: 2.2, // popularity points per second toward target
  highAt: 65,
  lowAt: 30,
  highHarvest: 1.12,
  lowHarvest: 0.85,
  highTrain: 0.9,
  lowTrain: 1.15,
  immigrateAt: 65,
  immigrateEvery: 18,
  emigrateAt: 30,
  emigrateEvery: 20,
};

// ── Resource nodes ───────────────────────────────────────────────────────────
export interface NodeDef {
  res: ResKind;
  amount: number;
}

export const NODE_DEFS: Record<NodeType, NodeDef> = {
  tree: { res: "wood", amount: 110 },
  rock: { res: "stone", amount: 260 },
  gold: { res: "gold", amount: 220 },
};

// ── Combat / movement tuning ─────────────────────────────────────────────────
export const WORK_RANGE = 44; // px from node/site center to work
export const RETALIATE_RANGE = 320;
export const PROJECTILE_SPEED = 400;
export const MAX_QUEUE = 5;

// Pathfinding costs
export const COST_OWN_WALL = 2.6; // own walls passable but discouraged
export const COST_ENEMY_WALL = 70; // enemies smash through walls
export const COST_SIEGE = 420; // fallback: walk "through" buildings to siege

// ── AI tuning ────────────────────────────────────────────────────────────────
export const AI = {
  villagerTarget: 15,
  defenseHold: 3, // units kept home
  waveSizes: [5, 8, 11, 14, 17, 20, 23, 26, 29],
  firstWaveAfter: 300, // no attacks before this (seconds)
  waveInterval: 95, // minimum spacing between waves
  forceAttackAfter: 660, // seconds
  forceAttackEvery: 90,
  raidAfter: 420,
  raidEvery: 120,
  raidSize: 3,
  raidDuration: 50,
  buildInterval: 0.55, // decision tick
  /** soft cap on standing army, ramps with time so the AI can't snowball early */
  militaryCap: (time: number): number =>
    time > 1600 ? 32 : Math.min(4 + Math.floor(time / 80), 26),
};

// ── Misc ─────────────────────────────────────────────────────────────────────
export const TEAM_COLORS = ["#4f83ff", "#e0503e"];
export const TEAM_COLORS_DARK = ["#2a4a9e", "#8e2a1e"];
export const RES_ORDER: ResKind[] = ["food", "wood", "stone", "gold"];

export function canAfford(res: Resources, cost: Partial<Resources>): boolean {
  return (
    res.wood >= (cost.wood ?? 0) &&
    res.stone >= (cost.stone ?? 0) &&
    res.gold >= (cost.gold ?? 0) &&
    res.food >= (cost.food ?? 0)
  );
}

export function payCost(res: Resources, cost: Partial<Resources>): void {
  res.wood -= cost.wood ?? 0;
  res.stone -= cost.stone ?? 0;
  res.gold -= cost.gold ?? 0;
  res.food -= cost.food ?? 0;
}
