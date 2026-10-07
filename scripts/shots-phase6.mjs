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
await new Promise((r) => server.listen(4185, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
await page.goto("http://localhost:4185/", { waitUntil: "networkidle" });
await page.waitForTimeout(900);

// 1 — match setup
await page.screenshot({ path: join(SHOTS, "p6-1-setup.png") });

// 2 — settings overlay
await page.getByRole("dialog", { name: "Match setup" }).getByRole("button", { name: "Open settings" }).click();
await page.waitForTimeout(300);
await page.locator("button", { hasText: /^Graphics$/ }).first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: join(SHOTS, "p6-2-settings.png") });
await page.locator("button", { hasText: /^Done$/ }).click();

const begin = async () => {
  await page.locator("text=BEGIN MATCH").click();
  await page.waitForTimeout(1000);
};
const buildBase = () =>
  page.evaluate(() => {
    const g = window.__game;
    g.res[0].wood += 900; g.res[0].stone += 500; g.res[0].gold += 400; g.res[0].food += 400;
    const keep = g.buildingById.get(g.keeps[0]);
    const put = (type, dx, dy) => {
      const sp = g.findSpotNear(keep.tx + dx, keep.ty + dy, type, 0, 4);
      if (sp) g.place(0, type, sp.x, sp.y);
    };
    put("house", 7, 6); put("house", 9, 6); put("farm", 7, 9); put("farm", 10, 9);
    put("barracks", -6, 7); put("tower", 6, -4); put("tower", -4, -5);
    put("granary", -7, 4); put("inn", 10, 3); put("shrine", -9, 6);
    for (let i = 0; i < 6; i++) g.place(0, "wall", keep.tx + 8 + i, keep.ty - 6);
    g.place(0, "gate", keep.tx + 11, keep.ty - 6);
    for (const b of g.teamBuildings(0)) if (!b.built) { b.built = true; b.work = 0; b.hp = b.maxHp; }
    g.time = 150;
    return true;
  });

// 3 — desert
await page.locator("button", { hasText: "Desert Siege" }).click();
await begin();
await buildBase();
await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  g.cam.x = (keep.tx + 3) * 32; g.cam.y = (keep.ty + 3) * 32; g.cam.zoom = 1.15; g.zoomTarget = 1.15; g.clampCam();
});
await page.waitForTimeout(800);
await page.screenshot({ path: join(SHOTS, "p6-3-desert.png") });

// 4 — riverlands bridge
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.locator("button", { hasText: "Riverlands" }).click();
await begin();
await page.evaluate(() => {
  const g = window.__game;
  let bx = 0, by = 0;
  outer: for (let y = 0; y < g.grid.h; y++)
    for (let x = 0; x < g.grid.w; x++)
      if (g.grid.terrain[y * g.grid.w + x] === 5) { bx = x; by = y; break outer; }
  g.cam.x = bx * 32; g.cam.y = by * 32; g.cam.zoom = 1.3; g.zoomTarget = 1.3; g.clampCam();
  // march a squad across the bridge for life
  for (let i = 0; i < 8; i++)
    g.spawnUnit(0, i % 2 ? "militia" : "villager", (bx - 4 + i % 4) * 32, (by + 5 + ((i / 4) | 0) * 1.5) * 32);
  g.cmdMove(g.teamUnits(0).slice(-8), bx * 32, (by - 6) * 32);
});
await page.waitForTimeout(2500);
await page.screenshot({ path: join(SHOTS, "p6-4-river-bridge.png") });

// 5 — AI siege on player walls/tower
await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  const wx = (keep.tx + 10) * 32, wy = (keep.ty - 6) * 32;
  const tower = g.teamBuildings(0, "tower")[0];
  if (tower) tower.hp = tower.maxHp * 0.35;
  for (let i = 0; i < 16; i++) {
    const u = g.spawnUnit(1, i % 5 === 4 ? "catapult" : i % 3 === 2 ? "archer" : i % 3 === 1 ? "knight" : "militia", wx + 80 + i * 16, wy - 120 - (i % 4) * 22);
    u.state = "attackMove";
    u.tx = wx; u.ty = wy;
  }
  const wall = g.teamBuildings(0, "wall")[1];
  for (const u of g.teamUnits(1)) if (wall) u.targetId = wall.id, u.state = "attack";
  g.cam.x = wx; g.cam.y = wy - 30; g.cam.zoom = 1.3; g.zoomTarget = 1.3; g.clampCam();
});
await page.waitForTimeout(3000);
await page.screenshot({ path: join(SHOTS, "p6-5-ai-siege.png") });

// 6 — large battle
await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  const cx = (keep.tx + 14) * 32, cy = (keep.ty + 12) * 32;
  for (let i = 0; i < 36; i++) {
    const u = g.spawnUnit(0, ["militia", "spearman", "archer", "knight"][i % 4], cx - 120 + (i % 9) * 26, cy + ((i / 9) | 0) * 26);
    u.state = "attackMove"; u.tx = cx + 160; u.ty = cy;
  }
  for (let i = 0; i < 36; i++) {
    const u = g.spawnUnit(1, ["militia", "spearman", "archer", "knight"][i % 4], cx + 320 - (i % 9) * 26, cy + ((i / 9) | 0) * 26);
    u.state = "attackMove"; u.tx = cx - 100; u.ty = cy;
  }
  g.cam.x = cx + 90; g.cam.y = cy + 40; g.cam.zoom = 1.25; g.zoomTarget = 1.25; g.clampCam();
});
await page.waitForTimeout(4000);
await page.screenshot({ path: join(SHOTS, "p6-6-large-battle.png") });

// 7 — final victory
await page.evaluate(() => {
  const g = window.__game;
  const ek = g.buildingById.get(g.keeps[1]);
  if (ek) g.damage(ek, 999999, 0, -1);
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(SHOTS, "p6-7-victory.png") });

await browser.close();
server.close();
console.log("phase-6 screenshots captured");
