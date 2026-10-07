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
