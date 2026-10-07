/**
 * Campaign validation: every mission must be completable by a competent bot
 * (same playbook as the skirmish sim bot) using only public engine APIs.
 */
import {
  TILE,
  UNIT_DEFS,
  type MatchConfig,
  defaultMatchConfig,
} from "../src/game/constants";
import { MISSIONS } from "../src/game/campaign";
import { Game, isNode } from "../src/game/engine";
import type { RNode, Unit, UnitType } from "../src/game/types";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

type Bld = { tx: number; ty: number; w: number; h: number; id: number };

function sendSiege(g: Game, free: Unit[], ek: Bld): void {
  const cats = free.filter((u) => u.type === "catapult");
  const rest = free.filter((u) => u.type !== "catapult");
  const tw = g.teamBuildings(1, "tower").filter((t) => t.built)[0];
  if (cats.length && tw) {
    g.cmdAttack(cats, tw.id);
    const esc = rest.slice(0, 6);
    if (esc.length) g.cmdMove(esc, (tw.tx + 1) * TILE, (tw.ty + 3) * TILE);
    if (rest.length > 6)
      g.cmdAttackMove(rest.slice(6), (ek.tx + ek.w / 2) * TILE, (ek.ty + ek.h + 1) * TILE);
  } else {
    g.cmdAttackMove(free, (ek.tx + ek.w / 2) * TILE, (ek.ty + ek.h + 1) * TILE);
  }
}

function playMission(missionId: number, seed: number, capSeconds: number) {
  const md = MISSIONS[missionId];
  const cfg: MatchConfig = {
    ...defaultMatchConfig(),
    mode: "campaign",
    missionId,
    map: md.map,
    size: md.size,
    lord: md.lord,
    difficulty: md.difficulty,
    startRes: md.startRes,
    seed,
  };
  const g = new Game(null, seed);
  g.startMatch(cfg);

  let houseIdx = 0;
  let farmIdx = 0;
  let wallsBuilt = false;
  let armySent = -999;

  const decide = (): void => {
    if (g.phase !== "playing") return;
    const pk = g.buildingById.get(g.keeps[0]);
    if (!pk) return;
    const kc = { x: (pk.tx + pk.w / 2) * TILE, y: (pk.ty + pk.h / 2) * TILE };
    const villagers = g.teamUnits(0, "villager");
    const farmsB = g.teamBuildings(0, "farm").filter((f) => f.built);

    // workers
    const wc = { food: 0, wood: 0, stone: 0, gold: 0 };
    for (const w of villagers) {
      if (w.state !== "harvest") continue;
      const t = g.byId.get(w.taskId);
      if (!t) continue;
      if (isNode(t))
        wc[t.kind === "tree" ? "wood" : t.kind === "rock" ? "stone" : "gold"]++;
      else if ((t as { type?: string }).type === "farm") wc.food++;
    }
    for (const v of villagers) {
      if (v.state !== "idle") continue;
      const site = g.teamBuildings(0).find((b) => !b.built && b.builders < 2);
      if (site) {
        g.assignBuild(v, site);
        continue;
      }
      if (farmsB.length && wc.food < farmsB.length * 3 && g.res[0].food < 340) {
        g.assignHarvest(v, farmsB[0].id);
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
    // staff unattended sites (pull harvesters)
    for (const site of g.teamBuildings(0)) {
      if (site.built || site.builders > 0) continue;
      const cands = villagers
        .filter((v) => v.state === "idle" || v.state === "harvest")
        .sort(
          (a, b) =>
            Math.hypot(a.x - kc.x, a.y - kc.y) - Math.hypot(b.x - kc.x, b.y - kc.y),
        );
      const pick = [...cands.filter((v) => v.state === "idle").slice(0, 2)];
      if (pick.length < 2)
        pick.push(...cands.filter((v) => v.state === "harvest").slice(0, 2 - pick.length));
      for (const v of pick) g.assignBuild(v, site);
    }

    const houses = g.teamBuildings(0, "house");
    const farmsAll = g.teamBuildings(0, "farm");
    const barracks = g.teamBuildings(0, "barracks");
    const busy = g
      .teamBuildings(0)
      .some((b) => !b.built && b.type !== "wall" && b.type !== "gate");

    // upgrades
    const keepB = g.buildingById.get(g.keeps[0])!;
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
      if (g.popCap[0] - g.popCur[0] <= 2 && g.res[0].wood >= 60 && houses.length < 10) {
        const a = houseIdx++ * 2.1;
        const sp = g.findSpotNear(
          Math.round((kc.x + Math.cos(a) * 8 * TILE) / TILE),
          Math.round((kc.y + Math.sin(a) * 8 * TILE) / TILE),
          "house", 0, 6);
        if (sp) g.place(0, "house", sp.x, sp.y);
      } else if (farmsAll.length < 4 && g.res[0].wood >= 50) {
        const a = 1.2 + farmIdx++ * 2.2;
        const sp = g.findSpotNear(
          Math.round((kc.x + Math.cos(a) * 9 * TILE) / TILE),
          Math.round((kc.y + Math.sin(a) * 9 * TILE) / TILE),
          "farm", 0, 6);
        if (sp) g.place(0, "farm", sp.x, sp.y);
      } else if (
        g.time > 150 && g.teamBuildings(0, "lumbercamp").length < 1 && g.res[0].wood >= 80
      ) {
        const tree = g.nearestNode("wood", kc.x, kc.y, 20 * TILE);
        if (tree) {
          const sp = g.findSpotNear(tree.tx, tree.ty, "lumbercamp", 0, 4);
          if (sp) g.place(0, "lumbercamp", sp.x, sp.y);
        }
      } else if (barracks.length < 1 && (g.time > 50 || g.res[0].wood > 150) && g.res[0].wood >= 130 && g.res[0].stone >= 45) {
        const sp = g.findSpotNear(Math.round(kc.x / TILE) - 5, Math.round(kc.y / TILE) + 4, "barracks", 0, 7);
        if (sp) g.place(0, "barracks", sp.x, sp.y);
      } else if (barracks.length === 1 && g.time > 300 && !busy && g.res[0].wood >= 260 && g.res[0].stone >= 80) {
        const sp = g.findSpotNear(Math.round(kc.x / TILE) + 5, Math.round(kc.y / TILE) + 5, "barracks", 0, 7);
        if (sp) g.place(0, "barracks", sp.x, sp.y);
      } else if (g.time > 400 && g.teamBuildings(0, "market").length < 1 && g.res[0].wood >= 140 && g.res[0].stone >= 50) {
        const sp = g.findSpotNear(Math.round(kc.x / TILE) - 6, Math.round(kc.y / TILE) - 5, "market", 0, 6);
        if (sp) g.place(0, "market", sp.x, sp.y);
      } else if (g.time > 240 && g.teamBuildings(0, "tower").length < 3 && g.res[0].stone >= 130) {
        const base = Math.atan2(-1, 1);
        const a = base + (g.teamBuildings(0, "tower").length - 1) * 0.9;
        const sp = g.findSpotNear(
          Math.round((kc.x + Math.cos(a) * 6 * TILE) / TILE),
          Math.round((kc.y + Math.sin(a) * 6 * TILE) / TILE),
          "tower", 0, 4);
        if (sp) g.place(0, "tower", sp.x, sp.y);
      } else if (barracks.length >= 1 && houses.length >= 3 && !wallsBuilt && g.res[0].stone > 90 && g.time > 240) {
        const base = Math.atan2(-1, 1);
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

    // training
    if (g.res[0].food >= 55 && villagers.length < 14) g.trainAt(keepB, "villager");
    const armyAll = g.teamUnits(0).filter((u) => UNIT_DEFS[u.type].military);
    const enemyKnights = g.teamUnits(1, "knight").length;
    const mySpears = g.teamUnits(0, "spearman").length;
    const myArchers = g.teamUnits(0, "archer").length;
    const myCats = g.teamUnits(0, "catapult").length;
    for (const bar of barracks) {
      if (!bar.built || bar.queue.length >= 2) continue;
      let type: UnitType;
      if (g.time > 420 && myCats < (missionId >= 1 ? 4 : 2) && g.res[0].wood > 260) type = "catapult";
      else if (enemyKnights >= 3 && mySpears < enemyKnights + 2) type = "spearman";
      else if (myArchers >= 4 && g.teamUnits(0, "knight").length < 3) type = "knight";
      else type = armyAll.length % 3 === 2 ? "archer" : "militia";
      if (!g.trainAt(bar, type)) g.trainAt(bar, "militia");
    }

    // defense micro
    if (g.time - g.alarm[0] < 8) {
      const threat = g
        .teamUnits(1)
        .filter(
          (e) =>
            UNIT_DEFS[e.type].military &&
            Math.hypot(e.x - kc.x, e.y - kc.y) < 14 * TILE,
        );
      if (threat.length) {
        const defenders = g
          .teamUnits(0)
          .filter((u) => UNIT_DEFS[u.type].military && u.state === "idle");
        if (defenders.length) g.cmdAttack(defenders, threat[0].id);
      }
    }

    // assaults
    const ek = g.buildingById.get(g.keeps[1]);
    const free = armyAll.filter(
      (u) => u.state !== "attack" && u.state !== "attackMove",
    );
    if (missionId === 0) {
      const camp = g.teamBuildings(1, "barracks")[0];
      if (camp && free.length >= 6) g.cmdAttack(free, camp.id);
      return;
    }
    if (missionId === 2 && !g.objectives.find((o) => o.id === "hold")?.done) return;
    if (!ek) return;
    const threshold = missionId === 3 ? 18 : 15;
    if (free.length >= threshold && g.time - armySent > 80) {
      armySent = g.time;
      sendSiege(g, free, ek);
    }
    // re-task idle siege/stragglers
    if (g.time > 400) {
      const idleCats = g.teamUnits(0, "catapult").filter((u) => u.state === "idle");
      if (idleCats.length) {
        const tw = g.teamBuildings(1, "tower").filter((t) => t.built)[0];
        const tgt = tw ?? ek;
        if (tgt) g.cmdAttack(idleCats, tgt.id);
      }
      const stray = g
        .teamUnits(0)
        .filter(
          (u) =>
            UNIT_DEFS[u.type].military &&
            u.type !== "catapult" &&
            u.state === "idle" &&
            Math.hypot(u.x - (ek.tx + 2) * TILE, u.y - (ek.ty + 2) * TILE) > 25 * TILE,
        );
      if (stray.length >= 5)
        g.cmdAttackMove(stray, (ek.tx + ek.w / 2) * TILE, (ek.ty + ek.h + 1) * TILE);
    }
  };

  const t0 = Date.now();
  while (g.phase === "playing" && g.time < capSeconds) {
    g.step(10);
    decide();
    if (Date.now() - t0 > 120000) break;
  }
  return g;
}

const caps = [900, 2400, 3000, 3300];
for (let i = 0; i < MISSIONS.length; i++) {
  const m = MISSIONS[i];
  const g = playMission(i, 4242 + i, caps[i]);
  const done = g.objectives.filter((o) => o.done).length;
  check(
    `mission ${i + 1} (${m.name}) completable`,
    g.phase === "victory" && g.objectives.every((o) => !o.primary || o.done),
    `phase=${g.phase} objectives=${done}/${g.objectives.length} t=${Math.round(g.time)} kills=${g.kills}`,
  );
  const dueEvents = m.events.filter((e) => e.t < g.time).length;
  check(
    `mission ${i + 1} scripted events fired`,
    g.missionEventIdx >= dueEvents,
    `fired=${g.missionEventIdx} due=${dueEvents}`,
  );
}
console.log(fails === 0 ? "\nCAMPAIGN TEST PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
