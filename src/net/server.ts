/**
 * Castle Dominion — lightweight authoritative multiplayer server.
 * Lockstep intent-relay: the server simulates the match headlessly and
 * schedules player intents on exact ticks; clients re-simulate deterministically.
 *
 * Run: npm run mp   (default port 8787, override: MP_PORT=9000)
 */
import { WebSocketServer, type WebSocket } from "ws";
import { pathToFileURL } from "node:url";
import { defaultMatchConfig, type MatchConfig } from "../game/constants";
import { Game } from "../game/engine";
import type { ReplayEvent } from "../game/replay";

export interface ServerOpts {
  port?: number;
  tickMs?: number;
  /** simulate faster than wall-clock (tests / fast-forward hosts) */
  timeScale?: number;
  intentDelayTicks?: number;
  onClose?: () => void;
}

interface Seat {
  ws: WebSocket | null;
  token: string;
  ready: boolean;
  lastSeen: number;
}

interface Room {
  code: string;
  seats: [Seat, Seat];
  state: "lobby" | "playing" | "ended";
  game: Game | null;
  cfg: MatchConfig | null;
  log: Array<{ i: number; team: 0 | 1; ev: ReplayEvent }>;
  timer: ReturnType<typeof setInterval> | null;
  winner: -1 | 0 | 1;
}

const rand = (n: number) => Math.floor(Math.random() * n);
const code4 = () =>
  Array.from({ length: 4 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[rand(31)]).join("");

export function startServer(opts: ServerOpts = {}): {
  close: () => void;
  rooms: Map<string, Room>;
} {
  const port = opts.port ?? Number(process.env.MP_PORT ?? 8787);
  const tickMs = opts.tickMs ?? 33;
  const timeScale = opts.timeScale ?? 1;
  const delayTicks = opts.intentDelayTicks ?? 8;
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ port });

  const send = (ws: WebSocket | null, msg: unknown) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (room: Room, msg: unknown) => {
    send(room.seats[0].ws, msg);
    send(room.seats[1].ws, msg);
  };

  const stopRoom = (room: Room) => {
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    rooms.delete(room.code);
  };

  const startMatch = (room: Room) => {
    const cfg = { ...defaultMatchConfig(), mode: "multiplayer" as const };
    room.cfg = cfg;
    const game = new Game(null, cfg.seed);
    game.init(cfg.seed, cfg);
    // authoritative instance: netMode keeps QoL auto-staffing symmetric
    game.netMode = { seat: 0, room: room.code };
    game.phase = "playing";
    room.game = game;
    room.state = "playing";
    room.log = [];
    broadcast(room, { k: "start", seed: cfg.seed, cfg });
    let acc = 0;
    room.timer = setInterval(() => {
      const g = room.game!;
      if (g.phase === "playing") {
        acc += (tickMs / 1000) * timeScale;
        let stepped = false;
        while (acc >= 1 / 30) {
          g.step(1 / 30);
          acc -= 1 / 30;
          stepped = true;
        }
        if (!stepped) return;
        broadcast(room, { k: "tick", i: g.tickCount });
        if (g.tickCount % 300 === 0)
          broadcast(room, { k: "hash", i: g.tickCount, h: g.stateHash() });
      } else if (room.state === "playing") {
        room.state = "ended";
        room.winner = g.phase === "victory" ? 0 : g.phase === "defeat" ? 1 : -1;
        broadcast(room, { k: "end", winner: room.winner });
        setTimeout(() => stopRoom(room), 30000);
      }
    }, tickMs);
  };

  const handleIntent = (room: Room, seat: 0 | 1, ev: ReplayEvent) => {
    const g = room.game;
    if (!g || room.state !== "playing") return;
    const i = g.tickCount + delayTicks;
    const entry = { i, team: seat, ev };
    room.log.push(entry);
    g.queueNetEvent(i, seat, ev);
    broadcast(room, { k: "ev", ...entry });
  };

  wss.on("connection", (ws) => {
    let room: Room | null = null;
    let seat: 0 | 1 | null = null;

    const detach = () => {
      if (!room || seat === null) return;
      room.seats[seat].ws = null;
      room.seats[seat].lastSeen = Date.now();
      if (room.state === "playing") {
        broadcast(room, { k: "wait", reason: "opponent disconnected" });
        if (room.timer) clearInterval(room.timer);
        room.timer = null;
        // give 60s to reconnect, then forfeit
        const rr = room;
        setTimeout(() => {
          if (rr.state === "playing" && !rr.seats[seat!].ws) {
            rr.winner = seat === 0 ? 1 : 0;
            rr.state = "ended";
            broadcast(rr, { k: "end", winner: rr.winner, forfeit: true });
            setTimeout(() => stopRoom(rr), 15000);
          }
        }, 60000);
      }
    };

    ws.on("close", detach);
    ws.on("error", detach);

    ws.on("message", (raw) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (m.k) {
        case "host": {
          const code = code4();
          room = {
            code,
            seats: [
              { ws, token: code4() + code4(), ready: false, lastSeen: 0 },
              { ws: null, token: "", ready: false, lastSeen: 0 },
            ],
            state: "lobby",
            game: null,
            cfg: null,
            log: [],
            timer: null,
            winner: -1,
          };
          seat = 0;
          rooms.set(code, room);
          send(ws, { k: "hosted", code, seat: 0, token: room.seats[0].token });
          break;
        }
        case "join": {
          const r = rooms.get(String(m.code ?? ""));
          if (!r || r.state !== "lobby") {
            send(ws, { k: "error", msg: "Room not found or already started." });
            return;
          }
          if (r.seats[1].ws) {
            send(ws, { k: "error", msg: "Room is full." });
            return;
          }
          room = r;
          seat = 1;
          r.seats[1].ws = ws;
          r.seats[1].token = code4() + code4();
          send(ws, { k: "joined", code: r.code, seat: 1, token: r.seats[1].token });
          send(r.seats[0].ws, { k: "peer", msg: "opponent joined" });
          break;
        }
        case "reconnect": {
          const r = rooms.get(String(m.code ?? ""));
          const s = m.seat === 1 ? 1 : 0;
          if (!r || r.seats[s].token !== String(m.token ?? "")) {
            send(ws, { k: "error", msg: "Reconnect failed." });
            return;
          }
          room = r;
          seat = s as 0 | 1;
          r.seats[seat].ws = ws;
          if (r.state === "playing" && r.game && r.cfg) {
            send(ws, {
              k: "sync",
              seed: r.cfg.seed,
              cfg: r.cfg,
              seat,
              log: r.log,
              tick: r.game.tickCount,
            });
            const other = r.seats[seat === 0 ? 1 : 0];
            if (other.ws && !r.timer) {
              // resume the sim loop
              let acc2 = 0;
              r.timer = setInterval(() => {
                const g = r.game!;
                if (g.phase === "playing") {
                  acc2 += (tickMs / 1000) * timeScale;
                  let stepped = false;
                  while (acc2 >= 1 / 30) {
                    g.step(1 / 30);
                    acc2 -= 1 / 30;
                    stepped = true;
                  }
                  if (!stepped) return;
                  broadcast(r, { k: "tick", i: g.tickCount });
                  if (g.tickCount % 300 === 0)
                    broadcast(r, { k: "hash", i: g.tickCount, h: g.stateHash() });
                } else if (r.state === "playing") {
                  r.state = "ended";
                  r.winner = g.phase === "victory" ? 0 : 1;
                  broadcast(r, { k: "end", winner: r.winner });
                }
              }, tickMs);
              broadcast(r, { k: "resumed" });
            }
          } else if (r.state === "lobby") {
            send(ws, { k: "joined", code: r.code, seat, token: r.seats[seat].token });
          }
          break;
        }
        case "ready": {
          if (!room || seat === null) return;
          room.seats[seat].ready = true;
          if (room.seats[0].ready && room.seats[1].ready && room.state === "lobby")
            startMatch(room);
          break;
        }
        case "intent": {
          if (room && seat !== null)
            handleIntent(room, seat, m.ev as ReplayEvent);
          break;
        }
        case "ping": {
          send(ws, { k: "pong", t: m.t });
          break;
        }
      }
    });
  });

  console.log(`[mp-server] listening on ws://localhost:${port}`);
  return {
    close: () => {
      for (const r of [...rooms.values()]) stopRoom(r);
      wss.close();
      opts.onClose?.();
    },
    rooms,
  };
}

const isDirectRun =
  process.env.MP_RUN === "1" ||
  (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href);
if (isDirectRun) {
  startServer();
}
