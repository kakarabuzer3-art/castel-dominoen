/**
 * Multiplayer intent hardening (Phase 0).
 *  1. sanitizeReplayEvent: every event the engine emits survives unchanged,
 *     every malformed one is rejected.
 *  2. Ownership: a command may only act on the sender's own buildings.
 *  3. Fuzz: thousands of garbage intents can never throw inside the simulation.
 * Runs headless — no websocket server needed.
 */
import { UPGRADES } from "../src/game/constants";
import { Game } from "../src/game/engine";
import { sanitizeReplayEvent, type ReplayEvent } from "../src/game/replay";
import { mulberry32 } from "../src/game/rng";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

// ── 1. validator: honest events pass through unchanged ───────────────────────
const honest: ReplayEvent[] = [
  { t: 0, k: "rc", x: 640.5, y: 320, sel: [3, 4, 5], selB: -1 },
  { t: 0, k: "rc", x: 10, y: 10, sel: [], selB: 7 },
  { t: 0, k: "place", type: "house", tx: 12, ty: 30 },
  { t: 0, k: "place", type: "wall", tx: 0, ty: 0 },
  { t: 0, k: "train", bId: 2, unit: "villager" },
  { t: 0, k: "res", bId: 1, up: "wheelbarrow" },
  { t: 0, k: "trade", kind: "sellWood" },
  { t: 0, k: "form", v: 2 },
  { t: 0, k: "move", ids: [1, 2], x: 100.25, y: 200 },
  { t: 0, k: "amove", ids: [9], x: 5, y: 6 },
  { t: 0, k: "atk", ids: [1, 2, 3], target: 44 },
  { t: 0, k: "harv", ids: [1], node: 12 },
  { t: 0, k: "stop", ids: [1, 2] },
];
for (const ev of honest) {
  const out = sanitizeReplayEvent(JSON.parse(JSON.stringify(ev)));
  check(
    `validator accepts honest "${ev.k}" unchanged`,
    out !== null && JSON.stringify(out) === JSON.stringify(ev),
  );
}

// ── 1b. validator: malformed events are rejected ─────────────────────────────
const manyIds = Array.from({ length: 1501 }, (_, i) => i);
const bad: Array<[string, unknown]> = [
  ["null", null],
  ["string", "move"],
  ["number", 42],
  ["array", []],
  ["empty object", {}],
  ["unknown kind", { k: "hack", ids: [1] }],
  ["kind is a prototype key", { k: "constructor" }],
  ["move: ids missing", { k: "move", x: 1, y: 2 }],
  ["move: ids is a number", { k: "move", ids: 5, x: 1, y: 2 }],
  ["move: ids is a string", { k: "move", ids: "1,2", x: 1, y: 2 }],
  ["move: negative id", { k: "move", ids: [-1], x: 1, y: 2 }],
  ["move: fractional id", { k: "move", ids: [1.5], x: 1, y: 2 }],
  ["move: id is a string", { k: "move", ids: ["1"], x: 1, y: 2 }],
  ["move: 1501 ids", { k: "move", ids: manyIds, x: 1, y: 2 }],
  ["move: NaN x", { k: "move", ids: [1], x: NaN, y: 2 }],
  ["move: Infinity y", { k: "move", ids: [1], x: 1, y: Infinity }],
  ["move: absurd coordinate", { k: "move", ids: [1], x: 1e12, y: 2 }],
  ["move: string coordinate", { k: "move", ids: [1], x: "1", y: 2 }],
  ["rc: sel missing", { k: "rc", x: 1, y: 2, selB: -1 }],
  ["rc: selB below -1", { k: "rc", x: 1, y: 2, sel: [], selB: -2 }],
  ["rc: selB fractional", { k: "rc", x: 1, y: 2, sel: [], selB: 0.5 }],
  ["place: keep (free building)", { k: "place", type: "keep", tx: 5, ty: 5 }],
  ["place: unknown type", { k: "place", type: "castle", tx: 5, ty: 5 }],
  ["place: prototype key type", { k: "place", type: "toString", tx: 5, ty: 5 }],
  ["place: fractional tile", { k: "place", type: "house", tx: 5.5, ty: 5 }],
  ["place: huge tile", { k: "place", type: "house", tx: 1e9, ty: 5 }],
  ["train: unknown unit", { k: "train", bId: 1, unit: "dragon" }],
  ["train: __proto__ unit", { k: "train", bId: 1, unit: "__proto__" }],
  ["train: negative building", { k: "train", bId: -3, unit: "villager" }],
  ["res: upgrade too long", { k: "res", bId: 1, up: "x".repeat(41) }],
  ["res: upgrade empty", { k: "res", bId: 1, up: "" }],
  ["res: upgrade not a string", { k: "res", bId: 1, up: 7 }],
  ["trade: unknown kind", { k: "trade", kind: "printMoney" }],
  ["trade: prototype key", { k: "trade", kind: "toString" }],
  ["form: out of range", { k: "form", v: 3 }],
  ["form: negative", { k: "form", v: -1 }],
  ["atk: target missing", { k: "atk", ids: [1] }],
  ["harv: node negative", { k: "harv", ids: [1], node: -5 }],
  ["stop: ids missing", { k: "stop" }],
];
for (const [name, raw] of bad)
  check(`validator rejects ${name}`, sanitizeReplayEvent(raw) === null);

// extra/unknown fields are dropped, never forwarded
{
  const out = sanitizeReplayEvent({
    k: "stop",
    ids: [1],
    evil: "payload",
    __proto__: { polluted: true },
  }) as unknown as Record<string, unknown> | null;
  check(
    "validator drops unknown fields",
    out !== null && !("evil" in out) && JSON.stringify(out) === '{"t":0,"k":"stop","ids":[1]}',
  );
}

// ── 2. ownership: commands only act on the sender's own buildings ────────────
{
  const g = new Game(null, 4321);
  g.startGame();
  const myKeep = g.buildingById.get(g.keeps[0])!;
  const enemyKeep = g.buildingById.get(g.keeps[1])!;
  g.res[1] = { wood: 5000, stone: 5000, gold: 5000, food: 5000 };

  // seat 0 (team 0) tries to make the ENEMY keep train a villager
  const foodBefore = g.res[1].food;
  g.applyReplayEvent({ t: 0, k: "train", bId: enemyKeep.id, unit: "villager" }, 0);
  check(
    "train: team 0 cannot queue units in the enemy keep",
    enemyKeep.queue.length === 0 && g.res[1].food === foodBefore,
    `queue=${enemyKeep.queue.length} food ${foodBefore}->${g.res[1].food}`,
  );

  // control: the enemy's own seat can
  g.applyReplayEvent({ t: 0, k: "train", bId: enemyKeep.id, unit: "villager" }, 1);
  check(
    "train: team 1 CAN train in its own keep (control)",
    enemyKeep.queue.length === 1 && g.res[1].food < foodBefore,
  );

  // control: team 0 on its own keep
  const myBefore = myKeep.queue.length;
  g.applyReplayEvent({ t: 0, k: "train", bId: myKeep.id, unit: "villager" }, 0);
  check("train: team 0 CAN train in its own keep (control)", myKeep.queue.length === myBefore + 1);

  // research on the enemy keep
  const up = UPGRADES.find((u) => u.at === "keep")!;
  const resBefore = JSON.stringify(g.res[1]);
  g.applyReplayEvent({ t: 0, k: "res", bId: enemyKeep.id, up: up.id }, 0);
  check(
    "res: team 0 cannot start research on the enemy keep",
    enemyKeep.research === null && JSON.stringify(g.res[1]) === resBefore,
  );
  g.applyReplayEvent({ t: 0, k: "res", bId: enemyKeep.id, up: up.id }, 1);
  check(
    "res: team 1 CAN research at its own keep (control)",
    enemyKeep.research !== null && enemyKeep.research.id === up.id,
  );

  // keeps cannot be placed (cost {} would make them free)
  const nBuild = g.buildings.length;
  g.applyReplayEvent({ t: 0, k: "place", type: "keep", tx: 40, ty: 40 }, 0);
  check("place: a keep can never be placed", g.buildings.length === nBuild);
  const spot = g.findSpotNear(Math.round(myKeep.tx + 8), Math.round(myKeep.ty + 8), "house", 0, 10);
  if (spot) {
    g.applyReplayEvent({ t: 0, k: "place", type: "house", tx: spot.x, ty: spot.y }, 0);
    check("place: a normal house still works (control)", g.buildings.length === nBuild + 1);
  } else check("place: found a house spot (control)", false, "no spot");
}

// ── 3. fuzz: garbage intents must never throw inside the simulation ──────────
{
  const rnd = mulberry32(20261014);
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const junk: unknown[] = [
    null, undefined, NaN, Infinity, -Infinity, -1, 0, 1, 2, 3, 7, 0.5, 1e9, -1e9,
    "", "x", "constructor", "__proto__", "villager", "house", "keep", "sellWood",
    [], [1], [1, 2, 3], [-1], ["a"], [null], {}, { a: 1 }, true, false,
  ];
  const kinds = [
    "rc", "place", "train", "res", "trade", "form", "move", "amove", "atk", "harv", "stop",
    "nope",
  ];
  const fields = ["x", "y", "sel", "selB", "type", "tx", "ty", "bId", "unit", "up", "kind", "v", "ids", "target", "node"];
  const g = new Game(null, 777);
  g.startGame();
  let accepted = 0;
  let threw = 0;
  let firstErr = "";
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const raw: Record<string, unknown> = { k: pick(kinds) };
    for (const f of fields) if (rnd() < 0.6) raw[f] = pick(junk);
    const ev = sanitizeReplayEvent(raw);
    if (!ev) continue;
    accepted++;
    try {
      g.applyReplayEvent(ev, (i & 1) as 0 | 1);
    } catch (err) {
      threw++;
      if (!firstErr) firstErr = `${JSON.stringify(ev)} -> ${String(err)}`;
    }
    if (i % 400 === 0) {
      try {
        g.step(1);
      } catch (err) {
        threw++;
        if (!firstErr) firstErr = `step after fuzz -> ${String(err)}`;
      }
    }
  }
  check(
    `fuzz: ${N} garbage intents, ${accepted} passed the validator, none threw`,
    threw === 0,
    threw ? `${threw} threw; first: ${firstErr}` : `accepted=${accepted}`,
  );
  check("fuzz: game still ticks normally afterwards", (() => {
    try {
      g.step(2);
      return g.tickCount > 0;
    } catch {
      return false;
    }
  })());
}

console.log(fails === 0 ? "\nNET VALIDATION TEST PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
