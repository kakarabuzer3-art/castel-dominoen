/** Map archetype & mode validation (headless). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAPS,
  MAP_DIMS,
  startPositions,
  T_BRIDGE,
  T_FORD,
  T_WATER,
} from "../src/game/constants";
import { GameGrid } from "../src/game/grid";
import { Game } from "../src/game/engine";
import type { MatchConfig } from "../src/game/constants";
import { defaultMatchConfig } from "../src/game/constants";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

// ── every archetype × size: connectivity + feature presence ──────────────────
for (const m of MAPS.filter((x) => x.id !== "random")) {
  for (const size of ["S", "M", "L", "XL"] as const) {
    const g = new GameGrid(12345, m.id, size, 1);
    const [a, b] = startPositions();
    const connected = g.connected(a.x, a.y, b.x, b.y);
    let water = 0, bridges = 0, fords = 0, rocky = 0, oasis = 0;
    for (let i = 0; i < g.terrain.length; i++) {
      if (g.terrain[i] === T_WATER) water++;
      if (g.terrain[i] === T_BRIDGE) bridges++;
      if (g.terrain[i] === T_FORD) fords++;
      if (g.terrain[i] === 3) rocky++;
      if (g.terrain[i] === 4) oasis++;
    }
    const nodes = g.scatterNodes(1);
    const trees = nodes.filter((n) => n.kind === "tree").length;
    let ok = connected && trees > 40;
    let detail = `${size} water=${water} bridge=${bridges} ford=${fords} rocky=${rocky} oasis=${oasis} trees=${trees}`;
    if (m.id === "riverlands") ok = ok && bridges >= 6 && fords >= 4;
    if (m.id === "twin") ok = ok && water > g.w * 4;
    if (m.id === "mountain") ok = ok && rocky > g.w * 6;
    if (m.id === "oasis" || m.id === "desert") ok = ok && oasis >= 0;
    if (m.id === "oasis") ok = ok && oasis > 100;
    check(`map ${m.id} ${size}`, ok, detail);
  }
}

// ── XL: opt-in extra-large map must be denser, not just bigger ──────────────
{
  check("XL dimensions", MAP_DIMS.XL === 160, `XL=${MAP_DIMS.XL}`);
  const xl = new GameGrid(12345, "verdant", "XL", 1);
  const lg = new GameGrid(12345, "verdant", "L", 1);
  // scatterNodes() force-converts terrain under the guaranteed starter ores,
  // so it must be called exactly once per grid (as the engine does)
  const count = (nodes: Array<{ kind: string }>, k: string) =>
    nodes.filter((n) => n.kind === k).length;
  const xlNodes = xl.scatterNodes(1);
  const lgNodes = lg.scatterNodes(1);
  const xlTrees = count(xlNodes, "tree");
  const lgTrees = count(lgNodes, "tree");
  const xlRock = count(xlNodes, "rock");
  const lgRock = count(lgNodes, "rock");
  const areaRatio = (160 * 160) / (128 * 128); // 1.5625
  check(
    "XL forest density scales with area",
    xlTrees / lgTrees >= areaRatio * 0.9,
    `trees XL=${xlTrees} L=${lgTrees} ratio=${(xlTrees / lgTrees).toFixed(2)} area=${areaRatio.toFixed(2)}`,
  );
  check(
    "XL ore density scales with area",
    xlRock / Math.max(1, lgRock) >= areaRatio * 0.8,
    `rocks XL=${xlRock} L=${lgRock}`,
  );
  // NB: startPositions() reads the module-level MAP_W/MAP_H that the *last*
  // constructed GameGrid set, so derive the XL keeps from the grid itself
  const ax = Math.round((xl.w * 0.125));
  const ay = Math.round((xl.h * 0.875));
  const bx = Math.round((xl.w * 0.875));
  const by = Math.round((xl.h * 0.125));
  check("XL keeps connected", xl.connected(ax, ay, bx, by), `${ax},${ay} → ${bx},${by}`);
  check(
    "XL keeps span the map diagonal",
    bx - ax === 120 && ay - by === 120,
    `dx=${bx - ax} dy=${ay - by}`,
  );
}

// ── regression guard: S/M/L generation must be byte-identical to the recorded
//    baseline (saves, replays and campaign missions depend on it) ────────────
{
  const fxPath = fileURLToPath(
    new URL("./fixtures/map-fingerprints-SML.json", import.meta.url),
  );
  const fx = JSON.parse(readFileSync(fxPath, "utf8")) as Record<string, string>;
  let same = 0;
  let diff: string[] = [];
  for (const m of MAPS.filter((x) => x.id !== "random")) {
    for (const size of ["S", "M", "L"] as const) {
      for (const seed of [12345, 4242, 777]) {
        const g = new GameGrid(seed, m.id, size, 1);
        let h = 2166136261;
        for (let i = 0; i < g.terrain.length; i++) {
          h ^= g.terrain[i];
          h = Math.imul(h, 16777619);
        }
        const nodes = g.scatterNodes(1);
        const cnt = (k: string) => nodes.filter((n) => n.kind === k).length;
        const [a, b] = startPositions();
        const fp = [
          `terrain=${(h >>> 0).toString(16)}`,
          `w=${g.w}`,
          `trees=${cnt("tree")}`,
          `rocks=${cnt("rock")}`,
          `gold=${cnt("gold")}`,
          `conn=${g.connected(a.x, a.y, b.x, b.y) ? 1 : 0}`,
        ].join("|");
        const key = `${m.id}/${size}/${seed}`;
        if (fx[key] === fp) same++;
        else diff.push(`${key}: ${fx[key]} -> ${fp}`);
      }
    }
  }
  check(
    "S/M/L map fingerprints unchanged vs baseline",
    diff.length === 0 && same === Object.keys(fx).length,
    `${same}/${Object.keys(fx).length} identical${diff.length ? ` | ${diff[0]}` : ""}`,
  );
}

// ── bridge/ford pathing: units must cross the river ─────────────────────────
{
  const cfg = defaultMatchConfig();
  cfg.map = "riverlands";
  cfg.seed = 4242;
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  const [, b] = startPositions();
  const u = g.teamUnits(0, "villager")[0];
  const ok = g.pathNow(u, b.x * 32, b.y * 32);
  // expand path segments (Bresenham) and ensure the crossing uses bridge/ford
  let crossed = false;
  const pts: Array<[number, number]> = [
    [Math.floor(u.x / 32), Math.floor(u.y / 32)],
  ];
  for (const p of u.path ?? []) pts.push([p % g.grid.w, (p / g.grid.w) | 0]);
  for (let i = 1; i < pts.length; i++) {
    let [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (let k = 0; k < 400; k++) {
      const t = g.grid.terrain[g.grid.idx(x0, y0)];
      if (t === T_BRIDGE || t === T_FORD) crossed = true;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  check("riverlands: path crosses bridge/ford", ok && crossed, `waypoints=${u.path?.length ?? 0}`);
}

// ── game modes ───────────────────────────────────────────────────────────────
{
  const cfg = defaultMatchConfig();
  cfg.mode = "survival";
  cfg.timeLimitMin = 8;
  cfg.seed = 99;
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  // give the tester a real defense so the timer can be reached
  const pk = g.buildingById.get(g.keeps[0])!;
  for (const [dx, dy] of [
    [6, -4],
    [-4, -4],
    [6, 6],
    [-4, 6],
  ]) {
    const sp = g.findSpotNear(pk.tx + dx, pk.ty + dy, "tower", 0, 3);
    if (sp) g.spawnBuilding(0, "tower", sp.x, sp.y, true);
  }
  for (let i = 0; i < 16; i++)
    g.spawnUnit(0, i % 2 ? "militia" : "archer", (pk.tx + 1 + (i % 6)) * 32, (pk.ty + 7 + ((i / 6) | 0)) * 32);
  for (let t = 0; t < 8 * 60 + 30 && g.phase === "playing"; t += 60) {
    g.step(60);
    const pk2 = g.buildingById.get(g.keeps[0]);
    if (pk2 && t % 120 === 0)
      for (let i = 0; i < 4; i++)
        g.spawnUnit(0, i % 2 ? "militia" : "archer", (pk2.tx + 2 + i) * 32, (pk2.ty + 7) * 32);
  }
  check("survival: timer victory", g.phase === "victory", `phase=${g.phase} t=${Math.round(g.time)}`);
}
{
  const cfg = defaultMatchConfig();
  cfg.mode = "siege";
  cfg.seed = 55;
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  const army = g.teamUnits(0).filter((u) => u.type !== "villager").length;
  const ek = g.buildingById.get(g.keeps[1])!;
  check("siege: prebuilt army + doubled keep", army >= 12 && ek.hp === ek.maxHp && ek.maxHp === 4800, `army=${army} keepHp=${ek.maxHp}`);
}
{
  const cfg = defaultMatchConfig();
  cfg.mode = "sandbox";
  cfg.seed = 77;
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  g.step(600);
  const invaders = g
    .teamUnits(1)
    .filter((u) => u.type !== "villager").length;
  const [a] = startPositions();
  const nearPlayer = g
    .teamUnits(1)
    .filter((u) => Math.hypot(u.x - a.x * 32, u.y - a.y * 32) < 40 * 32 && u.type !== "villager").length;
  check("sandbox: passive neighbour", invaders > 0 && nearPlayer === 0, `army=${invaders} near=${nearPlayer}`);
}
{
  const cfg = defaultMatchConfig();
  cfg.noRushMin = 10;
  cfg.seed = 33;
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  g.step(540);
  check("no-rush treaty: no combat before 10 min", g.kills === 0 && g.losses === 0, `k=${g.kills} l=${g.losses}`);
}
{
  // time limit scoring
  const cfg = defaultMatchConfig();
  cfg.timeLimitMin = 15;
  cfg.seed = 21;
  const g = new Game(null, cfg.seed);
  g.startMatch(cfg);
  g.step(15 * 60 + 20);
  check("time limit concludes match", g.phase === "victory" || g.phase === "defeat", `phase=${g.phase}`);
}
// config types sanity
const _c: MatchConfig = defaultMatchConfig();
void _c;

console.log(fails === 0 ? "\nMAPS/MODES TEST PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
