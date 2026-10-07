/**
 * Probe: why does the adaptive 3D→2D fallback check see renderer=2d with
 * fellBackTo2D=false? Replays the browser-test fallback section with wrap-around
 * instrumentation (perf.reset / downgradeTo2D / upgradeTo3D / applySettings
 * stacks + a 200 ms state-transition timeline).
 *
 * Usage: node scripts/probe-fallback.mjs
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};
const server = createServer(async (req, res) => {
  try {
    const raw = req.url.split("?")[0];
    const path = raw === "/" || raw === "\\" ? "/index.html" : normalize(raw);
    const data = await readFile(join(DIST, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("nf");
  }
});
await new Promise((r) => server.listen(4179, r));

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 560 } });
await ctx.addInitScript(() => {
  try {
    const raw = localStorage.getItem("castle-dominion-settings-v1");
    const cur = raw ? JSON.parse(raw) : {};
    cur.renderer = "auto";
    cur.quality = 2;
    cur.qualityAuto = true;
    cur.shadows = true;
    localStorage.setItem("castle-dominion-settings-v1", JSON.stringify(cur));
  } catch {
    /* ignore */
  }
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("console: " + m.text().slice(0, 160));
});

const stamp = () => new Date().toISOString().slice(11, 23);
await page.goto("http://localhost:4179/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
console.log(stamp(), "kind0 =", await page.evaluate(() => window.__game?.renderer?.kind ?? "?"));
// instrument BEFORE the match starts
await page.evaluate(() => {
  const g = window.__game;
  const P = (window.__probe = { events: [] });
  const ev = (s) => P.events.push(Math.round(performance.now()) + " " + s);
  const wrap = (obj, name, label) => {
    const orig = obj[name];
    if (typeof orig !== "function") {
      ev(label + " MISSING");
      return;
    }
    obj[name] = function (...a) {
      ev(label + " stack[" + (new Error().stack || "").split("\n").slice(1, 5).join(" <- ") + "]");
      return orig.apply(this, a);
    };
  };
  wrap(g.perf, "reset", "perf.reset");
  wrap(g.perf, "setCap", "setCap");
  wrap(g.perf, "setAuto", "setAuto");
  wrap(g, "applySettings", "applySettings");
  wrap(g, "downgradeTo2D", "downgradeTo2D");
  wrap(g, "upgradeTo3D", "upgradeTo3D");
  let prev = "";
  let prevR = null;
  P.timer = setInterval(() => {
    const r = g.renderer;
    const key =
      [r?.kind, r === prevR ? "same" : "NEW-RENDERER", g.perf.state.tier, g.perf.state.fellBackTo2D, g.perf.state.reason].join(" | ");
    if (key !== prev) {
      prev = key;
      ev("STATE " + key);
    }
    prevR = r;
  }, 200);
});

const MENU_WAIT = Number(process.env.MENU_WAIT || 1500);
if (MENU_WAIT > 1500) {
  console.log(stamp(), `sitting at menu until +${MENU_WAIT} ms so the ladder can hit the floor...`);
  await page.waitForTimeout(MENU_WAIT - 1500);
  console.log(
    stamp(),
    "pre-click state =",
    JSON.stringify(
      await page.evaluate(() => ({
        kind: window.__game.renderer?.kind,
        tier: window.__game.perf.state.tier,
        fell: window.__game.perf.state.fellBackTo2D,
        reason: window.__game.perf.state.reason,
      })),
    ),
  );
}

await page.locator("text=BEGIN MATCH").click();
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const g = window.__game;
  const T = 32;
  const k = g.buildings.find((b) => b.type === "keep" && b.team === 0);
  for (let i = 0; i < 260; i++)
    g.spawnUnit(0, i % 2 ? "militia" : "archer", k.tx * T + (i % 20) * T, k.ty * T + 8 * T + Math.floor(i / 20) * T);
  for (let i = 0; i < 24; i++) g.burst(k.tx * T + i * 30, k.ty * T + 300, "fire", 30, "#ff9a3c", 60, 3, 5);
  g.paused = false;
  window.__probe.events.push(Math.round(performance.now()) + " SPAWNED heavy scene");
});

let fb = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1500);
  fb = await page.evaluate(() => {
    const g = window.__game;
    return {
      kind: g.renderer?.kind,
      ctor: g.renderer?.constructor?.name,
      tier: g.perf.state.tier,
      fell: g.perf.state.fellBackTo2D,
      auto: g.perf.state.auto,
      reason: g.perf.state.reason,
      settingsRenderer: g.settings.renderer,
      phase: g.phase,
      frameMs: g.perfFrameMs,
    };
  });
  console.log(stamp(), "poll", i, JSON.stringify(fb));
  if (fb.kind === "2d" && fb.fell === true) {
    console.log(">>> fallback latch FIRED as expected");
    break;
  }
  if (fb.kind === "2d" && fb.fell === false) {
    console.log(">>> REPRODUCED: kind=2d with fell=false");
    break;
  }
}

const events = await page.evaluate(() => window.__probe.events);
console.log("\n=== event timeline ===");
for (const e of events) console.log(e);
console.log("\n=== page errors ===");
console.log(errs.length ? errs.join("\n") : "(none)");

clearTimeout && (await page.evaluate(() => clearInterval(window.__probe.timer)));
await browser.close();
server.close();
