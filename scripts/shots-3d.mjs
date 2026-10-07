/**
 * 3D renderer visual QA — captures every POI category in realistic scenes:
 * full building set, every unit type, battle w/ projectiles+particles, night
 * torches, fog plane, desert palette, river+bridge, zoom-out, profiler HUD,
 * mobile viewport. Renders under headless SwiftShader (software GL) — these
 * shots validate composition/artifacts, NOT real-GPU performance.
 *
 * Usage: node scripts/shots-3d.mjs
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const DIST = new URL("../dist", import.meta.url).pathname;
const SHOTS = new URL("../shots", import.meta.url).pathname;
await mkdir(SHOTS, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const path = normalize(req.url.split("?")[0]);
    const file = join(DIST, path === "/" ? "index.html" : path);
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(4186, r));

const browser = await chromium.launch();
let shotCount = 0;

const newPage = async (settings = {}, viewport = { width: 1360, height: 800 }) => {
  const ctx = await browser.newContext({ viewport, hasTouch: !!settings.touch });
  await ctx.addInitScript((s) => {
    try {
      const raw = localStorage.getItem("castle-dominion-settings-v1");
      const cur = raw ? JSON.parse(raw) : {};
      Object.assign(cur, { renderer: "3d", quality: 1, shadows: true, dayNight: true }, s);
      delete cur.touch;
      localStorage.setItem("castle-dominion-settings-v1", JSON.stringify(cur));
    } catch { /* ignore */ }
  }, settings);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  !! pageerror: " + e.message));
  await page.goto("http://localhost:4186/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return { ctx, page };
};

const begin = async (page, mapName) => {
  if (mapName) await page.locator(`button >> text="${mapName}"`).first().click();
  await page.locator("text=BEGIN MATCH").click();
  await page.waitForTimeout(2500);
};

const advance = (page, simSecs) =>
  page.evaluate((s) => {
    const g = window.__game;
    for (let i = 0; i < s * 60; i++) g.tick(1 / 60);
  }, simSecs);

const settle = (page, ms = 3000) => page.waitForTimeout(ms);

const buildBase = (page) =>
  page.evaluate(() => {
    const g = window.__game;
    g.res[0].wood += 1500; g.res[0].stone += 900; g.res[0].gold += 600; g.res[0].food += 700;
    const keep = g.buildingById.get(g.keeps[0]);
    const put = (type, dx, dy) => {
      const sp = g.findSpotNear(keep.tx + dx, keep.ty + dy, type, 0, 4);
      if (sp) g.place(0, type, sp.x, sp.y);
    };
    put("house", 7, 6); put("house", 9, 6); put("house", 11, 6);
    put("farm", 7, 9); put("farm", 10, 9); put("farm", 13, 9);
    put("barracks", -6, 7); put("tower", 6, -4); put("tower", -4, -5);
    put("granary", -7, 4); put("inn", 10, 3); put("shrine", -9, 6);
    put("market", -8, -3); put("lumbercamp", 9, -6); put("quarry", -9, -7);
    for (let i = 0; i < 6; i++) g.place(0, "wall", keep.tx + 8 + i, keep.ty - 6);
    g.place(0, "gate", keep.tx + 11, keep.ty - 6);
    for (const b of g.teamBuildings(0)) if (!b.built) { b.built = true; b.work = 0; b.hp = b.maxHp; }
    // damage one tower for the damaged-visual POI
    const tw = g.teamBuildings(0).find((b) => b.type === "tower");
    if (tw) tw.hp = Math.round(tw.maxHp * 0.45);
    // every unit type around the keep
    const types = ["villager", "villager", "villager", "militia", "spearman", "archer", "knight", "catapult"];
    types.forEach((t, i) => {
      const a = (i / types.length) * Math.PI * 2;
      g.spawnUnit(0, t, keep.tx * 32 + 16 + Math.cos(a) * 150, keep.ty * 32 + 16 + Math.sin(a) * 120);
    });
    // veteran rank chevrons POI
    const mil = g.units.filter((u) => u.team === 0 && u.type === "militia")[0];
    if (mil) { mil.rank = 2; mil.hp = mil.maxHp * 0.7; }
    g.cam.x = keep.tx * 32 + 16;
    g.cam.y = keep.ty * 32 + 16;
    g.zoomTarget = 1.05; g.cam.zoom = 1.05;
    g.clampCam();
    g.time = 40;
    return true;
  });

const spawnRaid = (page) =>
  page.evaluate(() => {
    const g = window.__game;
    const keep = g.buildingById.get(g.keeps[0]);
    const ex = keep.tx * 32 + 420, ey = keep.ty * 32 + 260;
    for (let i = 0; i < 7; i++)
      g.spawnUnit(1, i % 3 === 0 ? "archer" : "militia", ex + (i % 3) * 40, ey + Math.floor(i / 3) * 40);
    const foes = g.units.filter((u) => u.team === 1);
    for (const u of g.units) if (u.team === 0 && u.type !== "villager") g.selection.add(u.id);
    g.rightClickCommand(ex, ey);
    return foes.length;
  });

// ── 1. full base, all buildings + all unit types (day) ──────────────────────
{
  const { ctx, page } = await newPage({ fog: false });
  await begin(page, null);
  await buildBase(page);
  await advance(page, 2);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, "p10-1-base-3d.png") });
  shotCount++;
  console.log("  shot p10-1-base-3d");

  // zoom-out overview
  await page.evaluate(() => {
    const g = window.__game;
    g.zoomTarget = 0.62; g.cam.zoom = 0.62;
  });
  await settle(page, 2500);
  await page.screenshot({ path: join(SHOTS, "p10-2-zoomout-3d.png") });
  shotCount++;
  console.log("  shot p10-2-zoomout-3d");
  await page.evaluate(() => { const g = window.__game; g.zoomTarget = 1.05; g.cam.zoom = 1.05; });

  // ── 2. battle: projectiles, particles, flashes ──
  await spawnRaid(page);
  await advance(page, 6);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, "p10-3-battle-3d.png") });
  shotCount++;
  console.log("  shot p10-3-battle-3d");

  // ── 3. profiler overlay open over battle ──
  await page.keyboard.press("F3");
  await page.waitForTimeout(2200);
  await page.screenshot({ path: join(SHOTS, "p10-4-profiler-3d.png") });
  shotCount++;
  console.log("  shot p10-4-profiler-3d");

  // ── 4. night: torches, dark ambient ──
  await page.keyboard.press("F3");
  await page.evaluate(() => { window.__game.time = 336; });
  await advance(page, 1);
  await settle(page, 2600);
  await page.screenshot({ path: join(SHOTS, "p10-5-night-3d.png") });
  shotCount++;
  console.log("  shot p10-5-night-3d");
  await ctx.close();
}

// ── 5. fog of war plane ─────────────────────────────────────────────────────
{
  const { ctx, page } = await newPage({ fog: true });
  await begin(page, null);
  await buildBase(page);
  await advance(page, 2);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, "p10-6-fog-3d.png") });
  shotCount++;
  console.log("  shot p10-6-fog-3d");
  // enemy base must stay hidden under unexplored fog
  await page.evaluate(() => {
    const g = window.__game;
    const ek = g.buildings.find((b) => b.type === "keep" && b.team !== g.myTeam);
    if (ek) { g.cam.x = ek.tx * 32 + 16; g.cam.y = ek.ty * 32 + 16; g.clampCam(); }
    return !!ek;
  });
  await settle(page, 2600);
  await page.screenshot({ path: join(SHOTS, "p10-6b-fog-enemy-3d.png") });
  shotCount++;
  console.log("  shot p10-6b-fog-enemy-3d");
  await ctx.close();
}

// ── 6. desert palette + palms + oasis water ─────────────────────────────────
{
  const { ctx, page } = await newPage({ fog: false });
  await begin(page, "Oasis Crossroads");
  await buildBase(page);
  await advance(page, 2);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, "p10-7-desert-3d.png") });
  shotCount++;
  console.log("  shot p10-7-desert-3d");
  await ctx.close();
}

// ── 7. river + bridge + ford + heightfield hills (Mountain Pass) ───────────
{
  const { ctx, page } = await newPage({ fog: false });
  await begin(page, "Riverlands");
  await page.evaluate(() => {
    const g = window.__game;
    // center camera on the first bridge tile
    let found = null;
    for (let ty = 0; ty < g.grid.h && !found; ty++)
      for (let tx = 0; tx < g.grid.w; tx++)
        if (g.grid.terrain[g.grid.idx(tx, ty)] === 5) { found = { tx, ty }; break; }
    if (found) {
      g.cam.x = found.tx * 32 + 16;
      g.cam.y = found.ty * 32 + 16;
      g.clampCam();
    }
    g.zoomTarget = 1.2; g.cam.zoom = 1.2;
    g.time = 60;
    return !!found;
  });
  await advance(page, 1);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, "p10-8-river-bridge-3d.png") });
  shotCount++;
  console.log("  shot p10-8-river-bridge-3d");
  await ctx.close();
}

{
  const { ctx, page } = await newPage({ fog: false });
  await begin(page, "Mountain Pass");
  await page.evaluate(() => {
    const g = window.__game;
    // find a rocky cluster for the heightfield
    let best = null;
    for (let ty = 4; ty < g.grid.h - 4; ty++)
      for (let tx = 4; tx < g.grid.w - 4; tx++)
        if (g.grid.terrain[g.grid.idx(tx, ty)] === 4) { best = { tx, ty }; break; }
    if (best) { g.cam.x = best.tx * 32; g.cam.y = best.ty * 32; g.clampCam(); }
    g.zoomTarget = 1.15; g.cam.zoom = 1.15;
    return !!best;
  });
  await advance(page, 1);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, "p10-9-mountain-3d.png") });
  shotCount++;
  console.log("  shot p10-9-mountain-3d");
  await ctx.close();
}

// ── 8. mobile viewport ──────────────────────────────────────────────────────
{
  const { ctx, page } = await newPage({ fog: false, touch: true }, { width: 420, height: 860 });
  await begin(page, null);
  await buildBase(page);
  await advance(page, 2);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, "p10-10-mobile-3d.png") });
  shotCount++;
  console.log("  shot p10-10-mobile-3d");
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n3D QA: ${shotCount} shots written to shots/`);
