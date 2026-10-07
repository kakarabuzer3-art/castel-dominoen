import { sfx } from "./audio";
import {
  AI,
  BUILDING_DEFS,
  DIFFICULTIES,
  TILE,
  UNIT_DEFS,
  UPGRADES,
  canAfford,
} from "./constants";
import type { Game } from "./engine";
import { isBuilding, isNode } from "./engine";
import type { Building, ResKind, Unit, UnitType } from "./types";

/**
 * Enemy AI: adaptive build order, economy management, upgrades, defensive
 * towers/walls/gates, harassment raids and escalating attack waves.
 */
export interface AiPersonality {
  id: number;
  name: string;
  desc: string;
  waveTime: number;
  waveSpacing: number;
  raidTime: number;
  raidSpacing: number;
  capMult: number;
  hold: number;
  towers: number;
  walls: number;
  villagers: number;
}

export const PERSONALITIES: AiPersonality[] = [
  {
    id: 0,
    name: "Aggressive",
    desc: "Early raids and relentless waves. Weak walls, strong army.",
    waveTime: 0.8,
    waveSpacing: 0.8,
    raidTime: 0.65,
    raidSpacing: 0.75,
    capMult: 1.15,
    hold: 2,
    towers: 1,
    walls: 12,
    villagers: 12,
  },
  {
    id: 1,
    name: "Defensive",
    desc: "Turtles behind towers and walls, then counter-attacks in force.",
    waveTime: 1.3,
    waveSpacing: 1.25,
    raidTime: 1.3,
    raidSpacing: 1.4,
    capMult: 0.95,
    hold: 5,
    towers: 4,
    walls: 40,
    villagers: 16,
  },
  {
    id: 2,
    name: "Economic",
    desc: "Booms its economy and upgrades, then overwhelms you late.",
    waveTime: 1.5,
    waveSpacing: 1.1,
    raidTime: 1.2,
    raidSpacing: 1.2,
    capMult: 0.85,
    hold: 3,
    towers: 2,
    walls: 20,
    villagers: 18,
  },
  {
    id: 3,
    name: "Siege Master",
    desc: "Fields catapult trains and grinds fortifications to dust.",
    waveTime: 1.1,
    waveSpacing: 1.0,
    raidTime: 1.1,
    raidSpacing: 1.1,
    capMult: 1.0,
    hold: 3,
    towers: 2,
    walls: 24,
    villagers: 15,
  },
];

export class AIController {
  personality: AiPersonality;
  private t = 0;
  private waveIdx = 0;
  private lastWave = -999;
  private lastRaid = -999;
  private trainFlip = false;
  private wallsDone = 0;
  private gatesDone = 0;
  private towersDone = 0;
  private houseRing = 0;
  private catapultsWanted = 0;

  difficulty = 1;

  constructor(
    private g: Game,
    personalityId = 1,
    difficulty = 1,
  ) {
    this.personality =
      PERSONALITIES[Math.max(0, Math.min(PERSONALITIES.length - 1, personalityId))];
    this.difficulty = Math.max(0, Math.min(3, difficulty));
  }

  private get diff() {
    return DIFFICULTIES[this.difficulty];
  }

  serialize(): Record<string, number> {
    return {
      personality: this.personality.id,
      waveIdx: this.waveIdx,
      lastWave: this.lastWave,
      lastRaid: this.lastRaid,
      trainFlip: this.trainFlip ? 1 : 0,
      wallsDone: this.wallsDone,
      gatesDone: this.gatesDone,
      towersDone: this.towersDone,
      houseRing: this.houseRing,
      catapultsWanted: this.catapultsWanted,
      t: this.t,
    };
  }

  deserialize(d: Record<string, number> | undefined): void {
    if (!d) return;
    if (d.personality !== undefined)
      this.personality =
        PERSONALITIES[Math.max(0, Math.min(2, d.personality))];
    this.waveIdx = d.waveIdx ?? 0;
    this.lastWave = d.lastWave ?? -999;
    this.lastRaid = d.lastRaid ?? -999;
    this.trainFlip = !!d.trainFlip;
    this.wallsDone = d.wallsDone ?? 0;
    this.gatesDone = d.gatesDone ?? 0;
    this.towersDone = d.towersDone ?? 0;
    this.houseRing = d.houseRing ?? 0;
    this.catapultsWanted = d.catapultsWanted ?? 0;
    this.t = d.t ?? 0;
  }

  update(dt: number): void {
    if (this.g.phase !== "playing") return;
    this.t += dt;
    if (this.t < AI.buildInterval) return;
    this.t = 0;
    const g = this.g;
    const team = 1 as const;

    const keep = g.buildingById.get(g.keeps[1]);
    if (!keep) return;
    const late = g.time > 1800;
    // sandbox neighbour never attacks; campaign pressure comes from mission
    // scripts (waves/raids disabled here so mission difficulty stays tunable)
    const passive = g.cfg.mode === "sandbox" || g.cfg.mode === "campaign";
    const treaty = g.time < g.cfg.noRushMin * 60;
    const missionPassive =
      g.cfg.mode === "campaign" &&
      g.mission?.aiPassiveUntil !== undefined &&
      g.time < g.mission.aiPassiveUntil;
    // endgame: convert surplus into gold for a decisive army
    if (late && g.hasMarket(team)) {
      if (g.res[team].wood > 400) g.exchange(team, "sellWood");
      if (g.res[team].food > 400) g.exchange(team, "sellFood");
    }
    const kcx = (keep.tx + keep.w / 2) * TILE;
    const kcy = (keep.ty + keep.h / 2) * TILE;

    const villagers = g.teamUnits(team, "villager");
    const military = g
      .teamUnits(team)
      .filter((u) => UNIT_DEFS[u.type].military);

    // ── raid retreat logic ───────────────────────────────────────────────────
    for (const u of military) {
      if (u.raid > 0) {
        if (g.time > u.raid || u.hp < u.maxHp * 0.35) {
          u.raid = -2;
          g.cmdMove([u], kcx, kcy + 4 * TILE);
        }
      }
    }

    // difficulty income handicap/bonus (brutal AI cheats slightly)
    if (this.diff.incomeMult !== 1) {
      const bonus = (this.diff.incomeMult - 1) * dt * 2.2;
      g.res[team].wood += bonus;
      g.res[team].food += bonus;
      g.res[team].gold += bonus * 0.5;
      g.res[team].stone += bonus * 0.5;
    }

    // ── worker bookkeeping ───────────────────────────────────────────────────
    const workers: Record<string, number> = {
      food: 0,
      wood: 0,
      stone: 0,
      gold: 0,
    };
    const idle: Unit[] = [];
    for (const v of villagers) {
      if (v.state === "idle") {
        idle.push(v);
        continue;
      }
      if (v.state === "harvest") {
        const t = g.byId.get(v.taskId);
        if (!t) continue;
        if (isNode(t))
          workers[t.kind === "tree" ? "wood" : t.kind === "rock" ? "stone" : "gold"]++;
        else if (isBuilding(t) && t.type === "farm") workers.food++;
      }
    }

    const farms = g.teamBuildings(team, "farm").filter((f) => f.built);
    const needFood = farms.length ? Math.min(6, farms.length * 3) : 0;
    const needWood = 5;
    const needStone = 2;
    const needGold = 2;

    // ── assign idle villagers ────────────────────────────────────────────────
    for (const v of idle) {
      const foodLow = g.res[team].food < 90;
      const woodLow = g.res[team].wood < 70;
      let kind: ResKind | null = null;
      if (
        (workers.food < needFood && (foodLow || workers.wood >= needWood)) ||
        workers.food === 0
      )
        kind = "food";
      if (kind === "food" && !farms.length) kind = woodLow ? "wood" : "food";
      if (kind === "food" && farms.length) {
        const farm = farms.reduce((a, b) =>
          this.farmLoad(a) <= this.farmLoad(b) ? a : b,
        );
        if (this.farmLoad(farm) < 3) {
          g.assignHarvest(v, farm.id);
          workers.food++;
          continue;
        }
        kind = "wood";
      }
      if (!kind)
        kind =
          workers.wood < needWood
            ? "wood"
            : workers.gold < needGold
              ? "gold"
              : workers.stone < needStone
                ? "stone"
                : "wood";
      if (woodLow && kind !== "wood" && workers.wood < needWood) kind = "wood";
      const node =
        g.nearestNode(kind, v.x, v.y, 30 * TILE) ??
        g.nearestNode(kind, kcx, kcy, 44 * TILE) ??
        g.nearestNode(null, v.x, v.y, 30 * TILE);
      if (node) {
        g.assignHarvest(v, node.id);
        const k =
          node.kind === "tree" ? "wood" : node.kind === "rock" ? "stone" : "gold";
        workers[k]++;
      }
    }

    // ── keep construction sites staffed; repair damaged buildings ──────────
    for (const b of g.teamBuildings(team)) {
      if (!b.built && b.builders === 0) {
        const helpers = this.pickBuilders(b, 2);
        for (const h of helpers) g.assignBuild(h, b);
      } else if (b.built && b.hp < b.maxHp * 0.6) {
        const repairers = g
          .teamUnits(team, "villager")
          .filter((v) => v.state === "repair" && v.taskId === b.id).length;
        if (repairers < 2) {
          const idle = g
            .teamUnits(team, "villager")
            .filter((v) => v.state === "idle")
            .slice(0, 2 - repairers);
          for (const v of idle) g.assignRepair(v, b);
        }
      }
    }

    // ── build order ──────────────────────────────────────────────────────────
    const res = g.res[team];
    const houses = g.teamBuildings(team, "house");
    const barracks = g.teamBuildings(team, "barracks");
    const buildingSomething = g
      .teamBuildings(team)
      .some((b) => !b.built && b.type !== "wall" && b.type !== "gate");

    const tryBuild = (
      type: keyof typeof BUILDING_DEFS,
      nearX: number,
      nearY: number,
      maxR: number,
    ): boolean => {
      if (buildingSomething && type !== "wall" && type !== "farm" && type !== "gate")
        return false;
      const spot = g.findSpotNear(
        Math.round(nearX / TILE),
        Math.round(nearY / TILE),
        type,
        team,
        maxR,
      );
      if (!spot) return false;
      const b = g.place(team, type, spot.x, spot.y);
      if (b) {
        const helpers = this.pickBuilders(b, 2);
        for (const h of helpers) g.assignBuild(h, b);
      }
      return !!b;
    };

    if (
      g.popCap[team] - g.popCur[team] <= 2 &&
      res.wood >= BUILDING_DEFS.house.cost.wood! + 30 &&
      houses.length < (g.cfg.epic ? 26 : 10)
    ) {
      const ang = this.houseRing * 1.9 + 0.7;
      this.houseRing++;
      tryBuild(
        "house",
        kcx + Math.cos(ang) * 8 * TILE,
        kcy + Math.sin(ang) * 8 * TILE,
        5,
      );
    }

    const farmTarget = Math.max(2, Math.min(8, Math.ceil(villagers.length / 3)));
    if (
      farms.length +
        g.teamBuildings(team, "farm").filter((f) => !f.built).length <
        farmTarget &&
      res.wood >= BUILDING_DEFS.farm.cost.wood! + 25
    ) {
      const ang = farms.length * 2.4 + 2.0;
      tryBuild(
        "farm",
        kcx + Math.cos(ang) * 9 * TILE,
        kcy + Math.sin(ang) * 9 * TILE,
        6,
      );
    }

    if (
      barracks.length === 0 &&
      (g.time > 40 || res.wood > 220) &&
      res.wood >= BUILDING_DEFS.barracks.cost.wood! + 40 &&
      res.stone >= BUILDING_DEFS.barracks.cost.stone!
    ) {
      tryBuild("barracks", kcx - 6 * TILE, kcy + 5 * TILE, 7);
    } else if (
      barracks.length === 1 &&
      g.time > 300 &&
      res.wood >= 240 &&
      res.stone >= 100
    ) {
      tryBuild("barracks", kcx + 6 * TILE, kcy - 4 * TILE, 8);
    } else if (
      g.cfg.epic &&
      barracks.length === 2 &&
      g.time > 420 &&
      res.wood >= 320 &&
      res.stone >= 140
    ) {
      // an epic army needs a third production line
      tryBuild("barracks", kcx - 8 * TILE, kcy - 6 * TILE, 9);
    } else if (
      g.cfg.epic &&
      barracks.length === 3 &&
      g.time > 600 &&
      res.wood >= 320 &&
      res.stone >= 140
    ) {
      tryBuild("barracks", kcx + 8 * TILE, kcy + 6 * TILE, 9);
    }

    // economy buildings: lumber camp & quarry auras
    if (
      g.time > 150 &&
      workers.wood >= 4 &&
      g.teamBuildings(team, "lumbercamp").length < 2 &&
      canAfford(res, BUILDING_DEFS.lumbercamp.cost)
    ) {
      const tree = g.nearestNode("wood", kcx, kcy, 24 * TILE);
      if (tree) tryBuild("lumbercamp", tree.tx * TILE, tree.ty * TILE, 4);
    }
    if (
      g.time > 210 &&
      g.teamBuildings(team, "quarry").length < 1 &&
      canAfford(res, BUILDING_DEFS.quarry.cost)
    ) {
      const rock = g.nearestNode("stone", kcx, kcy, 26 * TILE);
      if (rock) tryBuild("quarry", rock.tx * TILE, rock.ty * TILE, 4);
    }
    if (
      g.time > 300 &&
      g.teamBuildings(team, "shrine").length < 2 &&
      canAfford(res, BUILDING_DEFS.shrine.cost)
    ) {
      const ang = 3.6;
      tryBuild("shrine", kcx + Math.cos(ang) * 7 * TILE, kcy + Math.sin(ang) * 7 * TILE, 5);
    }
    if (
      g.time > 380 &&
      g.teamBuildings(team, "market").length < 1 &&
      canAfford(res, BUILDING_DEFS.market.cost)
    ) {
      tryBuild("market", kcx - 7 * TILE, kcy - 5 * TILE, 6);
    }
    if (
      g.time > 300 &&
      g.teamBuildings(team, "granary").length < 1 &&
      canAfford(res, BUILDING_DEFS.granary.cost)
    ) {
      tryBuild("granary", kcx - 8 * TILE, kcy + 3 * TILE, 5);
    }
    if (
      g.time > 420 &&
      g.teamBuildings(team, "inn").length < 1 &&
      canAfford(res, BUILDING_DEFS.inn.cost)
    ) {
      tryBuild("inn", kcx + 8 * TILE, kcy + 2 * TILE, 5);
    }

    // defensive towers guarding the approach
    const pKeep = g.buildingById.get(g.keeps[0]);
    const baseAng = pKeep
      ? Math.atan2(
          (pKeep.ty + pKeep.h / 2) * TILE - kcy,
          (pKeep.tx + pKeep.w / 2) * TILE - kcx,
        )
      : Math.PI * 0.75;
    if (
      !missionPassive &&
      g.time > 240 &&
      this.towersDone <
        Math.min(
          g.cfg.mode === "campaign" ? 1 : 99,
          g.time > 1200
            ? this.personality.towers + 1
            : this.personality.towers,
        ) &&
      canAfford(res, BUILDING_DEFS.tower.cost)
    ) {
      const a = baseAng + (this.towersDone === 0 ? -0.7 : 0.7);
      if (
        tryBuild(
          "tower",
          kcx + Math.cos(a) * 6 * TILE,
          kcy + Math.sin(a) * 6 * TILE,
          4,
        )
      )
        this.towersDone++;
    }

    // wall arc facing the player, with two gates
    if (
      !missionPassive &&
      g.time > 210 &&
      this.wallsDone <
        Math.min(
          g.cfg.mode === "campaign" ? 6 : 99,
          this.personality.walls,
        ) &&
      res.stone >= 60
    ) {
      let placed = 0;
      for (let i = 0; i < 15 && placed < 3; i++) {
        const a = baseAng - 1.15 + (i / 14) * 2.3;
        const tx = Math.round((kcx + Math.cos(a) * 7.5 * TILE) / TILE);
        const ty = Math.round((kcy + Math.sin(a) * 7.5 * TILE) / TILE);
        // leave gate gaps at the middle of the arc
        const isGateSpot = i === 7 || i === 8;
        if (isGateSpot) {
          if (this.gatesDone < 2 && g.place(team, "gate", tx, ty)) {
            this.gatesDone++;
            placed++;
          }
          continue;
        }
        if (g.place(team, "wall", tx, ty)) {
          placed++;
          this.wallsDone++;
        }
      }
    }

    // ── upgrades ─────────────────────────────────────────────────────────────
    const researchIfAffordable = (id: string, minRes: Partial<Record<ResKind, number>>) => {
      if (g.hasUpgrade(team, id)) return;
      const def = UPGRADES.find((u) => u.id === id)!;
      const b = g
        .teamBuildings(team, def.at)
        .find((x) => x.built && !x.research);
      if (!b) return;
      for (const k of Object.keys(minRes) as ResKind[])
        if (res[k] < (minRes[k] ?? 0)) return;
      if (!canAfford(res, def.cost)) return;
      g.startResearch(b, id);
    };
    researchIfAffordable("wheelbarrow", { food: 200 });
    researchIfAffordable("iron_swords", { food: 220, gold: 180 });
    researchIfAffordable("longbows", { wood: 200, gold: 160 });
    researchIfAffordable("padded_armor", { food: 240, gold: 140 });
    researchIfAffordable("town_watch", { wood: 160, gold: 160 });
    if (g.time > 540) researchIfAffordable("siege_eng", { wood: 220, gold: 220 });

    // ── training (adaptive composition) ─────────────────────────────────────
    const keepB = g.buildingById.get(g.keeps[1])!;
    if (
      !late &&
      villagers.length + keepB.queue.filter((q) => q === "villager").length <
        this.personality.villagers *
          this.diff.villMult *
          (g.cfg.epic ? 1.7 : 1) &&
      res.food >= UNIT_DEFS.villager.cost.food! + 40
    ) {
      g.trainAt(keepB, "villager");
    }

    const campMult = g.cfg.mode === "campaign" ? 0.5 : 1;
    // epic matches are meant to look like epic battles: the AI fields a
    // proportionally larger army (still bounded by its housing)
    const epicMult = g.cfg.epic ? 2.4 : 1;
    const milCap = missionPassive
      ? 0
      : Math.round(
          (late ? 44 : AI.militaryCap(g.time)) *
            this.personality.capMult *
            this.diff.capMult *
            campMult *
            epicMult,
        );
    const queuedMil = barracks.reduce(
      (n, bar) => n + bar.queue.filter((q) => q !== "villager").length,
      0,
    );
    const playerCav = g.teamUnits(0, "knight").length;
    const playerArchers = g.teamUnits(0, "archer").length;
    const aiSpears = g.teamUnits(1, "spearman").length;
    const aiKnights = g.teamUnits(1, "knight").length;
    const aiCats = g.teamUnits(1, "catapult").length;

    for (const bar of barracks) {
      if (!bar.built || bar.queue.length >= 2) continue;
      if (military.length + queuedMil >= milCap) break;
      let type: UnitType;
      const catWant =
        g.cfg.mode === "campaign"
          ? this.personality.id === 3
            ? 2
            : 0
          : this.personality.id === 3
            ? g.time > 360
              ? 6
              : 3
            : late
              ? 6
              : g.time > 1200
                ? 4
                : 2;
      if (g.time > 540 && aiCats + this.catapultsWanted < catWant && res.wood > 300) {
        type = "catapult";
        this.catapultsWanted++;
      } else if (playerCav >= 3 && aiSpears < playerCav + 2) type = "spearman";
      else if (playerArchers >= 4 && aiKnights < 4) type = "knight";
      else {
        type = this.trainFlip ? "archer" : "militia";
        this.trainFlip = !this.trainFlip;
      }
      if (!g.trainAt(bar, type)) {
        g.trainAt(bar, "militia") || g.trainAt(bar, "spearman");
      }
    }

    // ── harassment raids ─────────────────────────────────────────────────────
    if (
      !passive &&
      !treaty &&
      g.time > AI.raidAfter * this.personality.raidTime &&
      g.time - this.lastRaid > AI.raidEvery * this.personality.raidSpacing &&
      military.length >= AI.raidSize + 3
    ) {
      // target the player's busiest gathering spot
      const gatherers = g
        .teamUnits(0, "villager")
        .filter((v) => v.state === "harvest");
      let tx = (pKeep?.tx ?? 13) * TILE;
      let ty = (pKeep?.ty ?? 90) * TILE;
      if (gatherers.length) {
        tx = gatherers.reduce((s, v) => s + v.x, 0) / gatherers.length;
        ty = gatherers.reduce((s, v) => s + v.y, 0) / gatherers.length;
      }
      const raiders = [...military]
        .filter((u) => u.raid < 0 && u.hp > u.maxHp * 0.6)
        .sort((a, b) => (a.type === "knight" ? -1 : b.type === "knight" ? 1 : 0))
        .slice(0, AI.raidSize);
      if (raiders.length >= 3) {
        for (const r of raiders) r.raid = g.time + AI.raidDuration;
        g.cmdAttackMove(raiders, tx, ty);
        this.lastRaid = g.time;
        sfx.play("horn");
        g.msg("Scouts report raiders slipping toward your workers!", "bad");
      }
    }

    // ── attack waves ─────────────────────────────────────────────────────────
    const waveSize = Math.max(
      4,
      Math.round(
        AI.waveSizes[Math.min(this.waveIdx, AI.waveSizes.length - 1)] *
          this.diff.waveMult,
      ),
    );
    const spacing =
      (late ? 50 : g.time > 1600 ? 80 : AI.waveInterval) *
      this.personality.waveSpacing;
    const waveWindow =
      g.time > AI.firstWaveAfter * this.personality.waveTime &&
      g.time - this.lastWave > spacing;
    const forced =
      g.time > AI.forceAttackAfter &&
      g.time - this.lastWave > AI.forceAttackEvery &&
      military.length >= 4;
    const survivalPush =
      g.cfg.mode === "survival" && g.time - this.lastWave > Math.max(45, AI.waveInterval - this.waveIdx * 3);
    if (
      !passive &&
      !treaty &&
      !missionPassive &&
      (waveWindow && (military.length >= waveSize || forced) || survivalPush)
    ) {
      if (pKeep && military.length > 0) {
        const hold =
          this.waveIdx >= 4
            ? 0
            : Math.min(this.personality.hold, Math.floor(military.length / 3));
        const sorted = [...military].sort(
          (a, b) =>
            Math.hypot(a.x - kcx, a.y - kcy) - Math.hypot(b.x - kcx, b.y - kcy),
        );
        const attackers = sorted.slice(hold).filter((u) => u.raid < 0);
        if (attackers.length) {
          // late waves break the defender's towers first, then the keep
          let gx = (pKeep.tx + pKeep.w / 2) * TILE;
          let gy = (pKeep.ty + pKeep.h + 1) * TILE;
          if (this.waveIdx >= 3) {
            const towers = g.teamBuildings(0, "tower").filter((t) => t.built);
            if (towers.length) {
              const t0 = towers.reduce((a, b) =>
                Math.hypot(a.tx - pKeep.tx, a.ty - pKeep.ty) <
                Math.hypot(b.tx - pKeep.tx, b.ty - pKeep.ty)
                  ? a
                  : b,
              );
              gx = (t0.tx + t0.w / 2) * TILE;
              gy = (t0.ty + t0.h / 2) * TILE;
            }
          }
          g.cmdAttackMove(attackers, gx, gy);
          this.waveIdx++;
          this.lastWave = g.time;
          sfx.play("horn");
          g.msg("An enemy army marches on your realm!", "bad");
        }
      }
    }
  }

  private farmLoad(farm: Building): number {
    let n = 0;
    for (const v of this.g.teamUnits(1, "villager"))
      if (v.state === "harvest" && v.taskId === farm.id) n++;
    return n;
  }

  private pickBuilders(site: Building, max: number): Unit[] {
    const g = this.g;
    const p = {
      x: (site.tx + site.w / 2) * TILE,
      y: (site.ty + site.h / 2) * TILE,
    };
    const idle = g
      .teamUnits(1, "villager")
      .filter((v) => v.state === "idle" || v.state === "harvest")
      .sort(
        (a, b) =>
          Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y),
      );
    const trulyIdle = idle.filter((v) => v.state === "idle");
    const out = trulyIdle.slice(0, max);
    if (out.length < max)
      out.push(
        ...idle
          .filter((v) => v.state === "harvest")
          .slice(0, max - out.length),
      );
    return out;
  }
}
