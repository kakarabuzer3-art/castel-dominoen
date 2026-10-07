/**
 * Diagnostic probe: replicate the XL/epic box-select sequence from
 * browser-test.mjs with pointer-level instrumentation to determine why
 * box select returns 0 (HUD interception vs geometry vs timing).
 *
 * Usage: node scripts/probe-epic-select.mjs
 */
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const SHOTS = fileURLToPath(new URL("../shots", import.meta.url));
await mkdir(SHOTS, { recursive: true });

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};
const server = createServer(async (req, res) => {
  try {
    const raw = req.url.split("?")[0];
    const path = raw === "/" || raw === "\\" ? "/index.html" : normalize(raw);
    const file = join(DIST, path);
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("nf");
  }
});
await new Promise((r) => server.listen(4182, r));

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
await page.addInitScript(() => {
  try {
    const raw = localStorage.getItem("castle-dominion-settings-v1");
    const cur = raw ? JSON.parse(raw) : {};
    cur.renderer = "2d";
    cur.hudMode = "full";
    localStorage.setItem("castle-dominion-settings-v1", JSON.stringify(cur));
  } catch { /* ignore */ }
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto("http://localhost:4182/", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.locator("xpath=//button[normalize-space()='XL']").first().click();
await page
  .locator("xpath=//span[normalize-space()='Epic army']/following::button[normalize-space()='On'][1]")
  .click();
await page.waitForTimeout(400);
await page.locator("text=BEGIN MATCH").click();
await page.waitForTimeout(2200);

// spawn the epic battle exactly like the suite does
await page.evaluate(() => {
  const g = window.__game;
  const T = 32;
  const mx = Math.round(g.grid.w / 2) * T;
  const my = Math.round(g.grid.h / 2) * T;
  const types = ["militia", "spearman", "archer", "knight"];
  const perRow = 20;
  for (let t = 0; t < 2; t++)
    for (let k = 0; k < 600; k++)
      g.spawnUnit(
        t,
        types[k % 4],
        mx + (t ? 15 : -15) * T + ((k % perRow) - perRow / 2) * T,
        my + (Math.floor(k / perRow) - 15) * T,
      );
  g.cmdAttackMove(g.teamUnits(0), mx + 15 * T, my);
  g.cmdAttackMove(g.teamUnits(1), mx - 15 * T, my);
  g.cam.x = mx;
  g.cam.y = my;
  g.camTarget = { x: mx, y: my };
  g.cam.zoom = 1;
  g.zoomTarget = 1;
  g.clampCam();
  g.paused = false;
});
await page.waitForTimeout(6500);

// instrument pointer events
await page.evaluate(() => {
  const w = { down: 0, move: 0, up: 0, downTarget: "", upTarget: "" };
  window.__ptr = w;
  window.addEventListener("pointerdown", (e) => {
    w.down++;
    w.downTarget = (e.target.tagName || "") + (e.target.className ? "." + e.target.className : "");
  });
  window.addEventListener("pointermove", () => { w.move++; });
  window.addEventListener("pointerup", (e) => {
    w.up++;
    w.upTarget = (e.target.tagName || "") + (e.target.className ? "." + e.target.className : "");
  });
});

const sel = await page.evaluate(() => {
  const g = window.__game;
  const us = g.teamUnits(0).filter((u) => u.type !== "villager");
  const cx = us.reduce((s2, u) => s2 + u.x, 0) / Math.max(1, us.length);
  const cy = us.reduce((s2, u) => s2 + u.y, 0) / Math.max(1, us.length);
  const a = g.worldToScreen(cx - 300, cy - 220);
  const b = g.worldToScreen(cx + 300, cy + 220);
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const box = {
    x0: cl(a.x, 10, 1430), y0: cl(a.y, 90, 850),
    x1: cl(b.x, 10, 1430), y1: cl(b.y, 90, 850),
  };
  const el = (x, y) => {
    const e = document.elementFromPoint(x, y);
    return e ? `${e.tagName}.${e.className || ""}` : "null";
  };
  // what does the world rect actually contain right now?
  const wa = g.screenToWorld(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1));
  const wb = g.screenToWorld(Math.max(box.x0, box.x1), Math.max(box.y0, box.y1));
  const inRect = g.teamUnits(0).filter(
    (u) => u.x >= wa.x && u.x <= wb.x && u.y >= wa.y && u.y <= wb.y,
  ).length;
  return {
    box, us: us.length,
    el00: el(box.x0, box.y0), el11: el(box.x1, box.y1),
    cam: { ...g.cam }, view: { w: g.viewW, h: g.viewH },
    wa: { x: Math.round(wa.x), y: Math.round(wa.y) },
    wb: { x: Math.round(wb.x), y: Math.round(wb.y) },
    inRect,
  };
});
console.log("pre-drag state:", JSON.stringify(sel, null, 1));

await page.mouse.move(sel.box.x0, sel.box.y0);
await page.mouse.down();
await page.mouse.move(sel.box.x1, sel.box.y1, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(400);

const post = await page.evaluate(() => {
  const g = window.__game;
  return {
    nSel: g.selUnits().length,
    ptr: window.__ptr,
    dragSel: g.dragSel,
    clickAnchor: g.clickAnchor !== undefined ? !!g.clickAnchor : "n/a",
  };
});
console.log("post-drag state:", JSON.stringify(post, null, 1));
console.log(
  post.nSel > 20
    ? `PROBE PASS — selected=${post.nSel}`
    : `PROBE FAIL — selected=${post.nSel}, inRectAtCompute=${sel.inRect}, downTarget=${post.ptr.downTarget}, downCount=${post.ptr.down}`,
);
await page.screenshot({ path: join(SHOTS, "probe-epic-select.png") });
await browser.close();
server.close();
