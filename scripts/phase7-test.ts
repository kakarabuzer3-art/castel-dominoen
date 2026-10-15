/** Phase 7 systems: fog of war, repair, formations, veterancy. */
import { TILE, defaultMatchConfig, type MatchConfig } from "../src/game/constants";
import { Game } from "../src/game/engine";
import { sanitizeReplayEvent } from "../src/game/replay";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

// ── fog of war ───────────────────────────────────────────────────────────────
{
  const g = new Game(null, 4242);
  g.settings.fog = true;
  g.startGame();
  g.refreshVision();
  const pk = g.buildingById.get(g.keeps[0])!;
  const ek = g.buildingById.get(g.keeps[1])!;
  check(
    "fog: own base visible, enemy keep hidden",
    g.isVisibleTo(0, (pk.tx + 2) * TILE, (pk.ty + 2) * TILE) &&
      !g.isVisibleTo(0, (ek.tx + 2) * TILE, (ek.ty + 2) * TILE),
  );
  check(
    "fog: enemy keep unexplored",
    !g.isExplored(0, (ek.tx + 2) * TILE, (ek.ty + 2) * TILE),
  );
  // scout: move a villager toward the enemy, vision follows
  const v = g.teamUnits(0, "villager")[0];
  v.x = (ek.tx - 6) * TILE;
  v.y = (ek.ty + 6) * TILE;
  g.refreshVision();
  check(
    "fog: vision follows scout",
    g.isVisibleTo(0, (ek.tx + 2) * TILE, (ek.ty + 2) * TILE) ||
      g.isExplored(0, (ek.tx - 4) * TILE, (ek.ty + 4) * TILE),
  );
  // right-clicking an unseen enemy must NOT order an attack (no omni-vision)
  const mil = g.teamUnits(0, "militia")[0] ?? g.spawnUnit(0, "militia", (pk.tx + 4) * TILE, (pk.ty + 4) * TILE);
  const mid = { x: (g.grid.w / 2) * TILE, y: (g.grid.h / 2) * TILE };
  const hidden = g.spawnUnit(1, "militia", mid.x, mid.y);
  g.selection.clear();
  g.selection.add(mil.id);
  mil.selected = true;
  g.refreshVision();
  check("fog: mid-map enemy is unseen", !g.isVisibleTo(0, mid.x, mid.y));
  g.rightClickCommand(mid.x, mid.y);
  check(
    "fog: right-click on unseen enemy orders move, not attack",
    mil.state === "move" && mil.targetId !== hidden.id,
    `state=${mil.state}`,
  );
  // save/load keeps explored map
  const json = g.serialize();
  const g2 = new Game(null, 1);
  g2.settings.fog = true;
  const okLoad = g2.loadFrom(json);
  check(
    "fog: explored map survives save/load",
    okLoad && g2.explored[0].some((x) => x === 1),
  );
}

// ── repair ───────────────────────────────────────────────────────────────────
{
  const g = new Game(null, 77);
  g.startGame();
  const pk = g.buildingById.get(g.keeps[0])!;
  const sp = g.findSpotNear(pk.tx + 7, pk.ty + 7, "house", 0, 4)!;
  const house = g.place(0, "house", sp.x, sp.y)!;
  house.built = true;
  house.hp = 100;
  g.res[0].wood = 500;
  g.res[0].stone = 300;
  const v = g.teamUnits(0, "villager")[0];
  g.assignRepair(v, house);
  g.step(6);
  check("repair: hp regrows while villager works", house.hp > 100, `hp=${house.hp.toFixed(0)}`);
  g.step(30);
  check("repair: completes to full and villager idles", house.hp === house.maxHp && v.state === "idle");
}

// ── formations ───────────────────────────────────────────────────────────────
{
  const g = new Game(null, 5);
  g.startGame();
  const pk = g.buildingById.get(g.keeps[0])!;
  const squad: import("../src/game/types").Unit[] = [];
  for (let i = 0; i < 9; i++) squad.push(g.spawnUnit(0, "militia", (pk.tx + 2) * TILE, (pk.ty + 8) * TILE));
  g.formation = 1; // line
  g.cmdMove(squad, (pk.tx + 2) * TILE, (pk.ty - 20) * TILE); // march north → line should spread east/west
  const xs = squad.map((u) => u.tx);
  const ys = squad.map((u) => u.ty);
  const xSpread = Math.max(...xs) - Math.min(...xs);
  const ySpread = Math.max(...ys) - Math.min(...ys);
  check("formation line: spreads perpendicular", xSpread > 150 && ySpread < 40, `dx=${xSpread.toFixed(0)} dy=${ySpread.toFixed(0)}`);
  g.formation = 2; // column
  g.cmdMove(squad, (pk.tx + 2) * TILE, (pk.ty - 20) * TILE);
  const xs2 = squad.map((u) => u.tx);
  const ys2 = squad.map((u) => u.ty);
  check(
    "formation column: stacks along march",
    Math.max(...ys2) - Math.min(...ys2) > 150 && Math.max(...xs2) - Math.min(...xs2) < 40,
  );
}

// ── veterancy ────────────────────────────────────────────────────────────────
{
  const g = new Game(null, 9);
  g.startGame();
  const pk = g.buildingById.get(g.keeps[0])!;
  const hero = g.spawnUnit(0, "militia", (pk.tx + 2) * TILE, (pk.ty + 8) * TILE);
  for (let i = 0; i < 3; i++) {
    const foe = g.spawnUnit(1, "villager", (pk.tx + 4) * TILE, (pk.ty + 8) * TILE);
    foe.lastAttacker = hero.id;
    g.damage(foe, 999, 0, hero.id);
    g.step(0.1);
  }
  check("veterancy: 3 kills → veteran rank", hero.rank === 1 && hero.kills === 3, `rank=${hero.rank} kills=${hero.kills}`);
  const dmgBefore = g.dmgOf(hero);
  for (let i = 0; i < 4; i++) {
    const foe = g.spawnUnit(1, "villager", (pk.tx + 4) * TILE, (pk.ty + 8) * TILE);
    g.damage(foe, 999, 0, hero.id);
    foe.lastAttacker = hero.id;
    g.step(0.1);
  }
  check("veterancy: 7 kills → elite (+dmg)", hero.rank === 2 && g.dmgOf(hero) > dmgBefore, `dmg=${g.dmgOf(hero).toFixed(1)}`);
}

// ── replay determinism ───────────────────────────────────────────────────────
let replayRef: ReturnType<Game["dumpReplay"]> = null;
{
  const cfg = { ...defaultMatchConfig(), seed: 777 };
  const g1 = new Game(null, cfg.seed);
  g1.startMatch(cfg);
  const pk = g1.buildingById.get(g1.keeps[0])!;
  const run = (g: Game, scripted: boolean) => {
    // deterministic scripted inputs at fixed times (recorded on g1, replayed on g2)
    for (let t = 0; t < 300; t += 1) {
      g.step(1);
      if (!scripted) continue;
      if (t === 10) {
        for (const v of g.teamUnits(0, "villager")) {
          g.selection.add(v.id);
          v.selected = true;
        }
        const tree = g.nearestNode("wood", pk.tx * 32, pk.ty * 32, 20 * 32);
        if (tree) g.rightClickCommand(tree.tx * 32 + 16, tree.ty * 32 + 16);
        g.selection.clear();
      }
      if (t === 40) {
        const sp = g.findSpotNear(pk.tx + 7, pk.ty + 7, "house", 0, 4);
        if (sp) g.place(0, "house", sp.x, sp.y);
      }
      if (t === 80) g.trainAt(g.buildingById.get(g.keeps[0])!, "villager");
      if (t === 120) {
        const mil = g.teamUnits(0, "militia");
        if (mil.length) g.cmdMove(mil, (pk.tx + 12) * 32, (pk.ty + 12) * 32);
      }
      if (t === 160) {
        g.formation = 1;
        g.cycleFormation();
      }
    }
  };
  run(g1, true);
  const rep = g1.dumpReplay();
  replayRef = rep;
  const h1 = g1.stateHash();
  const g2 = new Game(null, 1);
  const okLoad = !!rep && g2.loadReplay(rep);
  // replay applies events during its own stepping
  for (let t = 0; t < 300; t++) g2.step(1);
  const h2 = g2.stateHash();
  check("replay: loads", okLoad, `events=${rep?.events.length ?? 0}`);
  check("replay: deterministic state hash", h1 === h2, `${h1} vs ${h2}`);
}

// ── replay scrubbing ─────────────────────────────────────────────────────────
{
  const mkLinear = (repSave: NonNullable<ReturnType<Game["dumpReplay"]>>, ticks: number) => {
    const g = new Game(null, 1);
    g.loadReplay(repSave);
    g.step(ticks / 30);
    return g;
  };
  // reuse the replay from the determinism block above
  const r = replayRef;
  if (r) {
    const ref750 = mkLinear(r, 750).stateHash();
    const ref900 = mkLinear(r, 900).stateHash();
    const ref1500 = mkLinear(r, 1500).stateHash();
    const g3 = new Game(null, 1);
    g3.loadReplay(r);
    g3.step(50);
    g3.replaySeek(50);
    check("scrub: forward play == linear @1500", g3.stateHash() === ref1500);
    g3.replaySeek(25);
    check("scrub: backward seek == linear @750", g3.stateHash() === ref750, g3.stateHash());
    g3.replaySeek(30);
    check("scrub: checkpoint seek == linear @900", g3.stateHash() === ref900);
    g3.replaySeek(50);
    check("scrub: forward again == linear @1500", g3.stateHash() === ref1500);
  } else {
    check("scrub: replay available", false);
  }
}

// ── campaign mission 1 ───────────────────────────────────────────────────────
{
  const cfg = { ...defaultMatchConfig(), mode: "campaign" as const, missionId: 0, seed: 31337 };
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  check("campaign: objectives loaded", g.objectives.length === 4, `${g.objectives.length}`);
  check(
    "campaign: bandit camp pre-placed",
    g.teamBuildings(1, "barracks").length === 1,
  );
  const pk = g.buildingById.get(g.keeps[0])!;
  let houses = 0;
  let farms = 0;
  let barracks = 0;
  for (let t = 0; t < 1500 && g.phase === "playing"; t += 10) {
    g.step(10);
    for (const v of g.teamUnits(0, "villager")) {
      if (v.state !== "idle") continue;
      const site = g.teamBuildings(0).find((b) => !b.built && b.builders < 2);
      if (site) { g.assignBuild(v, site); continue; }
      const farm = g.teamBuildings(0, "farm").find((f) => f.built);
      if (farm && g.res[0].food < 250) { g.assignHarvest(v, farm.id); continue; }
      const n = g.nearestNode("wood", v.x, v.y, 26 * 32);
      if (n) g.assignHarvest(v, n.id);
    }
    if (houses < 2 && g.res[0].wood >= 60 && !g.teamBuildings(0).some((b) => !b.built)) {
      const sp = g.findSpotNear(pk.tx + 7, pk.ty + 6 + houses * 3, "house", 0, 4);
      if (sp) { g.place(0, "house", sp.x, sp.y); houses++; }
    } else if (farms < 1 && g.res[0].wood >= 50 && !g.teamBuildings(0).some((b) => !b.built)) {
      const sp = g.findSpotNear(pk.tx - 6, pk.ty + 7, "farm", 0, 4);
      if (sp) { g.place(0, "farm", sp.x, sp.y); farms++; }
    } else if (barracks < 1 && g.res[0].wood >= 160 && g.res[0].stone >= 45 && !g.teamBuildings(0).some((b) => !b.built)) {
      const sp = g.findSpotNear(pk.tx - 6, pk.ty - 6, "barracks", 0, 4);
      if (sp) { g.place(0, "barracks", sp.x, sp.y); barracks++; }
    }
    if (g.res[0].food >= 55 && g.teamUnits(0, "villager").length < 9)
      g.trainAt(pk, "villager");
    const bar = g.teamBuildings(0, "barracks")[0];
    if (bar?.built && bar.queue.length < 2 && g.teamUnits(0).filter((u) => u.type !== "villager").length < 8)
      g.trainAt(bar, "militia");
    const army = g.teamUnits(0).filter((u) => u.type !== "villager" && u.state !== "attack" && u.state !== "attackMove");
    const camp = g.teamBuildings(1, "barracks")[0];
    if (camp && army.length >= 6) g.cmdAttack(army, camp.id);
  }
  check(
    "campaign: mission 1 completable",
    g.phase === "victory" && g.objectives.every((o) => o.done),
    `phase=${g.phase} done=${g.objectives.filter((o) => o.done).length}/${g.objectives.length} t=${Math.round(g.time)}`,
  );
}

// ── save/load across map sizes ──────────────────────────────────────────────
// Regression guard: loading a save must never scramble map dimensions or grid
// state (the XL loadFrom bug), and must not resurrect depleted nodes (phantom
// resources + stale occupancy marks).
{
  const eqArr = (a: Uint8Array | Int32Array, b: Uint8Array | Int32Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const saves = new Map<string, string>();
  for (const size of ["S", "M", "L", "XL"] as const) {
    const cfg = { ...defaultMatchConfig(), size, map: "verdant", seed: 4242, lord: 0, epic: size === "XL" } as MatchConfig;
    const g = new Game(null, 4242);
    g.startMatch(cfg);
    g.step(120);
    const json = g.serialize();
    saves.set(size, json);
    const g2 = new Game(null, 4242);
    const ok = g2.loadFrom(json);
    check(
      `save/load ${size}: round-trip keeps cfg`,
      ok && g2.cfg.size === size && g2.cfg.epic === (size === "XL"),
      `ok=${ok} size=${g2.cfg.size} epic=${g2.cfg.epic}`,
    );
    check(
      `save/load ${size}: grid dims intact`,
      g2.grid.w === g.grid.w && g2.grid.h === g.grid.h,
      `${g2.grid.w}x${g2.grid.h}`,
    );
    check(
      `save/load ${size}: terrain + occupancy identical`,
      eqArr(g2.grid.terrain, g.grid.terrain) && eqArr(g2.grid.occ, g.grid.occ),
    );
    const liveNodes = g.nodes.map((n) => `${n.id}:${Math.round(n.amount)}`).join(",");
    const loadNodes = g2.nodes.map((n) => `${n.id}:${Math.round(n.amount)}`).join(",");
    check(
      `save/load ${size}: node set + amounts identical, hash equal`,
      liveNodes === loadNodes && g2.stateHash() === g.stateHash(),
      `nodes=${g2.nodes.length} hash=${g2.stateHash() === g.stateHash() ? "eq" : "DIFF"}`,
    );
  }
  const gs = new Game(null, 7);
  gs.startMatch({ ...defaultMatchConfig(), size: "S", map: "verdant", seed: 7, lord: 0 } as MatchConfig);
  gs.step(30);
  const okSX = gs.loadFrom(saves.get("XL")!);
  check(
    "save/load cross-size: S match absorbs XL save",
    okSX && gs.grid.w === 160 && gs.cfg.size === "XL",
    `${gs.grid.w}x${gs.grid.h}`,
  );
  const gx = new Game(null, 7);
  gx.startMatch({ ...defaultMatchConfig(), size: "XL", map: "verdant", seed: 7, lord: 0, epic: true } as MatchConfig);
  gx.step(30);
  const okXS = gx.loadFrom(saves.get("S")!);
  check(
    "save/load cross-size: XL match absorbs S save",
    okXS && gx.grid.w === 84 && gx.cfg.size === "S",
    `${gx.grid.w}x${gx.grid.h}`,
  );
}

// ── regression: every lord's AI personality must survive save/load ───────────
// (ai.ts used to clamp the saved personality to 0..2, so Master Torvald — the
// Siege Master, personality 3 — silently came back as the Economic lord)
{
  type AiPeek = { ai: { personality: { id: number; name: string } } };
  for (const lord of [0, 1, 2, 3]) {
    const g = new Game(null, 100 + lord);
    g.startMatch({ ...defaultMatchConfig(), size: "S", map: "verdant", seed: 100 + lord, lord } as MatchConfig);
    g.step(5);
    const before = (g as unknown as AiPeek).ai.personality;
    const g2 = new Game(null, 1);
    const ok = g2.loadFrom(g.serialize());
    const after = (g2 as unknown as AiPeek).ai.personality;
    check(
      `save/load lord ${lord}: AI personality preserved`,
      ok && after.id === before.id,
      `${before.name} -> ${after.name}`,
    );
  }
}

// ── regression: network intents are untrusted input ─────────────────────────
// The MP relay forwards whatever a peer sends. sanitizeReplayEvent() must
// accept every honest command and reject malformed / hostile ones, and the
// engine must never let one seat spend another seat's resources.
{
  const ok = [
    { k: "move", ids: [1, 2], x: 10.5, y: -3 },
    { k: "amove", ids: [], x: 0, y: 0 },
    { k: "atk", ids: [4], target: 9 },
    { k: "harv", ids: [4], node: 2 },
    { k: "stop", ids: [4] },
    { k: "rc", x: 5, y: 6, sel: [1], selB: -1 },
    { k: "place", type: "house", tx: 12, ty: 14 },
    { k: "train", bId: 3, unit: "villager" },
    { k: "res", bId: 3, up: "wheelbarrow" },
    { k: "trade", kind: "sellWood" },
    { k: "form", v: 2 },
  ];
  check(
    "intent sanitizer: every honest command kind is accepted",
    ok.every((e) => sanitizeReplayEvent(e) !== null),
  );

  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["string", "move"],
    ["number", 5],
    ["empty object", {}],
    ["unknown kind", { k: "nuke" }],
    ["ids not an array", { k: "move", ids: "x", x: 1, y: 1 }],
    ["negative id", { k: "stop", ids: [-1] }],
    ["fractional id", { k: "stop", ids: [1.5] }],
    ["oversized id list", { k: "stop", ids: new Array(1501).fill(1) }],
    ["NaN coordinate", { k: "move", ids: [1], x: NaN, y: 1 }],
    ["Infinity coordinate", { k: "move", ids: [1], x: 1, y: Infinity }],
    ["huge coordinate", { k: "move", ids: [1], x: 1e9, y: 1 }],
    ["string coordinate", { k: "amove", ids: [1], x: "5", y: 1 }],
    ["placing a free keep", { k: "place", type: "keep", tx: 3, ty: 3 }],
    ["building type __proto__", { k: "place", type: "__proto__", tx: 3, ty: 3 }],
    ["building type constructor", { k: "place", type: "constructor", tx: 3, ty: 3 }],
    ["fractional tile", { k: "place", type: "house", tx: 1.5, ty: 3 }],
    ["unknown unit", { k: "train", bId: 1, unit: "dragon" }],
    ["unit toString", { k: "train", bId: 1, unit: "toString" }],
    ["negative building id", { k: "train", bId: -2, unit: "villager" }],
    ["market kind __proto__", { k: "trade", kind: "__proto__" }],
    ["formation out of range", { k: "form", v: 9 }],
    ["overlong upgrade id", { k: "res", bId: 1, up: "x".repeat(41) }],
  ];
  const leaked = bad.filter(([, e]) => sanitizeReplayEvent(e) !== null).map(([n]) => n);
  check(
    `intent sanitizer: ${bad.length} malformed/hostile intents all rejected`,
    leaked.length === 0,
    leaked.join(", "),
  );

  const clean = sanitizeReplayEvent({ k: "stop", ids: [1], t: 99999, evil: "x" }) as
    | (Record<string, unknown> & { t: number })
    | null;
  check(
    "intent sanitizer: extra fields stripped, time reset to 0",
    !!clean && clean.t === 0 && !("evil" in clean),
  );

  // engine: seat 1 targeting seat 0's keep must change nothing; seat 0 can
  const g = new Game(null, 5150);
  g.startMatch({ ...defaultMatchConfig(), size: "S", map: "verdant", seed: 5150, lord: 0 } as MatchConfig);
  const k0 = g.buildingById.get(g.keeps[0])!;
  const food0 = g.res[0].food;
  const gold0 = g.res[0].gold;
  const bCount = g.buildings.length;

  g.applyReplayEvent({ t: 0, k: "train", bId: k0.id, unit: "villager" }, 1);
  g.applyReplayEvent({ t: 0, k: "res", bId: k0.id, up: "wheelbarrow" }, 1);
  g.applyReplayEvent({ t: 0, k: "place", type: "keep", tx: 30, ty: 30 }, 0);
  g.applyReplayEvent({ t: 0, k: "place", type: "keep", tx: 30, ty: 30 }, 1);
  check(
    "engine: foreign seat cannot train/research on my keep, nobody can place a keep",
    k0.queue.length === 0 &&
      k0.research === null &&
      g.res[0].food === food0 &&
      g.res[0].gold === gold0 &&
      g.buildings.length === bCount,
    `queue=${k0.queue.length} research=${k0.research ? "set" : "none"} food=${g.res[0].food}/${food0} buildings=${g.buildings.length}/${bCount}`,
  );

  g.applyReplayEvent({ t: 0, k: "train", bId: k0.id, unit: "villager" }, 0);
  g.applyReplayEvent({ t: 0, k: "res", bId: k0.id, up: "wheelbarrow" }, 0);
  check(
    "engine: control — the owning seat can still train and research",
    k0.queue.length === 1 && k0.research !== null && g.res[0].food < food0,
    `queue=${k0.queue.length} research=${k0.research ? "set" : "none"} food=${g.res[0].food}/${food0}`,
  );
}

console.log(fails === 0 ? "\nPHASE-7/8 SYSTEMS TEST PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
