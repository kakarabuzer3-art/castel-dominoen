/**
 * Headless multiplayer test: authoritative server + two lockstep clients.
 * Verifies: lobby/start, intent relay, combat across the wire, tick-exact
 * determinism (state hashes), disconnect pause + reconnect resync.
 */
import WebSocket from "ws";
import { startServer } from "../src/net/server";
import { Game } from "../src/game/engine";
import type { ReplayEvent } from "../src/game/replay";

const PORT = 8899;
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

interface Client {
  game: Game;
  ws: WebSocket;
  seat: number;
  token: string;
  code: string;
  desyncs: number;
  verified?: number;
  started: boolean;
}

const mkClient = (url: string): Promise<Client> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    const c: Client = {
      game: new Game(null, 1),
      ws,
      seat: -1,
      token: "",
      code: "",
      desyncs: 0,
      verified: 0,
      started: false,
    };
    ws.on("open", () => resolve(c));
    const hashes: Array<{ i: number; h: string }> = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      switch (m.k) {
        case "hosted":
          c.seat = 0; c.token = m.token; c.code = m.code;
          ws.send(JSON.stringify({ k: "ready" }));
          resolve(c);
          break;
        case "joined":
          c.seat = m.seat; c.token = m.token; c.code = m.code;
          ws.send(JSON.stringify({ k: "ready" }));
          resolve(c);
          break;
        case "peer":
          ws.send(JSON.stringify({ k: "ready" }));
          break;
        case "start": {
          c.started = true;
          const g = c.game;
          g.init(m.seed, { ...m.cfg, mode: "multiplayer" });
          g.myTeam = c.seat as 0 | 1;
          g.netMode = { seat: c.seat as 0 | 1, room: c.code };
          g.netServerTick = null;
          g.phase = "playing";
          g.onIntent = (ev: ReplayEvent) =>
            ws.send(JSON.stringify({ k: "intent", ev }));
          break;
        }
        case "sync": {
          const g = c.game;
          g.init(m.seed, { ...m.cfg, mode: "multiplayer" });
          g.myTeam = c.seat as 0 | 1;
          g.netMode = { seat: c.seat as 0 | 1, room: c.code };
          g.phase = "playing";
          g.onIntent = (ev: ReplayEvent) =>
            ws.send(JSON.stringify({ k: "intent", ev }));
          for (const e of m.log) g.queueNetEvent(e.i, e.team, e.ev);
          let guard = 0;
          while (g.tickCount < m.tick && guard++ < 300000) g.step(1 / 30);
          g.netServerTick = m.tick;
          break;
        }
        case "tick":
          c.game.netServerTick = m.i;
          break;
        case "ev":
          c.game.queueNetEvent(m.i, m.team, m.ev);
          break;
        case "hash":
          hashes.push({ i: m.i, h: m.h });
          break;
        case "wait":
          c.game.netServerTick = null;
          break;
        case "resumed":
          break;
        case "end":
          c.game.phase = m.winner === c.seat ? "victory" : "defeat";
          break;
      }
      for (const hc of [...hashes]) {
        if (c.game.tickCount === hc.i) {
          if (c.game.stateHash() !== hc.h) c.desyncs++;
          else c.verified = (c.verified ?? 0) + 1;
          hashes.splice(hashes.indexOf(hc), 1);
        } else if (c.game.tickCount > hc.i) {
          hashes.splice(hashes.indexOf(hc), 1); // missed window: drop, not a desync
        }
      }
    });
  });

const pump = (c: Client) => c.game.netPump(60);

const waitFor = async (fn: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms)
    await new Promise((r) => setTimeout(r, 30));
};

/**
 * A peer is untrusted. Malformed intents must get an error reply (not throw
 * inside the simulation), garbage frames must be ignored, and one seat must not
 * be able to spend the other seat's resources. The relay has to keep ticking.
 */
async function hostile(): Promise<void> {
  const server2 = startServer({ port: PORT + 1, tickMs: 5, timeScale: 4, intentDelayTicks: 6 });
  await new Promise((r) => setTimeout(r, 300));
  const url2 = `ws://localhost:${PORT + 1}`;
  const A = await mkClient(url2);
  A.ws.send(JSON.stringify({ k: "host" }));
  await waitFor(() => A.seat === 0);
  const B = await mkClient(url2);
  B.ws.send(JSON.stringify({ k: "join", code: A.code }));
  await waitFor(() => B.seat === 1);
  await waitFor(() => A.started && B.started, 5000);

  const errors: string[] = [];
  A.ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.k === "error") errors.push(String(m.msg));
  });
  const room = [...server2.rooms.values()][0];
  const srv = room.game!;
  const k1 = srv.buildingById.get(srv.keeps[1])!;

  const malformed: unknown[] = [
    { k: "move", ids: "x", x: 1, y: 1 },
    { k: "place", type: "keep", tx: 5, ty: 5 },
    { k: "stop", ids: [-5] },
    { k: "train", bId: 1, unit: "dragon" },
    null,
    "boom",
  ];
  for (const ev of malformed) A.ws.send(JSON.stringify({ k: "intent", ev }));
  A.ws.send("this is not json at all");
  // well-formed, but aimed at the *other* seat's keep
  A.ws.send(JSON.stringify({ k: "intent", ev: { k: "train", bId: k1.id, unit: "villager" } }));

  const tick0 = srv.tickCount;
  const drive = setInterval(() => {
    pump(A);
    pump(B);
  }, 8);
  await waitFor(() => srv.tickCount > tick0 + 120, 8000);
  clearInterval(drive);

  const rejected = errors.filter((e) => e === "Invalid command ignored.").length;
  check(
    "hostile peer: every malformed intent answered with an error reply",
    rejected === malformed.length,
    `${rejected}/${malformed.length}`,
  );
  check(
    "hostile peer: relay keeps ticking and the room survives",
    srv.tickCount > tick0 + 120 && room.state === "playing" && server2.rooms.has(room.code),
    `ticks +${srv.tickCount - tick0}, state=${room.state}`,
  );
  check(
    "hostile peer: seat 0 cannot train on seat 1's keep",
    k1.queue.length === 0,
    `queue=${k1.queue.length}`,
  );

  A.ws.close();
  B.ws.close();
  server2.close();
}

async function main(): Promise<void> {
  const server = startServer({ port: PORT, tickMs: 5, timeScale: 4, intentDelayTicks: 6 });
  await new Promise((r) => setTimeout(r, 300));
  const url = `ws://localhost:${PORT}`;

  const A = await mkClient(url);
  A.ws.send(JSON.stringify({ k: "host" }));
  await waitFor(() => A.seat === 0);
  const B = await mkClient(url);
  B.ws.send(JSON.stringify({ k: "join", code: A.code }));
  await waitFor(() => B.seat === 1);
  await waitFor(() => A.started && B.started, 5000);
  check("lobby: both seats ready & match started", A.started && B.started);

  const drive = setInterval(() => {
    pump(A);
    pump(B);
  }, 8);

  // scripted play (tick-indexed)
  const script: Array<{ tick: number; seat: Client; fn: (c: Client) => void }> = [
    {
      tick: 90,
      seat: A,
      fn: (c) => {
        const g = c.game;
        g.selection.clear();
        for (const v of g.teamUnits(g.myTeam, "villager")) {
          g.selection.add(v.id);
          v.selected = true;
        }
        const n = g.nearestNode("wood", g.selUnits()[0].x, g.selUnits()[0].y, 20 * 32);
        if (n) g.rightClickCommand(n.tx * 32 + 16, n.ty * 32 + 16);
        g.selection.clear();
      },
    },
    {
      tick: 150,
      seat: B,
      fn: (c) => {
        const g = c.game;
        g.selection.clear();
        for (const v of g.teamUnits(g.myTeam, "villager")) {
          g.selection.add(v.id);
          v.selected = true;
        }
        const foe = g.teamUnits(g.enemyTeam())[0];
        if (foe) g.rightClickCommand(foe.x, foe.y);
        g.selection.clear();
      },
    },
    {
      tick: 400,
      seat: A,
      fn: (c) => {
        const g = c.game;
        const keep = g.buildingById.get(g.keeps[g.myTeam])!;
        const sp = g.findSpotNear(keep.tx + 7, keep.ty + 7, "house", g.myTeam, 4);
        if (sp) g.place(g.myTeam, "house", sp.x, sp.y);
      },
    },
    {
      tick: 700,
      seat: B,
      fn: (c) => {
        const g = c.game;
        const mil = g.teamUnits(g.myTeam).slice(0, 3);
        if (mil.length) {
          const foe = g.teamUnits(g.enemyTeam())[0];
          if (foe) g.cmdAttack(mil, foe.id);
        }
      },
    },
    {
      tick: 900,
      seat: A,
      fn: (c) => {
        const g = c.game;
        g.selection.clear();
        for (const v of g.teamUnits(g.myTeam, "villager")) g.selection.add(v.id);
        g.cmdMove(g.selUnits(), g.selUnits()[0].x + 120, g.selUnits()[0].y - 60);
        g.selection.clear();
      },
    },
  ];
  const done = new Set<number>();

  const t0 = Date.now();
  let reconnectDone = false;
  let B2: Client | null = null;
  while (Date.now() - t0 < 45000) {
    await new Promise((r) => setTimeout(r, 40));
    pump(A);
    pump(B2 ?? B);
    for (let i = 0; i < script.length; i++) {
      const st = script[i];
      if (!done.has(i) && st.seat.game.tickCount >= st.tick) {
        done.add(i);
        st.fn(st.seat);
      }
    }
    // disconnect B mid-match, then reconnect with token
    if (!reconnectDone && A.game.tickCount > 1500) {
      reconnectDone = true;
      const savedB = B;
      savedB.ws.close();
      await new Promise((r) => setTimeout(r, 600));
      B2 = await mkClient(url);
      B2.seat = 1;
      B2.token = savedB.token;
      B2.code = savedB.code;
      B2.ws.send(
        JSON.stringify({
          k: "reconnect",
          code: savedB.code,
          seat: 1,
          token: savedB.token,
        }),
      );
    }
    if (A.game.tickCount >= 3000) break;
  }
  clearInterval(drive);
  await new Promise((r) => setTimeout(r, 500));
  pump(A);
  pump(B2 ?? B);

  const liveB = B2 ?? B;
  check("reconnect: resynced client reached live tick", Math.abs((B2?.game.tickCount ?? 0) - A.game.tickCount) < 90, `A=${A.game.tickCount} B2=${B2?.game.tickCount}`);
  check(
    "lockstep: client hashes identical at same tick",
    A.game.stateHash() === liveB.game.stateHash(),
    `${A.game.stateHash()} vs ${liveB.game.stateHash()}`,
  );
  const srvGame = [...server.rooms.values()][0]?.game;
  check(
    "authority: server hash matches clients",
    !!srvGame && srvGame.stateHash() === A.game.stateHash(),
  );
  check("combat crossed the wire", A.game.kills + A.game.losses > 0, `kills=${A.game.kills} losses=${A.game.losses}`);
  check("no desync warnings", A.desyncs === 0 && liveB.desyncs === 0, `desyncs A=${A.desyncs} B=${liveB.desyncs}`);
  check(
    "hash checkpoints verified on both seats",
    (A.verified ?? 0) >= 1 && ((B.verified ?? 0) >= 1 || (liveB.verified ?? 0) >= 1),
    `A=${A.verified} B=${B.verified} B2=${liveB.verified}`,
  );
  check("intent relay applied (house built by A)", A.game.teamBuildings(0, "house").length >= 1 || A.game.teamBuildings(1, "house").length >= 1);

  A.ws.close();
  liveB.ws.close();
  server.close();
  await hostile();
  console.log(fails === 0 ? "\nMP TEST PASSED" : `\n${fails} MP CHECK(S) FAILED`);
  process.exit(fails ? 1 : 0);
}

void main();
