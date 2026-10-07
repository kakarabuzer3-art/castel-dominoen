/**
 * Final authoritative screenshot set (Checkpoint E): setup screen, multiplayer
 * lobby (self-hosted relay), 3D day base, 3D night battle, F3 profiler with
 * completed 4s benchmark, 2D day base, 2D night battle, replay scrubbing.
 * Headless SwiftShader — validates composition/artifacts, NOT GPU performance.
 *
 * Usage: node scripts/shots-final.mjs   (npm run shots:final)
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const SECTION = process.argv[2] ?? "all";
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
await new Promise((r) => server.listen(4187, r));

let mpServer = null;
if (SECTION === "1" || SECTION === "all") {
  mpServer = spawn("npx", ["tsx", "src/net/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, MP_PORT: "8899" },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 2500));
}

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
let shotCount = 0;

const newPage = async (settings = {}, viewport = { width: 1440, height: 900 }) => {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((s) => {
    try {
      const raw = localStorage.getItem("castle-dominion-settings-v1");
      const cur = raw ? JSON.parse(raw) : {};
      Object.assign(cur, { dayNight: true }, s);
      localStorage.setItem("castle-dominion-settings-v1", JSON.stringify(cur));
    } catch { /* ignore */ }
  }, settings);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("http://localhost:4187/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return { ctx, page };
};

const begin = async (page) => {
  await page.locator("text=BEGIN MATCH").click();
  await page.waitForTimeout(2500);
  const phase = await page.evaluate(() => window.__game.phase);
  if (phase !== "playing") throw new Error("match did not start: " + phase);
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
    put("granary", -7, 4); put("shrine", -9, 6);
    put("market", -8, -3); put("lumbercamp", 9, -6); put("quarry", -9, -7);
    for (let i = 0; i < 6; i++) g.place(0, "wall", keep.tx + 8 + i, keep.ty - 6);
    g.place(0, "gate", keep.tx + 11, keep.ty - 6);
    for (const b of g.teamBuildings(0)) if (!b.built) { b.built = true; b.work = 0; b.hp = b.maxHp; }
    const types = ["villager", "villager", "villager", "militia", "spearman", "archer", "knight", "catapult"];
    types.forEach((t, i) => {
      const a = (i / types.length) * Math.PI * 2;
      g.spawnUnit(0, t, keep.tx * 32 + 16 + Math.cos(a) * 150, keep.ty * 32 + 16 + Math.sin(a) * 120);
    });
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
    for (const u of g.units) if (u.team === 0 && u.type !== "villager") g.selection.add(u.id);
    g.rightClickCommand(ex, ey);
  });

const shot = async (page, name) => {
  await page.screenshot({ path: join(SHOTS, name) });
  shotCount++;
  console.log("  shot " + name);
};

// ── 1. setup screen (default/auto renderer) ─────────────────────────────────
if (SECTION === "1" || SECTION === "all") {
  const { ctx, page } = await newPage({});
  await shot(page, "final-1-setup.png");

  // ── 2. multiplayer lobby hosting via the self-hosted relay ──
  await page.locator("button", { hasText: "Multiplayer" }).click();
  await page.getByLabel("Server address").fill("ws://localhost:8899");
  await page.locator("button", { hasText: "Host game" }).click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[aria-label="Room code"]');
      return el && /^[A-Z2-9]{4}$/.test(el.textContent.trim());
    },
    null,
    { timeout: 8000 },
  );
  await page.waitForTimeout(500);
  await shot(page, "final-2-multiplayer.png");
  await ctx.close();
}

// ── 3–5. 3D: day base, night battle, profiler + benchmark ───────────────────
if (SECTION === "2" || SECTION === "all") {
  const { ctx, page } = await newPage({ renderer: "3d", quality: 1, shadows: true, fog: false });
  await begin(page);
  await buildBase(page);
  await advance(page, 2);
  await settle(page);
  await shot(page, "final-3-3d-day.png");

  await spawnRaid(page);
  await advance(page, 6);
  await page.evaluate(() => { window.__game.time = 336; });
  await advance(page, 1);
  await settle(page, 2600);
  await shot(page, "final-4-3d-night-battle.png");

  await page.keyboard.press("F3");
  await page.getByRole("button", { name: /Run 4s GPU benchmark/i }).click();
  await page.waitForTimeout(5500);
  await shot(page, "final-5-profiler.png");
  await ctx.close();
}

// ── 6–8. 2D: day base, night battle, then replay scrubbing ──────────────────
if (SECTION === "3" || SECTION === "all") {
  const { ctx, page } = await newPage({ renderer: "2d", fog: false });
  await begin(page);
  await buildBase(page);
  await advance(page, 2);
  await settle(page);
  await shot(page, "final-6-2d-day.png");

  await spawnRaid(page);
  await advance(page, 6);
  await page.evaluate(() => { window.__game.time = 336; });
  await advance(page, 1);
  await settle(page, 2200);
  await shot(page, "final-7-2d-night.png");

  // play ~90s of real sim, then conclude → replay is saved to the library
  await page.evaluate(() => { window.__game.time = 90; });
  await advance(page, 90);
  // end the match through the engine's real keep-destruction path so the
  // replay recorder finalizes (externally forcing phase skips finishRecording)
  await page.evaluate(() => {
    const g = window.__game;
    const ek = g.buildingById.get(g.keeps[1]);
    g.destroyBuilding(ek);
    g.publish(true);
  });
  await page.waitForTimeout(1500);
  const endedPhase = await page.evaluate(() => window.__game.phase);
  if (endedPhase !== "victory") throw new Error("match did not end: " + endedPhase);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.locator("button", { hasText: "Replays" }).click();
  await page.waitForTimeout(400);
  const rows = await page.locator("button", { hasText: "▶ Play" }).count();
  if (rows < 1) throw new Error("no replay recorded");
  await page.locator("button", { hasText: "▶ Play" }).first().click();
  await page.waitForTimeout(1500);
  const slider = page.getByLabel("Replay timeline");
  await slider.fill("45");
  await page.waitForTimeout(700);
  await page.locator("button[title='Play/pause']").click();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__game.clampCam());
  await page.waitForTimeout(300);
  await shot(page, "final-8-replay.png");
  await ctx.close();
}

await browser.close();
if (mpServer) mpServer.kill();
server.close();
console.log(`\nFINAL SHOTS DONE — ${shotCount} screenshots, ${errors.length} page errors`);
if (errors.length) { console.log(errors.slice(0, 5).join("\n")); process.exit(1); }
