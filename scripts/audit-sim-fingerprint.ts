/**
 * Audit probe: deterministic simulation fingerprints.
 *
 * Runs several pinned configs headlessly and prints a compact fingerprint
 * (stateHash + resources + deaths + counts). Used to *prove* that performance
 * work does not change simulation behaviour: the fingerprint of a config must
 * be byte-identical before and after optimisation.
 *
 * Usage: npx tsx scripts/audit-sim-fingerprint.ts [--json out.json]
 */
import { writeFileSync } from "node:fs";
import {
  TILE,
  defaultMatchConfig,
  startPositions,
  type MatchConfig,
} from "../src/game/constants";
import { Game } from "../src/game/engine";

interface Case {
  id: string;
  cfg: Partial<MatchConfig>;
  units?: number;
  seconds: number;
  fight?: boolean;
}

const CASES: Case[] = [
  { id: "M-verdant-idle-300s", cfg: { size: "M", map: "verdant", seed: 12345, lord: 0 }, seconds: 300 },
  { id: "S-desert-idle-180s", cfg: { size: "S", map: "desert", seed: 777, lord: 2 }, seconds: 180 },
  { id: "L-riverlands-idle-240s", cfg: { size: "L", map: "riverlands", seed: 4242, lord: 1 }, seconds: 240 },
  { id: "L-600unit-brawl-45s", cfg: { size: "L", map: "verdant", seed: 20260101, lord: 0 }, units: 600, seconds: 45, fight: true },
  { id: "M-twin-survival-240s", cfg: { size: "M", map: "twin", mode: "survival", timeLimitMin: 4, seed: 99, lord: 3 }, seconds: 240 },
  { id: "L-mountain-siege-300s", cfg: { size: "L", map: "mountain", mode: "siege", seed: 555, lord: 1 }, seconds: 300 },
];

function fingerprint(g: Game): string {
  const r = (t: 0 | 1) =>
    ["wood", "stone", "gold", "food"]
      .map((k) => Math.round(g.res[t][k as keyof (typeof g.res)[0]]))
      .join(",");
  return [
    `hash=${g.stateHash()}`,
    `t=${g.time.toFixed(1)}`,
    `tick=${g.tickCount}`,
    `u=${g.units.length}`,
    `b=${g.buildings.length}`,
    `n=${g.nodes.length}`,
    `pop=${g.popCur[0]}/${g.popCur[1]}`,
    `cap=${g.popCap[0]}/${g.popCap[1]}`,
    `popularity=${g.popularity[0].toFixed(3)}/${g.popularity[1].toFixed(3)}`,
    `res0=${r(0)}`,
    `res1=${r(1)}`,
    `deaths=${g.deaths[0]}/${g.deaths[1]}`,
    `phase=${g.phase}`,
  ].join("|");
}

function run(c: Case): string {
  const cfg = { ...defaultMatchConfig(), ...c.cfg } as MatchConfig;
  cfg.lord = c.cfg.lord ?? 0; // pinned: no Math.random in the fingerprint path
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  if (c.units) {
    // two blocks 26 tiles apart near the map centre so combat, projectiles,
    // separation, deaths and grief all run inside the measured window
    const [a, b] = startPositions();
    const mx = Math.round((a.x + b.x) / 2);
    const my = Math.round((a.y + b.y) / 2);
    const types = ["militia", "spearman", "archer", "knight"] as const;
    const perRow = Math.max(8, Math.ceil(Math.sqrt(c.units / 2)));
    for (let i = 0; i < c.units; i++) {
      const t = i % 2 === 0 ? 0 : 1;
      const k = i >> 1;
      const ox = t === 0 ? -13 : 13;
      g.spawnUnit(
        t,
        types[k % types.length],
        (mx + ox + (k % perRow) - perRow / 2) * TILE,
        (my + Math.floor(k / perRow) - perRow / 2) * TILE,
      );
    }
    if (c.fight) {
      g.cmdAttackMove(g.teamUnits(0), b.x * TILE, b.y * TILE);
      g.cmdAttackMove(g.teamUnits(1), a.x * TILE, a.y * TILE);
    }
  }
  g.step(c.seconds);
  return fingerprint(g);
}

const out: Record<string, string> = {};
for (const c of CASES) {
  const f1 = run(c);
  const f2 = run(c); // same config twice → must be identical (determinism)
  out[c.id] = f1;
  console.log(`${f1 === f2 ? "STABLE" : "NONDETERMINISTIC"}  ${c.id}`);
  console.log(`   ${f1}`);
  if (f1 !== f2) {
    console.log(`   rerun: ${f2}`);
    process.exitCode = 1;
  }
}

const jsonIdx = process.argv.indexOf("--json");
if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(out, null, 1));
  console.log(`wrote ${process.argv[jsonIdx + 1]}`);
}
