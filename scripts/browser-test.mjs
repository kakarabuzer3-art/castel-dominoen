/**
 * Browser runtime test: serves dist/, opens the game in headless chromium,
 * plays it with real mouse events, asserts state changes, catches console
 * errors, and captures screenshots for visual review.
 *
 * Usage: node scripts/browser-test.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const DIST = new URL("../dist", import.meta.url).pathname;
const SHOTS = new URL("../shots", import.meta.url).pathname;
await mkdir(SHOTS, { recursive: true });

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
    const path = normalize(req.url.split("?")[0]);
    const file = join(DIST, path === "/" ? "index.html" : path);
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("nf");
  }
});
await new Promise((r) => server.listen(4179, r));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// /dev/shm is tiny (64 MB) in CI sandboxes — without disable-dev-shm-usage
// extra contexts/pages crash the renderer with "Target crashed"
const LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];
let browser = await chromium.launch({ args: LAUNCH_ARGS });
// functional suite runs on the deterministic 2D renderer (SwiftShader-friendly);
// the 3D renderer gets its own dedicated section at the end
const FORCE_2D = () => {
  try {
    const raw = localStorage.getItem("castle-dominion-settings-v1");
    const cur = raw ? JSON.parse(raw) : {};
    cur.renderer = "2d";
    cur.hudMode = "full"; // functional suite interacts with every panel directly
    localStorage.setItem("castle-dominion-settings-v1", JSON.stringify(cur));
  } catch { /* ignore */ }
};
let page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
await page.addInitScript(FORCE_2D);

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    consoleErrors.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));

/**
 * Dispose + relaunch the whole browser and recreate the main page. The
 * sandbox cgroup caps memory at 1 GiB; long sections accumulate heap that
 * Chromium never returns, and a second live renderer then OOM-crashes with
 * "Target crashed". Called at the two heaviest transitions of the suite.
 */
const relaunchMain = async () => {
  try {
    await page.evaluate(() => {
      try { window.__game.dispose(); } catch { /* ignore */ }
    });
  } catch { /* page already gone */ }
  try { await page.close(); } catch { /* ignore */ }
  await browser.close();
  browser = await chromium.launch({ args: LAUNCH_ARGS });
  page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await page.addInitScript(FORCE_2D);
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      consoleErrors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  await page.goto("http://localhost:4179/", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
};

await page.goto("http://localhost:4179/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// ── start screen ─────────────────────────────────────────────────────────────
check("title present", (await page.title()).includes("Castle Dominion"));
check(
  "match setup screen visible",
  await page.locator("text=Game mode").first().isVisible(),
);
check(
  "map list offers 7 archetypes",
  (await page.locator("button", { hasText: "Verdant Valley" }).count()) === 1 &&
    (await page.locator("button", { hasText: "Twin Fortresses" }).count()) === 1 &&
    (await page.locator("button", { hasText: "Mountain Pass" }).count()) === 1,
);
check(
  "lord cards offered",
  (await page.locator("button", { hasText: "Lord Vharek" }).count()) === 1 &&
    (await page.locator("button", { hasText: "Random lord" }).count()) === 1,
);
check(
  "map preview canvas painted",
  await page.evaluate(() => {
    const cs = [...document.querySelectorAll("canvas")];
    const prev = cs.find((c) => c.width === 160);
    if (!prev) return false;
    const d = prev.getContext("2d").getImageData(0, 0, 160, 160).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 40) if (d[i] + d[i + 1] + d[i + 2] > 40) n++;
    return n > 500;
  }),
);
await page.screenshot({ path: join(SHOTS, "01-start.png") });

// ── SEO / metadata / semantic structure ─────────────────────────────────────
const head = await page.evaluate(() => {
  const q = (sel) => document.querySelector(sel);
  let ld = null;
  try {
    ld = JSON.parse(q('script[type="application/ld+json"]').textContent);
  } catch {
    ld = null;
  }
  return {
    desc: q('meta[name="description"]')?.content?.length ?? 0,
    canonical: q('link[rel="canonical"]')?.getAttribute("href") ?? "",
    ogTitle: q('meta[property="og:title"]')?.content ?? "",
    ogImage: q('meta[property="og:image"]')?.content ?? "",
    twCard: q('meta[name="twitter:card"]')?.content ?? "",
    ldType: ld?.["@type"] ?? null,
    ldName: ld?.name ?? "",
    favicon: q('link[rel="icon"]')?.getAttribute("href") ?? "",
    themeColor: q('meta[name="theme-color"]')?.content ?? "",
    noscript: !!q('noscript'),
    lang: document.documentElement.lang,
    main: !!q('main'),
    header: !!q('header'),
  };
});
check("meta description present (100-200 chars)", head.desc >= 100 && head.desc <= 200, `${head.desc} chars`);
check(
  "canonical set to served origin (no placeholder domain)",
  /^https?:\/\//.test(head.canonical) && !head.canonical.includes("example.com"),
  head.canonical,
);
check("open graph title/image set", head.ogTitle.length > 5 && head.ogImage.endsWith("og-cover.png"));
check("twitter card set", head.twCard === "summary_large_image");
check("JSON-LD VideoGame schema valid", head.ldType === "VideoGame" && head.ldName === "Castle Dominion");
check("favicon + theme-color set", head.favicon === "/favicon.svg" && head.themeColor === "#191209");
check("noscript fallback + lang", head.noscript && head.lang === "en");
check("semantic main/header present", head.main && head.header);

// canvas is painting (non-blank)
const notBlank = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let nonBlack = 0;
  for (let i = 0; i < d.length; i += 400) if (d[i] + d[i + 1] + d[i + 2] > 40) nonBlack++;
  return nonBlack > 500;
});
check("canvas renders terrain behind menu", notBlank);

// ── settings overlay controls ───────────────────────────────────────────────
// (gear only exists in-game; open settings from top bar after match start below)

// ── start the game ───────────────────────────────────────────────────────────
await page.locator("text=BEGIN MATCH").click();
await page.waitForTimeout(1500);
check(
  "game entered playing phase",
  (await page.evaluate(() => window.__game.phase)) === "playing",
);
check("HUD pause button visible", await page.locator("button[title^='Pause']").isVisible());
await page.screenshot({ path: join(SHOTS, "02-playing.png") });

// ── select all villagers with a real drag box ────────────────────────────────
const box = await page.evaluate(() => {
  const g = window.__game;
  const vs = g.teamUnits(0, "villager");
  const a = g.worldToScreen(Math.min(...vs.map((v) => v.x)) - 30, Math.min(...vs.map((v) => v.y)) - 30);
  const b = g.worldToScreen(Math.max(...vs.map((v) => v.x)) + 30, Math.max(...vs.map((v) => v.y)) + 30);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
});
await page.mouse.move(box.x0, box.y0);
await page.mouse.down();
await page.mouse.move(box.x1, box.y1, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const selCount = await page.evaluate(() => window.__game.selUnits().length);
check("drag-box selected all 4 villagers", selCount === 4, `selected=${selCount}`);
await page.screenshot({ path: join(SHOTS, "03-selection.png") });

// ── right-click a tree → gather ──────────────────────────────────────────────
const treeScreen = await page.evaluate(() => {
  const g = window.__game;
  const v = g.teamUnits(0, "villager")[0];
  const n = g.nearestNode("wood", v.x, v.y, 30 * 32);
  if (!n) return null;
  // pan camera so the node is on screen
  g.cam.x = n.tx * 32;
  g.cam.y = n.ty * 32;
  const s = g.worldToScreen(n.tx * 32 + 16, n.ty * 32 + 16);
  return { x: s.x, y: s.y, id: n.id };
});
check("found a tree near base", !!treeScreen);
await page.mouse.click(treeScreen.x, treeScreen.y, { button: "right" });
await page.waitForTimeout(400);
const harvesting = await page.evaluate(
  () => window.__game.teamUnits(0, "villager").filter((u) => u.state === "harvest").length,
);
check("villagers went to harvest", harvesting >= 3, `harvesting=${harvesting}`);

// wait and verify wood income
const wood0 = await page.evaluate(() => window.__game.res[0].wood);
await page.waitForTimeout(8000);
const wood1 = await page.evaluate(() => window.__game.res[0].wood);
check("wood income flows", wood1 > wood0, `${Math.floor(wood0)} → ${Math.floor(wood1)}`);
await page.screenshot({ path: join(SHOTS, "04-gathering.png") });

// ── build a house via the real UI button ─────────────────────────────────────
await page.evaluate(() => {
  const g = window.__game;
  g.res[0].wood += 200; // ensure affordable regardless of income timing
  g.publish(true);
});
await page.getByRole("button", { name: /House/ }).click();
await page.waitForTimeout(200);
const spot = await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  const s = g.findSpotNear(keep.tx + 6, keep.ty + 6, "house", 0, 5);
  g.cam.x = (s.x + 1) * 32;
  g.cam.y = (s.y + 1) * 32;
  const sc = g.worldToScreen(s.x * 32 + 16, s.y * 32 + 16);
  return sc;
});
await page.mouse.click(spot.x, spot.y);
await page.waitForTimeout(400);
const houses = await page.evaluate(() => window.__game.teamBuildings(0, "house").length);
check("house placed via build palette", houses === 1, `houses=${houses}`);
await page.screenshot({ path: join(SHOTS, "05-house-site.png") });

// select all villagers (drag) and right-click the site to build it
const siteBox = await page.evaluate(() => {
  const g = window.__game;
  const site = g.teamBuildings(0, "house")[0];
  const vs = g.teamUnits(0, "villager");
  g.cam.x = (site.tx + 1) * 32;
  g.cam.y = (site.ty + 1) * 32;
  const a = g.worldToScreen(Math.min(...vs.map((v) => v.x)) - 25, Math.min(...vs.map((v) => v.y)) - 25);
  const b = g.worldToScreen(Math.max(...vs.map((v) => v.x)) + 25, Math.max(...vs.map((v) => v.y)) + 25);
  const s = g.worldToScreen((site.tx + 1) * 32, (site.ty + 1) * 32);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, sx: s.x, sy: s.y };
});
await page.mouse.move(siteBox.x0, siteBox.y0);
await page.mouse.down();
await page.mouse.move(siteBox.x1, siteBox.y1, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.mouse.click(siteBox.sx, siteBox.sy, { button: "right" });
await page.waitForTimeout(500);
const buildersSent = await page.evaluate(() =>
  window.__game.teamUnits(0, "villager").filter((u) => u.state === "build").length,
);
check("right-click sent villagers to build", buildersSent >= 1, `builders=${buildersSent}`);
await page.waitForTimeout(12000);
const houseBuilt = await page.evaluate(() =>
  window.__game.teamBuildings(0, "house").some((h) => h.built),
);
check("house construction completed", houseBuilt);

// ── train a villager from the keep via UI ────────────────────────────────────
await page.evaluate(() => {
  const g = window.__game;
  g.res[0].food += 200;
  g.selectedBuilding = g.keeps[0];
  g.selection.clear();
  g.publish(true);
});
await page.waitForTimeout(200);
const trainBtn = page.getByRole("button", { name: /^Villager/ });
check("train button visible with keep selected", await trainBtn.isVisible());
await trainBtn.click();
await page.waitForTimeout(300);
const queued = await page.evaluate(() => {
  const k = window.__game.buildingById.get(window.__game.keeps[0]);
  return k.queue.length;
});
check("villager queued for training", queued === 1, `queue=${queued}`);

// ── phase-2 UI: keep upgrades visible ───────────────────────────────────────
check(
  "keep shows upgrade buttons",
  await page.getByRole("button", { name: /Wheelbarrow/ }).isVisible(),
);

// build a barracks + market directly, then check their panels
await page.evaluate(() => {
  const g = window.__game;
  g.res[0].wood += 600;
  g.res[0].stone += 300;
  g.res[0].gold += 300;
  const keep = g.buildingById.get(g.keeps[0]);
  const s1 = g.findSpotNear(keep.tx - 6, keep.ty + 6, "barracks", 0, 6);
  if (s1) g.place(0, "barracks", s1.x, s1.y);
  const s2 = g.findSpotNear(keep.tx + 7, keep.ty - 6, "market", 0, 6);
  if (s2) g.place(0, "market", s2.x, s2.y);
  for (const b of g.teamBuildings(0))
    if (!b.built) {
      b.built = true;
      b.work = 0;
      b.hp = b.maxHp;
    }
  g.selectedBuilding = g.teamBuildings(0, "barracks")[0].id;
  g.selection.clear();
  g.publish(true);
});
await page.waitForTimeout(300);
check(
  "barracks shows upgrade buttons",
  await page.getByRole("button", { name: /Iron Swords/ }).isVisible(),
);
// research one upgrade through the UI
await page.getByRole("button", { name: /Iron Swords/ }).click();
await page.waitForTimeout(400);
const researching = await page.evaluate(() => {
  const b = window.__game.teamBuildings(0, "barracks")[0];
  return b.research?.id ?? null;
});
check("upgrade research started via UI", researching === "iron_swords", `${researching}`);

// market panel
await page.evaluate(() => {
  const g = window.__game;
  g.selectedBuilding = g.teamBuildings(0, "market")[0].id;
  g.selection.clear();
  g.publish(true);
});
await page.waitForTimeout(300);
const tradeBtn = page.locator("button[title='Sell 100 wood → 55 gold']");
check("market trade buttons visible", await tradeBtn.isVisible());
const goldBefore = await page.evaluate(() => window.__game.res[0].gold);
await tradeBtn.click();
await page.waitForTimeout(300);
const goldAfter = await page.evaluate(() => window.__game.res[0].gold);
check(
  "market trade executes",
  goldAfter - goldBefore >= 54.5 && goldAfter - goldBefore <= 57,
  `${goldBefore.toFixed(1)}→${goldAfter.toFixed(1)}`,
);

// popularity panel with factors + policy controls
check(
  "popularity panel visible",
  await page.locator("text=Popularity").first().isVisible(),
);
check(
  "popularity factors listed",
  (await page.locator("text=Rations").count()) >= 1 &&
    (await page.locator("text=Taxes").count()) >= 1,
);
await page.getByRole("button", { name: "Ext", exact: true }).click();
await page.waitForTimeout(250);
check(
  "ration control works",
  (await page.evaluate(() => window.__game.ration[0])) === 3,
);
await page.getByRole("button", { name: "Hig", exact: true }).click();
await page.waitForTimeout(250);
const taxSet = await page.evaluate(() => window.__game.tax[0]);
check("tax control works", taxSet === 3, `tax=${taxSet}`);
// granary reserve appears once built
await page.evaluate(() => {
  const g = window.__game;
  g.res[0].wood += 200;
  g.res[0].stone += 100;
  const keep = g.buildingById.get(g.keeps[0]);
  const sp = g.findSpotNear(keep.tx - 8, keep.ty + 2, "granary", 0, 5);
  if (sp) g.place(0, "granary", sp.x, sp.y);
  for (const b of g.teamBuildings(0))
    if (!b.built && b.type === "granary") {
      b.built = true;
      b.work = 0;
      b.hp = b.maxHp;
    }
});
await page.waitForTimeout(2500);
check(
  "granary stocks a food reserve",
  (await page.evaluate(() => window.__game.granary[0])) > 0,
);

// place a tower + wall + gate for the screenshot
await page.evaluate(() => {
  const g = window.__game;
  g.res[0].stone += 400;
  const keep = g.buildingById.get(g.keeps[0]);
  const s1 = g.findSpotNear(keep.tx + 6, keep.ty + 7, "tower", 0, 5);
  if (s1) g.place(0, "tower", s1.x, s1.y);
  g.place(0, "gate", keep.tx + 10, keep.ty + 8);
  for (let i = 0; i < 5; i++)
    if (i !== 2) g.place(0, "wall", keep.tx + 8 + i, keep.ty + 8);
  for (const b of g.teamBuildings(0))
    if (!b.built) {
      b.built = true;
      b.work = 0;
      b.hp = b.maxHp;
    }
  // train a showcase squad
  const bar = g.teamBuildings(0, "barracks")[0];
  for (const t of ["spearman", "knight", "catapult", "archer"]) {
    g.res[0].food += 100;
    g.res[0].gold += 100;
    g.res[0].wood += 150;
    bar.queue.push(t);
  }
  g.selectedBuilding = -1;
  g.publish(true);
});
await page.waitForTimeout(6000);
await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  g.cam.x = (keep.tx + 4) * 32;
  g.cam.y = (keep.ty + 4) * 32;
  g.cam.zoom = 1.1;
  g.clampCam();
});
await page.waitForTimeout(800);
await page.screenshot({ path: join(SHOTS, "08-phase2.png") });

// let the showcase squad finish training, then frame it with the tower
await page.waitForTimeout(30000);
await page.evaluate(() => {
  const g = window.__game;
  const squad = g
    .teamUnits(0)
    .filter((u) => ["spearman", "knight", "catapult", "archer"].includes(u.type));
  for (const u of squad) {
    u.x = g.buildingById.get(g.keeps[0]).tx * 32 + 90 + squad.indexOf(u) * 26;
    u.y = g.buildingById.get(g.keeps[0]).ty * 32 + 220;
    u.state = "idle";
    u.path = null;
  }
  const tower = g.teamBuildings(0, "tower")[0];
  if (tower) {
    g.cam.x = (tower.tx + 1) * 32 - 60;
    g.cam.y = (tower.ty + 1) * 32 - 20;
  }
  g.cam.zoom = 1.5;
  g.clampCam();
  g.publish(true);
});
await page.waitForTimeout(600);
await page.screenshot({ path: join(SHOTS, "09-units.png") });

// ── camera keys + zoom wheel ─────────────────────────────────────────────────
const camBefore = await page.evaluate(() => ({ ...window.__game.cam }));
await page.mouse.move(700, 400);
await page.mouse.wheel(0, -240);
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(500);
await page.keyboard.up("ArrowUp");
const camAfter = await page.evaluate(() => ({ ...window.__game.cam }));
check(
  "wheel zoom + arrow pan work",
  camAfter.zoom > camBefore.zoom && camAfter.y < camBefore.y,
  `zoom ${camBefore.zoom.toFixed(2)}→${camAfter.zoom.toFixed(2)}`,
);

// ── let the AI live a bit: fast-forward via speed toggle ────────────────────
await page.evaluate(() => {
  window.__game.cam.zoom = 0.7;
  window.__game.clampCam();
});
await page.waitForTimeout(6000);
await page.screenshot({ path: join(SHOTS, "06-later.png") });

// minimap painted?
const mmPainted = await page.evaluate(() => {
  const canvases = document.querySelectorAll("canvas");
  const mm = canvases[canvases.length - 1];
  if (!mm) return false;
  const ctx = mm.getContext("2d");
  const d = ctx.getImageData(0, 0, mm.width, mm.height).data;
  let nonZero = 0;
  for (let i = 0; i < d.length; i += 40) if (d[i] + d[i + 1] + d[i + 2] > 30) nonZero++;
  return nonZero > 200;
});
check("minimap is painted", mmPainted);

// ── victory overlay + restart flow ──────────────────────────────────────────
await page.evaluate(() => {
  window.__game.phase = "victory";
  window.__game.publish(true);
});
await page.waitForTimeout(300);
check("victory overlay shows", await page.locator("text=VICTORY").isVisible());
await page.screenshot({ path: join(SHOTS, "07-victory.png") });
await page.locator("text=PLAY AGAIN").click();
await page.waitForTimeout(800);
check(
  "restart works",
  (await page.evaluate(() => window.__game.phase)) === "playing" &&
    (await page.evaluate(() => window.__game.time)) < 3,
);

// ── window resize resilience ────────────────────────────────────────────────
await page.setViewportSize({ width: 900, height: 700 });
await page.waitForTimeout(600);
const resized = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  return { w: window.__game.viewW, h: window.__game.viewH, cw: c.width > 0 };
});
check("resize handled", resized.w === 900 && resized.h === 700 && resized.cw);
await page.setViewportSize({ width: 1440, height: 860 });
await page.waitForTimeout(400);

// ── settings overlay: every category + controls ─────────────────────────────
await page.locator("button[aria-label='Open settings']").click();
await page.waitForTimeout(400);
check("settings overlay opens", await page.locator("text=SETTINGS").isVisible());
for (const tab of ["Gameplay", "Audio", "Graphics", "Accessibility", "Controls"]) {
  await page.locator("button", { hasText: new RegExp(`^${tab}$`) }).first().click();
  await page.waitForTimeout(150);
}
check("controls tab lists hotkeys", await page.locator("text=attack-move").first().isVisible());
await page.locator("button", { hasText: /^Graphics$/ }).first().click();
await page.locator("button", { hasText: /^Shadows/ }).click();
await page.waitForTimeout(200);
check(
  "shadows toggle reaches engine",
  (await page.evaluate(() => window.__game.settings.shadows)) === false,
);
await page.locator("button", { hasText: /^Audio$/ }).first().click();
const slider = page.locator("input[type='range']").first();
await slider.fill("0.3");
await page.waitForTimeout(200);
check(
  "master volume slider reaches engine",
  Math.abs((await page.evaluate(() => window.__game.settings.masterVol)) - 0.3) < 0.01,
);
await page.screenshot({ path: join(SHOTS, "p6-2-settings.png") });
await page.locator("button", { hasText: /^Done$/ }).click();
await page.waitForTimeout(200);
check(
  "shadows restored via toggle",
  (await page.evaluate(() => {
    window.__game.applySettings({ ...window.__game.settings, shadows: true });
    return window.__game.settings.shadows;
  })) === true,
);

// ── phase-3: tutorial panel, hotkeys, control groups ────────────────────────
check(
  "tutorial tracker visible",
  await page.locator("text=Tutorial 0/8").isVisible().catch(() => false) ||
    (await page.locator("text=/Tutorial \\d/8/").first().isVisible()),
);
// Q hotkey enters placement mode
await page.keyboard.press("q");
await page.waitForTimeout(200);
check(
  "Q hotkey arms house placement",
  (await page.evaluate(() => window.__game.placement)) === "house",
);
await page.keyboard.press("Escape");
// control groups: select villagers via H, assign Ctrl+1, deselect, recall with 1
await page.keyboard.press("h");
await page.waitForTimeout(200);
await page.keyboard.press("Control+1");
await page.waitForTimeout(150);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const selAfterEsc = await page.evaluate(() => window.__game.selUnits().length);
await page.keyboard.press("1");
await page.waitForTimeout(250);
const selAfterRecall = await page.evaluate(() => window.__game.selUnits().length);
check(
  "control group 1 assign/recall",
  selAfterEsc === 0 && selAfterRecall >= 1,
  `esc=${selAfterEsc} recall=${selAfterRecall}`,
);
// mute toggle
await page.locator("button[title^='Sound']").click();
check("mute toggles", (await page.evaluate(() => window.__game.muted)) === true);
await page.locator("button[title^='Sound']").click();

// ── save / continue flow ────────────────────────────────────────────────────
await page.evaluate(() => window.__game.saveNow());
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
check("continue button offered after reload", await page.locator("text=CONTINUE").isVisible());
await page.locator("text=CONTINUE").click();
await page.waitForTimeout(1200);
const loaded = await page.evaluate(() => ({
  phase: window.__game.phase,
  time: window.__game.time,
  units: window.__game.units.length,
}));
check(
  "save loads into a live game",
  loaded.phase === "playing" && loaded.time >= 2 && loaded.units > 3,
  JSON.stringify(loaded),
);
await page.screenshot({ path: join(SHOTS, "10-continued.png") });

// ── fog of war + formations in the live game ────────────────────────────────
await page.evaluate(() => {
  const g = window.__game;
  g.applySettings({ ...g.settings, fog: true });
  g.refreshVision();
});
await page.waitForTimeout(400);
const fogState = await page.evaluate(() => {
  const g = window.__game;
  const ek = g.buildingById.get(g.keeps[1]);
  const pk = g.buildingById.get(g.keeps[0]);
  return {
    enemyHidden: !g.isVisibleTo(0, (ek.tx + 2) * 32, (ek.ty + 2) * 32),
    ownVisible: g.isVisibleTo(0, (pk.tx + 2) * 32, (pk.ty + 2) * 32),
  };
});
check("fog hides enemy base, shows own", fogState.enemyHidden && fogState.ownVisible);
await page.screenshot({ path: join(SHOTS, "p7-1-fog.png") });
// formation button cycles
await page.evaluate(() => {
  const g = window.__game;
  g.applySettings({ ...g.settings, fog: false });
  g.deselectAllUnits?.();
  g.selection.clear();
  const keep = g.buildingById.get(g.keeps[0]);
  for (let i = 0; i < 5; i++) {
    const u = g.spawnUnit(0, "militia", (keep.tx + 2 + i) * 32, (keep.ty + 8) * 32);
    g.selection.add(u.id);
    u.selected = true;
  }
  g.publish(true);
});
await page.waitForTimeout(300);
const formBtn = page.locator("button", { hasText: /Loose|Line|Column/ }).first();
check("formation button visible with military selected", await formBtn.isVisible());
await formBtn.click();
await page.waitForTimeout(250);
check(
  "formation cycles to line",
  (await page.evaluate(() => window.__game.formation)) === 1,
);
await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  g.cmdMove(g.selUnits(), (keep.tx + 2) * 32, (keep.ty - 14) * 32);
  g.cam.x = (keep.tx + 2) * 32;
  g.cam.y = (keep.ty - 4) * 32;
  g.cam.zoom = 1.3;
  g.zoomTarget = 1.3;
  g.clampCam();
});
await page.waitForTimeout(1500);
await page.screenshot({ path: join(SHOTS, "p7-2-formation.png") });

// ── performance: baseline vs heavy scene (ratio-based; SwiftShader floor) ──
const measureFps = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
          else resolve(Math.round((n * 1000) / (performance.now() - t0)));
        };
        requestAnimationFrame(tick);
      }),
  );
const fpsBase = await measureFps();
check(
  "baseline render sanity on software GL >= 25 FPS",
  fpsBase >= 25,
  `${fpsBase} fps (SwiftShader — real-GPU numbers come from the in-game profiler)`,
);

// ── performance under a heavy scene (60 units + particles) ──────────────────
await page.evaluate(() => {
  const g = window.__game;
  for (let i = 0; i < 60; i++) {
    g.spawnUnit(
      0,
      i % 3 === 0 ? "knight" : i % 3 === 1 ? "militia" : "archer",
      600 + (i % 10) * 30,
      2600 + Math.floor(i / 10) * 30,
    );
  }
  g.burst(700, 2700, "fire", 60, "#ff9a3c", 80, 1, 4);
  g.burst(700, 2700, "smoke", 40, "#2e2e2e", 30, 2, 6);
  g.cam.x = 700;
  g.cam.y = 2700;
  g.cam.zoom = 1.2;
  g.clampCam();
});
await page.waitForTimeout(400);
const fpsHeavy = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => {
        n++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
        else resolve(Math.round((n * 1000) / (performance.now() - t0)));
      };
      requestAnimationFrame(tick);
    }),
);
check(
  "heavy scene stays within 1.8x baseline frame cost",
  fpsHeavy >= Math.max(15, fpsBase / 1.8),
  `${fpsHeavy} fps vs baseline ${fpsBase} fps`,
);

// ── FULL MATCH in the production bundle: start → victory/defeat ─────────────
const match = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const g = window.__game;
      const T = 32;
      let armySent = -999;
      let houseIdx = 0;
      let farmIdx = 0;
      let wallsBuilt = false;
      const decide = () => {
        if (g.phase !== "playing") return;
        const pk = g.buildingById.get(g.keeps[0]);
        if (!pk) return;
        const kc = { x: (pk.tx + 2.5) * T, y: (pk.ty + 2.5) * T };
        const villagers = g.teamUnits(0, "villager");
        for (const v of villagers) {
          if (v.state !== "idle") continue;
          const site = g.teamBuildings(0).find((b) => !b.built && b.builders < 2);
          if (site) { g.assignBuild(v, site); continue; }
          const farms = g.teamBuildings(0, "farm").filter((f) => f.built);
          if (farms.length && g.res[0].food < 320) { g.assignHarvest(v, farms[0].id); continue; }
          let node = g.nearestNode("wood", v.x, v.y, 32 * T);
          if (!node || g.res[0].gold < 80) node = node ?? g.nearestNode("gold", v.x, v.y, 46 * T);
          if (node) g.assignHarvest(v, node.id);
        }
        for (const site of g.teamBuildings(0)) {
          if (site.built || site.builders > 0) continue;
          const c = g.teamUnits(0, "villager").filter((v) => v.state === "idle" || v.state === "harvest")
            .sort((a, b) => Math.hypot(a.x - kc.x, a.y - kc.y) - Math.hypot(b.x - kc.x, b.y - kc.y));
          for (const v of c.slice(0, 2)) g.assignBuild(v, site);
        }
        const busy = g.teamBuildings(0).some((b) => !b.built);
        if (!busy) {
          if (g.popCap[0] - g.popCur[0] <= 2 && g.res[0].wood >= 60 && g.teamBuildings(0, "house").length < 9) {
            const a = houseIdx++ * 2.1;
            const sp = g.findSpotNear(Math.round((kc.x + Math.cos(a) * 8 * T) / T), Math.round((kc.y + Math.sin(a) * 8 * T) / T), "house", 0, 6);
            if (sp) g.place(0, "house", sp.x, sp.y);
          } else if (g.teamBuildings(0, "farm").length < 3 && g.res[0].wood >= 50) {
            const a = 1.2 + farmIdx++ * 2.2;
            const sp = g.findSpotNear(Math.round((kc.x + Math.cos(a) * 9 * T) / T), Math.round((kc.y + Math.sin(a) * 9 * T) / T), "farm", 0, 6);
            if (sp) g.place(0, "farm", sp.x, sp.y);
          } else if (!g.teamBuildings(0, "barracks").length && (g.time > 50 || g.res[0].wood > 150) && g.res[0].wood >= 130 && g.res[0].stone >= 45) {
            const sp = g.findSpotNear(Math.round(kc.x / T) - 5, Math.round(kc.y / T) + 4, "barracks", 0, 7);
            if (sp) g.place(0, "barracks", sp.x, sp.y);
          } else if (g.time > 240 && g.teamBuildings(0, "tower").length < 2 && g.res[0].stone >= 130) {
            const sp = g.findSpotNear(Math.round(kc.x / T) + 6, Math.round(kc.y / T) - 6, "tower", 0, 5);
            if (sp) g.place(0, "tower", sp.x, sp.y);
          } else if (!wallsBuilt && g.time > 240 && g.res[0].stone > 90) {
            let placed = 0;
            for (let i = 0; i < 6; i++) { const sp = { x: pk.tx + 7 + i, y: pk.ty + 8 }; if (g.place(0, "wall", sp.x, sp.y)) placed++; }
            if (placed) wallsBuilt = true;
          }
        }
        const keepB = g.buildingById.get(g.keeps[0]);
        if (keepB && g.res[0].food > 200) g.startResearch(keepB, "wheelbarrow");
        if (g.res[0].food >= 55 && villagers.length < 10 && keepB) g.trainAt(keepB, "villager");
        for (const bar of g.teamBuildings(0, "barracks")) {
          if (!bar.built || bar.queue.length >= 2) continue;
          const army = g.teamUnits(0).filter((u) => u.type !== "villager");
          const type = g.time > 540 && army.filter((u) => u.type === "catapult").length < 2 && g.res[0].wood > 260 ? "catapult" : army.length % 3 === 2 ? "archer" : "militia";
          if (!g.trainAt(bar, type)) g.trainAt(bar, "militia");
        }
        const army = g.teamUnits(0).filter((u) => u.type !== "villager");
        const free = army.filter((u) => u.state !== "attack" && u.state !== "attackMove");
        const ek = g.buildingById.get(g.keeps[1]);
        if (ek && ((free.length >= 12 && g.time > 400 && g.time - armySent > 70) || (g.time > 900 && free.length >= 8 && g.time - armySent > 60))) {
          armySent = g.time;
          g.cmdAttackMove(free, (ek.tx + ek.w / 2) * T, (ek.ty + ek.h + 1) * T);
        }
      };
      const loop = () => {
        let guard = 0;
        while (g.phase === "playing" && g.time < 3000 && guard++ < 20) {
          g.step(30);
          decide();
        }
        if (g.phase === "playing" && g.time < 3000) setTimeout(loop, 0);
        else resolve({ phase: g.phase, time: Math.round(g.time), kills: g.kills, losses: g.losses });
      };
      loop();
    }),
);
check(
  "full match reaches victory/defeat in production bundle",
  match.phase === "victory" || match.phase === "defeat",
  `${match.phase} at t=${match.time}s kills=${match.kills} losses=${match.losses}`,
);
await page.waitForTimeout(600);
await page.screenshot({ path: join(SHOTS, "12-endgame.png") });

// ── desert map + AI personality selection ───────────────────────────────────
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.locator("button", { hasText: "Desert Siege" }).click();
await page.locator("button", { hasText: "Lord Vharek" }).click();
await page.locator("text=BEGIN MATCH").click();
await page.waitForTimeout(1200);
const desertState = await page.evaluate(() => ({
  theme: window.__game.grid.theme,
  personality: window.__game.ai.personality.name,
  lord: window.__game.cfg.lord,
  palms: window.__game.nodes.filter((n) => n.kind === "tree").length,
  oasis: window.__game.grid.terrain.includes(4),
}));
check(
  "desert map + aggressive lord selected",
  desertState.theme === "desert" &&
    desertState.personality === "Aggressive" &&
    desertState.lord === 0 &&
    desertState.palms > 30 &&
    desertState.oasis,
  JSON.stringify(desertState),
);
// desert economy sanity: palms chop, buildings place on sand
const desertRun = await page.evaluate(() => {
  const g = window.__game;
  const w0 = g.res[0].wood;
  for (let i = 0; i < 8; i++) {
    g.step(30);
    for (const v of g.teamUnits(0, "villager")) {
      if (v.state !== "idle") continue;
      const n = g.nearestNode("wood", v.x, v.y, 30 * 32);
      if (n) g.assignHarvest(v, n.id);
    }
    if (i === 2) {
      const keep = g.buildingById.get(g.keeps[0]);
      const offs = [
        [7, 7],
        [-7, 7],
        [7, -7],
        [-7, -7],
        [9, 2],
        [-9, 2],
        [2, 9],
      ];
      for (const [dx, dy] of offs) {
        const sp = g.findSpotNear(keep.tx + dx, keep.ty + dy, "house", 0, 4);
        if (sp && g.place(0, "house", sp.x, sp.y)) break;
      }
      for (const b of g.teamBuildings(0))
        if (!b.built) {
          b.built = true;
          b.work = 0;
          b.hp = b.maxHp;
        }
    }
  }
  return {
    wood: Math.floor(g.res[0].wood),
    w0: Math.floor(w0),
    houses: g.teamBuildings(0, "house").length,
    phase: g.phase,
  };
});
check(
  "desert economy works (palms → wood, build on sand)",
  desertRun.wood > desertRun.w0 && desertRun.houses >= 1 && desertRun.phase === "playing",
  JSON.stringify(desertRun),
);
await page.evaluate(() => {
  const g = window.__game;
  const keep = g.buildingById.get(g.keeps[0]);
  g.cam.x = (keep.tx + 2.5) * 32;
  g.cam.y = (keep.ty + 2.5) * 32;
  g.cam.zoom = 1.15;
  g.zoomTarget = 1.15;
  g.clampCam();
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(SHOTS, "p5-2-desert-castle.png") });

// ── replay library + playback ───────────────────────────────────────────────
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.locator("button", { hasText: "Replays" }).click();
await page.waitForTimeout(400);
const replayRows = await page.locator("button", { hasText: "▶ Play" }).count();
check("replay recorded after finished match", replayRows >= 1, `rows=${replayRows}`);
if (replayRows >= 1) {
  await page.locator("button", { hasText: "▶ Play" }).first().click();
  await page.waitForTimeout(1500);
  check(
    "replay playback runs",
    (await page.evaluate(() => window.__game.replayMode)) === true &&
      (await page.evaluate(() => window.__game.time)) > 1,
  );
  check("replay banner visible", await page.locator("text=REPLAY").first().isVisible());
  // timeline scrubbing
  const slider = page.getByLabel("Replay timeline");
  check("replay timeline slider visible", await slider.isVisible());
  const tBefore = await page.evaluate(() => window.__game.time);
  await page.locator("button[title='Forward 10s']").click();
  await page.waitForTimeout(400);
  const tAfter = await page.evaluate(() => window.__game.time);
  check("seek +10s jumps forward", tAfter >= tBefore + 9, `${tBefore.toFixed(0)}→${tAfter.toFixed(0)}`);
  await slider.fill("20");
  await page.waitForTimeout(500);
  const tSeek = await page.evaluate(() => window.__game.time);
  check("slider seek to 20s", Math.abs(tSeek - 20) < 4, `t=${tSeek.toFixed(1)}`);
  await page.locator("button[title='Play/pause']").click();
  const tP1 = await page.evaluate(() => window.__game.time);
  await page.waitForTimeout(1200);
  const tP2 = await page.evaluate(() => window.__game.time);
  check("pause holds replay time", Math.abs(tP2 - tP1) < 0.5, `${tP1.toFixed(1)}→${tP2.toFixed(1)}`);
  await page.locator("button[title='Play/pause']").click();
  await page.screenshot({ path: join(SHOTS, "p8-3-replay.png") });
  await page.locator("button[title='Exit replay']").click();
  await page.waitForTimeout(600);
  check(
    "exit replay returns to menu",
    (await page.evaluate(() => window.__game.phase)) === "menu",
  );
}

// ── campaign mission flow ───────────────────────────────────────────────────
await page.locator("button", { hasText: "Campaign" }).click();
await page.waitForTimeout(400);
check(
  "mission list shows mission I",
  await page.locator("text=I — The Founding").first().isVisible(),
);
await page.screenshot({ path: join(SHOTS, "p8-1-campaign.png") });
await page.locator("text=BEGIN MISSION").click();
await page.waitForTimeout(1200);
check(
  "mission objectives panel visible",
  (await page.locator("text=I — The Founding").first().isVisible()) &&
    (await page.locator("text=Build 2 Houses").count()) >= 1,
);
check(
  "campaign mode active",
  (await page.evaluate(() => window.__game.cfg.mode)) === "campaign",
);
await page.screenshot({ path: join(SHOTS, "p8-2-mission.png") });
// leave the mission for subsequent steps
await page.evaluate(() => {
  window.__game.exitReplay();
});

// Free the accumulated heap (soak match, replays, campaign, FPS probes)
// before the extra-context sections — 1 GiB cgroup, see relaunchMain().
await relaunchMain();

// ── touch controls (separate touch context) ─────────────────────────────────
{
  const ctx2 = await browser.newContext({
    hasTouch: true,
    viewport: { width: 480, height: 800 },
    isMobile: true,
  });
  await ctx2.addInitScript(FORCE_2D);
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on("pageerror", (e) => errs2.push(e.message));
  await p2.goto("http://localhost:4179/", { waitUntil: "networkidle" });
  await p2.waitForTimeout(900);
  await p2.locator("text=BEGIN MATCH").click();
  await p2.waitForTimeout(1000);
  const pt = await p2.evaluate(() => {
    const g = window.__game;
    const v = g.teamUnits(0, "villager")[0];
    const s2 = g.worldToScreen(v.x, v.y);
    return { x: s2.x, y: s2.y };
  });
  await p2.touchscreen.tap(pt.x, pt.y);
  await p2.waitForTimeout(400);
  const selCount = await p2.evaluate(() => window.__game.selUnits().length);
  check("touch tap selects villager", selCount === 1, `sel=${selCount}`);
  // pinch zoom via raw CDP touch events (playwright's touchscreen can't pinch)
  const cdp2 = await ctx2.newCDPSession(p2);
  const zPinch0 = await p2.evaluate(() => window.__game.zoomTarget);
  await cdp2.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 200, y: 360, id: 1 },
      { x: 280, y: 360, id: 2 },
    ],
  });
  await cdp2.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 160, y: 360, id: 1 },
      { x: 320, y: 360, id: 2 },
    ],
  });
  await cdp2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await p2.waitForTimeout(200);
  const zPinch1 = await p2.evaluate(() => window.__game.zoomTarget);
  check("touch pinch spreads → zoom in", zPinch1 > zPinch0 * 1.1, `${zPinch0.toFixed(2)}→${zPinch1.toFixed(2)}`);
  await cdp2.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 140, y: 360, id: 1 },
      { x: 340, y: 360, id: 2 },
    ],
  });
  await cdp2.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 210, y: 360, id: 1 },
      { x: 270, y: 360, id: 2 },
    ],
  });
  await cdp2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await p2.waitForTimeout(200);
  const zPinch2 = await p2.evaluate(() => window.__game.zoomTarget);
  check("touch pinch closes → zoom out", zPinch2 < zPinch1 * 0.95, `${zPinch1.toFixed(2)}→${zPinch2.toFixed(2)}`);
  check("no touch page errors", errs2.length === 0, errs2.slice(0, 2).join("|"));
  await p2.screenshot({ path: join(SHOTS, "p8-4-mobile.png") });
  await ctx2.close();
}

// ── HUD auto-hide (default mode) + camera/input polish ──────────────────────
console.log("\n[HUD auto-hide + camera]");
{
        const errsH = [];
  page.on("pageerror", (e) => errsH.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errsH.push("console: " + m.text().slice(0, 120));
  });
  // this section reuses the shared page (a second live renderer OOMs the
  // 1 GiB sandbox cgroup), so switch its stored HUD mode to the default "auto".
  // A second init script runs after FORCE_2D on every navigation of this page.
  await page.addInitScript(() => {
    try {
      const raw = localStorage.getItem("castle-dominion-settings-v1");
      const cur = raw ? JSON.parse(raw) : {};
      cur.hudMode = "auto";
      cur.tutorial = false;
      localStorage.setItem("castle-dominion-settings-v1", JSON.stringify(cur));
    } catch { /* ignore */ }
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.locator("text=BEGIN MATCH").click();
  await page.waitForTimeout(1600);

  // auto-collapse: compact top bar + edge rails only; big panels hidden
  check("top status bar visible", await page.locator('[data-testid="hud-topbar"]').isVisible());
  const topH = await page.evaluate(
    () => document.querySelector('[data-testid="hud-topbar"]').getBoundingClientRect().height,
  );
  check("top bar is a compact strip (≤64px)", topH > 0 && topH <= 64, `${Math.round(topH)}px`);
  check(
    "build palette auto-collapsed to icon rail",
    !(await page.locator('[aria-label="Build menu"]').isVisible()) &&
      (await page.locator('[aria-label="Build quick rail"]').isVisible()),
  );
  check(
    "minimap compact by default (<110px)",
    await page.evaluate(
      () => document.querySelector('[data-testid="minimap"] canvas').getBoundingClientRect().width < 110,
    ),
  );

  // canvas unobstructed: grid-sample elementFromPoint over the whole viewport
  const occ = await page.evaluate(() => {
    const g = window.__game;
    const W = innerWidth;
    const H = innerHeight;
    let hits = 0;
    let total = 0;
    const bad = [];
    for (let y = 10; y < H; y += 30) {
      for (let x = 10; x < W; x += 30) {
        const el = document.elementFromPoint(x, y);
        total++;
        if (el === g.canvas) { hits++; continue; }
        // anything else must be a *visible* control (panel / button / input)
        if (!el || !el.closest(".panel, button, input, .btn"))
          bad.push(`${x},${y}:${el ? el.tagName + "." + String(el.className).slice(0, 20) : "null"}`);
      }
    }
    return { pct: +((hits / total) * 100).toFixed(1), bad: bad.slice(0, 5), nBad: bad.length };
  });
  check("≥85% of viewport samples hit the canvas directly", occ.pct >= 85, `${occ.pct}% canvas`);
  check("no invisible overlay blocks input", occ.nBad === 0, occ.bad.join(" "));
  const midHit = await page.evaluate(
    () =>
      document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2)) ===
      window.__game.canvas,
  );
  check("viewport center is canvas (clickable)", midHit);

  // hover a rail → drawer expands; leave → auto-collapses
  await page.hover('[aria-label="Build quick rail"]');
  await page.waitForTimeout(350);
  check("hover expands build drawer", await page.locator('[aria-label="Build menu"]').isVisible());
  await page.mouse.move(700, 300);
  await page.waitForTimeout(650);
  check(
    "leaving collapses build drawer (auto-hide)",
    !(await page.locator('[aria-label="Build menu"]').isVisible()),
  );

  // click a chip → pinned drawer; click ✕ → collapses
  await page.locator('[aria-label="Expand Popularity"]').click();
  await page.waitForTimeout(250);
  check(
    "click pins popularity drawer open",
    await page.locator('[aria-label="Popularity and kingdom policy"]').isVisible(),
  );
  await page.locator('[aria-label="Collapse Popularity"]').click();
  await page.waitForTimeout(250);
  check(
    "unpin collapses popularity drawer",
    !(await page.locator('[aria-label="Popularity and kingdom policy"]').isVisible()),
  );

  // minimap pin → full size
  await page.locator('[data-testid="minimap-pin"]').click();
  await page.waitForTimeout(400);
  const mmBig = await page.evaluate(
    () => document.querySelector('[data-testid="minimap"] canvas').getBoundingClientRect().width,
  );
  check("minimap pin expands to full size", mmBig > 150, `${Math.round(mmBig)}px`);
  await page.screenshot({ path: join(SHOTS, "p11-2-hud-expanded.png") });
  await page.locator('[data-testid="minimap-pin"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, "p11-1-hud-auto.png") });

  // ── camera: wheel zoom, +/- buttons & keys, dblclick focus, middle-drag pan
  const camState = () =>
    page.evaluate(() => {
      const g = window.__game;
      return { zoom: g.cam.zoom, zt: g.zoomTarget, x: g.cam.x, y: g.cam.y };
    });
  await page.mouse.move(720, 430);
  const cA = await camState();
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(450);
  const cB = await camState();
  check("wheel down zooms out", cB.zt < cA.zt * 0.97, `${cA.zt.toFixed(2)}→${cB.zt.toFixed(2)}`);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(450);
  const cC = await camState();
  check("wheel up zooms in", cC.zt > cB.zt * 1.03, `${cB.zt.toFixed(2)}→${cC.zt.toFixed(2)}`);

  await page.locator('[aria-label="Zoom in"]').click();
  await page.waitForTimeout(200);
  const cD = await camState();
  check("+ button zooms in", cD.zt > cC.zt * 1.05, `${cC.zt.toFixed(2)}→${cD.zt.toFixed(2)}`);
  await page.locator('[aria-label="Zoom out"]').click();
  await page.locator('[aria-label="Zoom out"]').click();
  await page.waitForTimeout(200);
  const cE = await camState();
  check("− button zooms out", cE.zt < cD.zt * 0.95, `${cD.zt.toFixed(2)}→${cE.zt.toFixed(2)}`);

  // double-click glides the camera to the clicked world point
  // (target is pre-clamped into the region the camera can actually reach)
  const dbl = await page.evaluate(() => {
    const g = window.__game;
    const hw = g.viewW / 2 / g.cam.zoom;
    const hh = g.viewH / 2 / g.cam.zoom;
    const ww = g.grid.w * 32;
    const wh = g.grid.h * 32;
    const tx = ww / 2 < hw ? ww / 2 : Math.max(hw, Math.min(ww - hw, g.cam.x + 240));
    const ty = wh / 2 < hh ? wh / 2 : Math.max(hh, Math.min(wh - hh, g.cam.y - 200));
    const s = g.worldToScreen(tx, ty);
    return { sx: Math.round(s.x), sy: Math.round(s.y), wx: tx, wy: ty };
  });
  check(
    "dblclick target is on-screen",
    dbl.sx > 40 && dbl.sx < 1400 && dbl.sy > 80 && dbl.sy < 820,
    JSON.stringify(dbl),
  );
  await page.mouse.dblclick(dbl.sx, dbl.sy);
  await page.waitForTimeout(1400);
  const cF = await camState();
  const dblDist = Math.hypot(cF.x - dbl.wx, cF.y - dbl.wy);
  check("double-click focuses camera on point", dblDist < 48, `d=${Math.round(dblDist)}px`);

  // middle-drag pan
  const cG0 = await camState();
  await page.mouse.move(720, 430);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(850, 430, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  const cG = await camState();
  check("middle-drag pans camera", cG.x < cG0.x - 50, `dx=${Math.round(cG.x - cG0.x)}`);

  // Home = fit kingdom
  await page.keyboard.press("Home");
  await page.waitForTimeout(1800);
  const cH = await camState();
  const mapInfo = await page.evaluate(() => ({
    w: window.__game.grid.w * 32,
    h: window.__game.grid.h * 32,
    vw: window.__game.viewW,
    vh: window.__game.viewH,
  }));
  const fitZ = Math.min(mapInfo.vw / mapInfo.w, mapInfo.vh / mapInfo.h);
  check("Home zooms out to fit-kingdom scale", Math.abs(cH.zt - Math.max(0.25, fitZ)) < 0.03, `zt=${cH.zt.toFixed(2)} fit=${fitZ.toFixed(2)}`);
  check(
    "Home centers the kingdom",
    Math.abs(cH.x - mapInfo.w / 2) < 40 && Math.abs(cH.y - mapInfo.h / 2) < 40,
    `cam=${Math.round(cH.x)},${Math.round(cH.y)} center=${mapInfo.w / 2},${mapInfo.h / 2}`,
  );

  // keyboard +/- accessibility fallback
  const cI0 = await camState();
  await page.keyboard.press("=");
  await page.waitForTimeout(350);
  const cI = await camState();
  check("+ key zooms in", cI.zt > cI0.zt * 1.05, `${cI0.zt.toFixed(2)}→${cI.zt.toFixed(2)}`);
  await page.keyboard.press("-");
  await page.waitForTimeout(350);

  // ── cinematic mode (F1)
  await page.keyboard.press("F1");
  await page.waitForTimeout(350);
  check(
    "F1 hides HUD + shows letterbox",
    !(await page.locator('[data-testid="hud-topbar"]').isVisible()) &&
      (await page.locator('[data-testid="cine-bars"]').isVisible()),
  );
  const cineMid = await page.evaluate(
    () =>
      document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2)) ===
      window.__game.canvas,
  );
  check("cinematic: canvas fully clickable", cineMid);
  const cJ0 = await camState();
  await page.mouse.move(720, 430);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(450);
  const cJ = await camState();
  check("cinematic: camera controls still live", cJ.zt > cJ0.zt * 1.03, `${cJ0.zt.toFixed(2)}→${cJ.zt.toFixed(2)}`);
  await page.screenshot({ path: join(SHOTS, "p11-3-cinematic.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc exits cinematic mode", await page.locator('[data-testid="hud-topbar"]').isVisible());

  // ── fullscreen: real request or graceful fallback toast, never a crash
  await page.locator('[data-testid="btn-fullscreen"]').click();
  await page.waitForTimeout(1000);
  const fsState = await page.evaluate(() => ({
    fs: !!document.fullscreenElement,
    msgs: window.__game.getSnapshot().messages.map((m) => m.text),
  }));
  check(
    "fullscreen enters or falls back gracefully",
    fsState.fs || fsState.msgs.some((t) => /Fullscreen/i.test(t)),
    JSON.stringify(fsState).slice(0, 130),
  );
  if (fsState.fs) {
    await page.locator('[data-testid="btn-fullscreen"]').click();
    await page.waitForTimeout(700);
    check(
      "fullscreen toggles back off",
      await page.evaluate(() => !document.fullscreenElement),
    );
  }

  // ── Esc closes overlays; settings can switch HUD mode live
  await page.locator('[aria-label="Open settings"]').click();
  await page.waitForTimeout(300);
  check("settings overlay opens", await page.locator("text=SETTINGS").first().isVisible());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc closes settings overlay", !(await page.locator("text=SETTINGS").first().isVisible()));
  await page.locator('[aria-label="Open settings"]').click();
  await page.waitForTimeout(250);
  check("settings offers HUD modes", await page.locator("button", { hasText: /^Auto-hide$/ }).first().isVisible());
  await page.locator("button", { hasText: /^Full$/ }).first().click();
  await page.locator("button", { hasText: /^Done$/ }).click();
  await page.waitForTimeout(400);
  check(
    "HUD mode 'Full' expands every panel live",
    (await page.locator('[aria-label="Build menu"]').isVisible()) &&
      (await page.locator('[aria-label="Popularity and kingdom policy"]').isVisible()),
  );
  await page.screenshot({ path: join(SHOTS, "p11-4-hud-full.png") });

  check("no HUD/camera page errors", errsH.length === 0, errsH.slice(0, 3).join(" | "));
}

// ── XL map + Epic Army + adaptive quality (Checkpoint B) ────────────────────
console.log("\n[XL map + epic army + adaptive quality]");
// fresh browser: this section pushes 1200+ units through the software renderer
await relaunchMain();
{
  const errsB = [];
  page.on("pageerror", (e) => errsB.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errsB.push("console: " + m.text().slice(0, 140));
  });

  // both new options must be reachable from the setup screen, and optional
  check(
    "setup offers an XL map size",
    await page.locator("xpath=//button[normalize-space()='XL']").first().isVisible(),
  );
  check(
    "setup offers an Epic army option",
    await page.locator("text=Epic army").first().isVisible(),
  );
  const epicDefault = await page.evaluate(() => window.__game.cfg.epic);
  check("epic army is off by default", epicDefault === false, `epic=${epicDefault}`);
  await page.locator("xpath=//button[normalize-space()='XL']").first().click();
  await page
    .locator("xpath=//span[normalize-space()='Epic army']/following::button[normalize-space()='On'][1]")
    .click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, "p12-0-setup-xl-epic.png") });
  await page.locator("text=BEGIN MATCH").click();
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => {
    const g = window.__game;
    return {
      phase: g.phase, w: g.grid.w, h: g.grid.h, size: g.cfg.size, epic: g.cfg.epic,
      nodes: g.nodes.length, fog: g.visible[0].length, cap: g.popCap[0],
      tier: g.perf.state.tier, capTier: g.perf.state.cap, auto: g.perf.state.auto,
      reason: g.perf.state.reason, load: g.sceneLoad(),
    };
  });
  check(
    "XL match starts on a 160x160 map",
    info.phase === "playing" && info.w === 160 && info.h === 160 && info.size === "XL",
    `phase=${info.phase} map=${info.w}x${info.h} size=${info.size}`,
  );
  check(
    "epic army flag reached the engine",
    info.epic === true && info.cap >= 26,
    `epic=${info.epic} popCap=${info.cap}`,
  );
  check("XL map is resource rich", info.nodes > 900, `nodes=${info.nodes}`);
  check("XL fog buffers sized to the map", info.fog === 160 * 160, `len=${info.fog}`);
  check(
    "adaptive governor live and inside its ceiling",
    info.auto === true && info.tier >= 0 && info.tier <= info.capTier,
    `tier=${info.tier}/${info.capTier} load=${Math.round(info.load)} reason="${info.reason}"`,
  );

  // ── huge army: 600 per side meeting mid-map, camera on the fight
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
  await page.waitForTimeout(6500); // let the governor sample the load
  const heavy = await page.evaluate(() => {
    const g = window.__game;
    const q = g.perf.state;
    return {
      units: g.units.length, load: g.sceneLoad(), tier: q.tier, cap: q.cap,
      dpr: q.dprScale, partCap: q.particleCap, partDraw: q.particleDraw,
      detail: q.unitDetail, frameMs: g.perfFrameMs, tickMs: g.perfTickMs,
      reason: q.reason, particles: g.particles.length, fell: q.fellBackTo2D,
    };
  });
  const fpsEpic = await measureFps();
  console.log(
    `   informational: ${heavy.units} units on XL epic — ${fpsEpic} fps on headless ` +
      `SwiftShader (NOT a GPU number); frame ${heavy.frameMs.toFixed(1)} ms, sim ` +
      `${heavy.tickMs.toFixed(2)} ms/tick, tier ${heavy.tier}/${heavy.cap}, dpr ${heavy.dpr}, ` +
      `unit detail ${heavy.detail}, particles ${heavy.particles}/${heavy.partCap}`,
  );
  check(
    "epic battle keeps rendering on the software-GL floor",
    fpsEpic >= 2,
    `${fpsEpic} fps with ${heavy.units} units live`,
  );
  check(
    "governor state stays inside its bounds under epic load",
    heavy.tier >= 0 && heavy.tier <= heavy.cap && heavy.dpr >= 0.6 && heavy.dpr <= 1 &&
      heavy.partCap > 0 && heavy.partDraw >= heavy.partCap,
    `tier=${heavy.tier}/${heavy.cap} dpr=${heavy.dpr} particles=${heavy.partCap}/${heavy.partDraw} detail=${heavy.detail}`,
  );
  if (heavy.frameMs > 24) {
    check(
      "slow frames made the governor shed detail",
      heavy.tier < heavy.cap,
      `frame ${heavy.frameMs.toFixed(1)} ms → tier ${heavy.tier}/${heavy.cap}: ${heavy.reason}`,
    );
  } else {
    console.log(
      `   informational: frame ${heavy.frameMs.toFixed(1)} ms — no degradation needed (tier stays ${heavy.tier}/${heavy.cap})`,
    );
  }
  check(
    "scene load reflects the epic army",
    heavy.units > 800 && heavy.load > 900,
    `units=${heavy.units} load=${Math.round(heavy.load)} particles=${heavy.particles}`,
  );
  check(
    "2D renderer never auto-fell back on this run",
    heavy.fell === false && (await page.evaluate(() => window.__game.renderer.kind)) === "2d",
    `fellBackTo2D=${heavy.fell}`,
  );
  await page.screenshot({ path: join(SHOTS, "p12-1-huge-army.png") });

  // particle budget enforced in the live engine
  const pb = await page.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 40; i++)
      g.burst(g.cam.x + (i % 8) * 40, g.cam.y + ((i / 8) | 0) * 40, "fire", 40, "#ff9a3c", 60, 3, 4);
    return { n: g.particles.length, cap: g.perf.state.particleCap };
  });
  check(
    "live particle count is clamped to the adaptive budget",
    pb.n <= pb.cap,
    `${pb.n} particles, budget ${pb.cap}`,
  );

  // gameplay input must still work with an epic army on screen
  const hits = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    const pts = [[0.5, 0.5], [0.4, 0.35], [0.62, 0.66], [0.5, 0.22]];
    let ok = 0;
    for (const [fx, fy] of pts) {
      const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      if (el === c) ok++;
    }
    return { ok, n: pts.length };
  });
  check(
    "canvas still owns the viewport during an epic battle",
    hits.ok === hits.n,
    `${hits.ok}/${hits.n} probe points hit the canvas`,
  );

  const sel = await page.evaluate(() => {
    const g = window.__game;
    // anchor the drag box on the army centroid (the battle drifts, so a
    // camera-centred box catches a varying slice of it) and clamp to viewport
    const us = g.teamUnits(0).filter((u) => u.type !== "villager");
    const cx = us.reduce((s2, u) => s2 + u.x, 0) / Math.max(1, us.length);
    const cy = us.reduce((s2, u) => s2 + u.y, 0) / Math.max(1, us.length);
    const a = g.worldToScreen(cx - 300, cy - 220);
    const b = g.worldToScreen(cx + 300, cy + 220);
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return {
      x0: cl(a.x, 10, 1430), y0: cl(a.y, 90, 850),
      x1: cl(b.x, 10, 1430), y1: cl(b.y, 90, 850),
    };
  });
  await page.mouse.move(sel.x0, sel.y0);
  await page.mouse.down();
  await page.mouse.move(sel.x1, sel.y1, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const nSel = await page.evaluate(() => window.__game.selUnits().length);
  check("box select works with an epic army on screen", nSel > 20, `selected=${nSel}`);
  await page.mouse.click(Math.round((sel.x0 + sel.x1) / 2), Math.round(sel.y1 + 40), {
    button: "right",
  });
  await page.waitForTimeout(600);
  const ordered = await page.evaluate(() =>
    window.__game
      .selUnits()
      .filter((u) => ["move", "attackMove", "attack", "harvest", "build"].includes(u.state)).length,
  );
  check(
    "right-click order accepted under epic load",
    ordered > 0,
    `${ordered}/${nSel} selected units took the order`,
  );

  // the minimap must cover the whole XL map
  const mm = await page.evaluate(() => {
    const c = document.querySelector('canvas[aria-label^="Strategic minimap"]');
    if (!c || !c.width) return { ok: false };
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return { ok: true, w: c.width, h: c.height, litPct: +((100 * lit) / (d.length / 4)).toFixed(1) };
  });
  check("XL minimap is painted", mm.ok && mm.litPct > 20, JSON.stringify(mm));

  // fit-kingdom view of the whole XL map
  await page.keyboard.press("Home");
  await page.waitForTimeout(2000);
  const fit = await page.evaluate(() => ({
    z: +window.__game.cam.zoom.toFixed(3),
    units: window.__game.units.length,
    detail: window.__game.perf.state.unitDetail,
  }));
  check("Home fits the whole XL map", fit.z > 0 && fit.z < 0.6, `zoom=${fit.z} units=${fit.units}`);
  const fpsFit = await measureFps();
  console.log(`   informational: XL fit-kingdom view — ${fpsFit} fps on headless SwiftShader`);
  check("fit-kingdom view of XL keeps rendering", fpsFit >= 2, `${fpsFit} fps at zoom ${fit.z}`);
  await page.screenshot({ path: join(SHOTS, "p12-2-xl-fit.png") });

  // save/load round trip at XL epic
  const rt = await page.evaluate(() => {
    const g = window.__game;
    const before = g.stateHash();
    const json = g.serialize();
    const ok = g.loadFrom(json);
    return {
      before, after: g.stateHash(), ok,
      kb: Math.round(json.length / 1024), w: g.grid.w, epic: g.cfg.epic,
    };
  });
  check(
    "XL epic save/load round-trip preserves state",
    rt.ok && rt.before === rt.after && rt.w === 160 && rt.epic === true,
    `${rt.before} → ${rt.after} (${rt.kb} kB save, map ${rt.w}, epic ${rt.epic})`,
  );

  // ── replay determinism at XL epic (recordable commands only, no test cheats)
  const rec = await page.evaluate(() => {
    const g = window.__game;
    g.startMatch({
      ...g.cfg, mode: "skirmish", map: "verdant", size: "XL", epic: true,
      seed: 987654, lord: 0, difficulty: 1, missionId: -1, noRushMin: 0, timeLimitMin: 0,
    });
    const keep = g.buildings.find((b) => b.type === "keep" && b.team === 0);
    g.trainAt(keep, "villager");
    g.trainAt(keep, "villager");
    g.cmdMove(g.teamUnits(0, "villager"), keep.tx * 32 + 240, keep.ty * 32 + 200);
    for (let i = 0; i < 1800; i++) g.tick(1 / 30);
    const r = g.dumpReplay();
    return {
      h1: g.stateHash(), ticks: g.tickCount, saved: r,
      events: r ? r.events.length : -1, epic: r?.cfg?.epic, size: r?.cfg?.size,
    };
  });
  check(
    "XL epic replay records cfg + events",
    rec.events > 0 && rec.epic === true && rec.size === "XL",
    `events=${rec.events} size=${rec.size} epic=${rec.epic} ticks=${rec.ticks}`,
  );
  const back = await page.evaluate(
    (r) => {
      const g = window.__game;
      const ok = g.loadReplay(r);
      for (let i = 0; i < 1800; i++) g.tick(1 / 30);
      return { ok, h2: g.stateHash(), ticks: g.tickCount, replay: g.replayMode };
    },
    rec.saved,
  );
  check(
    "XL epic replay reproduces the recorded state hash",
    back.ok && back.h2 === rec.h1 && back.ticks === rec.ticks,
    `${rec.h1} vs ${back.h2} at tick ${back.ticks} (replayMode=${back.replay})`,
  );

  check("no XL/epic page errors", errsB.length === 0, errsB.slice(0, 3).join(" | "));
}

// ── multiplayer smoke: host + join across two pages ─────────────────────────
// fresh browser: the HUD/camera section left a live match heap behind, and
// this section runs three live processes (p1 + p2 + relay server) at once
await relaunchMain();
// kill stray mp-servers from previously crashed runs — they hold MP_PORT 8897
for (const pid of readdirSync("/proc")) {
  if (!/^\d+$/.test(pid) || pid === String(process.pid)) continue;
  try {
    const cl = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (cl.includes("src/net/server.ts")) process.kill(Number(pid), 9);
  } catch { /* gone or not ours */ }
}
// spawn the relay directly under node (--import tsx): a single process, so
// mpServer.kill() below really kills it (npx tsx leaves orphaned children)
const mpServer = spawn(process.execPath, ["--import", "tsx", "src/net/server.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, MP_PORT: "8897" },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 4000));
try {
  // reuse the main page as seat 0 (renderer memory is scarce under SwiftShader)
  const p1 = page;
  await p1.goto("http://localhost:4179/", { waitUntil: "networkidle" });
  await p1.setViewportSize({ width: 1000, height: 640 });
  await p1.waitForTimeout(700);
  await p1.locator("button", { hasText: "Multiplayer" }).click();
  await p1.getByLabel("Server address").fill("ws://localhost:8897");
  await p1.locator("button", { hasText: "Host game" }).click();
  await p1.waitForTimeout(1200);
  const code = (await p1.getByLabel("Room code").textContent()) ?? "";
  check("host shows room code", /^[A-Z2-9]{4}$/.test(code.trim()), code);

  let p2 = null;
  for (let attempt = 0; attempt < 2 && !p2; attempt++) {
    try {
      p2 = await browser.newPage({ viewport: { width: 900, height: 600 } });
      await p2.addInitScript(FORCE_2D);
      await p2.goto("http://localhost:4179/", { waitUntil: "networkidle" });
    } catch {
      if (p2) try { await p2.close(); } catch { /* ignore */ }
      p2 = null;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!p2) throw new Error("could not open seat-2 page");
  await p2.waitForTimeout(700);
  await p2.locator("button", { hasText: "Multiplayer" }).click();
  await p2.getByLabel("Server address").fill("ws://localhost:8897");
  await p2.locator('input[placeholder="CODE"]').fill(code.trim());
  await p2.locator("button", { hasText: "Join", exact: false }).first().click();
  await p1.waitForTimeout(1500);
  await p2.waitForTimeout(1500);
  const ph1 = await p1.evaluate(() => window.__game.phase);
  const ph2 = await p2.evaluate(() => window.__game.phase);
  check("both peers enter the match", ph1 === "playing" && ph2 === "playing", `${ph1}/${ph2}`);
  check("net badge visible", await p1.locator("text=⚡").first().isVisible());

  // seat0 issues a real intent through the relay: harvest wood
  await p1.evaluate(() => {
    const g = window.__game;
    g.selection.clear();
    for (const v of g.teamUnits(g.myTeam, "villager")) g.selection.add(v.id);
    const n = g.nearestNode("wood", 500, 2800, 30 * 32);
    if (n) g.rightClickCommand(n.tx * 32 + 16, n.ty * 32 + 16);
    g.selection.clear();
  });
  await p1.waitForTimeout(16000);
  const w1 = await p1.evaluate(() => Math.floor(window.__game.res[window.__game.myTeam].wood));
  const ticks1 = await p1.evaluate(() => window.__game.tickCount);
  const ticks2 = await p2.evaluate(() => window.__game.tickCount);
  const w2 = await p2.evaluate(() => Math.floor(window.__game.res[window.__game.myTeam].wood));
  check("relayed intent produces income on host", w1 > 260, `wood=${w1}`);
  check("peers stay tick-synced", Math.abs(ticks1 - ticks2) < 90, `${ticks1} vs ${ticks2}`);
  check("no desync toast", (await p1.locator("text=desync").count()) === 0);
  // seat1 sees its own (untouched) wood unchanged → intents are seat-scoped
  check("seat-scoped economies", w2 === 260 || w2 < w1, `w2=${w2}`);
  await p1.screenshot({ path: join(SHOTS, "p9-1-multiplayer.png") });
  await p2.close();
} finally {
  mpServer.kill("SIGKILL");
}

// offline fallback: unreachable server must degrade gracefully
{
  const p3 = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await p3.addInitScript(FORCE_2D);
  await p3.goto("http://localhost:4179/", { waitUntil: "networkidle" });
  await p3.waitForTimeout(600);
  await p3.locator("button", { hasText: "Multiplayer" }).click();
  await p3.getByLabel("Server address").fill("ws://localhost:9");
  await p3.locator("button", { hasText: "Host game" }).click();
  await p3.waitForTimeout(2500);
  const status = (await p3.getByLabel("Multiplayer status").textContent()) ?? "";
  check(
    "offline fallback message",
    status.includes("Could not reach server"),
    status.slice(0, 60),
  );
  await p3.close();
}

// ── console cleanliness ──────────────────────────────────────────────────────
const realErrors = consoleErrors.filter(
  (e) =>
    !e.includes("favicon") &&
    !e.includes("404") &&
    !e.includes("WebSocket"), // expected handled failure in the offline-fallback check
);
check("no console errors", realErrors.length === 0, realErrors.slice(0, 4).join(" | "));

// ── FPS sample (clean skirmish session) ─────────────────────────────────────
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.locator("text=BEGIN MATCH").click();
await page.waitForTimeout(1200);
const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => {
        n++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
        else resolve(Math.round((n * 1000) / (performance.now() - t0)));
      };
      requestAnimationFrame(tick);
    }),
);
check(
  "clean skirmish renders at software-GL floor",
  fps >= 25,
  `${fps} fps (SwiftShader floor; see profiler for GPU hardware numbers)`,
);

// ── 3D renderer + GPU profiler (SwiftShader = software GL; numbers informational) ──
console.log("\n[3D renderer + profiler]");
{
  const ctx3d = await browser.newContext({ viewport: { width: 1000, height: 620 } });
  await ctx3d.addInitScript(() => {
    try {
      const raw = localStorage.getItem("castle-dominion-settings-v1");
      const cur = raw ? JSON.parse(raw) : {};
      cur.renderer = "auto";
      cur.quality = 0; // software GL: keep the 3D section affordable
      cur.qualityAuto = false; // pinned: this section tests the 3D renderer,
      //                         the adaptive ladder is tested separately below
      cur.shadows = false;
      localStorage.setItem("castle-dominion-settings-v1", JSON.stringify(cur));
    } catch { /* ignore */ }
  });
  const p3 = await ctx3d.newPage();
  const errs3d = [];
  p3.on("pageerror", (e) => errs3d.push("pageerror: " + e.message));
  p3.on("console", (m) => {
    if (m.type() === "error") errs3d.push("console: " + m.text().slice(0, 120));
  });
  await p3.goto("http://localhost:4179/", { waitUntil: "networkidle" });
  await p3.waitForTimeout(1500);
  const kind = await p3.evaluate(() => window.__game?.renderer?.kind ?? "?");
  check("auto picks 3D renderer under WebGL", kind === "3d", "kind=" + kind);
  await p3.locator("text=BEGIN MATCH").click();
  await p3.waitForTimeout(4000);
  const snap3 = await p3.evaluate(() => ({
    phase: window.__game.getSnapshot().phase,
    units: window.__game.units.length,
    time: window.__game.time,
  }));
  check("3D skirmish runs", snap3.phase === "playing" && snap3.units > 0, JSON.stringify(snap3));
  // camera rotate
  await p3.keyboard.press("z");
  await p3.waitForTimeout(500);
  await p3.keyboard.press("x");
  await p3.waitForTimeout(500);
  check("3D rotate (Z/X) no errors", errs3d.length === 0, errs3d.slice(0, 2).join(" | "));
  // orders still work under 3D (sim advances slower under software GL — allow time)
  await p3.evaluate(() => {
    const g = window.__game;
    const keep = g.buildings.find((b) => b.type === "keep" && b.team === g.myTeam);
    const sx = keep.tx * 32;
    const sy = keep.ty * 32;
    window.__t3d = { sx, sy };
    g.spawnUnit(g.myTeam, "militia", sx + 96, sy + 96);
    const u = g.units[g.units.length - 1];
    g.selection.clear();
    g.selection.add(u.id);
    g.rightClickCommand(sx + 288, sy + 288);
  });
  // advance sim deterministically (software GL runs far below realtime)
  await p3.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 240; i++) g.tick(1 / 60);
  });
  await p3.waitForTimeout(1200);
  const moved = await p3.evaluate(() => {
    const g = window.__game;
    const { sx, sy } = window.__t3d;
    const u = g.units[g.units.length - 1];
    return !!u && Math.hypot(u.x - (sx + 96), u.y - (sy + 96)) > 40;
  });
  check("3D unit responds to move order", moved);
  // profiler
  await p3.keyboard.press("F3");
  await p3.waitForTimeout(1600);
  const prof = await p3.evaluate(() => {
    const el = document.querySelector('[aria-label="Performance profiler"]');
    return { open: !!el, text: el ? el.innerText : "" };
  });
  check("F3 opens profiler", prof.open);
  check(
    "profiler shows fps/frame/tick/draw info",
    /FPS/.test(prof.text) && /Frame ms/.test(prof.text) && /Tick ms/.test(prof.text) && /Draw calls/.test(prof.text),
    prof.text.replace(/\n/g, " ").slice(0, 140),
  );
  // benchmark
  await p3.getByRole("button", { name: /Run 4s GPU benchmark/i }).click();
  await p3.waitForTimeout(5500);
  const bench = await p3.evaluate(() => {
    const el = document.querySelector('[aria-label="Performance profiler"]');
    const raw = localStorage.getItem("castle-dominion-gpu-bench");
    return { text: el ? el.innerText : "", raw };
  });
  check(
    "benchmark records device result + recommendation",
    !!bench.raw && /Last device benchmark/.test(bench.text),
    String(bench.raw).slice(0, 120),
  );
  // software fps (informational only — never a GPU claim)
  const fps3d = await p3.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
          else resolve(Math.round((n * 1000) / (performance.now() - t0)));
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log("   informational 3D fps (headless SwiftShader, NOT a GPU number): " + fps3d);
  check("3D renders at software floor", fps3d >= 2, fps3d + " fps on SwiftShader");
  check("no 3D runtime errors", errs3d.length === 0, errs3d.slice(0, 3).join(" | "));
  await p3.screenshot({ path: join(SHOTS, "p9-10-3d-battle.png") });
  await p3.evaluate(() => { window.__game.settings.dayNight = true; });

  // ── XL + epic army under the 3D renderer (instancing capacity must scale)
  const xl3d = await p3.evaluate(() => {
    const g = window.__game;
    g.startMatch({
      ...g.cfg, mode: "skirmish", map: "verdant", size: "XL", epic: true,
      seed: 555111, lord: 0, difficulty: 1, missionId: -1, noRushMin: 0, timeLimitMin: 0,
    });
    const T = 32;
    // spawn on the flattened dry ground around the player keep: mid-map on a
    // random XL seed can be a lake, and 3D units standing in water render
    // underneath the water sheet (2D has no depth, 3D does)
    const k = g.buildings.find((b) => b.type === "keep" && b.team === 0);
    const mx = (k.tx + 2.5) * T;
    const my = (k.ty + k.h + 6) * T;
    const types = ["militia", "spearman", "archer", "knight"];
    // pick each team's column offset so its 14x7 spawn rectangle is fully dry
    // ground — units standing in a lake would render knee-deep in the 3D
    // water sheet and read as a pathing bug in the screenshot
    const dryOff = (sign) => {
      for (const off of [12, 16, 20, 8, 24, 28, 32]) {
        const bx = Math.round(mx / T) + sign * off;
        let dry = true;
        for (let dx = -7; dx < 7 && dry; dx++)
          for (let dy = -3; dy <= 3 && dry; dy++)
            if (g.grid.isWater(bx + dx, Math.round(my / T) + dy)) dry = false;
        if (dry) return sign * off;
      }
      return sign * 12;
    };
    const offs = [dryOff(-1), dryOff(1)];
    for (let t = 0; t < 2; t++)
      for (let i = 0; i < 90; i++)
        g.spawnUnit(t, types[i % 4], mx + offs[t] * T + ((i % 14) - 7) * T, my + (Math.floor(i / 14) - 3) * T);
    g.cmdAttackMove(g.teamUnits(1), mx - 6 * T, my);
    g.cam.x = mx; g.cam.y = my; g.camTarget = { x: mx, y: my };
    g.cam.zoom = 1.1; g.zoomTarget = 1.1; g.clampCam();
    return { w: g.grid.w, epic: g.cfg.epic, units: g.units.length };
  });
  await p3.waitForTimeout(3500);
  const st3d = await p3.evaluate(() => {
    const g = window.__game;
    const s = g.renderer.kind === "3d" ? g.renderer.stats() : null;
    return { kind: g.renderer.kind, stats: s, units: g.units.length, tier: g.perf.state.tier };
  });
  check(
    "3D renderer handles an XL epic match",
    xl3d.w === 160 && xl3d.epic === true && st3d.kind === "3d" && !!st3d.stats && st3d.stats.instances > 0,
    `map=${xl3d.w} units=${st3d.units} renderer=${st3d.kind} instances=${st3d.stats ? st3d.stats.instances : "-"} calls=${st3d.stats ? st3d.stats.calls : "-"} tris=${st3d.stats ? st3d.stats.tris : "-"}`,
  );
  // regression guard: three caches InstancedMesh.boundingSphere at the first
  // frustum check, which culled the whole unit set against a stale sphere from
  // the menu preview (armies invisible on XL). Dynamic sets skip culling now.
  const cull = await p3.evaluate(() => {
    const r = window.__game.renderer;
    return r.kind === "3d" ? r.uParts.map((m) => ({ c: m.count, f: m.frustumCulled })) : null;
  });
  check(
    "3D unit instance sets render (not frustum-culled away)",
    !!cull && cull[0].c > 0 && cull.every((u) => !u.f),
    cull ? `counts=${cull.map((u) => u.c).join("/")} culled=${cull.some((u) => u.f)}` : "n/a",
  );
  const fps3dxl = await p3.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
          else resolve(Math.round((n * 1000) / (performance.now() - t0)));
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log("   informational 3D XL epic fps (headless SwiftShader, NOT a GPU number): " + fps3dxl);
  check("3D XL epic renders at the software floor", fps3dxl >= 1, fps3dxl + " fps");
  check("no 3D XL/epic runtime errors", errs3d.length === 0, errs3d.slice(0, 3).join(" | "));
  await p3.keyboard.press("Escape"); // close the profiler for a clean shot
  await p3.waitForTimeout(700);
  await p3.screenshot({ path: join(SHOTS, "p12-3-3d-xl-epic.png") });
  await ctx3d.close();
}

// ── adaptive ladder: automatic 3D → 2D fallback under sustained load ────────
// Headless SwiftShader is deliberately far below any real GPU, which makes it a
// convenient way to prove the last rung of the ladder fires and recovers input.
console.log("\n[adaptive quality: automatic 3D→2D fallback]");
{
  const ctxFb = await browser.newContext({ viewport: { width: 900, height: 560 } });
  await ctxFb.addInitScript(() => {
    try {
      const raw = localStorage.getItem("castle-dominion-settings-v1");
      const cur = raw ? JSON.parse(raw) : {};
      cur.renderer = "auto";
      cur.quality = 2; // ceiling tier 3, so the ladder has somewhere to fall
      cur.qualityAuto = true;
      cur.shadows = true;
      localStorage.setItem("castle-dominion-settings-v1", JSON.stringify(cur));
    } catch { /* ignore */ }
  });
  const p4 = await ctxFb.newPage();
  const errsFb = [];
  p4.on("pageerror", (e) => errsFb.push("pageerror: " + e.message));
  p4.on("console", (m) => { if (m.type() === "error") errsFb.push("console: " + m.text().slice(0, 140)); });
  await p4.goto("http://localhost:4179/", { waitUntil: "networkidle" });
  await p4.waitForTimeout(1500);
  const kind0 = await p4.evaluate(() => window.__game?.renderer?.kind ?? "?");
  check("fallback test starts on the 3D renderer", kind0 === "3d", "kind=" + kind0);
  await p4.locator("text=BEGIN MATCH").click();
  await p4.waitForTimeout(1500);
  // give the software rasteriser plenty to chew on
  await p4.evaluate(() => {
    const g = window.__game;
    const T = 32;
    const k = g.buildings.find((b) => b.type === "keep" && b.team === 0);
    for (let i = 0; i < 260; i++)
      g.spawnUnit(0, i % 2 ? "militia" : "archer", k.tx * T + (i % 20) * T, k.ty * T + 8 * T + Math.floor(i / 20) * T);
    for (let i = 0; i < 24; i++) g.burst(k.tx * T + i * 30, k.ty * T + 300, "fire", 30, "#ff9a3c", 60, 3, 5);
    g.paused = false;
  });
  // poll: the ladder needs ~3 downgrades (1.5 s cooldown each) + a 6 s hold
  let fb = null;
  for (let i = 0; i < 26; i++) {
    await p4.waitForTimeout(1500);
    fb = await p4.evaluate(() => {
      const g = window.__game;
      return {
        kind: g.renderer.kind, tier: g.perf.state.tier, cap: g.perf.state.cap,
        fell: g.perf.state.fellBackTo2D, frameMs: g.perfFrameMs, reason: g.perf.state.reason,
        dpr: g.perf.state.dprScale, phase: g.phase,
      };
    });
    if (fb.kind === "2d") break;
  }
  console.log(
    `   informational: fallback ladder under SwiftShader — tier ${fb.tier}/${fb.cap}, ` +
      `frame ${fb.frameMs.toFixed(1)} ms, renderer ${fb.kind}, reason "${fb.reason}"`,
  );
  check(
    "governor degraded stepwise before falling back",
    fb.tier === 0 || fb.kind === "2d",
    `tier=${fb.tier}/${fb.cap} renderer=${fb.kind}`,
  );
  check(
    "sustained software-GL load triggers the one-shot 3D→2D fallback",
    fb.kind === "2d" && fb.fell === true,
    `renderer=${fb.kind} fellBackTo2D=${fb.fell}`,
  );
  check("match survives the renderer switch", fb.phase === "playing", `phase=${fb.phase}`);
  // input must still work after the switch: the canvas element was *replaced*,
  // so listeners have to be bound to the new one
  const hitFb = await p4.evaluate(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width * 0.5, r.top + r.height * 0.5) === c;
  });
  check("canvas still clickable after the automatic fallback", hitFb, `centre hit=${hitFb}`);
  const target = await p4.evaluate(() => {
    const g = window.__game;
    const u = g.teamUnits(0)[0];
    if (!u) return null;
    g.camTarget = { x: u.x, y: u.y };
    g.cam.x = u.x; g.cam.y = u.y; g.clampCam();
    const s = g.worldToScreen(u.x, u.y);
    return { id: u.id, x: Math.round(s.x), y: Math.round(s.y), state: u.state };
  });
  if (target) {
    await p4.mouse.click(target.x, target.y);
    await p4.waitForTimeout(300);
    const nSelFb = await p4.evaluate(() => window.__game.selUnits().length);
    await p4.mouse.click(Math.min(880, target.x + 120), Math.min(540, target.y + 90), {
      button: "right",
    });
    await p4.waitForTimeout(600);
    const movedFb = await p4.evaluate(
      (id) => {
        const g = window.__game;
        const u = g.units.find((x) => x.id === id);
        return u ? ["move", "attackMove", "attack", "harvest", "build"].includes(u.state) : false;
      },
      target.id,
    );
    check(
      "click-select + right-click order work after the fallback",
      nSelFb > 0 && movedFb,
      `selected=${nSelFb} unit ${target.id} took the order=${movedFb}`,
    );
  } else {
    check("click-select + right-click order work after the fallback", false, "no unit to select");
  }
  check("no errors during the automatic fallback", errsFb.length === 0, errsFb.slice(0, 3).join(" | "));
  await p4.screenshot({ path: join(SHOTS, "p12-4-auto-fallback-2d.png") });
  await ctxFb.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? "\nBROWSER TEST PASSED" : `\n${failures} BROWSER CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
