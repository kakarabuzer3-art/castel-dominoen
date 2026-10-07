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
await new Promise((r) => server.listen(4183, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
await page.goto("http://localhost:4183/", { waitUntil: "networkidle" });

const startWith = async (theme) => {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  if (theme === "desert") await page.locator("button", { hasText: "Desert Siege" }).click();
  await page.locator("text=BEGIN MATCH").click();
  await page.waitForTimeout(900);
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
    put("granary", -7, 4); put("inn", 10, 3); put("shrine", -9, 6); put("market", 4, 10);
    put("lumbercamp", 12, 5); put("quarry", -10, 3);
    for (let i = 0; i < 6; i++) g.place(0, "wall", keep.tx + 8 + i, keep.ty - 6);
    g.place(0, "gate", keep.tx + 11, keep.ty - 6);
    for (const b of g.teamBuildings(0)) if (!b.built) { b.built = true; b.work = 0; b.hp = b.maxHp; }
    for (let i = 0; i < 8; i++) {
      const v = g.spawnUnit(0, "villager", (keep.tx + 2 + (i % 4)) * 32, (keep.ty + 7 + ((i / 4) | 0)) * 32);
      v.state = "harvest";
    }
    g.time = 120;
    return true;
  });

const frame = (dx = 2, dy = 2, zoom = 1.15) =>
  page.evaluate(([dx, dy, zoom]) => {
    const g = window.__game;
    const keep = g.buildingById.get(g.keeps[0]);
    g.cam.x = (keep.tx + dx) * 32; g.cam.y = (keep.ty + dy) * 32;
    g.cam.zoom = zoom; g.zoomTarget = zoom; g.clampCam();
  }, [dx, dy, zoom]);

// 1 — normal kingdom (green, day)
await startWith("green");
await buildBase();
await frame();
await page.waitForTimeout(900);
await page.screenshot({ path: join(SHOTS, "p5-1-kingdom.png") });

// 2 — desert castle
await startWith("desert");
await buildBase();
await frame();
await page.waitForTimeout(900);
await page.screenshot({ path: join(SHOTS, "p5-2-desert-castle.png") });

// 3 — large army marching
await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  const types = ["militia", "spearman", "archer", "knight", "militia", "archer", "spearman", "knight"];
  for (let i = 0; i < 44; i++) {
    const u = g.spawnUnit(0, types[i % types.length], (keep.tx + 10 + (i % 11) * 1.6) * 32, (keep.ty + 10 + Math.floor(i / 11) * 1.8) * 32);
    u.facing = -0.6;
  }
  g.cam.x = (keep.tx + 17) * 32; g.cam.y = (keep.ty + 13) * 32; g.cam.zoom = 1.25; g.zoomTarget = 1.25; g.clampCam();
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(SHOTS, "p5-3-large-army.png") });

// 4 — siege battle: army + catapults hitting walls & tower
await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  const wx = (keep.tx + 10) * 32, wy = (keep.ty - 6) * 32;
  const tower = g.teamBuildings(0, "tower")[0];
  if (tower) tower.hp = tower.maxHp * 0.3;
  const wall = g.teamBuildings(0, "wall")[2];
  if (wall) wall.hp = wall.maxHp * 0.25;
  for (let i = 0; i < 14; i++) {
    const u = g.spawnUnit(1, i % 4 === 3 ? "archer" : i % 4 === 2 ? "knight" : "militia", wx + 60 + i * 14, wy - 90 - (i % 3) * 20);
    u.state = "attack";
  }
  for (let i = 0; i < 10; i++) {
    const u = g.spawnUnit(0, i % 3 === 0 ? "catapult" : i % 3 === 1 ? "militia" : "archer", wx - 40 + i * 16, wy + 70 + (i % 2) * 24);
    u.state = "attack";
  }
  const foes = g.teamUnits(1), mine = g.teamUnits(0);
  for (let i = 0; i < foes.length; i++) { foes[i].targetId = mine[i % mine.length].id; }
  for (let i = 0; i < mine.length; i++) { mine[i].targetId = foes[i % foes.length].id; }
  g.cam.x = wx + 20; g.cam.y = wy - 10; g.cam.zoom = 1.35; g.zoomTarget = 1.35; g.clampCam();
});
await page.waitForTimeout(2600);
await page.screenshot({ path: join(SHOTS, "p5-4-siege-battle.png") });

// 5 — night battle with torches
await page.evaluate(() => {
  const g = window.__game;
  g.time = 300; // night window
  const keep = g.buildingById.get(g.keeps[0]);
  g.cam.x = (keep.tx + 4) * 32; g.cam.y = (keep.ty + 2) * 32; g.cam.zoom = 1.2; g.zoomTarget = 1.2; g.clampCam();
});
await page.waitForTimeout(1500);
await page.screenshot({ path: join(SHOTS, "p5-5-night-battle.png") });

// 6 — final victory
await page.evaluate(() => {
  const g = window.__game;
  const ek = g.buildingById.get(g.keeps[1]);
  if (ek) g.damage(ek, 999999, 0, -1);
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(SHOTS, "p5-6-victory.png") });

await browser.close();
server.close();
console.log("phase-5 screenshots captured");
