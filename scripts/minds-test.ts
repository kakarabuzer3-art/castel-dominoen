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
import { MIND, MIND_FLAGS, WORK, moodLabel, workFromMood } from "../src/game/minds";
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
  // a stranger: friends of the victim grieve a *friend* (tested in section 7), not a sight
  const vFriends = g.minds.viewOf(victim.id)!.friends;
  const witness = ids
    .slice(1)
    .map((id) => g.units.find((u) => u.id === id)!)
    .find((u) => Math.hypot(u.x - victim.x, u.y - victim.y) < MIND.witnessR && !vFriends.includes(g.minds.viewOf(u.id)!.name))!;
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

// ── 7. social layer (Phase 3b): friendships, rumors, grief for a friend ──────
console.log("== social layer ==");
type Inner = { minds: Map<number, { id: number; team: number; ties: number[] }> };
const inner = (g: Game) => (g.minds as unknown as Inner).minds;
const RUMOR_TEXT: Record<string, string> = {
  famine: "the food stores are almost empty",
  raiders: "raiders are about to strike",
  plenty: "there is food aplenty",
  panic: "the keep is doomed",
};
// counted from each person's own view (the stats cache only refreshes on the next update)
const holders = (g: Game, kind: string): number =>
  g.minds.ids(0).filter((id) => g.minds.viewOf(id)!.rumors.some((r) => r.text === RUMOR_TEXT[kind])).length;
const clampTo = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
{
  // friendships: mutual, same team, never more than MIND.ties
  const g = mk(301);
  crowd(g, 40);
  g.step(5);
  const all = inner(g);
  let mutual = true;
  let capped = true;
  let sameTeam = true;
  let withFriend = 0;
  for (const m of all.values()) {
    if (m.ties.length > MIND.ties) capped = false;
    if (m.ties.length > 0) withFriend++;
    for (const tid of m.ties) {
      const o = all.get(tid);
      if (!o || !o.ties.includes(m.id)) mutual = false;
      if (o && o.team !== m.team) sameTeam = false;
    }
  }
  check("friendships are mutual", mutual);
  check(`nobody has more than ${MIND.ties} close friends`, capped);
  check("friends are always on the same team", sameTeam);
  check("most people have at least one friend", withFriend >= all.size * 0.7, `${withFriend}/${all.size}`);
}
{
  // a rumor spreads along friendships and moves mood — causally
  const a = mk(302);
  const b = mk(302); // control: identical village, nobody whispers
  for (const g of [a, b]) {
    crowd(g, 40);
    g.step(5);
  }
  const planted = a.minds.plantRumor(0, "panic", 1);
  check("a planted rumor reaches exactly one person at first", planted === 1 && holders(a, "panic") === 1);
  // the village sees nothing wrong (stores full, no attack), so this rumor is short-lived:
  // watch it second by second and measure it at its widest
  let peak = 0;
  let peakAt = 0;
  let heard: number[] = [];
  for (let s = 1; s <= 14; s++) {
    a.step(1);
    b.step(1);
    const h = holders(a, "panic");
    if (h > peak) {
      peak = h;
      peakAt = s;
      heard = a.minds.ids(0).filter((id) => a.minds.viewOf(id)!.rumors.length > 0);
    }
  }
  check("…and spreads through the village", peak >= 3 && peak <= a.minds.count(0), `${peak} of ${a.minds.count(0)} believed it at the widest (after ${peakAt} s)`);
  // measure the mood effect at that same moment in both villages
  const a2 = mk(302);
  const b2 = mk(302);
  for (const g of [a2, b2]) {
    crowd(g, 40);
    g.step(5);
  }
  a2.minds.plantRumor(0, "panic", 1);
  a2.step(peakAt);
  b2.step(peakAt);
  const heard2 = a2.minds.ids(0).filter((id) => a2.minds.viewOf(id)!.rumors.length > 0);
  const diff = mean(heard2.map((id) => b2.minds.viewOf(id)!.mood - a2.minds.viewOf(id)!.mood));
  check("people who heard it are measurably less happy than in the control village", heard2.length >= 3 && diff > 2, `${heard2.length} people, mood -${diff.toFixed(1)} on average`);
  const retold = heard2.map((id) => a2.minds.viewOf(id)!).flatMap((v) => v.rumors).find((r) => r.hops >= 1);
  check("a retold rumor remembers who told them and how many times it was retold", !!retold && retold.from !== "", JSON.stringify(retold));
  heard = heard2;
  // honesty: the rumor shows up in the explanation and the total still adds up
  let honest = true;
  let named = false;
  for (const id of heard) {
    const ex = a2.minds.explain(id)!;
    const sum = ex.factors.reduce((s, f) => s + f.delta, 0);
    if (Math.abs(clampTo(50 + sum, 0, 100) - ex.mood) > 1e-9) honest = false;
    if (ex.factors.some((f) => f.label === "Rumor" && f.text.includes("the keep is doomed"))) named = true;
  }
  check("the explanation names the rumor", named);
  check("mood == clamp(50 + sum(why)) still holds for everyone who heard a rumor", honest, `${heard.length} people`);
  // rumors fade on their own
  a.step(240);
  check("with nothing to feed it, the rumor dies out", holders(a, "panic") === 0, `${holders(a, "panic")} still repeating it`);
}
{
  // reality replaces the rumor instead of double-counting with it
  const g = mk(303);
  crowd(g, 20);
  g.step(5);
  g.minds.plantRumor(0, "raiders", 1);
  const who = g.minds.ids(0).find((id) => g.minds.viewOf(id)!.rumors.some((r) => r.text.includes("raiders")))!;
  check("(setup) one person has heard raiders are coming", who !== undefined);
  g.alarm[0] = g.time; // a building really was just attacked
  g.step(3);
  const v = g.minds.viewOf(who)!;
  const ex = g.minds.explain(who)!;
  check("once the danger is real the rumor about it is dropped", !v.rumors.some((r) => r.text.includes("raiders")), JSON.stringify(v.rumors));
  check("…so the mood is explained by the real alarm, not counted twice", !ex.factors.some((f) => f.label === "Rumor" && f.text.includes("raiders")));
}
{
  // losing a friend hurts more than watching a stranger fall
  const g = mk(304);
  crowd(g, 30);
  g.step(5);
  const all = inner(g);
  const victimId = [...all.values()].find((m) => m.team === 0 && m.ties.length >= 1)!.id;
  const victim = g.units.find((u) => u.id === victimId)!;
  const vName = g.minds.viewOf(victimId)!.name;
  const friendId = all.get(victimId)!.ties[0];
  const friendBefore = g.minds.viewOf(friendId)!;
  check("(setup) the friend lists the victim by name", friendBefore.friends.includes(vName));
  const stranger = [...all.values()].find(
    (m) => m.team === 0 && m.id !== victimId && !all.get(victimId)!.ties.includes(m.id) && g.units.some((u) => u.id === m.id && Math.hypot(u.x - victim.x, u.y - victim.y) < MIND.witnessR),
  );
  const strangerBefore = stranger ? g.minds.viewOf(stranger.id)!.mood : NaN;
  victim.hp = 0;
  g.step(2);
  const fa = g.minds.viewOf(friendId)!;
  check("the friend remembers losing them by name", fa.memories.some((m) => m.text === `Lost their friend ${vName}`), fa.memories.map((m) => m.text).join("; "));
  check("…and no longer counts them as a living friend", !fa.friends.includes(vName));
  check("…and is far less happy than before", fa.mood < friendBefore.mood - 5, `${friendBefore.mood} -> ${fa.mood}`);
  if (stranger) {
    const sa = g.minds.viewOf(stranger.id)!;
    check("a stranger who merely saw it is hurt less than the friend", friendBefore.mood - fa.mood > strangerBefore - sa.mood, `friend -${friendBefore.mood - fa.mood}, stranger -${strangerBefore - sa.mood}`);
  }
}
{
  // determinism, persistence, compatibility
  const run = (): Game => {
    const g = mk(305);
    crowd(g, 40);
    g.step(5);
    g.minds.plantRumor(0, "famine", 2);
    g.step(40);
    return g;
  };
  const a = run();
  const b = run();
  check("social layer is deterministic (same seed -> identical mind fingerprint)", a.minds.hash() === b.minds.hash());
  check("…and identical simulation hash", a.stateHash() === b.stateHash());

  const g2 = new Game(null, 1);
  check("a save with friendships and rumors loads", g2.loadFrom(a.serialize()));
  check("save/load: identical mind fingerprint (ties + rumors included)", a.minds.hash() === g2.minds.hash());
  let same = true;
  for (const id of a.minds.ids(0)) {
    const x = a.minds.viewOf(id);
    const y = g2.minds.viewOf(id);
    if (!x || !y || x.friends.join() !== y.friends.join() || JSON.stringify(x.rumors) !== JSON.stringify(y.rumors)) same = false;
  }
  check("save/load: same friends and same rumors for everyone", same, `${a.minds.count(0)} people`);
  check("save/load: the rumor is still being passed on after loading", holders(g2, "famine") === holders(a, "famine"), `${holders(g2, "famine")} holders`);

  // a Phase 3a save (minds without friends/rumors) still loads, with no friendships
  const old = JSON.parse(a.serialize()) as { minds: { m: unknown[][] } };
  old.minds.m = old.minds.m.map((r) => r.slice(0, 8));
  const g3 = new Game(null, 1);
  check("a Phase 3a save (no friendships) still loads", g3.loadFrom(JSON.stringify(old)));
  check("…nobody holds a rumor, and the old villagers are given friendships on load", g3.minds.ids(0).every((id) => g3.minds.viewOf(id)!.rumors.length === 0) && g3.minds.ids(0).some((id) => g3.minds.viewOf(id)!.friends.length > 0));
  const m3 = inner(g3);
  let ok3 = true;
  for (const m of m3.values()) {
    if (m.ties.length > MIND.ties) ok3 = false;
    for (const tid of m.ties) if (!m3.get(tid)?.ties.includes(m.id)) ok3 = false;
  }
  check("…and those friendships are mutual and within the cap", ok3);
}
{
  // the switch: off means no friendships, no rumors, nothing planted
  MIND_FLAGS.social = false;
  const g = mk(306);
  crowd(g, 30);
  g.step(5);
  const planted = g.minds.plantRumor(0, "panic", 3);
  g.step(20);
  const noTies = g.minds.ids(0).every((id) => g.minds.viewOf(id)!.friends.length === 0);
  const noRumors = g.minds.ids(0).every((id) => g.minds.viewOf(id)!.rumors.length === 0);
  MIND_FLAGS.social = true;
  check("social layer OFF: no friendships, no rumors, plantRumor does nothing", planted === 0 && noTies && noRumors);
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
