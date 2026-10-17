/**
 * Mind layer v1 (Phase 2) — "people, not numbers".
 *
 * Every villager (up to MIND.cap per team) is a named person with two traits,
 * four needs (food / safety / company / purpose), a mood and a few memories.
 * Needs are driven by the *actual* world (rations, famine, nearby enemies,
 * shrines, neighbours, whether the person has work), and the "why is this
 * person unhappy?" answer is built from the very same numbers that produce
 * the mood — it cannot disagree with the simulation.
 *
 * Design rules (see CONCEPT.md, pillar 4):
 *  - Phase 2 was OBSERVATIONAL (read-only). Since Phase 3a moods feed back into
 *    the simulation in exactly one, bounded place: villager work speed (see
 *    WORK / workMult). So minds are now simulation state: part of
 *    `stateHash()`, saved and restored exactly. They still never touch
 *    `Game.rnd`. Every further gameplay effect needs its own reviewed rebaseline.
 *  - Deterministic: names, traits and temperament come from a hash of
 *    (match seed, unit id); dynamic state only uses + - * / and Math.sqrt /
 *    Math.round / min / max (all exactly specified by IEEE-754 / ECMAScript),
 *    never Math.exp / pow / random, so every peer computes identical values.
 *  - Saved and restored with the match (`serialize` / `deserialize`).
 */
import { EPIC, POP, RATIONS, UNIT_DEFS } from "./constants";
import type { Game } from "./engine";
import { hash2 } from "./rng";
import type { Team, Unit } from "./types";

export const MIND = {
  /** named villagers per team; the rest of the crowd is anonymous */
  cap: 100,
  /** game ticks between updates (30 ticks = 1 second at 30 Hz) */
  every: 30,
  /** seconds a memory takes to fade out completely */
  ttl: 150,
  maxMem: 4,
  threatR: 640,
  closeR: 320,
  neighbourR: 192,
  witnessR: 256,
  fallenMax: 40,
  unhappyBelow: 40,
  desperateBelow: 25,
} as const;

/**
 * Phase 3a — the first place a mood changes gameplay: how fast a villager works.
 * Linear and bounded, built only from + - * / so every peer computes the exact
 * same number (no Math.pow / exp). Calm baseline is mood 55 -> x1.00.
 */
export const WORK = {
  neutral: 55,
  slope: 0.006,
  min: 0.75,
  max: 1.1,
} as const;

/** work-speed multiplier a given mood earns (1 = normal) */
export function workFromMood(mood: number): number {
  const x = 1 + WORK.slope * (mood - WORK.neutral);
  return x < WORK.min ? WORK.min : x > WORK.max ? WORK.max : x;
}

export type NeedId = "food" | "safety" | "belonging" | "purpose";
export const NEEDS: readonly NeedId[] = ["food", "safety", "belonging", "purpose"];
const NEED_LABEL: Record<NeedId, string> = {
  food: "Food",
  safety: "Safety",
  belonging: "Company",
  purpose: "Purpose",
};
const BASE_W: Record<NeedId, number> = {
  food: 0.3,
  safety: 0.3,
  belonging: 0.2,
  purpose: 0.2,
};

// ── traits ───────────────────────────────────────────────────────────────────

export type TraitId =
  | "devout"
  | "sociable"
  | "fearful"
  | "stoic"
  | "ambitious"
  | "frugal"
  | "hardy"
  | "proud";

interface TraitDef {
  id: TraitId;
  name: string;
  blurb: string;
  /** multiplier on how much a need matters to this person */
  w?: Partial<Record<NeedId, number>>;
  shrine?: number;
  inn?: number;
  /** multiplier on every negative influence */
  bad?: number;
  /** safety recovers this many times slower after a scare */
  fear?: number;
  /** half rations hurt less */
  lean?: boolean;
  /** heavy taxes hurt this many times more */
  tax?: number;
  /** idleness erodes purpose this many times faster */
  idle?: number;
}

const TRAITS: readonly TraitDef[] = [
  { id: "devout", name: "Devout", blurb: "Draws double strength from a shrine.", shrine: 2 },
  { id: "sociable", name: "Sociable", blurb: "Needs company; loves the inn.", w: { belonging: 1.5 }, inn: 1.5 },
  { id: "fearful", name: "Fearful", blurb: "Frightened easily, calms slowly.", w: { safety: 1.5 }, fear: 1.8 },
  { id: "stoic", name: "Stoic", blurb: "Bad news weighs less on them.", bad: 0.7 },
  { id: "ambitious", name: "Ambitious", blurb: "Restless without meaningful work.", w: { purpose: 1.5 }, idle: 1.8 },
  { id: "frugal", name: "Frugal", blurb: "Copes with half rations.", lean: true },
  { id: "hardy", name: "Hardy", blurb: "Hunger bothers them less.", w: { food: 0.7 } },
  { id: "proud", name: "Proud", blurb: "Resents heavy taxes twice as much.", tax: 2 },
];

// ── names ────────────────────────────────────────────────────────────────────

const GIVEN = [
  "Aldric", "Alys", "Berta", "Bertram", "Cedric", "Cecily", "Dunstan", "Edda",
  "Edmund", "Elspeth", "Fenn", "Godric", "Gwen", "Hale", "Hilda", "Hugh",
  "Isolde", "Jory", "Kenric", "Lena", "Leofric", "Maud", "Merrick", "Nell",
  "Oswin", "Perrin", "Petra", "Quill", "Rowan", "Rolf", "Sibyl", "Selwyn",
  "Tamsin", "Tobias", "Ulric", "Una", "Vance", "Wilmot", "Wynn", "Yorick",
  "Alden", "Brenna", "Corwin", "Dagny", "Emmeline", "Garrick", "Hester", "Ingram",
];
const BYNAME = [
  "Ashby", "Barlow", "Cooper", "Dunmore", "Fletcher", "Garrow", "Hollis", "Marsh",
  "Miller", "Thatcher", "Wickham", "Thorne", "Reeve", "Tanner", "Wheeler", "Fenwick",
  "Harker", "Kempe", "Lowell", "Mercer", "Nash", "Oakes", "Pryor", "Rudd",
  "Sayer", "Tolliver", "Underhill", "Vickers", "Weaver", "Yardley", "Ames", "Brook",
];

// ── memories ─────────────────────────────────────────────────────────────────

type MemKind = "death" | "wounded" | "hunger" | "blessing" | "plenty" | "victory";
const MEM_KINDS: readonly MemKind[] = ["death", "wounded", "hunger", "blessing", "plenty", "victory"];

interface Memory {
  k: MemKind;
  /** game-time the memory was made */
  t: number;
  /** signed mood effect at full strength */
  mag: number;
  text: string;
}

// ── tuning ───────────────────────────────────────────────────────────────────

/** food target by ration tier: none / half / normal / extra */
const FOOD_BASE = [8, 38, 72, 92] as const;
const FOOD_CAUSE = ["noRations", "halfRations", "fedOk", "fedWell"] as const;
/** purpose lost to taxes by tier: none / low / medium / high */
const TAX_PEN = [0, 3, 9, 16] as const;
/** how fast a need eases toward its target each second: [falling, rising] */
const EASE: ReadonlyArray<readonly [number, number]> = [
  [1 / 6, 1 / 10], // food
  [1 / 2, 1 / 14], // safety: fear arrives fast, calm returns slowly
  [1 / 12, 1 / 12], // belonging
  [1 / 10, 1 / 6], // purpose
];

const CAUSE_TEXT: Record<NeedId, Record<string, string>> = {
  food: {
    famine: "Going hungry — the stores are empty",
    noRations: "No rations are being issued",
    halfRations: "Living on half rations",
    lowStock: "The food stores are running low",
    fedOk: "Fed on normal rations",
    fedWell: "Eating well on extra rations",
  },
  safety: {
    enemyClose: "Enemy soldiers are right here",
    enemyNear: "Enemy soldiers are close by",
    alarm: "The keep was just attacked",
    towers: "Towers keep watch over the village",
    guarded: "Soldiers stand close by",
    peace: "No danger in sight",
  },
  belonging: {
    shrine: "Comforted by the shrine",
    inn: "Cheered by the inn",
    company: "Good company nearby",
    alone: "Working alone, far from anyone",
    grief: "The village is grieving",
    crowding: "Cramped, overcrowded homes",
    plain: "Getting by",
  },
  purpose: {
    working: "Busy with useful work",
    idle: "Standing around with nothing to do",
    taxes: "Heavy taxes eat into their wages",
    walking: "On the move",
  },
};

const q4 = (x: number): number => Math.round(x * 10000) / 10000;
const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

function causeText(need: NeedId, code: string): string {
  return CAUSE_TEXT[need][code] ?? CAUSE_TEXT[need].plain ?? "Getting by";
}

export function moodLabel(mood: number): string {
  if (mood >= 70) return "Happy";
  if (mood >= 55) return "Content";
  if (mood >= MIND.unhappyBelow) return "Uneasy";
  if (mood >= MIND.desperateBelow) return "Unhappy";
  return "Desperate";
}

// ── public view types (consumed by the HUD) ──────────────────────────────────

export interface MindWhy {
  label: string;
  /** signed effect on mood, in mood points */
  delta: number;
  text: string;
}

export interface MindView {
  id: number;
  name: string;
  mood: number;
  label: string;
  traits: Array<{ id: TraitId; name: string; blurb: string }>;
  needs: Record<NeedId, number>;
  /** how fast this mood makes them work (1 = normal), see WORK */
  work: number;
  /** the strongest reasons for the current mood, biggest first */
  why: MindWhy[];
  memories: Array<{ text: string; mag: number }>;
}

export interface MindStats {
  named: number;
  avgMood: number;
  unhappy: number;
  desperate: number;
  /** up to three lowest moods */
  worst: Array<{ id: number; name: string; mood: number }>;
}

const emptyStats = (): MindStats => ({
  named: 0,
  avgMood: 0,
  unhappy: 0,
  desperate: 0,
  worst: [],
});

// ── internal state ───────────────────────────────────────────────────────────

type Quad = [number, number, number, number];

interface Mind {
  id: number;
  team: Team;
  name: string;
  /** indices into TRAITS (always two different ones) */
  traits: [number, number];
  /** natural temperament in mood points, -6..+6 */
  disp: number;
  needs: Quad;
  /** cause code of each need's current target (for explanations) */
  cause: [string, string, string, string];
  idle: number;
  famT: number;
  lastHp: number;
  /** game-time of the last update */
  t: number;
  mood: number;
  mem: Memory[];
}

interface TeamCtx {
  famine: boolean;
  ration: number;
  tax: number;
  grief: number;
  alarmAge: number;
  shrines: number;
  towers: number;
  inns: number;
  crowded: boolean;
  stockSecs: number;
}

export class MindSystem {
  private minds = new Map<number, Mind>();
  private live = new Map<number, Unit>();
  private buf: Unit[] = [];
  private mix = 17;
  private shrinesSeen: [number, number] = [-1, -1];
  private plentyT: [number, number] = [0, 0];
  private fallen: Array<{ id: number; team: Team; name: string; t: number }> = [];
  private cache: [MindStats, MindStats] = [emptyStats(), emptyStats()];

  constructor(private g: Game) {}

  /** new match: forget everyone */
  reset(seed: number): void {
    this.minds.clear();
    this.live.clear();
    this.mix = (Math.abs(Math.floor(seed)) % 99991) + 17;
    this.shrinesSeen = [-1, -1];
    this.plentyT = [0, 0];
    this.fallen = [];
    this.cache = [emptyStats(), emptyStats()];
  }

  // ── identity (pure functions of seed + unit id) ────────────────────────────

  private h(id: number, salt: number): number {
    return hash2(id * 131 + salt * 7, this.mix);
  }

  private create(u: Unit): Mind {
    const id = u.id;
    const given = GIVEN[Math.floor(this.h(id, 1) * GIVEN.length)];
    const by = BYNAME[Math.floor(this.h(id, 2) * BYNAME.length)];
    const t1 = Math.floor(this.h(id, 3) * TRAITS.length);
    const t2 = (t1 + 1 + Math.floor(this.h(id, 4) * (TRAITS.length - 1))) % TRAITS.length;
    const m: Mind = {
      id,
      team: u.team,
      name: `${given} ${by}`,
      traits: [t1, t2],
      disp: Math.floor(this.h(id, 5) * 13) - 6,
      needs: [70, 80, 55, 60],
      cause: ["fedOk", "peace", "plain", "walking"],
      idle: 0,
      famT: 0,
      lastHp: u.hp,
      t: this.g.time,
      mood: 50,
      mem: [],
    };
    this.minds.set(id, m);
    return m;
  }

  private has(m: Mind, id: TraitId): boolean {
    return TRAITS[m.traits[0]].id === id || TRAITS[m.traits[1]].id === id;
  }

  // ── per-second update ──────────────────────────────────────────────────────

  update(): void {
    const g = this.g;
    if (g.tickCount % MIND.every !== 0) return;
    const now = g.time;

    this.live.clear();
    for (const u of g.units) if (u.type === "villager") this.live.set(u.id, u);
    for (const id of [...this.minds.keys()]) if (!this.live.has(id)) this.minds.delete(id);

    const ctx: [TeamCtx, TeamCtx] = [this.teamCtx(0, now), this.teamCtx(1, now)];
    for (const t of [0, 1] as const) {
      const c = ctx[t];
      if (this.shrinesSeen[t] >= 0 && c.shrines > this.shrinesSeen[t])
        this.rememberAll(t, "blessing", 8, "Rejoiced at the new shrine", now);
      this.shrinesSeen[t] = c.shrines;
      if (c.ration === 3 && !c.famine) {
        this.plentyT[t]++;
        if (this.plentyT[t] % 150 === 60)
          this.rememberAll(t, "plenty", 6, "Ate well under extra rations", now);
      } else this.plentyT[t] = 0;
    }

    const counts: [number, number] = [0, 0];
    for (const m of this.minds.values()) counts[m.team]++;
    for (const u of g.units) {
      if (u.type !== "villager") continue;
      let m = this.minds.get(u.id);
      let fresh = false;
      if (!m) {
        if (counts[u.team] >= MIND.cap) continue;
        m = this.create(u);
        counts[u.team]++;
        fresh = true;
      }
      this.stepMind(m, u, ctx[u.team], now, fresh);
    }
    this.recomputeStats();
  }

  private teamCtx(team: Team, now: number): TeamCtx {
    const g = this.g;
    let shrines = 0;
    let towers = 0;
    for (const b of g.buildings) {
      if (b.team !== team || !b.built) continue;
      if (b.type === "shrine") shrines++;
      else if (b.type === "tower") towers++;
    }
    const ration = g.ration[team];
    const upkeep =
      g.popCur[team] *
      POP.upkeepPerHead *
      RATIONS[ration].mult *
      (g.cfg.epic ? EPIC.upkeepMult : 1);
    return {
      famine: g.famine[team],
      ration,
      tax: g.tax[team],
      grief: g.grief[team],
      alarmAge: now - g.alarm[team],
      shrines: Math.min(shrines, POP.shrineCap),
      towers: Math.min(towers, 3),
      inns: Math.min(g.innsActive[team], POP.innCap),
      crowded: g.popCur[team] > g.popCap[team],
      stockSecs:
        upkeep > 0 ? (g.res[team].food + g.granary[team]) / upkeep : Infinity,
    };
  }

  private stepMind(m: Mind, u: Unit, c: TeamCtx, now: number, fresh: boolean): void {
    const g = this.g;
    m.t = now;
    if (u.hp < m.lastHp - 0.25 * u.maxHp)
      this.remember(m, "wounded", -9, "Was hurt in a fight", now);
    m.lastHp = u.hp;
    if (c.famine) {
      m.famT++;
      if (m.famT === 6)
        this.remember(m, "hunger", -10, "Went hungry while the stores ran dry", now);
    } else m.famT = 0;

    // who is around this person?
    const n = g.queryUnitsInto(this.buf, u.x, u.y, MIND.threatR);
    let enemyD = Infinity;
    let friends = 0;
    let guards = 0;
    const nb2 = MIND.neighbourR * MIND.neighbourR;
    for (let i = 0; i < n; i++) {
      const o = this.buf[i];
      if (o.id === u.id) continue;
      const dx = o.x - u.x;
      const dy = o.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (o.team !== u.team) {
        if (UNIT_DEFS[o.type].military) {
          const d = Math.sqrt(d2);
          if (d < enemyD) enemyD = d;
        }
      } else if (o.type === "villager") {
        if (d2 <= nb2) friends++;
      } else if (UNIT_DEFS[o.type].military) guards++;
    }
    if (enemyD > MIND.threatR) enemyD = Infinity;

    // ── food
    let ft: number;
    let fc: string;
    if (c.famine) {
      ft = 4;
      fc = "famine";
    } else {
      ft = FOOD_BASE[c.ration];
      fc = FOOD_CAUSE[c.ration];
      if (c.ration === 1 && this.has(m, "frugal")) ft += 18;
      if (c.stockSecs < 90) {
        const lim = 30 + c.stockSecs * 0.4;
        if (lim < ft) {
          ft = lim;
          fc = "lowStock";
        }
      }
    }

    // ── safety
    let st = 82;
    let sc = "peace";
    if (c.towers > 0) {
      st += c.towers * 3;
      sc = "towers";
    }
    if (guards > 0) {
      st += Math.min(8, guards * 2);
      if (sc === "peace") sc = "guarded";
    }
    if (enemyD < MIND.threatR) {
      const closeness = 1 - enemyD / MIND.threatR;
      st -= 10 + 65 * closeness;
      sc = enemyD < MIND.closeR ? "enemyClose" : "enemyNear";
    }
    if (c.alarmAge < 20) {
      st -= 15;
      if (enemyD === Infinity) sc = "alarm";
    }

    // ── belonging: the biggest single influence names the cause
    const parts: Array<[string, number]> = [
      ["shrine", c.shrines * 12 * (this.has(m, "devout") ? 2 : 1)],
      ["inn", c.inns * 10 * (this.has(m, "sociable") ? 1.5 : 1)],
      friends === 0 ? ["alone", -14] : ["company", Math.min(3, friends) * 4],
      ["grief", -Math.min(25, c.grief * 2)],
      ["crowding", c.crowded ? -10 : 0],
    ];
    let bt = 50;
    let bc = "plain";
    let bestAbs = 0;
    for (const [code, v] of parts) {
      bt += v;
      if (Math.abs(v) > bestAbs) {
        bestAbs = Math.abs(v);
        bc = code;
      }
    }

    // ── purpose
    let pt: number;
    let pc: string;
    const taxPen = TAX_PEN[c.tax] * (this.has(m, "proud") ? 2 : 1);
    if (u.state === "harvest" || u.state === "build" || u.state === "repair") {
      m.idle = 0;
      pt = 80 - taxPen;
      pc = taxPen >= 8 ? "taxes" : "working";
    } else if (u.state === "idle") {
      m.idle++;
      pt = Math.max(12, 66 - m.idle * (this.has(m, "ambitious") ? 2.2 : 1.2)) - taxPen;
      pc = "idle";
    } else {
      m.idle = 0;
      pt = m.needs[3]; // walking: no pressure either way
      pc = "walking";
    }

    const targets: Quad = [
      clamp(ft, 0, 100),
      clamp(st, 0, 100),
      clamp(bt, 0, 100),
      clamp(pt, 0, 100),
    ];
    const fearSlow = this.has(m, "fearful") ? 1.8 : 1;
    for (let i = 0; i < 4; i++) {
      if (fresh) {
        m.needs[i] = q4(targets[i]);
        continue;
      }
      const cur = m.needs[i];
      let rate = targets[i] < cur ? EASE[i][0] : EASE[i][1];
      if (i === 1 && targets[i] > cur) rate = rate / fearSlow;
      m.needs[i] = q4(clamp(cur + (targets[i] - cur) * rate, 0, 100));
    }
    m.cause = [fc, sc, bc, pc];
    this.refresh(m);
  }

  // ── memories ───────────────────────────────────────────────────────────────

  private remember(m: Mind, k: MemKind, mag: number, text: string, now: number): void {
    for (const e of m.mem)
      if (e.k === k && e.text === text) {
        e.t = now;
        e.mag = mag;
        this.refresh(m);
        return;
      }
    m.mem.push({ k, t: now, mag, text });
    if (m.mem.length > MIND.maxMem) {
      // forget the one that currently matters least (oldest on ties)
      let worst = 0;
      let worstV = Infinity;
      for (let i = 0; i < m.mem.length; i++) {
        const v = Math.abs(m.mem[i].mag) * this.fade(m.mem[i], now);
        if (v < worstV) {
          worstV = v;
          worst = i;
        }
      }
      m.mem.splice(worst, 1);
    }
    this.refresh(m);
  }

  private rememberAll(team: Team, k: MemKind, mag: number, text: string, now: number): void {
    for (const m of this.minds.values())
      if (m.team === team)
        this.remember(m, k, this.has(m, "devout") && k === "blessing" ? mag * 1.5 : mag, text, now);
  }

  private fade(e: Memory, at: number): number {
    return clamp(1 - (at - e.t) / MIND.ttl, 0, 1);
  }

  /** the engine calls this just before a unit is removed because it died */
  noteDeath(u: Unit): void {
    const g = this.g;
    const now = g.time;
    const dead = u.type === "villager" ? this.minds.get(u.id) : undefined;
    if (dead) {
      this.fallen.push({ id: dead.id, team: dead.team, name: dead.name, t: now });
      if (this.fallen.length > MIND.fallenMax) this.fallen.shift();
    }
    const military = UNIT_DEFS[u.type].military;
    if (!dead && !military) return;
    const r2 = MIND.witnessR * MIND.witnessR;
    for (const m of this.minds.values()) {
      if (m.id === u.id) continue;
      const e = g.byId.get(m.id);
      if (!e || !("state" in e)) continue;
      const dx = e.x - u.x;
      const dy = e.y - u.y;
      if (dx * dx + dy * dy > r2) continue;
      if (m.team === u.team) {
        if (dead) this.remember(m, "death", -14, `Saw ${dead.name} fall`, now);
        else this.remember(m, "death", -7, "Saw a soldier fall", now);
      } else if (military) {
        this.remember(m, "victory", 5, "Saw raiders cut down", now);
      }
    }
  }

  // ── mood: one function builds both the number and its explanation ──────────

  private weights(m: Mind): Record<NeedId, number> {
    const a = TRAITS[m.traits[0]];
    const b = TRAITS[m.traits[1]];
    const raw = {} as Record<NeedId, number>;
    let sum = 0;
    for (const n of NEEDS) {
      raw[n] = BASE_W[n] * (a.w?.[n] ?? 1) * (b.w?.[n] ?? 1);
      sum += raw[n];
    }
    for (const n of NEEDS) raw[n] = raw[n] / sum;
    return raw;
  }

  private factors(m: Mind): MindWhy[] {
    const a = TRAITS[m.traits[0]];
    const b = TRAITS[m.traits[1]];
    const bad = (a.bad ?? 1) * (b.bad ?? 1);
    const w = this.weights(m);
    const out: MindWhy[] = [];
    for (let i = 0; i < 4; i++) {
      const need = NEEDS[i];
      let d = w[need] * (m.needs[i] - 50);
      if (d < 0) d *= bad;
      out.push({ label: NEED_LABEL[need], delta: d, text: causeText(need, m.cause[i]) });
    }
    if (m.disp !== 0)
      out.push({
        label: "Temperament",
        delta: m.disp < 0 ? m.disp * bad : m.disp,
        text: m.disp > 0 ? "Naturally cheerful" : "Naturally gloomy",
      });
    for (const e of m.mem) {
      let d = e.mag * this.fade(e, m.t);
      if (d < 0) d *= bad;
      if (d !== 0) out.push({ label: "Memory", delta: d, text: e.text });
    }
    return out;
  }

  private refresh(m: Mind): void {
    let sum = 50;
    for (const f of this.factors(m)) sum += f.delta;
    m.mood = clamp(sum, 0, 100);
  }

  // ── read API ───────────────────────────────────────────────────────────────

  /**
   * Work-speed multiplier for one villager. Named villagers use their own mood;
   * the anonymous rest of the crowd uses their team's average mood (cached once
   * per second and saved with the match, so a reload cannot change it).
   */
  workMult(u: Unit): number {
    const m = this.minds.get(u.id);
    if (m) return workFromMood(m.mood);
    const s = this.cache[u.team];
    return s.named ? workFromMood(s.avgMood) : 1;
  }

  count(team?: Team): number {
    if (team === undefined) return this.minds.size;
    let n = 0;
    for (const m of this.minds.values()) if (m.team === team) n++;
    return n;
  }

  ids(team: Team): number[] {
    const out: number[] = [];
    for (const m of this.minds.values()) if (m.team === team) out.push(m.id);
    return out;
  }

  /** unrounded explanation: mood === clamp(50 + sum(deltas), 0, 100) exactly */
  explain(id: number): { mood: number; factors: MindWhy[] } | null {
    const m = this.minds.get(id);
    if (!m) return null;
    return { mood: m.mood, factors: this.factors(m) };
  }

  viewOf(id: number): MindView | null {
    const m = this.minds.get(id);
    if (!m) return null;
    const mood = Math.round(m.mood);
    const why = this.factors(m)
      .filter((f) => Math.abs(f.delta) >= 1.5)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, 3)
      .map((f) => ({ label: f.label, delta: Math.round(f.delta * 10) / 10, text: f.text }));
    const memories = m.mem
      .filter((e) => this.fade(e, m.t) > 0)
      .sort((x, y) => y.t - x.t)
      .map((e) => ({ text: e.text, mag: e.mag }));
    const t0 = TRAITS[m.traits[0]];
    const t1 = TRAITS[m.traits[1]];
    return {
      id: m.id,
      name: m.name,
      mood,
      label: moodLabel(mood),
      traits: [t0, t1].map((t) => ({ id: t.id, name: t.name, blurb: t.blurb })),
      needs: {
        food: Math.round(m.needs[0]),
        safety: Math.round(m.needs[1]),
        belonging: Math.round(m.needs[2]),
        purpose: Math.round(m.needs[3]),
      },
      work: Math.round(workFromMood(m.mood) * 100) / 100,
      why,
      memories,
    };
  }

  stats(team: Team): MindStats {
    return this.cache[team];
  }

  fallenCount(): number {
    return this.fallen.length;
  }

  private recomputeStats(): void {
    for (const t of [0, 1] as const) {
      let named = 0;
      let sum = 0;
      let unhappy = 0;
      let desperate = 0;
      const worst: Array<{ id: number; name: string; mood: number }> = [];
      for (const m of this.minds.values()) {
        if (m.team !== t) continue;
        named++;
        sum += m.mood;
        if (m.mood < MIND.unhappyBelow) unhappy++;
        if (m.mood < MIND.desperateBelow) desperate++;
        const mood = Math.round(m.mood);
        let at = worst.length;
        while (at > 0 && worst[at - 1].mood > mood) at--;
        if (at < 3) {
          worst.splice(at, 0, { id: m.id, name: m.name, mood });
          if (worst.length > 3) worst.pop();
        }
      }
      this.cache[t] = {
        named,
        avgMood: named ? Math.round(sum / named) : 0,
        unhappy,
        desperate,
        worst,
      };
    }
  }

  /** compact fingerprint of everyone's state (tests; not part of stateHash) */
  hash(): string {
    const ids = [...this.minds.keys()].sort((a, b) => a - b);
    let s = `${this.fallen.length}`;
    for (const id of ids) {
      const m = this.minds.get(id)!;
      s += `|${id},${Math.round(m.mood * 100)},${m.needs.map((x) => Math.round(x * 100)).join(".")},${m.mem.length}`;
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  // ── save / load ────────────────────────────────────────────────────────────

  serialize(): unknown {
    const out: unknown[] = [];
    for (const m of this.minds.values())
      out.push([
        m.id,
        m.needs,
        m.cause.join("|"),
        m.idle,
        m.famT,
        m.lastHp,
        m.t,
        m.mem.map((e) => [e.k, e.t, e.mag, e.text]),
      ]);
    return {
      v: 1,
      sh: this.shrinesSeen,
      pl: this.plentyT,
      // the cached village mood drives anonymous villagers' work speed, so it
      // must come back exactly (memories can change a mood between updates)
      av: [this.cache[0].avgMood, this.cache[1].avgMood],
      fallen: this.fallen.map((f) => [f.id, f.team, f.name, f.t]),
      m: out,
    };
  }

  /** call after the units exist; unknown / malformed entries are skipped */
  deserialize(raw: unknown): void {
    const d = raw as {
      v?: number;
      sh?: number[];
      pl?: number[];
      av?: number[];
      fallen?: Array<[number, Team, string, number]>;
      m?: Array<[number, number[], string, number, number, number, number, Array<[string, number, number, string]>]>;
    } | null;
    if (!d || d.v !== 1 || !Array.isArray(d.m)) return;
    const num = (x: unknown, fb: number): number =>
      typeof x === "number" && Number.isFinite(x) ? x : fb;
    this.minds.clear();
    if (Array.isArray(d.sh) && d.sh.length === 2)
      this.shrinesSeen = [num(d.sh[0], -1), num(d.sh[1], -1)];
    if (Array.isArray(d.pl) && d.pl.length === 2)
      this.plentyT = [num(d.pl[0], 0), num(d.pl[1], 0)];
    this.fallen = [];
    for (const f of d.fallen ?? []) {
      if (!Array.isArray(f) || typeof f[2] !== "string") continue;
      this.fallen.push({ id: num(f[0], -1), team: f[1] === 1 ? 1 : 0, name: f[2].slice(0, 40), t: num(f[3], 0) });
    }
    if (this.fallen.length > MIND.fallenMax) this.fallen = this.fallen.slice(-MIND.fallenMax);
    for (const rec of d.m) {
      if (!Array.isArray(rec)) continue;
      const u = this.g.byId.get(num(rec[0], -1));
      if (!u || !("state" in u) || u.type !== "villager") continue;
      if (this.minds.size >= MIND.cap * 2) break;
      const m = this.create(u);
      if (Array.isArray(rec[1]) && rec[1].length === 4)
        for (let i = 0; i < 4; i++) m.needs[i] = clamp(num(rec[1][i], m.needs[i]), 0, 100);
      if (typeof rec[2] === "string") {
        const parts = rec[2].split("|");
        if (parts.length === 4) m.cause = [parts[0], parts[1], parts[2], parts[3]];
      }
      m.idle = Math.max(0, num(rec[3], 0));
      m.famT = Math.max(0, num(rec[4], 0));
      m.lastHp = num(rec[5], u.hp);
      m.t = num(rec[6], this.g.time);
      m.mem = [];
      for (const e of Array.isArray(rec[7]) ? rec[7] : []) {
        if (!Array.isArray(e) || !MEM_KINDS.includes(e[0] as MemKind)) continue;
        if (typeof e[3] !== "string" || m.mem.length >= MIND.maxMem) continue;
        m.mem.push({
          k: e[0] as MemKind,
          t: num(e[1], m.t),
          mag: clamp(num(e[2], 0), -30, 30),
          text: e[3].slice(0, 80),
        });
      }
      this.refresh(m);
    }
    this.recomputeStats();
    if (Array.isArray(d.av) && d.av.length === 2) {
      this.cache[0].avgMood = clamp(num(d.av[0], this.cache[0].avgMood), 0, 100);
      this.cache[1].avgMood = clamp(num(d.av[1], this.cache[1].avgMood), 0, 100);
    }
  }
}
