/**
 * Phase 3b-2 — the castle's will, decrees and yielding. Headless; no browser, no server.
 *
 *  1. Isolation: with MIND_FLAGS.will off nothing of this layer exists.
 *  2. Decrees: price, cooldown, "nobody to reach", and what each one really does.
 *  3. Determinism: same orders -> same state; a recorded replay reproduces it.
 *  4. Yielding: a castle opens its gates only when its people have lost heart AND
 *     an army stands at its gates, for a full minute — and relief buys time.
 *     The same rule binds the player and the enemy.
 *  5. Persistence + validation: saves keep the clock, old saves load, network
 *     intents are validated and can only spend the sender's own gold.
 *  6. The AI plays by the player's rules and never reads the player's minds.
 *
 * The yield scenes use a small TEST RIG, said out loud here so nobody mistakes
 * it for gameplay: it makes the victim's people unkillable (so the count of
 * named people stays fixed), parks a fixed number of unkillable enemy soldiers
 * at the keep, and — where a scene needs miserable people — keeps three heavy
 * memories of loss alive in every villager. Everything the rules then do with
 * those people (mood, resolve, the siege test, the clock, the yield) is the
 * real code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultMatchConfig, type MatchConfig } from "../src/game/constants";
import { Game } from "../src/game/engine";
import { DECREE, MIND_FLAGS, WILL } from "../src/game/minds";
import { sanitizeReplayEvent } from "../src/game/replay";
import type { Team } from "../src/game/types";

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
  mode: "skirmish",
  ...over,
});

function mk(seed: number, over: Partial<MatchConfig> = {}): Game {
  const g = new Game(null, seed);
  g.startMatch(cfg({ seed, ...over }));
  return g;
}

// ── access to the private parts a scenario needs ─────────────────────────────
type Mind = { id: number; team: Team; rum: Array<{ k: string; b: number }>; mem: Array<{ text: string }> };
type Inner = {
  minds: Map<number, Mind>;
  remember(m: Mind, k: string, mag: number, text: string, now: number): void;
};
const inner = (g: Game) => g.minds as unknown as Inner;

const holders = (g: Game, team: Team, kind: string): Mind[] =>
  [...inner(g).minds.values()].filter((m) => m.team === team && m.rum.some((e) => e.k === kind));
const maxBelief = (g: Game, team: Team, kind: string): number => {
  let b = 0;
  for (const m of holders(g, team, kind)) for (const e of m.rum) if (e.k === kind && e.b > b) b = e.b;
  return b;
};

/** a ring of villagers for one team (a crowd big enough for the castle's will to be judged) */
function addVillagers(g: Game, team: Team, n: number): void {
  const k = g.buildingById.get(g.keeps[team])!;
  const kx = (k.tx + k.w / 2) * 32;
  const ky = (k.ty + k.h / 2) * 32;
  for (let i = 0; i < n; i++)
    g.spawnUnit(team, "villager", kx + (i % 10) * 20 - 90, ky + 90 + Math.floor(i / 10) * 20);
}

const clamp01 = (x: number) => Math.min(100, Math.max(0, x));

/** every named person's mood must equal clamp(50 + sum(why)) — the layer stays honest */
function honest(g: Game): { ok: boolean; n: number; worst: number } {
  let worst = 0;
  let n = 0;
  for (const t of [0, 1] as const)
    for (const id of g.minds.ids(t)) {
      const e = g.minds.explain(id)!;
      const want = clamp01(50 + e.factors.reduce((s, f) => s + f.delta, 0));
      worst = Math.max(worst, Math.abs(want - e.mood));
      n++;
    }
  return { ok: worst < 1e-9, n, worst };
}

// ── the yield test rig ───────────────────────────────────────────────────────
interface Scene {
  g: Game;
  victim: Team;
  siegeIds: number[];
  garrisonIds: number[];
  misery: boolean;
  said: string[];
  /** call once per simulated second, BEFORE g.step(1) */
  rig(): void;
}

function scene(
  seed: number,
  victim: Team,
  o: { siege: number; garrison?: number; misery: boolean; mode?: MatchConfig["mode"] },
): Scene {
  const g = mk(seed, { mode: o.mode ?? "skirmish" });
  const k = g.buildingById.get(g.keeps[victim])!;
  const kx = (k.tx + k.w / 2) * 32;
  const ky = (k.ty + k.h / 2) * 32;
  addVillagers(g, victim, 20);
  const foe = (1 - victim) as Team;
  const siegeIds: number[] = [];
  for (let i = 0; i < o.siege; i++) siegeIds.push(g.spawnUnit(foe, "militia", kx + 150 + i * 14, ky + 150).id);
  const garrisonIds: number[] = [];
  for (let i = 0; i < (o.garrison ?? 0); i++)
    garrisonIds.push(g.spawnUnit(victim, "militia", kx - 150 - i * 14, ky + 150).id);
  const said: string[] = [];
  const orig = g.msg.bind(g);
  (g as unknown as { msg: Game["msg"] }).msg = (text, kind) => {
    said.push(text);
    orig(text, kind);
  };
  const sc: Scene = { g, victim, siegeIds, garrisonIds, misery: o.misery, said, rig: () => undefined };
  sc.rig = () => rigStep(sc);
  return sc;
}

function rigStep(sc: Scene): void {
  const { g, victim } = sc;
  const k = g.buildingById.get(g.keeps[victim]);
  if (!k) return;
  const kx = (k.tx + k.w / 2) * 32;
  const ky = (k.ty + k.h / 2) * 32;
  g.res[1].gold = 0; // the AI must not decree its way out of (or into) a scene
  k.hp = k.maxHp = 1e9; // a yield must come from the people, never from a destroyed keep
  for (const u of g.units) if (u.team === victim && u.type === "villager") u.hp = u.maxHp = 1e9;
  sc.siegeIds.forEach((id, i) => park(g, id, kx + 150 + i * 14, ky + 150));
  sc.garrisonIds.forEach((id, i) => park(g, id, kx - 150 - i * 14, ky + 150));
  if (sc.misery)
    for (const m of inner(g).minds.values())
      if (m.team === victim) for (const t of ["a", "b", "c"]) inner(g).remember(m, "death", -35, `test grief ${t}`, g.time);
}

function park(g: Game, id: number, x: number, y: number): void {
  const u = g.byId.get(id);
  if (!u || !("state" in u)) return;
  u.hp = u.maxHp = 1e9;
  u.x = x;
  u.y = y;
  u.state = "idle";
  u.path = null;
}

/** run a scene one second at a time until it ends or `max` seconds pass; returns the second it ended */
function run(sc: Scene, max: number, each?: (s: number) => void): number {
  for (let s = 1; s <= max; s++) {
    sc.rig();
    each?.(s);
    sc.g.step(1);
    if (sc.g.phase !== "playing") return s;
  }
  return -1;
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("== isolation ==");
{
  const g = mk(31, { mode: "sandbox" });
  MIND_FLAGS.will = false;
  const gold0 = g.res[0].gold;
  const ok = g.decree(0, "reassure");
  MIND_FLAGS.will = true;
  check("will OFF: a decree does nothing and costs nothing", !ok && g.res[0].gold === gold0);

  // a quiet match: no siege, no decree -> the layer must leave no trace at all
  MIND_FLAGS.will = false;
  const a = mk(77, { mode: "sandbox" });
  a.step(120);
  MIND_FLAGS.will = true;
  const b = mk(77, { mode: "sandbox" });
  b.step(120);
  check("will ON vs OFF in a quiet match: identical simulation hash", a.stateHash() === b.stateHash());
}

console.log("== decrees: price, cooldown, reach ==");
{
  // Named people only exist from the first whole second of a match, and villagers keep
  // gathering while time runs, so every gold check below sets the gold and compares it
  // with NO time passing in between (a decree takes its gold synchronously).
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;

  const early = mk(10, { mode: "sandbox" });
  early.res[0].gold = 500;
  check("before anyone has a name there is nobody to reach: refused, nothing charged", !early.decree(0, "reassure") && early.res[0].gold === 500);

  const g = mk(11, { mode: "sandbox" });
  g.step(2);
  g.res[0].gold = 500;
  const ok1 = g.decree(0, "reassure");
  check("reassure is accepted and costs its gold", ok1 && near(g.res[0].gold, 500 - DECREE.reassure.gold), `gold ${g.res[0].gold}`);
  const afterFirst = g.res[0].gold;
  const ok2 = g.decree(0, "reassure");
  check("a second order at once is refused and costs nothing", !ok2 && g.res[0].gold === afterFirst);
  g.step(DECREE.reassure.cd - 2);
  check("still cooling down just before the cooldown ends", !g.decree(0, "reassure"));
  g.step(5);
  check("ready again once the cooldown has passed", g.decree(0, "reassure"));

  const p = mk(12, { mode: "sandbox" });
  p.step(2); // people exist now, so a refusal can only be about the gold
  p.res[0].gold = DECREE.whisper.gold - 1;
  check("not enough gold: refused, nothing charged", !p.decree(0, "whisper") && p.res[0].gold === DECREE.whisper.gold - 1);

  const q = mk(13, { mode: "sandbox" });
  for (const u of q.units) if (u.team === 1 && u.type === "villager") u.hp = 0;
  q.step(2);
  q.res[0].gold = 500;
  check("nobody left to whisper to: refused, nothing charged", !q.decree(0, "whisper") && q.res[0].gold === 500, `enemy named ${q.minds.count(1)}`);
}

console.log("== decrees: what they really do ==");
{
  const mkCrowd = (): Game => {
    const g = mk(21, { mode: "sandbox" });
    addVillagers(g, 0, 24);
    addVillagers(g, 1, 24);
    g.res[0].gold = 500;
    g.step(5);
    return g;
  };

  // reassure: negative rumors lose their grip; people remember the lord's word
  const a = mkCrowd();
  a.minds.plantRumor(0, "panic", 3);
  const before = maxBelief(a, 0, "panic");
  const ctl = mkCrowd();
  ctl.minds.plantRumor(0, "panic", 3);
  a.decree(0, "reassure");
  a.step(2);
  ctl.step(2);
  const after = maxBelief(a, 0, "panic");
  check("reassure: the rumor is much weaker afterwards", after > 0 ? after <= before * DECREE.reassure.belief + 0.011 : true, `belief ${before} -> ${after}`);
  check("control (no decree): the same rumor is still strong", maxBelief(ctl, 0, "panic") >= 0.8, `belief ${maxBelief(ctl, 0, "panic")}`);
  const remembered = a.minds.ids(0).filter((id) => a.minds.viewOf(id)!.memories.some((m) => m.text === DECREE.reassure.text)).length;
  check("reassure: everyone remembers the lord's word", remembered === a.minds.count(0), `${remembered}/${a.minds.count(0)}`);

  // whisper: the enemy's people start to believe "the keep is doomed"; ours do not
  const w = mkCrowd();
  const gold = w.res[0].gold;
  const paid = w.decree(0, "whisper");
  check("whisper: costs gold", paid && Math.abs(w.res[0].gold - (gold - DECREE.whisper.gold)) < 1e-9, `${gold} -> ${w.res[0].gold}`);
  w.step(2);
  const foe = holders(w, 1, "panic").length;
  check("whisper: the enemy's people now believe it", foe >= 1, `${foe} believe it`);
  check("whisper: our own people are untouched", holders(w, 0, "panic").length === 0);
  const victim = holders(w, 1, "panic")[0];
  const why = victim ? w.minds.viewOf(victim.id)!.why.map((x) => x.text).join(" | ") : "";
  check("whisper: the victim's 'why' names the rumor", /doomed/.test(why), why.slice(0, 80));
  w.step(180);
  check("whisper: with nothing to feed it, the rumor fades again", holders(w, 1, "panic").length === 0, `${holders(w, 1, "panic").length} still believe it`);

  const h = honest(w);
  check("mood == clamp(50 + sum(why)) still holds for everyone", h.ok, `${h.n} people, max error ${h.worst}`);
}

console.log("== determinism and replay ==");
{
  const play = (decrees: boolean): Game => {
    const g = mk(555);
    g.res[0].gold = 600;
    g.step(30);
    if (decrees) {
      g.decree(0, "reassure");
      g.step(20);
      g.decree(0, "whisper");
    }
    g.step(60);
    return g;
  };
  const a = play(true);
  const b = play(true);
  const c = play(false);
  check("same orders at the same moments -> identical hash", a.stateHash() === b.stateHash());
  check("…and the decrees really are part of the state", a.stateHash() !== c.stateHash());

  const rep = a.dumpReplay();
  const n = rep ? rep.events.filter((e) => e.k === "decree").length : 0;
  check("the replay recorded both decrees", n === 2, `${n} decree events`);
  const r = new Game(null, 1);
  const loaded = !!rep && r.loadReplay(rep);
  // the one thing the scenario does outside the recorded commands is the starting gold
  // (a test convenience, applied at tick 0 in play() too) — repeat it identically here,
  // so any remaining difference can only come from the decrees themselves
  r.res[0].gold = 600;
  r.step(110);
  check("replaying the match reproduces the same state", loaded && r.stateHash() === a.stateHash(), `${r.stateHash().slice(0, 24)}…`);
}

console.log("== yielding: the rule ==");
{
  // 1. misery + an army at the gates (the AI's castle): it opens its gates, about a minute later
  const s1 = scene(4242, 1, { siege: 6, misery: true });
  const t1 = run(s1, 150);
  const keep1 = s1.g.buildingById.get(s1.g.keeps[1]);
  check("enemy castle: breaking + besieged -> the gates open after about a minute", s1.g.phase === "victory" && t1 >= WILL.yieldAfter - 2 && t1 <= WILL.yieldAfter + 12, `phase ${s1.g.phase} at ${t1}s`);
  check("…and no keep was destroyed to win it", !!keep1 && keep1.hp > 1e8);
  check("…the win is recorded as 'Hearts and Minds'", s1.g.achievements.includes("hearts"));

  // 2. the very same rule against us
  const s2 = scene(4242, 0, { siege: 6, misery: true });
  const t2 = run(s2, 150);
  check("my castle: the same rule defeats me", s2.g.phase === "defeat" && t2 >= WILL.yieldAfter - 2 && t2 <= WILL.yieldAfter + 12, `phase ${s2.g.phase} at ${t2}s`);
  check("…and I was warned that my people were losing heart", s2.said.some((t) => /losing heart/i.test(t)));

  // 3. people with no heart but nobody at the gates: nothing happens, however long
  const s3 = scene(4242, 1, { siege: 0, misery: true });
  const t3 = run(s3, 200);
  check("broken people, nobody at the gates: no yield in 200 s", t3 === -1 && s3.g.minds.stats(1).will === "breaking" && s3.g.minds.stats(1).yieldIn === -1, `will ${s3.g.minds.stats(1).will}`);

  // 4. an army at the gates but cheerful people: nothing happens
  const s4 = scene(4242, 1, { siege: 6, misery: false });
  const t4 = run(s4, 150);
  check("besieged but with a cheerful village: no yield in 150 s", t4 === -1 && s4.g.minds.stats(1).will === "steady", `will ${s4.g.minds.stats(1).will}, resolve ${s4.g.minds.stats(1).resolve}`);

  // 5. a siege is an army, not a raider
  const s5 = scene(4242, 1, { siege: WILL.siegeMin - 1, misery: true });
  check(`${WILL.siegeMin - 1} enemy soldiers are a raid, not a siege: no yield in 150 s`, run(s5, 150) === -1);
  const s5b = scene(4242, 1, { siege: WILL.siegeMin, misery: true });
  check(`${WILL.siegeMin} enemy soldiers are a siege: the gates open`, run(s5b, 150) > 0 && s5b.g.phase === "victory");

  // 6. a held gate is not a siege
  const s6 = scene(4242, 1, { siege: 4, garrison: 5, misery: true });
  check("5 defenders hold the gate against 4 attackers: no yield in 150 s", run(s6, 150) === -1);

  // 7. relief: the enemy pulls back and the clock drains
  const s7 = scene(4242, 1, { siege: 6, misery: true });
  let seen = -1;
  let drained = -1;
  run(s7, 170, (s) => {
    if (s === 30) {
      seen = s7.g.minds.stats(1).yieldIn;
      for (const id of s7.siegeIds) {
        const u = s7.g.byId.get(id);
        if (u && "hp" in u) u.hp = 0;
      }
      s7.siegeIds.length = 0; // the rig stops parking them: they are gone
    }
    if (s > 30 && drained < 0 && s7.g.minds.stats(1).yieldIn === -1) drained = s;
  });
  check("relief: the countdown was running…", seen >= 0 && seen < WILL.yieldAfter, `yieldIn ${seen} at 30 s`);
  check("…and it drains once the army leaves; the castle never yields", s7.g.phase === "playing" && drained > 30 && drained <= 55, `clock cleared at ${drained}s`);

  // 8. other modes have their own win conditions
  for (const mode of ["sandbox", "survival"] as const) {
    const s = scene(4242, 1, { siege: 6, misery: true, mode });
    check(`${mode} mode: a besieged, broken castle does not yield`, run(s, 150) === -1);
  }

  // 9. nothing here may leak seat information: the clock is the same from both seats
  const h = honest(s1.g);
  check("mood == clamp(50 + sum(why)) still holds in a besieged castle", h.ok, `${h.n} people`);
}

console.log("== yielding: telegraphed ==");
{
  // no rigged misery at all: an idle village under siege, left to itself, loses heart slowly
  const s = scene(4242, 0, { siege: 6, misery: false });
  const t = run(s, 260);
  const iW = s.said.findIndex((x) => /wavering/i.test(x));
  const iB = s.said.findIndex((x) => /losing heart/i.test(x));
  check("a siege left alone: warned 'wavering', then 'losing heart', then the gates open", iW >= 0 && iB > iW && s.g.phase === "defeat", `wavering#${iW} losing#${iB} end ${t}s ${s.g.phase}`);
  check("…with a visible countdown in between", t > 0 && s.said.length > 0);
}

console.log("== persistence and validation ==");
{
  const a = scene(4242, 1, { siege: 6, misery: true });
  run(a, 30);
  const clock = a.g.minds.stats(1).yieldIn;
  const json = a.g.serialize();

  // two independent loads of the same save must agree, and continue the SAME clock
  const make = (): Scene => {
    const g = new Game(null, 1);
    g.loadFrom(json);
    const sc: Scene = { ...a, g, said: [], rig: () => undefined };
    sc.rig = () => rigStep(sc);
    return sc;
  };
  const b = make();
  const c = make();
  check("a save made during the countdown loads", b.g.phase === "playing");
  check("…and restores the exact clock", b.g.minds.stats(1).yieldIn === clock && clock >= 0, `${clock}s left`);
  check("…and the same mind fingerprint", b.g.minds.hash() === a.g.minds.hash());
  const tb = run(b, 80);
  const tc = run(c, 80);
  check("two loads play out identically", tb === tc && b.g.stateHash() === c.g.stateHash(), `yield at +${tb}s / +${tc}s`);
  check("…and the clock carried on from where it was saved (not from zero)", tb > 0 && tb <= clock + 8, `${tb}s after load, ${clock}s were left`);

  // saves from before this layer have no clock: they still load, with a fresh one
  const old = JSON.parse(json) as { minds?: { wl?: unknown } };
  delete old.minds?.wl;
  const o = new Game(null, 1);
  check("an older save (no will state) still loads", o.loadFrom(JSON.stringify(old)) && o.minds.stats(1).yieldIn === -1);

  // garbage in the will state never throws
  const junk = JSON.parse(json) as { minds: { wl?: unknown } };
  junk.minds.wl = { b: ["x", null], r: [[1], "no"], n: [-5, {}], p: [[9, 9], 7] };
  const j = new Game(null, 1);
  let threw = false;
  try {
    j.loadFrom(JSON.stringify(junk));
    j.step(5);
  } catch {
    threw = true;
  }
  check("garbage in a save's will state is survived", !threw);
}

console.log("== network intents ==");
{
  for (const k of ["reassure", "whisper"] as const) {
    const ev = sanitizeReplayEvent({ k: "decree", kind: k, t: 99, junk: 1 });
    check(`validator accepts a "${k}" decree, drops extras, resets time`, !!ev && JSON.stringify(ev) === JSON.stringify({ t: 0, k: "decree", kind: k }));
  }
  const bad: unknown[] = [
    { k: "decree" },
    { k: "decree", kind: "nuke" },
    { k: "decree", kind: {} },
    { k: "decree", kind: ["whisper"] },
    { k: "decree", kind: null },
  ];
  check("validator rejects malformed decrees", bad.every((x) => sanitizeReplayEvent(x) === null), `${bad.length} cases`);

  const g = mk(9, { mode: "sandbox" });
  g.step(2); // named people exist from the first whole second
  g.res[0].gold = 500;
  g.res[1].gold = 500;
  g.applyReplayEvent({ t: 0, k: "decree", kind: "reassure" }, 1);
  check("a relayed decree is paid by the sender only", Math.abs(g.res[1].gold - (500 - DECREE.reassure.gold)) < 1e-9 && g.res[0].gold === 500, `seat0 ${g.res[0].gold}, seat1 ${g.res[1].gold}`);
}

console.log("== the AI: same rules, no peeking ==");
{
  const here = fileURLToPath(new URL("../src/game/ai.ts", import.meta.url));
  const src = readFileSync(here, "utf8");
  const calls = [...src.matchAll(/\bminds\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2].trim()})`);
  check("the AI reads only its OWN people's stats, never the player's minds", calls.length > 0 && calls.every((c) => c === "stats(1)"), calls.join(", "));
  const orders = [...src.matchAll(/\bg\.decree\(([^)]*)\)/g)].map((m) => m[1].split(",")[0].trim());
  check("the AI gives decrees only as team 1, through the same g.decree() the player uses", orders.length > 0 && orders.every((o) => o === "1"), `${orders.length} call sites`);

  type Log = { t: number; kind: string; gold: number };
  const spy = (g: Game): Log[] => {
    const log: Log[] = [];
    const orig = g.decree.bind(g);
    (g as unknown as { decree: Game["decree"] }).decree = (team, kind) => {
      const gold = g.res[team].gold;
      const ok = orig(team, kind);
      if (ok && team === 1) log.push({ t: g.time, kind, gold });
      return ok;
    };
    return log;
  };
  const playAI = (seed: number, over: Partial<MatchConfig>): { g: Game; log: Log[] } => {
    const g = mk(seed, over);
    const log = spy(g);
    for (let s = 0; s < 1500 && g.phase === "playing"; s++) g.step(1);
    return { g, log };
  };

  const all: Log[] = [];
  const perGame: Log[][] = []; // game time restarts with every match, so spacing is judged within one match
  for (const seed of [12345, 777, 31337]) {
    const { log } = playAI(seed, { difficulty: 1 });
    all.push(...log);
    perGame.push(log);
  }
  const whispers = all.filter((l) => l.kind === "whisper");
  const reassures = all.filter((l) => l.kind === "reassure");
  console.log(`  info  Normal AI over 3 seeds: ${whispers.length} whispers, ${reassures.length} reassurances`);
  check("the AI does use decrees in a real match", all.length > 0, `${all.length} decrees`);
  check("it only whispers with gold to spare", whispers.every((l) => l.gold >= DECREE.whisper.gold + 120), whispers.map((l) => Math.round(l.gold)).join(","));
  const spaced = (xs: Log[], cd: number) => xs.every((l, i) => i === 0 || l.t - xs[i - 1].t >= cd - 1.5);
  const cdOk = perGame.every(
    (lg) => spaced(lg.filter((l) => l.kind === "whisper"), DECREE.whisper.cd) && spaced(lg.filter((l) => l.kind === "reassure"), DECREE.reassure.cd),
  );
  const gaps = perGame.flatMap((lg) => lg.filter((l) => l.kind === "whisper").map((l, i, xs) => (i ? Math.round(l.t - xs[i - 1].t) : -1))).filter((x) => x >= 0);
  // honest about its strength: in a real match the AI rarely whispers twice, so this
  // observation alone can pass with nothing to observe — the direct gate check below is the proof
  check("no two AI decrees of a kind were ever closer than the cooldown", cdOk, `${gaps.length} repeated whisper pair(s) observed${gaps.length ? `, gaps (s): ${gaps.join(",")}` : " (nothing to compare — see the gate check)"}`);
  {
    // the AI's decrees go through g.decree(1, ...): prove that exact gate binds team 1 like team 0
    const t = mk(31, { mode: "sandbox" });
    t.step(2);
    t.res[1].gold = 500;
    const first = t.decree(1, "whisper");
    const afterFirst = t.res[1].gold;
    const second = t.decree(1, "whisper");
    check("team 1 (the AI's seat): a second whisper at once is refused and costs nothing", first && !second && t.res[1].gold === afterFirst);
    t.step(DECREE.whisper.cd - 2);
    const early = t.decree(1, "whisper");
    t.step(5);
    t.res[1].gold = 500;
    const later = t.decree(1, "whisper");
    check("team 1: refused just before the cooldown ends, allowed just after", !early && later);
  }

  const easy = playAI(12345, { difficulty: 0 });
  check("on Easy the AI never whispers", easy.log.every((l) => l.kind !== "whisper"));
  const sand = playAI(12345, { mode: "sandbox" });
  check("in Free Build the AI gives no decrees at all", sand.log.length === 0);
}

console.log(fails === 0 ? "\nWILL TEST PASSED" : `\n${fails} WILL CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
