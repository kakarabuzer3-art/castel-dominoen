import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  try {
    const raw = req.url.split("?")[0];
    const path = raw === "/" || raw === "\\" ? "/index.html" : normalize(raw);
    const file = join(DIST, path);
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(4181, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
await page.goto("http://localhost:4181/", { waitUntil: "networkidle" });
await page.locator("text=BEGIN MATCH").click();
await page.waitForTimeout(1000);
// jump to night + stage a fight with particles
await page.evaluate(() => {
  const g = window.__game;
  g.time = 300; // night window (273-378s of the 420s cycle)
  const keep = g.buildingById.get(g.keeps[0]);
  const px = (keep.tx + 2.5) * 32, py = (keep.ty + 8) * 32;
  for (let i = 0; i < 4; i++) g.spawnUnit(0, i % 2 ? "militia" : "archer", px + i * 22, py);
  for (let i = 0; i < 4; i++) g.spawnUnit(1, i % 2 ? "militia" : "archer", px + 90 + i * 22, py + 10);
  const us = g.units.slice(-8);
  for (let i = 0; i < 4; i++) g.cmdAttack([us[i]], us[4 + i].id);
  for (let i = 0; i < 4; i++) g.cmdAttack([us[4 + i]], us[i].id);
  // damage a building so it smokes/burns
  const house = g.teamBuildings(0, "house")[0] ?? keep;
  house.hp = house.maxHp * 0.18;
  g.cam.x = px + 40; g.cam.y = py; g.cam.zoom = 1.4; g.clampCam();
});
await page.waitForTimeout(2500);
await page.screenshot({ path: join(fileURLToPath(new URL("../shots", import.meta.url)), "11-night-combat.png") });
await browser.close();
server.close();
console.log("night shot captured");
