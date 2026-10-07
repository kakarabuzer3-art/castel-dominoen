/**
 * Checkpoint B test suite: XL map + Epic Army scale, adaptive quality governor,
 * and proof that the performance work did not change simulation behaviour.
 *
 * Everything here is headless (no DOM, no GPU): the numbers it prints are
 * *simulation* costs measured on this machine. Real render/GPU numbers come
 * from the in-game F3 profiler — see README "Phase 10 Checkpoint B".
 *
 * Usage: npx tsx scripts/perf-test.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILDING_DEFS,
  EPIC,
  MAP_DIMS,
  TILE,
  defaultMatchConfig,
  type MatchConfig,
} from "../src/game/constants";
import { Game } from "../src/game/engine";
import { PerfGovernor, TIER_FX, tierFromQuality } from "../src/game/perf";

let fails = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

const STEP = 1 / 30;

function epicCfg(size: "S" | "M" | "L" | "XL", epic: boolean, seed = 20260101): MatchConfig {
  const cfg = defaultMatchConfig();
  cfg.size = size;
  cfg.epic = epic;
  cfg.map = "verdant";
  cfg.seed = seed;
  cfg.lord = 0;
  cfg.difficulty = 1;
  return cfg;
}

/**
 * Spawn two blocks of units.
 *  - "brawl": facing each other mid-map and attack-moving → real combat
 *    (projectiles, splash, deaths, grief, particles). Armies attrit fast.
 *  - "keeps": each army around its own keep with no orders → a *sustained*
 *    population for measuring steady-state per-unit sim cost.
 */
function muster(g: Game, perTeam: number, where: "brawl" | "keeps" = "brawl"): number {
  const types = ["militia", "spearman", "archer", "knight"] as const;
  const perRow = Math.max(8, Math.ceil(Math.sqrt(perTeam)));
  const kx = [Math.round(g.grid.w * 0.125), Math.round(g.grid.w * 0.875)];
  const ky = [Math.round(g.grid.h * 0.875), Math.round(g.grid.h * 0.125)];
  const mx = Math.round(g.grid.w / 2);
  const my = Math.round(g.grid.h / 2);
  let n = 0;
  for (let t = 0 as 0 | 1; t <= 1; t++) {
    const bx = where === "keeps" ? kx[t] : mx + (t === 0 ? -14 : 14);
    const by = where === "keeps" ? ky[t] : my;
    for (let k = 0; k < perTeam; k++) {
      g.spawnUnit(
        t,
        types[k % types.length],
        (bx + (k % perRow) - perRow / 2) * TILE,
        (by + Math.floor(k / perRow) - perRow / 2) * TILE,
      );
      n++;
    }
  }
  if (where === "brawl") {
    g.cmdAttackMove(g.teamUnits(0), (mx + 14) * TILE, my * TILE);
    g.cmdAttackMove(g.teamUnits(1), (mx - 14) * TILE, my * TILE);
  }
  return n;
}

interface RunReport {
  avgTickMs: number;
  p95TickMs: number;
  maxTickMs: number;
  realtimeFactor: number;
  units: number;
  peakUnits: number;
  buildings: number;
  particles: number;
  projectiles: number;
  heapMB: number;
  rssMB: number;
  fingerprint: string;
}

function runScale(
  cfg: MatchConfig,
  perTeam: number,
  seconds: number,
  where: "brawl" | "keeps" = "brawl",
): RunReport {
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  muster(g, perTeam, where);
  let peakUnits = 0;
  const times: number[] = [];
  const total = Math.round(seconds / STEP);
  const t0 = performance.now();
  for (let i = 0; i < total; i++) {
    const s = performance.now();
    g.step(STEP);
    times.push(performance.now() - s);
    peakUnits = Math.max(peakUnits, g.units.length);
    if (g.phase !== "playing") break;
  }
  const wall = performance.now() - t0;
  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
  const mem = process.memoryUsage();
  const r = (t: 0 | 1) =>
    ["wood", "stone", "gold", "food"]
      .map((k) => Math.round(g.res[t][k as keyof (typeof g.res)[0]]))
      .join(",");
  return {
    avgTickMs: +avg.toFixed(3),
    p95TickMs: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3),
    maxTickMs: +sorted[sorted.length - 1].toFixed(3),
    realtimeFactor: +((seconds * 1000) / wall).toFixed(2),
    units: g.units.length,
    peakUnits,
    buildings: g.buildings.length,
    particles: g.particles.length,
    projectiles: g.projectiles.length,
    heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    rssMB: +(mem.rss / 1048576).toFixed(1),
    fingerprint: [
      g.stateHash(),
      `t=${g.time.toFixed(2)}`,
      `pop=${g.popCur[0]}/${g.popCur[1]}`,
      `cap=${g.popCap[0]}/${g.popCap[1]}`,
      `deaths=${g.deaths[0]}/${g.deaths[1]}`,
      `res0=${r(0)}`,
      `res1=${r(1)}`,
      `popularity=${g.popularity[0].toFixed(4)}/${g.popularity[1].toFixed(4)}`,
    ].join("|"),
  };
}

console.log("\n=== 1. behaviour preservation (recorded pre-optimisation fingerprints) ===");
{
  const fxPath = fileURLToPath(new URL("./fixtures/sim-fingerprints.json", import.meta.url));
  const fx = JSON.parse(readFileSync(fxPath, "utf8")) as Record<string, string>;
  // re-run the exact configs the fixture was recorded from
  const cases: Array<[string, MatchConfig, number, number, boolean]> = [
    ["M-verdant-idle-300s", { ...defaultMatchConfig(), size: "M", map: "verdant", seed: 12345, lord: 0 }, 0, 300, false],
    ["S-desert-idle-180s", { ...defaultMatchConfig(), size: "S", map: "desert", seed: 777, lord: 2 }, 0, 180, false],
    ["L-riverlands-idle-240s", { ...defaultMatchConfig(), size: "L", map: "riverlands", seed: 4242, lord: 1 }, 0, 240, false],
    ["L-mountain-siege-300s", { ...defaultMatchConfig(), size: "L", map: "mountain", mode: "siege", seed: 555, lord: 1 }, 0, 300, false],
    ["M-twin-survival-240s", { ...defaultMatchConfig(), size: "M", map: "twin", mode: "survival", timeLimitMin: 4, seed: 99, lord: 3 }, 0, 240, false],
  ];
  let same = 0;
  const diffs: string[] = [];
  for (const [id, cfg, perTeam, secs] of cases) {
    const g = new Game(null, cfg.seed);
    g.startMatch(cfg);
    if (perTeam) muster(g, perTeam);
    g.step(secs);
    const r = (t: 0 | 1) =>
      ["wood", "stone", "gold", "food"]
        .map((k) => Math.round(g.res[t][k as keyof (typeof g.res)[0]]))
        .join(",");
    const fp = [
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
    if (fx[id] === fp) same++;
    else diffs.push(`${id}\n      want ${fx[id]}\n      got  ${fp}`);
  }
  check(
    "non-epic sim fingerprints identical to the recorded baseline",
    diffs.length === 0 && same === cases.length,
    `${same}/${cases.length} identical${diffs.length ? `\n      ${diffs[0]}` : ""}`,
  );
}

console.log("\n=== 2. popRatePerMin() must equal sum(popFactors()) exactly ===");
{
  const g = new Game(null, 4242);
  g.startMatch(epicCfg("L", true, 4242));
  let ok = true;
  let worst = 0;
  let samples = 0;
  for (let i = 0; i < 40; i++) {
    g.step(30);
    for (const t of [0, 1] as const) {
      const a = g.popFactors(t).reduce((s, f) => s + f.value, 0);
      const b = g.popRatePerMin(t);
      const d = Math.abs(a - b);
      worst = Math.max(worst, d);
      samples++;
      if (a !== b) ok = false;
    }
  }
  check(
    "allocation-free popularity rate is bit-identical to popFactors()",
    ok,
    `${samples} samples, max |Δ| = ${worst}`,
  );
}

console.log("\n=== 3. Epic Army capacity (opt-in) ===");
{
  const normal = new Game(null, 20260101);
  normal.startMatch(epicCfg("L", false));
  const epic = new Game(null, 20260101);
  epic.startMatch(epicCfg("L", true));
  check(
    "epic start resources are richer for both seats",
    epic.res[0].wood > normal.res[0].wood && epic.res[1].wood > normal.res[1].wood,
    `epic wood ${Math.round(epic.res[0].wood)}/${Math.round(epic.res[1].wood)} vs normal ${Math.round(normal.res[0].wood)}/${Math.round(normal.res[1].wood)}`,
  );
  check(
    "epic population ceiling is higher before any house",
    epic.popCap[0] === EPIC.popBase && normal.popCap[0] === 8,
    `epic=${epic.popCap[0]} normal=${normal.popCap[0]}`,
  );
  // same number of houses → epic cap must scale by EPIC.housePop
  for (const g of [normal, epic]) {
    const k = g.buildingById.get(g.keeps[0])!;
    for (let i = 0; i < 5; i++) g.spawnBuilding(0, "house", k.tx - 8 + i * 3, k.ty + 8, true);
  }
  normal.step(1);
  epic.step(1);
  const housePop = BUILDING_DEFS.house.pop;
  check(
    "epic houses provide EPIC.housePop each",
    epic.popCap[0] === EPIC.popBase + 5 * EPIC.housePop &&
      normal.popCap[0] === 8 + 5 * housePop,
    `epic=${epic.popCap[0]} (=${EPIC.popBase}+5x${EPIC.housePop}) normal=${normal.popCap[0]} (=8+5x${housePop})`,
  );
  check(
    "epic is off by default (never forced on weak machines)",
    defaultMatchConfig().epic === false,
    `default epic=${defaultMatchConfig().epic}`,
  );
}

console.log("\n=== 4. AI fields a bigger army in epic mode ===");
{
  // A no-rush treaty is required here: without it the epic AI simply wins the
  // match in ~5 minutes (the player is idle) and the clock stops, so "after
  // 25 minutes" would silently measure a finished game.
  const run = (epic: boolean) => {
    const cfg = epicCfg("L", epic, 31337);
    cfg.noRushMin = 10;
    const g = new Game(null, cfg.seed);
    g.startMatch(cfg);
    g.step(570); // 9.5 minutes of AI build-up, still inside the treaty
    const mil = g.teamUnits(1).filter((u) => u.type !== "villager").length;
    return { mil, pop: g.popCur[1], cap: g.popCap[1], houses: g.teamBuildings(1, "house").length, phase: g.phase };
  };
  const n = run(false);
  const e = run(true);
  check(
    "match still running at 9.5 min (treaty held)",
    n.phase === "playing" && e.phase === "playing",
    `normal=${n.phase} epic=${e.phase}`,
  );
  check(
    "epic AI fields a materially larger army",
    e.mil > n.mil * 1.4,
    `epic=${e.mil} mil (pop ${e.pop}/${e.cap}, ${e.houses} houses) vs normal=${n.mil} mil (pop ${n.pop}/${n.cap}, ${n.houses} houses)`,
  );
  check(
    "epic AI uses its higher population ceiling",
    e.cap > n.cap * 1.5,
    `epic cap=${e.cap} normal cap=${n.cap}`,
  );
}

console.log("\n=== 5. adaptive quality governor ===");
{
  const gov = new PerfGovernor();
  gov.reset({ auto: true, cap: 3, load: 10 });
  check("starts at the user's ceiling on a light scene", gov.state.tier === 3, `tier=${gov.state.tier}`);

  // sustained bad frames walk the ladder down, one rung at a time
  const seen: number[] = [];
  for (let i = 0; i < 200; i++) {
    gov.sample(0.1, 40, 20, 900);
    seen.push(gov.state.tier);
  }
  check(
    "degrades stepwise to the floor under sustained load",
    gov.state.tier === 0 && new Set(seen).size === 4,
    `tiers visited=${[...new Set(seen)].sort().join(">")} final=${gov.state.tier}`,
  );
  check("never degrades below tier 0", gov.state.tier >= 0, `tier=${gov.state.tier}`);
  check(
    "floor rung sheds the most (dpr/particles/detail)",
    gov.state.dprScale === TIER_FX[0].dprScale &&
      gov.state.particleCap === TIER_FX[0].particleCap &&
      gov.state.unitDetail === 0 &&
      !gov.state.clouds &&
      !gov.state.shadows3d,
    `dpr=${gov.state.dprScale} part=${gov.state.particleCap} detail=${gov.state.unitDetail}`,
  );

  // the 2D fallback latch fires exactly once, only at the floor
  const f1 = gov.shouldFallBackTo2D();
  const f2 = gov.shouldFallBackTo2D();
  check("3D→2D fallback latches once at the floor", f1 === true && f2 === false, `first=${f1} second=${f2}`);

  // frame-driven only: a sim-bound match must not swap rasterisers
  const simBound = new PerfGovernor();
  simBound.reset({ auto: true, cap: 3, load: 10 });
  for (let i = 0; i < 400; i++) simBound.sample(0.1, 10, 30, 1200);
  check(
    "sim-bound load degrades detail but does NOT trigger the 3D→2D fallback",
    simBound.shouldFallBackTo2D() === false && simBound.state.tier === 0,
    `frame 10 ms / sim 30 ms → tier=${simBound.state.tier}, fallback=${simBound.shouldFallBackTo2D()}`,
  );

  // recovery: good frames climb back, but never past the cap
  for (let i = 0; i < 400; i++) gov.sample(0.1, 6, 2, 100);
  check("recovers to the ceiling when headroom returns", gov.state.tier === 3, `tier=${gov.state.tier} cap=${gov.state.cap}`);
  for (let i = 0; i < 200; i++) gov.sample(0.1, 4, 1, 10);
  check("never exceeds the user's ceiling", gov.state.tier <= gov.state.cap, `tier=${gov.state.tier}`);

  // user ceiling is respected: Quality=Performance caps the ladder at tier 1
  const low = new PerfGovernor();
  low.reset({ auto: true, cap: tierFromQuality(0), load: 10 });
  for (let i = 0; i < 300; i++) low.sample(0.1, 5, 1, 10);
  check(
    "Performance preset caps the ladder at tier 1",
    low.state.cap === 1 && low.state.tier <= 1,
    `cap=${low.state.cap} tier=${low.state.tier}`,
  );

  // adaptive off pins the preset exactly
  const off = new PerfGovernor();
  off.reset({ auto: true, cap: 3, load: 10 });
  off.setAuto(false);
  for (let i = 0; i < 300; i++) off.sample(0.1, 60, 40, 2000);
  check(
    "adaptive off pins the user's preset (never auto-degrades)",
    off.state.tier === 3 && off.state.degraded === 0,
    `tier=${off.state.tier} reason="${off.state.reason}"`,
  );

  // pre-emptive degradation for epic / heavy scenes
  const heavy = new PerfGovernor();
  heavy.reset({ auto: true, cap: 3, load: 1600 });
  check(
    "very heavy scenes start already reduced (no slideshow to measure first)",
    heavy.state.tier < 3 && heavy.state.degraded > 0,
    `tier=${heavy.state.tier} reason="${heavy.state.reason}"`,
  );

  // hysteresis: alternating good/bad must not flap the ladder every sample
  const flap = new PerfGovernor();
  flap.reset({ auto: true, cap: 3, load: 10 });
  let transitions = 0;
  let prev = flap.state.tier;
  for (let i = 0; i < 600; i++) {
    flap.sample(0.1, i % 2 ? 30 : 8, i % 2 ? 16 : 3, 500);
    if (flap.state.tier !== prev) transitions++;
    prev = flap.state.tier;
  }
  check(
    "hysteresis: alternating load does not flap the ladder",
    transitions <= 12,
    `${transitions} tier transitions over 60 s of alternating load`,
  );
}

console.log("\n=== 6. engine respects the particle budget ===");
{
  const g = new Game(null, 20260101);
  g.startMatch(epicCfg("L", true));
  for (let i = 0; i < 40; i++) g.burst(1000 + i, 1000, "fire", 40, "#ff9a3c", 60, 3, 4);
  const cap = g.perf.state.particleCap;
  check(
    "particle count is clamped to the governor budget",
    g.particles.length <= cap,
    `${g.particles.length} particles, cap=${cap} (tier ${g.perf.state.tier})`,
  );
}

console.log("\n=== 7. XL + epic scale (simulation cost, this machine) ===");
const results: Record<string, RunReport> = {};
for (const [label, size, epic, perTeam, secs, where, mode] of [
  ["M-normal-idle-50v50", "M", false, 50, 30, "keeps", "sandbox"],
  ["L-normal-idle-150v150", "L", false, 150, 30, "keeps", "sandbox"],
  ["XL-epic-idle-350v350", "XL", true, 350, 30, "keeps", "sandbox"],
  ["XL-epic-idle-700v700", "XL", true, 700, 30, "keeps", "sandbox"],
  ["XL-epic-brawl-450v450", "XL", true, 450, 30, "brawl", "skirmish"],
] as Array<[string, "M" | "L" | "XL", boolean, number, number, "brawl" | "keeps", "sandbox" | "skirmish"]>) {
  const cfg = epicCfg(size, epic);
  cfg.mode = mode;
  const a = runScale(cfg, perTeam, secs, where);
  const b = runScale(cfg, perTeam, secs, where);
  results[label] = a;
  check(
    `${label}: deterministic (two identical runs)`,
    a.fingerprint === b.fingerprint,
    a.fingerprint === b.fingerprint
      ? `${a.units} units, deaths in fp, hash=${a.fingerprint.split("|")[0]}`
      : `run1=${a.fingerprint}\n      run2=${b.fingerprint}`,
  );
  console.log(
    `        sim ${a.avgTickMs} ms/tick avg, p95 ${a.p95TickMs} ms, max ${a.maxTickMs} ms ` +
      `| ${a.realtimeFactor}x realtime | units ${a.units} (peak ${a.peakUnits}) buildings ${a.buildings} ` +
      `particles ${a.particles} projectiles ${a.projectiles} | heap ${a.heapMB} MB rss ${a.rssMB} MB`,
  );
}
{
  const small = results["M-normal-idle-50v50"];
  const big = results["XL-epic-idle-700v700"];
  const brawl = results["XL-epic-brawl-450v450"];
  check(
    "sustained 1400-unit XL epic scene simulates faster than realtime",
    big.avgTickMs < 33.3 && big.realtimeFactor > 1 && big.peakUnits >= 1300,
    `${big.avgTickMs} ms/tick avg = ${big.realtimeFactor}x realtime at peak ${big.peakUnits} units (30 Hz budget = 33.3 ms)`,
  );
  check(
    "epic brawl (combat + projectiles + deaths) stays under the frame budget",
    brawl.avgTickMs < 33.3 && brawl.p95TickMs < 33.3,
    `avg ${brawl.avgTickMs} ms, p95 ${brawl.p95TickMs} ms, max ${brawl.maxTickMs} ms, ${brawl.projectiles} projectiles in flight`,
  );
  check(
    "cost scales sub-quadratically with army size",
    big.avgTickMs / small.avgTickMs < (big.peakUnits / Math.max(1, small.peakUnits)) * 2.2,
    `${small.avgTickMs} ms @ ${small.peakUnits} units → ${big.avgTickMs} ms @ ${big.peakUnits} units (${(big.avgTickMs / small.avgTickMs).toFixed(1)}x cost for ${(big.peakUnits / small.peakUnits).toFixed(1)}x units)`,
  );
  check(
    "XL epic heap stays inside the sandbox budget",
    big.heapMB < 400,
    `heap ${big.heapMB} MB, rss ${big.rssMB} MB`,
  );
  const capStr = big.fingerprint.split("|").find((x) => x.startsWith("cap=")) ?? "";
  const caps = capStr.slice(4).split("/").map(Number);
  check(
    "epic population ceiling is in force during the scale runs",
    caps.length === 2 && caps.every((c) => c >= EPIC.popBase),
    `${capStr} (epic base is ${EPIC.popBase}, normal base 8)`,
  );
}

console.log("\n=== 8. XL epic soak: 10 simulated minutes on the big map ===");
{
  const cfg = epicCfg("XL", true, 864209);
  cfg.noRushMin = 10; // keep the idle player alive so the soak actually runs
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  check("XL grid dimensions", g.grid.w === MAP_DIMS.XL && g.grid.h === MAP_DIMS.XL, `${g.grid.w}x${g.grid.h}`);
  check("XL node population is rich", g.nodes.length > 900, `nodes=${g.nodes.length}`);
  const t0 = performance.now();
  g.step(600);
  const soakMs = performance.now() - t0;
  check(
    "XL epic match survives 10 simulated minutes",
    g.phase === "playing" && g.time >= 599.9,
    `phase=${g.phase} t=${g.time.toFixed(0)}s units=${g.units.length} buildings=${g.buildings.length} nodes=${g.nodes.length}`,
  );
  check(
    "XL epic soak runs far faster than realtime",
    soakMs < 60000,
    `${(soakMs / 1000).toFixed(1)} s wall for 600 sim-seconds (${(600000 / soakMs).toFixed(1)}x realtime, ${(soakMs / 18000).toFixed(2)} ms/tick avg)`,
  );
  check("XL fog buffers sized to the map", g.visible[0].length === MAP_DIMS.XL * MAP_DIMS.XL, `${g.visible[0].length}`);
  const mem = process.memoryUsage();
  check(
    "XL soak memory stays inside the sandbox budget",
    mem.rss / 1048576 < 500,
    `heap ${(mem.heapUsed / 1048576).toFixed(1)} MB rss ${(mem.rss / 1048576).toFixed(1)} MB`,
  );
}

console.log(
  fails === 0
    ? "\nPERF/SCALE TEST PASSED"
    : `\n${fails} CHECK(S) FAILED`,
);
process.exit(fails ? 1 : 0);
