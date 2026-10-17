/**
 * Phase 2 — "minds" (named villagers). Headless; no browser, no server.
 *
 *  1. Determinism: same seed -> identical minds; different seed -> different people.
 *  2. Work speed (Phase 3a): mood changes how fast people work — bounded, causal,
 *     and deterministic now that minds are part of stateHash().
 *  3. Honesty: the "why" list always adds up to the mood it explains.
 *  4. Reactions: different decisions / events produce different, explainable moods.
 *  5. Persistence: save/load restores everyone; garbage input never throws.
 */
import { defaultMatchConfig, type MatchConfig } from "../src/game/constants";
import { Game } from "../src/game/engine";
import { MIND, WORK, moodLabel, workFromMood } from "../src/game/minds";
import type { Unit } from "../src/game/types";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

const cfg = (over: Partial<MatchConfig>): MatchConfig => ({
  ...defaultMatchConfig(),
  size: "S",
  map: "verdant",
  lord: 0,
  mode: "sandbox", // passive neighbour: scenario tests must not be raided
  ...over,
});

function mk(seed: number, over: Partial<MatchConfig> = {}): Game {
  const g = new Game(null, seed);
  g.startMatch(cfg({ seed, ...over }));
  return g;
}

/** a ring of extra villagers so every trait is represented */
function crowd(g: Game, n: number): void {
  const k = g.buildingById.get(g.keeps[0])!;
  for (let i = 0; i < n; i++)
    g.spawnUnit(
      0,
      "villager",
      (k.tx + 1 + (i % 12)) * 32 + 16,
      (k.ty + k.h + 2 + Math.floor(i / 12)) * 32 + 16,
    );
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const snapshotOfUnits = (g: Game): string =>
  [...g.units]
    .sort((a, b) => a.id - b.id)
    .map((u: Unit) => `${u.id}:${u.type}:${Math.round(u.x * 100)}:${Math.round(u.y * 100)}:${Math.round(u.hp * 100)}`)
    .join("|");

// ── 1. determinism ───────────────────────────────────────────────────────────
console.log("== determinism ==");
{
  const a = mk(4242, { mode: "skirmish" });
  const b = mk(4242, { mode: "skirmish" });
  a.step(120);
  b.step(120);
  check("same seed: identical mind fingerprint", a.minds.hash() === b.minds.hash(), a.minds.hash());
  check("same seed: identical simulation hash", a.stateHash() === b.stateHash());
  check("minds exist for both teams", a.minds.count(0) >= 4 && a.minds.count(1) >= 4, `${a.minds.count(0)}/${a.minds.count(1)}`);

  const c = mk(9001, { mode: "skirmish" });
  c.step(120);
  const namesA = a.minds.ids(0).map((id) => a.minds.viewOf(id)!.name).join(",");
  const namesC = c.minds.ids(0).map((id) => c.minds.viewOf(id)!.name).join(",");
  check("different seed: different people", namesA !== namesC, `${namesA.slice(0, 40)} vs ${namesC.slice(0, 40)}`);

  let okIdentity = true;
  for (const id of a.minds.ids(0)) {
    const v = a.minds.viewOf(id)!;
    if (!v.name.includes(" ") || v.traits.length !== 2 || v.traits[0].id === v.traits[1].id) okIdentity = false;
  }
  check("every person has a full name and two different traits", okIdentity);
}

// ── 2. mood steers work speed (Phase 3a): bounded, causal, deterministic ─────
console.log("== work speed ==");
{
  check("work multiplier: a neutral mood is exactly x1.00", workFromMood(WORK.neutral) === 1);
  check(
    "work multiplier: clamped to [min, max] at the extremes",
    workFromMood(-50) === WORK.min && workFromMood(500) === WORK.max &&
      workFromMood(0) >= WORK.min && workFromMood(100) <= WORK.max,
    `mood 0 -> x${workFromMood(0).toFixed(3)}, mood 100 -> x${workFromMood(100).toFixed(3)}`,
  );
  let mono = true;
  for (let m = 1; m <= 100; m++) if (workFromMood(m) < workFromMood(m - 1)) mono = false;
  check("work multiplier never falls as mood rises", mono);

  // One worker, one inexhaustible tree, two worlds. The ONLY difference: in one
  // a (siege-only, so harmless) enemy catapult stands near the worker and scares them.
  const pace = (menace: boolean) => {
    const g = mk(55);
    const k = g.buildingById.get(g.keeps[0])!;
    const tree = g.nearestNode("wood", (k.tx + 2) * 32, (k.ty + k.h + 2) * 32, 60 * 32)!;
    tree.amount = tree.maxAmount = 1e6; // measure pace, not depletion
    const w = g.spawnUnit(0, "villager", tree.tx * 32 + 16 + 18, tree.ty * 32 + 16);
    g.assignHarvest(w, tree.id);
    if (menace) g.spawnUnit(1, "catapult", w.x + 110, w.y);
    g.step(90);
    return { wood: g.stats.gathered.wood, view: g.minds.viewOf(w.id)! };
  };
  const calm = pace(false);
  const scared = pace(true);
  check(
    "a frightened worker has a lower mood and a lower work multiplier",
    scared.view.mood < calm.view.mood - 10 && scared.view.work < calm.view.work,
    `mood ${scared.view.mood} vs ${calm.view.mood}, x${scared.view.work} vs x${calm.view.work}`,
  );
  check(
    "…and really brings in less wood",
    scared.wood < calm.wood * 0.96,
    `${scared.wood.toFixed(1)} vs ${calm.wood.toFixed(1)} wood in 90 s`,
  );
  const measured = scared.wood / calm.wood;
  const expected = scared.view.work / calm.view.work;
  check(
    "…by about as much as the multipliers say it should",
    Math.abs(measured - expected) < 0.08,
    `measured ${measured.toFixed(3)} vs expected ${expected.toFixed(3)}`,
  );
}

// ── 2b. determinism now that minds are simulation state ──────────────────────
console.log("== determinism (minds are state) ==");
{
  const over = { mode: "skirmish" as const, lord: 0, difficulty: 3 as const };
  const a = mk(777, over);
  const b = mk(777, over);
  a.step(600);
  b.step(600);
  check("brutal AI skirmish 600 s: two runs end in an identical stateHash", a.stateHash() === b.stateHash(), a.stateHash().slice(-40));
  check("…and every unit is identical (id, type, x, y, hp)", snapshotOfUnits(a) === snapshotOfUnits(b), `${a.units.length} units, phase ${a.phase}`);
  check("the mind fingerprint is part of stateHash()", a.stateHash().endsWith(`|${a.minds.hash()}`));
}
{
  // a scripted brawl guarantees casualties, so noteDeath and the fallen list run
  const brawl = (g: Game): void => {
    const k = g.buildingById.get(g.keeps[0])!;
    const cx = (k.tx + 3) * 32;
    const cy = (k.ty + k.h + 3) * 32;
    for (let i = 0; i < 8; i++) g.spawnUnit(1, "militia", cx + 140 + i * 14, cy);
    for (let i = 0; i < 5; i++) g.spawnUnit(1, "archer", cx + 200, cy + i * 16);
    for (let i = 0; i < 6; i++) g.spawnUnit(0, "militia", cx + 60 + i * 10, cy + 12);
    crowd(g, 20);
  };
  const a = mk(2024);
  const b = mk(2024);
  brawl(a);
  brawl(b);
  a.step(90);
  b.step(90);
  const deaths = a.deaths[0] + a.deaths[1];
  check("scripted brawl really produced casualties", deaths >= 5, `${deaths} deaths`);
  check("brawl: two runs end in an identical stateHash", a.stateHash() === b.stateHash(), a.stateHash().slice(-30));
  check("brawl: every unit identical", snapshotOfUnits(a) === snapshotOfUnits(b), `${a.units.length} units`);
  check("brawl: the fallen are recorded by name", a.minds.fallenCount() > 0, `fallen ${a.minds.fallenCount()}`);
}

// ── 3. honesty: the explanation adds up ──────────────────────────────────────
console.log("== honesty ==");
{
  const g = mk(31);
  crowd(g, 60);
  g.ration[0] = 1;
  g.step(75);
  let n = 0;
  let worst = 0;
  let labelsOk = true;
  for (const id of g.minds.ids(0)) {
    const ex = g.minds.explain(id)!;
    const sum = ex.factors.reduce((s, f) => s + f.delta, 50);
    const clamped = Math.max(0, Math.min(100, sum));
    worst = Math.max(worst, Math.abs(clamped - ex.mood));
    const v = g.minds.viewOf(id)!;
    if (v.label !== moodLabel(v.mood)) labelsOk = false;
    n++;
  }
  check(`mood == clamp(50 + sum(why)) for all ${n} people`, n > 50 && worst < 1e-9, `max error ${worst}`);
  check("mood label always matches the mood number", labelsOk);
  const v = g.minds.viewOf(g.minds.ids(0)[0])!;
  check("HUD view is bounded (<=3 reasons, 0..100 needs)",
    v.why.length <= 3 && Object.values(v.needs).every((x) => x >= 0 && x <= 100) && v.mood >= 0 && v.mood <= 100);
}

// ── 4. reactions ─────────────────────────────────────────────────────────────
console.log("== reactions ==");
{
  const fed = mk(55);
  const hungry = mk(55);
  crowd(fed, 40);
  crowd(hungry, 40);
  fed.ration[0] = 3;
  hungry.ration[0] = 0;
  fed.step(60);
  hungry.step(60);
  const mf = fed.minds.stats(0).avgMood;
  const mh = hungry.minds.stats(0).avgMood;
  check("extra rations make the village happier than no rations", mf > mh + 8, `avg mood ${mf} vs ${mh}`);
  const worstId = hungry.minds.stats(0).worst[0].id;
  const why = hungry.minds.viewOf(worstId)!.why;
  const food = why.find((w) => w.label === "Food");
  check(
    'the unhappiest person is told "No rations are being issued"',
    !!food && food.delta < 0 && food.text === "No rations are being issued",
    JSON.stringify(why.map((w) => `${w.label}:${w.delta}`)),
  );

  // traits change reactions: frugal people cope with half rations
  const half = mk(55);
  crowd(half, 80);
  half.ration[0] = 1;
  half.step(80);
  const frugal: number[] = [];
  const other: number[] = [];
  for (const id of half.minds.ids(0)) {
    const v = half.minds.viewOf(id)!;
    (v.traits.some((t) => t.id === "frugal") ? frugal : other).push(v.needs.food);
  }
  check(
    "traits matter: frugal people feel half rations less than others",
    frugal.length >= 3 && other.length >= 3 && mean(frugal) > mean(other) + 5,
    `frugal ${mean(frugal).toFixed(1)} (n=${frugal.length}) vs others ${mean(other).toFixed(1)} (n=${other.length})`,
  );

  // an enemy soldier at the door frightens the people nearby
  const calm = mk(66);
  const scared = mk(66);
  const v0 = scared.units.find((u) => u.team === 0 && u.type === "villager")!;
  scared.spawnUnit(1, "militia", v0.x + 90, v0.y);
  scared.step(8);
  calm.step(8);
  const sc = scared.minds.viewOf(v0.id)!;
  const cc = calm.minds.viewOf(v0.id)!;
  check("an enemy soldier nearby lowers that person's safety", sc.needs.safety < cc.needs.safety - 15, `${sc.needs.safety} vs ${cc.needs.safety}`);
  check(
    "…and the explanation names the enemy",
    scared.minds.explain(v0.id)!.factors.some((f) => f.label === "Safety" && f.text.startsWith("Enemy soldiers")),
  );

  // a death is remembered by those who saw it
  const g = mk(88);
  crowd(g, 20);
  g.step(5);
  const ids = g.minds.ids(0);
  const victim = g.units.find((u) => u.id === ids[0])!;
  const vName = g.minds.viewOf(victim.id)!.name;
  const witness = ids.slice(1).map((id) => g.units.find((u) => u.id === id)!).find((u) => Math.hypot(u.x - victim.x, u.y - victim.y) < MIND.witnessR)!;
  const before = g.minds.viewOf(witness.id)!.mood;
  victim.hp = 0;
  g.step(2);
  const after = g.minds.viewOf(witness.id);
  check("a witness remembers the death by name", !!after && after.memories.some((m) => m.text === `Saw ${vName} fall`), after?.memories.map((m) => m.text).join("; "));
  check("…and is less happy for it", !!after && after.mood < before, `${before} -> ${after?.mood}`);
  check("the fallen are recorded and removed from the living", g.minds.fallenCount() >= 1 && g.minds.viewOf(victim.id) === null);
}

// ── 5. persistence + robustness ──────────────────────────────────────────────
console.log("== persistence ==");
{
  const g = mk(123);
  crowd(g, 30);
  g.ration[0] = 1;
  g.step(90);
  const json = g.serialize();
  const g2 = new Game(null, 1);
  const ok = g2.loadFrom(json);
  check("loadFrom accepts a save containing minds", ok);
  check("save/load: identical mind fingerprint", g.minds.hash() === g2.minds.hash(), `${g.minds.hash()} vs ${g2.minds.hash()}`);
  let same = g.minds.count() === g2.minds.count();
  for (const id of g.minds.ids(0)) {
    const a = g.minds.viewOf(id);
    const b = g2.minds.viewOf(id);
    if (!a || !b || a.name !== b.name || a.mood !== b.mood || a.traits[0].id !== b.traits[0].id) same = false;
  }
  check("save/load: same names, traits and moods for everyone", same, `${g.minds.count()} people`);

  const legacy = JSON.parse(json) as Record<string, unknown>;
  delete legacy.minds;
  const g3 = new Game(null, 1);
  check("old saves (no minds field) still load", g3.loadFrom(JSON.stringify(legacy)));
  g3.step(2);
  check("…and minds simply start fresh", g3.minds.count(0) > 0);

  let threw = false;
  const garbage: unknown[] = [null, 5, "x", {}, { v: 1 }, { v: 1, m: 7 }, { v: 1, m: [1, "x", [], null, [[]]] },
    { v: 1, m: [[999999, 5, 5, 5, 5, 5, 5, 5]] }, { v: 2, m: [] }, { v: 1, sh: "a", pl: [], fallen: [1, [1, 1, 5, 1]], m: [] }];
  for (const x of garbage) {
    try {
      g2.minds.deserialize(x);
    } catch {
      threw = true;
    }
  }
  check("garbage mind data never throws", !threw);
}

// ── 6. caps + cost ───────────────────────────────────────────────────────────
console.log("== caps and cost ==");
{
  const g = mk(5);
  crowd(g, 220);
  g.step(3);
  check(`at most ${MIND.cap} named villagers per team (the rest stay anonymous)`, g.minds.count(0) <= MIND.cap, `${g.minds.count(0)} named of ${g.units.filter((u) => u.team === 0 && u.type === "villager").length}`);
  const t0 = performance.now();
  const runs = 30;
  for (let i = 0; i < runs; i++) {
    // force an update pass: tickCount must be a multiple of MIND.every
    (g as unknown as { tickCount: number }).tickCount = MIND.every * (1000 + i);
    g.minds.update();
  }
  const per = (performance.now() - t0) / runs;
  check("one mind update (100 named villagers) stays cheap", per < 8, `${per.toFixed(2)} ms per pass (runs once per second of game time)`);
}

console.log(fails === 0 ? "\nMINDS TEST PASSED" : `\n${fails} MINDS CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
