import type { Game } from "./engine";
import type { ReplayEvent } from "./replay";
import type { MatchConfig } from "./constants";

/**
 * Lockstep multiplayer client: streams local intents to the authoritative
 * server and re-applies the server-scheduled intent feed tick-exactly.
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private token = "";
  private code = "";
  seat: 0 | 1 = 0;
  status: string = "";
  onStatus: (s: string) => void = () => {};
  onStarted: () => void = () => {};
  private hashChecks: Array<{ i: number; h: string }> = [];
  private pingT = 0;
  private closedByUs = false;

  constructor(
    private game: Game,
    private url: string,
  ) {}

  private set(msg: string): void {
    this.status = msg;
    this.onStatus(msg);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch {
        reject(new Error("bad server address"));
        return;
      }
      const to = setTimeout(() => {
        this.set("Could not reach server (offline?). Single-player remains available.");
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        reject(new Error("timeout"));
      }, 6000);
      this.ws.onopen = () => {
        clearTimeout(to);
        this.game.netConnected = true;
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(to);
        this.set("Could not reach server (offline?). Single-player remains available.");
        reject(new Error("ws error"));
      };
      this.ws.onclose = () => {
        this.game.netConnected = false;
        if (!this.closedByUs && this.game.netMode) {
          this.set("Connection lost — reconnecting…");
          setTimeout(() => this.reconnect(), 1500);
        }
      };
      this.ws.onmessage = (e) => this.onMsg(JSON.parse(String(e.data)));
    });
  }

  host(): Promise<string> {
    return this.connect().then(
      () =>
        new Promise<string>((resolve) => {
          this.pendingHost = resolve;
          this.send({ k: "host" });
        }),
    );
  }
  private pendingHost: ((c: string) => void) | null = null;
  private pendingJoin: ((seat: 0 | 1) => void) | null = null;

  join(code: string): Promise<0 | 1> {
    this.code = code.toUpperCase();
    return this.connect().then(
      () =>
        new Promise<0 | 1>((resolve) => {
          this.pendingJoin = resolve;
          this.send({ k: "join", code: this.code });
        }),
    );
  }

  setReady(): void {
    this.send({ k: "ready" });
  }

  private reconnect(): void {
    this.closedByUs = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.connect()
      .then(() => {
        this.send({
          k: "reconnect",
          code: this.code,
          seat: this.seat,
          token: this.token,
        });
      })
      .catch(() => {
        this.set("Reconnect failed — returning to menu.");
        this.game.netAbort();
      });
  }

  close(): void {
    this.closedByUs = true;
    this.game.onIntent = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private send(m: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(m));
  }

  private onMsg(m: Record<string, never> & {
    k: string;
    code?: string;
    seat?: 0 | 1;
    token?: string;
    seed?: number;
    cfg?: MatchConfig;
    log?: Array<{ i: number; team: 0 | 1; ev: ReplayEvent }>;
    tick?: number;
    i?: number;
    team?: 0 | 1;
    ev?: ReplayEvent;
    h?: string;
    t?: number;
    msg?: string;
    winner?: -1 | 0 | 1;
  }): void {
    const g = this.game;
    switch (m.k) {
      case "hosted":
        this.code = m.code!;
        this.seat = 0;
        this.token = m.token!;
        this.set(`Room ${this.code} — waiting for an opponent…`);
        this.pendingHost?.(this.code);
        this.pendingHost = null;
        break;
      case "joined":
        this.code = m.code!;
        this.seat = m.seat!;
        this.token = m.token!;
        this.set(`Joined ${this.code} — preparing…`);
        this.pendingJoin?.(this.seat);
        this.pendingJoin = null;
        this.setReady();
        break;
      case "peer":
        this.set("Opponent joined — starting…");
        this.setReady();
        break;
      case "error":
        this.set(m.msg ?? "Server error.");
        break;
      case "start": {
        const cfg = { ...m.cfg!, mode: "multiplayer" as const };
        g.init(m.seed!, cfg);
        g.myTeam = this.seat;
        g.netMode = { seat: this.seat, room: this.code };
        g.netServerTick = null;
        g.netConnected = true;
        g.renderer?.reset();
        g.phase = "playing";
        g.onIntent = (ev) => this.send({ k: "intent", ev });
        this.hashChecks = [];
        this.set(`Match started — seat ${this.seat + 1}, room ${this.code}`);
        this.onStarted();
        g.publish(true);
        this.pingT = window.setInterval(() => {
          this.send({ k: "ping", t: performance.now() });
        }, 2000);
        break;
      }
      case "sync": {
        const cfg = { ...m.cfg!, mode: "multiplayer" as const };
        g.init(m.seed!, cfg);
        g.myTeam = this.seat;
        g.netMode = { seat: this.seat, room: this.code };
        g.renderer?.reset();
        g.phase = "playing";
        g.onIntent = (ev) => this.send({ k: "intent", ev });
        for (const e of m.log ?? []) g.queueNetEvent(e.i, e.team, e.ev);
        // fast resim to the server tick
        const target = m.tick ?? 0;
        let guard = 0;
        while (g.tickCount < target && guard++ < 200000) g.step(1 / 30);
        g.netServerTick = target;
        this.set("Reconnected — resynchronised.");
        g.publish(true);
        break;
      }
      case "resumed":
        this.set("Match resumed.");
        break;
      case "wait":
        g.netServerTick = null;
        this.set("Waiting for opponent…");
        break;
      case "tick":
        g.netServerTick = m.i!;
        break;
      case "ev":
        g.queueNetEvent(m.i!, m.team!, m.ev!);
        break;
      case "hash":
        this.hashChecks.push({ i: m.i!, h: m.h! });
        break;
      case "pong":
        g.netPing = performance.now() - (m.t ?? 0);
        break;
      case "end": {
        clearInterval(this.pingT);
        const w = m.winner ?? -1;
        g.phase = w === this.seat ? "victory" : w === -1 ? "defeat" : "defeat";
        g.netMode = null;
        g.onIntent = null;
        g.publish(true);
        this.set(w === this.seat ? "Victory!" : "Defeat.");
        break;
      }
    }
    // verify pending hashes exactly at their tick
    if (this.hashChecks.length && g.tickCount > 0) {
      for (const hc of [...this.hashChecks]) {
        if (g.tickCount === hc.i) {
          const mine = g.stateHash();
          if (mine !== hc.h) {
            console.warn("desync at tick", hc.i, mine, hc.h);
            g.msg("Warning: simulation desync detected.", "bad");
          }
          this.hashChecks.splice(this.hashChecks.indexOf(hc), 1);
        } else if (g.tickCount > hc.i) {
          this.hashChecks.splice(this.hashChecks.indexOf(hc), 1);
        }
      }
    }
  }
}
