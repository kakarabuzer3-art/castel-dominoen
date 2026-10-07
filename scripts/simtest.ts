/**
 * Headless simulation test for Castle Dominion.
 * Runs the real engine (no DOM) with a scripted player bot and asserts the
 * full loop works: gather → build → train → fight → win/lose.
 *
 * Usage: npx tsx scripts/simtest.ts [seed...]
 */
import {
  BUILDING_DEFS,
  TILE,
  startPositions,
  UNIT_DEFS,
  canAfford,
} from "../src/game/constants";
import { Game, isNode } from "../src/game/engine";
import type { Building, RNode, Unit, UnitType } from "../src/game/types";

const seeds = process.argv.slice(2).map(Number).filter((n) => !isNaN(n));
const SEEDS = seeds.length ? seeds : [12345, 777, 20260101];

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function runSeed(seed: number): void {
  console.log(`\n=== seed ${seed} ===`);
  const personality = Number(process.env.SIM_PERSONALITY ?? 1);
  const g = new Game(null, seed, personality); // pinned lord personality

  // map sanity
  const p0 = startPositions()[0];
  const p1 = startPositions()[1];
  check(
    "keeps connected over dry land",
    g.grid.connected(p0.x, p0.y, p1.x, p1.y),
  );
  const trees = g.nodes.filter((n) => n.kind === "tree").length;
  const rocks = g.nodes.filter((n) => n.kind === "rock").length;
  const golds = g.nodes.filter((n) => n.kind === "gold").length;
  check("resource nodes generated", trees > 60 && rocks >= 14 && golds >= 8,
    `trees=${trees} rocks=${rocks} gold=${golds}`);

  g.startGame();

  const startWood = g.res[0].wood;
  let sawGather = false;
  let sawBuildDone = false;
  let sawTrained = false;
  let sawKill = false;
  let sawPopCapRise = false;
  const popCap0 = g.popCap[0];
  let simMs = 0;
  let simTicks = 0;

  const playerKeep = g.buildingById.get(g.keeps[0])!;
  const kc = { x: (playerKeep.tx + 2.5) * TILE, y: (playerKeep.ty + 2.5) * TILE };

  let houseIdx = 0;
  let farmIdx = 0;
  let armySent = 0;
  let wallsBuilt = false;
  let lastMicro = -99;

  const decide = (): void => {
    if (g.phase !== "playing") return;
    const keepAlive = g.buildingById.get(g.keeps[0]);
    if (!keepAlive) return;
    const villagers = g.teamUnits(0, "villager");
    const farms = g.teamBuildings(0, "farm").filter((f) => f.built);

    // count workers per resource
    const wc = { food: 0, wood: 0, stone: 0, gold: 0 };
    for (const w of villagers) {
      if (w.state !== "harvest") continue;
      const t = g.byId.get(w.taskId);
      if (!t) continue;
      if (isNode(t)) wc[t.kind === "tree" ? "wood" : t.kind === "rock" ? "stone" : "gold"]++;
      else if ((t as { type?: string }).type === "farm") wc.food++;
    }

    // 1. assign idle villagers
    for (const v of villagers) {
      if (v.state !== "idle") continue;
      const site = g.teamBuildings(0).find((b) => !b.built && b.builders < 2);
      if (site) {
        g.assignBuild(v, site);
        continue;
      }
      if (farms.length && wc.food < farms.length * 3 && g.res[0].food < 320) {
        const farm = farms.reduce((a, b) => a.id < b.id ? a : b);
        g.assignHarvest(v, farm.id);
        wc.food++;
        continue;
      }
      let node: RNode | null = null;
      if (wc.wood < 4 || g.res[0].wood < 200) node = g.nearestNode("wood", v.x, v.y, 32 * TILE);
      else if (wc.gold < 2) node = g.nearestNode("gold", v.x, v.y, 46 * TILE);
      else if (wc.stone < 2) node = g.nearestNode("stone", v.x, v.y, 46 * TILE);
      node = node ?? g.nearestNode("wood", v.x, v.y, 32 * TILE);
      if (node) {
        g.assignHarvest(v, node.id);
        wc[node.kind === "tree" ? "wood" : node.kind === "rock" ? "stone" : "gold"]++;
      }
    }

    // 1.5 staff any unattended construction site (pull harvesters if needed)
    for (const site of g.teamBuildings(0)) {
      if (site.built || site.builders > 0) continue;
      const p = { x: (site.tx + site.w / 2) * TILE, y: (site.ty + site.h / 2) * TILE };
      const cands = g
        .teamUnits(0, "villager")
        .filter((v) => v.state === "idle" || v.state === "harvest")
        .sort(
          (a, b) =>
            Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y),
        );
      const pick = [...cands.filter((v) => v.state === "idle").slice(0, 2)];
      if (pick.length < 2)
        pick.push(...cands.filter((v) => v.state === "harvest").slice(0, 2 - pick.length));
      for (const v of pick) g.assignBuild(v, site);
    }

    // 2. economy buildings + phase-2 structures
    const houses = g.teamBuildings(0, "house");
    const farmsAll = g.teamBuildings(0, "farm");
    const barracks = g.teamBuildings(0, "barracks");
    const busy = g.teamBuildings(0).some((b) => !b.built);

    // research upgrades
    const keepB = keepAlive;
    if (g.res[0].food > 200) g.startResearch(keepB, "wheelbarrow");
    if (g.res[0].wood > 160 && g.res[0].gold > 160) g.startResearch(keepB, "town_watch");
    for (const bar of barracks) {
      if (!bar.built || bar.research) continue;
      if (!g.hasUpgrade(0, "iron_swords") && g.res[0].food > 220 && g.res[0].gold > 180)
        g.startResearch(bar, "iron_swords");
      else if (!g.hasUpgrade(0, "longbows") && g.res[0].wood > 200 && g.res[0].gold > 160)
        g.startResearch(bar, "longbows");
      else if (!g.hasUpgrade(0, "padded_armor") && g.res[0].food > 240 && g.res[0].gold > 140)
        g.startResearch(bar, "padded_armor");
    }
    // market trading when gold-starved
    const market = g.teamBuildings(0, "market").find((m) => m.built);
    if (market && g.res[0].gold < 50 && g.res[0].wood > 150) {
      g.selectedBuilding = market.id;
      g.uiExchange("sellWood");
      g.selectedBuilding = -1;
    }

    if (!busy) {
      if (g.popCap[0] - g.popCur[0] <= 2 && canAfford(g.res[0], BUILDING_DEFS.house.cost)) {
        const ang = houseIdx++ * 2.1;
        const spot = g.findSpotNear(
          Math.round((kc.x + Math.cos(ang) * 8 * TILE) / TILE),
          Math.round((kc.y + Math.sin(ang) * 8 * TILE) / TILE),
          "house", 0, 6);
        if (spot) g.place(0, "house", spot.x, spot.y);
      } else if (farmsAll.length < 3 && canAfford(g.res[0], BUILDING_DEFS.farm.cost)) {
        const ang = 1.2 + farmIdx++ * 2.2;
        const spot = g.findSpotNear(
          Math.round((kc.x + Math.cos(ang) * 9 * TILE) / TILE),
          Math.round((kc.y + Math.sin(ang) * 9 * TILE) / TILE),
          "farm", 0, 6);
        if (spot) g.place(0, "farm", spot.x, spot.y);
      } else if (barracks.length < 1 && (g.time > 50 || g.res[0].wood > 150) && canAfford(g.res[0], BUILDING_DEFS.barracks.cost)) {
        const spot = g.findSpotNear(
          Math.round(kc.x / TILE) - 5, Math.round(kc.y / TILE) + 4, "barracks", 0, 7);
        if (spot) g.place(0, "barracks", spot.x, spot.y);
      } else if (
        g.time > 150 && g.teamBuildings(0, "lumbercamp").length < 1 &&
        g.res[0].wood >= 80
      ) {
        const tree = g.nearestNode("wood", kc.x, kc.y, 20 * TILE);
        if (tree) {
          const spot = g.findSpotNear(tree.tx, tree.ty, "lumbercamp", 0, 4);
          if (spot) g.place(0, "lumbercamp", spot.x, spot.y);
        }
      } else if (
        g.time > 400 && g.teamBuildings(0, "market").length < 1 &&
        g.res[0].wood >= 140 && g.res[0].stone >= 50
      ) {
        const spot = g.findSpotNear(Math.round(kc.x / TILE) - 6, Math.round(kc.y / TILE) - 5, "market", 0, 6);
        if (spot) g.place(0, "market", spot.x, spot.y);
      } else if (
        g.time > 240 && g.teamBuildings(0, "tower").length < 2 &&
        g.res[0].stone >= 130
      ) {
        const base = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const a = base + (g.teamBuildings(0, "tower").length === 0 ? -0.7 : 0.7);
        const spot = g.findSpotNear(
          Math.round((kc.x + Math.cos(a) * 6 * TILE) / TILE),
          Math.round((kc.y + Math.sin(a) * 6 * TILE) / TILE),
          "tower", 0, 4);
        if (spot) g.place(0, "tower", spot.x, spot.y);
      } else if (
        barracks.length >= 1 && houses.length >= 3 && !wallsBuilt &&
        g.res[0].stone > 90 && g.time > 240
      ) {
        // one defensive line toward the enemy, built once
        const base = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        let placed = 0;
        for (let i = 0; i < 7; i++) {
          const a = base - 0.9 + i * 0.3;
          const tx = Math.round((kc.x + Math.cos(a) * 7 * TILE) / TILE);
          const ty = Math.round((kc.y + Math.sin(a) * 7 * TILE) / TILE);
          if (g.place(0, "wall", tx, ty)) placed++;
        }
        if (placed) wallsBuilt = true;
      }
    }

    // 3. training
    if (canAfford(g.res[0], UNIT_DEFS.villager.cost) && villagers.length < 10) {
      g.trainAt(playerKeep, "villager");
    }
    if (
      barracks.length === 1 && g.time > 300 && !busy &&
      g.res[0].wood >= 260 && g.res[0].stone >= 80
    ) {
      const spot = g.findSpotNear(Math.round(kc.x / TILE) + 5, Math.round(kc.y / TILE) + 5, "barracks", 0, 7);
      if (spot) g.place(0, "barracks", spot.x, spot.y);
    }
    const armyAll = g.teamUnits(0).filter((u) => UNIT_DEFS[u.type].military);
    const enemyKnights = g.teamUnits(1, "knight").length;
    const mySpears = g.teamUnits(0, "spearman").length;
    const myArchers = g.teamUnits(0, "archer").length;
    const myCats = g.teamUnits(0, "catapult").length;
    for (const bar of barracks) {
      if (!bar.built || bar.queue.length >= 2) continue;
      let type: UnitType;
      if (g.time > 540 && myCats < (g.time > 900 ? 4 : 2) && g.res[0].wood > 260) type = "catapult";
      else if (enemyKnights >= 3 && mySpears < enemyKnights + 2) type = "spearman";
      else if (myArchers >= 4 && g.teamUnits(0, "knight").length < 3) type = "knight";
      else type = armyAll.length % 3 === 2 ? "archer" : ("militia" as UnitType);
      if (!g.trainAt(bar, type)) g.trainAt(bar, "militia");
    }

    // 3.5 defense micro: engage enemies near our base
    const pKeep0 = g.buildingById.get(g.keeps[0]);
    if (pKeep0 && g.time - g.alarm[0] < 8 && g.time - lastMicro > 6) {
      const kp = { x: (pKeep0.tx + 2.5) * TILE, y: (pKeep0.ty + 2.5) * TILE };
      const threat = g
        .teamUnits(1)
        .filter((e) => UNIT_DEFS[e.type].military && Math.hypot(e.x - kp.x, e.y - kp.y) < 14 * TILE);
      if (threat.length) {
        const defenders = g
          .teamUnits(0)
          .filter((u) => UNIT_DEFS[u.type].military && u.state === "idle");
        if (defenders.length) {
          g.cmdAttack(defenders, threat[0].id);
          lastMicro = g.time;
        }
      }
    }

    // 4. attack!
    const army = g.teamUnits(0).filter((u) => UNIT_DEFS[u.type].military);
    // keep a small home guard against raids early on
    const pKeep = g.buildingById.get(g.keeps[0])!;
    const pkc = { x: (pKeep.tx + 2.5) * TILE, y: (pKeep.ty + 2.5) * TILE };
    const sortedArmy = [...army].sort(
      (a, b) =>
        Math.hypot(a.x - pkc.x, a.y - pkc.y) - Math.hypot(b.x - pkc.x, b.y - pkc.y),
    );
    const guardCount = g.time < 500 ? 3 : 0;
    const guardIds = new Set(sortedArmy.slice(0, guardCount).map((u) => u.id));
    const freeArmy = army.filter(
      (u) => u.state !== "attack" && u.state !== "attackMove" && !guardIds.has(u.id),
    );
    const enemyKeep = g.buildingById.get(g.keeps[1]);
    const waveReady =
      (freeArmy.length >= 12 && g.time > 400 && g.time - armySent > 70) ||
      (g.time > 900 && freeArmy.length >= 8 && g.time - armySent > 60);
    if (enemyKeep && waveReady) {
      armySent = g.time;
      const gx = (enemyKeep.tx + enemyKeep.w / 2) * TILE;
      const gy = (enemyKeep.ty + enemyKeep.h + 1) * TILE;
      // catapults siege the nearest tower from outside its range first
      const cats = freeArmy.filter((u) => u.type === "catapult");
      const escort = freeArmy.filter((u) => u.type !== "catapult");
      const towers = g.teamBuildings(1, "tower").filter((t) => t.built);
      if (cats.length && towers.length) {
        const nt = towers.reduce((a, b) =>
          Math.hypot(a.tx - p0.x, a.ty - p0.y) < Math.hypot(b.tx - p0.x, b.ty - p0.y)
            ? a
            : b,
        );
        g.cmdAttack(cats, nt.id);
        g.cmdAttackMove(escort, gx, gy);
      } else {
        g.cmdAttackMove(freeArmy, gx, gy);
      }
    }
  };

  // ── run the sim ────────────────────────────────────────────────────────────
  let wallClock = 0;
  while (g.phase === "playing" && g.time < 2700) {
    const s = Date.now();
    g.step(1.0);
    wallClock += Date.now() - s;
    simTicks += 30;
    decide();
    // milestone tracking
    if (g.res[0].wood > startWood + 10) sawGather = true;
    if (g.teamBuildings(0).some((b) => b.built && b.type !== "keep")) sawBuildDone = true;
    if (g.teamUnits(0).some((u) => u.type !== "villager")) sawTrained = true;
    if (g.kills > 0) sawKill = true;
    if (g.popCap[0] > popCap0) sawPopCapRise = true;
  }
  simMs = wallClock;

  check("villagers gathered resources", sawGather, `wood ${startWood}→${Math.floor(g.res[0].wood)}`);
  check("building completed", sawBuildDone);
  check("population cap rose (house built)", sawPopCapRise, `cap ${popCap0}→${g.popCap[0]}`);
  check("military unit trained", sawTrained);
  check("combat produced kills", sawKill, `kills=${g.kills} losses=${g.losses}`);
  check(
    "game reached a conclusion",
    g.phase === "victory" || g.phase === "defeat",
    `phase=${g.phase} at t=${Math.floor(g.time)}s`,
  );
  const enemyBuildings = g.teamBuildings(1).length;
  const enemyUnits = g.teamUnits(1).length;
  console.log(
    `  info  t=${Math.floor(g.time)}s | enemy left: ${enemyBuildings} buildings, ${enemyUnits} units | player army=${g.teamUnits(0).filter((u) => u.type !== "villager").length}`,
  );
  const perTick = simMs / Math.max(1, simTicks);
  check(
    "performance: < 2ms per 33ms tick (headless)",
    perTick < 2,
    `${perTick.toFixed(3)} ms/tick avg over ${simTicks} ticks`,
  );

  // phase-2 systems actually appeared
  const p2Buildings =
    g.teamBuildings(0, "tower").length +
    g.teamBuildings(1, "tower").length +
    g.teamBuildings(0, "gate").length +
    g.teamBuildings(1, "gate").length +
    g.teamBuildings(0, "wall").length +
    g.teamBuildings(1, "wall").length;
  check("phase-2 defenses used (towers/gates/walls)", p2Buildings > 0, `${p2Buildings} pieces`);
  const ups = g.upgrades[0].length + g.upgrades[1].length;
  check("upgrades researched", ups > 0, `${ups} upgrades`);

  // no entity leaks
  check(
    "entity bookkeeping consistent",
    g.units.every((u: Unit) => g.byId.get(u.id) === u) &&
      g.buildings.every((b: Building) => g.byId.get(b.id) === b),
  );
}

for (const s of SEEDS) {
  try {
    runSeed(s);
  } catch (e) {
    failures++;
    console.error(`  FAIL  seed ${s} threw:`, e);
  }
}

console.log(
  failures === 0
    ? `\nALL SIM CHECKS PASSED (${SEEDS.length} seeds)`
    : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
