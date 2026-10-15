import { BUILDING_DEFS, MARKET, UNIT_DEFS } from "./constants";
import type { BuildingType, Team, UnitType } from "./types";

/**
 * Deterministic replay: a match is fully described by its MatchConfig (incl.
 * seed) plus the ordered list of player intents below. The engine re-simulates
 * at fixed step and re-applies intents at their recorded game-time.
 */
export type ReplayEvent =
  | { t: number; k: "rc"; x: number; y: number; sel: number[]; selB: number }
  | { t: number; k: "place"; type: BuildingType; tx: number; ty: number }
  | { t: number; k: "train"; bId: number; unit: UnitType }
  | { t: number; k: "res"; bId: number; up: string }
  | { t: number; k: "trade"; kind: string }
  | { t: number; k: "form"; v: number }
  | { t: number; k: "move"; ids: number[]; x: number; y: number }
  | { t: number; k: "amove"; ids: number[]; x: number; y: number }
  | { t: number; k: "atk"; ids: number[]; target: number }
  | { t: number; k: "harv"; ids: number[]; node: number }
  | { t: number; k: "stop"; ids: number[] };

// ── intent validation (multiplayer relay) ────────────────────────────────────
// The relay forwards player intents to every peer and applies them to its own
// authoritative simulation, so an intent from the network is *untrusted input*:
// a malformed one used to be able to throw inside the simulation tick.
// sanitizeReplayEvent() rebuilds a clean event from only the known fields, or
// returns null. Every event the engine itself emits passes through unchanged.

/** above EPIC.hardUnitCap (1400): no honest selection is ever larger */
const MAX_IDS = 1500;
const COORD_LIMIT = 1_000_000;
const MAX_TILE = 10_000;

const hasKey = (obj: object, key: unknown): key is string =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);
const isCoord = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT;
const isTile = (v: unknown): v is number =>
  isInt(v) && Math.abs(v) <= MAX_TILE;

function cleanIds(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length > MAX_IDS) return null;
  for (const id of v as unknown[]) if (!isInt(id) || id < 0) return null;
  return [...(v as number[])];
}

export function sanitizeReplayEvent(raw: unknown): ReplayEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const k = e.k;
  const x = e.x;
  const y = e.y;
  switch (k) {
    case "rc": {
      const sel = cleanIds(e.sel);
      const selB = e.selB;
      if (!sel || !isCoord(x) || !isCoord(y) || !isInt(selB) || selB < -1)
        return null;
      return { t: 0, k, x, y, sel, selB };
    }
    case "place": {
      const type = e.type;
      const tx = e.tx;
      const ty = e.ty;
      // keeps are never player-placed (their cost is empty: they would be free)
      if (!hasKey(BUILDING_DEFS, type) || type === "keep") return null;
      if (!isTile(tx) || !isTile(ty)) return null;
      return { t: 0, k, type: type as BuildingType, tx, ty };
    }
    case "train": {
      const bId = e.bId;
      const unit = e.unit;
      if (!isInt(bId) || bId < 0 || !hasKey(UNIT_DEFS, unit)) return null;
      return { t: 0, k, bId, unit: unit as UnitType };
    }
    case "res": {
      const bId = e.bId;
      const up = e.up;
      if (!isInt(bId) || bId < 0) return null;
      if (typeof up !== "string" || up.length === 0 || up.length > 40) return null;
      return { t: 0, k, bId, up };
    }
    case "trade": {
      const kind = e.kind;
      if (!hasKey(MARKET, kind)) return null;
      return { t: 0, k, kind };
    }
    case "form": {
      const v = e.v;
      if (!isInt(v) || v < 0 || v > 2) return null;
      return { t: 0, k, v };
    }
    case "move":
    case "amove": {
      const ids = cleanIds(e.ids);
      if (!ids || !isCoord(x) || !isCoord(y)) return null;
      return { t: 0, k, ids, x, y };
    }
    case "atk": {
      const ids = cleanIds(e.ids);
      const target = e.target;
      if (!ids || !isInt(target) || target < 0) return null;
      return { t: 0, k, ids, target };
    }
    case "harv": {
      const ids = cleanIds(e.ids);
      const node = e.node;
      if (!ids || !isInt(node) || node < 0) return null;
      return { t: 0, k, ids, node };
    }
    case "stop": {
      const ids = cleanIds(e.ids);
      if (!ids) return null;
      return { t: 0, k, ids };
    }
    default:
      return null;
  }
}

export interface ReplaySave {
  v: 1;
  date: number;
  seed: number;
  cfg: unknown; // MatchConfig
  result: string;
  duration: number;
  kills: number;
  losses: number;
  mapName: string;
  lordName: string;
  events: ReplayEvent[];
}

export const REPLAYS_KEY = "castle-dominion-replays-v1";
const MAX_REPLAYS = 8;

export function listReplays(): ReplaySave[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(REPLAYS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ReplaySave[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveReplay(r: ReplaySave): void {
  try {
    if (typeof localStorage === "undefined") return;
    const all = listReplays();
    all.unshift(r);
    while (all.length > MAX_REPLAYS) all.pop();
    localStorage.setItem(REPLAYS_KEY, JSON.stringify(all));
  } catch {
    /* quota — drop oldest and retry once */
    try {
      const all = listReplays().slice(0, 3);
      localStorage.setItem(REPLAYS_KEY, JSON.stringify(all));
    } catch {
      /* give up silently */
    }
  }
}

export function deleteReplay(date: number): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      REPLAYS_KEY,
      JSON.stringify(listReplays().filter((r) => r.date !== date)),
    );
  } catch {
    /* ignore */
  }
}

export type { BuildingType, Team, UnitType };
