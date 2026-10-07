import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sfx } from "../game/audio";
import {
  DIFFICULTIES,
  LORDS,
  MAP_H,
  MAP_W,
  MAPS,
  setMapSize,
  MODES,
  RATIONS,
  START_RES_MULT,
  T_BRIDGE,
  T_FORD,
  T_OASIS,
  T_ROCKY,
  T_WATER,
  defaultMatchConfig,
  type MatchConfig,
} from "../game/constants";
import { Game } from "../game/engine";
import { MISSIONS, campaignProgress } from "../game/campaign";
import { GameGrid } from "../game/grid";
import {
  deleteReplay,
  listReplays,
  type ReplaySave,
} from "../game/replay";
import { NetClient } from "../game/net";
import { DEFAULT_SETTINGS, SPEED_MULT, type Settings } from "../game/settings";
import type { HudSnapshot } from "../game/types";

const click = (fn: () => void) => () => {
  sfx.play("click");
  fn();
};

// ── map preview ──────────────────────────────────────────────────────────────

const MapPreview = ({ cfg }: { cfg: MatchConfig }): React.ReactElement => {
  const ref = useRef<HTMLCanvasElement>(null);
  const grid = useMemo(() => {
    // Building a GameGrid publishes its size into the module-level MAP_W/MAP_H
    // that the live match's renderer and pathfinder read. A preview must not
    // steal them (e.g. previewing "Medium" while an XL match sits behind the
    // menu), so restore whatever the game currently uses.
    const prevW = MAP_W;
    const prevH = MAP_H;
    const g = new GameGrid(cfg.seed, cfg.map, cfg.size, cfg.richness);
    setMapSize(prevW, prevH);
    return g;
  }, [cfg.seed, cfg.map, cfg.size, cfg.richness]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const N = 160;
    c.width = N;
    c.height = N;
    const img = ctx.createImageData(N, N);
    const desert = grid.theme === "desert";
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const tx = Math.floor((x / N) * grid.w);
        const ty = Math.floor((y / N) * grid.h);
        const t = grid.terrain[ty * grid.w + tx];
        let r = desert ? 217 : 77;
        let g = desert ? 194 : 122;
        let b = desert ? 140 : 58;
        if (t === T_WATER) {
          r = desert ? 63 : 47; g = desert ? 147 : 93; b = desert ? 165 : 158;
        } else if (t === T_OASIS) {
          r = 105; g = 168; b = 68;
        } else if (t === T_ROCKY) {
          r = desert ? 176 : 125; g = desert ? 150 : 119; b = desert ? 120 : 108;
        } else if (t === T_BRIDGE) {
          r = 122; g = 90; b = 52;
        } else if (t === T_FORD) {
          r = 121; g = 168; b = 196;
        }
        const i = (y * N + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // resource dots
    for (const n of grid.scatterNodes(1)) {
      const x = (n.tx / grid.w) * N;
      const y = (n.ty / grid.h) * N;
      ctx.fillStyle =
        n.kind === "tree"
          ? desert ? "#2f6b2a" : "#20401c"
          : n.kind === "rock"
            ? "#d8d2c6"
            : "#f0c840";
      ctx.fillRect(x - 0.5, y - 0.5, 1.6, 1.6);
    }
    // start markers
    ctx.fillStyle = "#4f83ff";
    ctx.fillRect(N * 0.125 - 3, N * 0.875 - 3, 6, 6);
    ctx.fillStyle = "#e0503e";
    ctx.fillRect(N * 0.875 - 3, N * 0.125 - 3, 6, 6);
  }, [grid]);
  const meta = MAPS.find((m) => m.id === cfg.map)!;
  return (
    <div className="flex gap-3 items-start">
      <canvas
        ref={ref}
        className="w-[150px] h-[150px] rounded-lg border border-[#4d3b2688]"
        style={{ imageRendering: "pixelated" }}
        aria-label="Map preview"
      />
      <div className="text-left w-[210px]">
        <div className="text-[13px] font-semibold text-[#e8c877]">{meta.name}</div>
        <div className="text-[10.5px] text-[#c9b98e] leading-snug mb-1">
          {meta.desc}
        </div>
        <div className="text-[10px] text-[#9c8a63] italic leading-snug">
          ⚑ {meta.notes}
        </div>
      </div>
    </div>
  );
};

// ── small segmented control ──────────────────────────────────────────────────

const Seg = <T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ v: T; l: string; tip?: string }>;
  value: T;
  onChange: (v: T) => void;
}): React.ReactElement => (
  <div className="flex items-center gap-1.5">
    <span className="text-[10px] text-[#9c8a63] w-[74px] shrink-0">{label}</span>
    <div className="flex gap-1 flex-wrap">
      {options.map((o) => (
        <button
          key={String(o.v)}
          title={o.tip}
          className={`btn !px-2 !py-0.5 !text-[10px] ${value === o.v ? "active" : ""}`}
          onClick={click(() => onChange(o.v))}
        >
          {o.l}
        </button>
      ))}
    </div>
  </div>
);

// ── match setup screen ───────────────────────────────────────────────────────

export const SetupScreen = ({
  game,
  settings,
  setSettings,
}: {
  game: Game;
  settings: Settings;
  setSettings: (s: Settings) => void;
}): React.ReactElement => {
  const [cfg, setCfg] = useState<MatchConfig>(() => defaultMatchConfig());
  const [showSet, setShowSet] = useState(false);
  const [tab, setTab] = useState<
    "skirmish" | "campaign" | "replays" | "multiplayer"
  >("skirmish");
  const [mpUrl, setMpUrl] = useState<string>(() => {
    try {
      return localStorage.getItem("cd-mp-url") ?? "ws://localhost:8787";
    } catch {
      return "ws://localhost:8787";
    }
  });
  const [mpCode, setMpCode] = useState("");
  const [mpStatus, setMpStatus] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [missionId, setMissionId] = useState(0);
  const [replays, setReplays] = useState<ReplaySave[]>([]);
  const progress = campaignProgress();
  const refreshReplays = useCallback(() => setReplays(listReplays()), []);
  useEffect(refreshReplays, [refreshReplays]);
  const hasSave = Game.hasSave();
  const set = (patch: Partial<MatchConfig>) =>
    setCfg((c) => ({ ...c, ...patch }));

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[#0a0c08e0] pointer-events-auto anim-fadein overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Match setup"
    >
      <div className="panel px-8 py-6 w-[860px] my-4 anim-rise relative">
        <button
          className="btn !px-2.5 !py-1 absolute top-3 right-3"
          aria-label="Open settings"
          title="Settings"
          onClick={click(() => setShowSet(true))}
        >
          ⚙
        </button>
        <div className="text-center mb-3">
          <div className="text-[10px] tracking-[0.4em] text-[#9c8a63] uppercase">
            A Medieval Kingdom RTS
          </div>
          <h1 className="font-medieval gold-title anim-glow text-4xl font-bold tracking-wide">
            CASTLE DOMINION
          </h1>
        </div>
        <div className="flex gap-1.5 justify-center mb-4">
          {(
            [
              ["skirmish", "⚔ Skirmish"],
              ["campaign", "📜 Campaign"],
              ["replays", "🎞 Replays"],
              ["multiplayer", "🌐 Multiplayer"],
            ] as Array<["skirmish" | "campaign" | "replays" | "multiplayer", string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={`btn !py-1.5 ${tab === id ? "active" : ""}`}
              onClick={click(() => setTab(id))}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "campaign" && (
          <div className="grid grid-cols-2 gap-6 mb-4">
            <div className="flex flex-col gap-1.5">
              {MISSIONS.map((m, i) => {
                const locked = i > progress;
                return (
                  <button
                    key={m.id}
                    disabled={locked}
                    className={`btn flex-col !items-start !gap-0 !py-2 ${missionId === m.id && !locked ? "active" : ""}`}
                    onClick={click(() => setMissionId(m.id))}
                  >
                    <span className="text-[12px] font-semibold">
                      {locked ? "🔒 " : i < progress ? "✅ " : ""}
                      {m.name}
                    </span>
                    <span className="text-[9.5px] text-[#9c8a63]">
                      {MAPS.find((x) => x.id === m.map)?.name} ·{" "}
                      {DIFFICULTIES[m.difficulty].name} ·{" "}
                      {LORDS[m.lord]?.name ?? "—"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="text-left">
              <div className="text-[13px] font-semibold text-[#e8c877] mb-1">
                {MISSIONS[missionId]?.name}
              </div>
              <p className="text-[11px] text-[#c9b98e] leading-relaxed mb-2">
                {MISSIONS[missionId]?.briefing}
              </p>
              <div className="text-[10px] text-[#9c8a63] mb-1">Objectives:</div>
              <ul className="text-[10.5px] text-[#c9b98e] list-disc pl-4 mb-4">
                {MISSIONS[missionId]?.objectives.map((o) => (
                  <li key={o.id}>
                    {o.label}
                    {!o.primary && <i className="text-[#8a7a58]"> (optional)</i>}
                  </li>
                ))}
              </ul>
              <button
                className="btn !px-6 !py-2 font-medieval tracking-widest gold-title"
                onClick={click(() => {
                  sfx.unlock();
                  Game.clearSave();
                  const m = MISSIONS[missionId];
                  game.startMatch({
                    ...defaultMatchConfig(),
                    mode: "campaign",
                    missionId: m.id,
                    map: m.map,
                    size: m.size,
                    lord: m.lord,
                    difficulty: m.difficulty,
                    startRes: m.startRes,
                    seed: (Math.random() * 1e9) | 0,
                  });
                })}
              >
                ⚔ BEGIN MISSION
              </button>
            </div>
          </div>
        )}
        {tab === "multiplayer" && (
          <div className="mb-4 flex flex-col gap-2.5 items-center">
            <div className="flex items-center gap-2 w-[420px]">
              <span className="text-[10px] text-[#9c8a63] w-[70px]">Server</span>
              <input
                aria-label="Server address"
                className="btn !py-1 flex-1 !justify-start text-[11px]"
                value={mpUrl}
                onChange={(e) => {
                  setMpUrl(e.target.value);
                  try {
                    localStorage.setItem("cd-mp-url", e.target.value);
                  } catch {
                    /* ignore */
                  }
                }}
              />
            </div>
            <div className="flex gap-2">
              <button
                className="btn !px-5 !py-2 font-semibold"
                onClick={click(() => {
                  setMpStatus("Connecting…");
                  const nc = new NetClient(game, mpUrl);
                  game.netClient = nc;
                  nc.onStatus = setMpStatus;
                  nc.host()
                    .then((c) => setRoomCode(c))
                    .catch(() => setMpStatus(nc.status));
                })}
              >
                🏰 Host game
              </button>
              <input
                className="btn !py-2 w-[110px] !justify-start text-[12px] tracking-[0.3em] uppercase"
                placeholder="CODE"
                value={mpCode}
                maxLength={4}
                onChange={(e) => setMpCode(e.target.value.toUpperCase())}
              />
              <button
                className="btn !px-5 !py-2 font-semibold"
                disabled={mpCode.length !== 4}
                onClick={click(() => {
                  setMpStatus("Connecting…");
                  const nc = new NetClient(game, mpUrl);
                  game.netClient = nc;
                  nc.onStatus = setMpStatus;
                  nc.join(mpCode).catch(() => setMpStatus(nc.status));
                })}
              >
                ⚔ Join
              </button>
            </div>
            {roomCode && (
              <div
                aria-label="Room code"
                className="text-[22px] font-medieval gold-title tracking-[0.4em]"
              >
                {roomCode}
              </div>
            )}
            <div aria-label="Multiplayer status" className="text-[11px] text-[#c9b98e] min-h-[16px]">
              {mpStatus}
            </div>
            <div className="text-[10px] text-[#6f5f3f] max-w-[440px] text-center leading-snug">
              Free peer match via a lightweight relay you host yourself:
              <code className="text-[#9c8a63]"> npm run mp</code> then share the
              4-letter code. Lockstep simulation with server-side validation;
              reconnects resynchronise automatically.
            </div>
          </div>
        )}
        {tab === "replays" && (
          <div className="mb-4 max-h-[300px] overflow-y-auto flex flex-col gap-1.5">
            {replays.length === 0 && (
              <div className="text-[11px] text-[#9c8a63] text-center py-6">
                No replays yet — finished matches are recorded automatically.
              </div>
            )}
            {replays.map((r) => (
              <div
                key={r.date}
                className="flex items-center gap-2 bg-[#221a10aa] rounded-lg px-3 py-1.5 border border-[#4d3b2688]"
              >
                <span className="text-[11px] text-[#e8c877] w-[150px]">
                  {new Date(r.date).toLocaleString()}
                </span>
                <span className="text-[10px] text-[#c9b98e] w-[130px]">
                  {r.mapName} · {r.lordName || "—"}
                </span>
                <span
                  className={`text-[10px] w-[60px] ${r.result === "victory" ? "text-[#8ce08a]" : "text-[#ff9d8f]"}`}
                >
                  {r.result}
                </span>
                <span className="text-[10px] tabular-nums text-[#9c8a63] w-[80px]">
                  {Math.round(r.duration / 60)}m {r.kills}/{r.losses}
                </span>
                <button
                  className="btn !px-2.5 !py-0.5 !text-[10px] ml-auto"
                  onClick={click(() => {
                    sfx.unlock();
                    game.loadReplay(r);
                  })}
                >
                  ▶ Play
                </button>
                <button
                  className="btn !px-2 !py-0.5 !text-[10px]"
                  onClick={click(() => {
                    deleteReplay(r.date);
                    refreshReplays();
                  })}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === "skirmish" && (
        <div className="grid grid-cols-2 gap-6">
          {/* left column: mode, map, preview */}
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#c4a86e] mb-1">
                Game mode
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    title={m.desc}
                    className={`btn flex-col !items-start !gap-0 !py-1.5 ${cfg.mode === m.id ? "active" : ""}`}
                    onClick={click(() =>
                      set({
                        mode: m.id,
                        timeLimitMin:
                          m.id === "survival" && !cfg.timeLimitMin
                            ? 15
                            : m.id === "siege" && !cfg.timeLimitMin
                              ? 25
                              : cfg.timeLimitMin,
                      }),
                    )}
                  >
                    <span className="text-[11px] font-semibold">{m.name}</span>
                    <span className="text-[9px] text-[#9c8a63] leading-tight">
                      {m.desc}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#c4a86e] mb-1">
                Map
              </div>
              <div className="flex gap-1 flex-wrap mb-2">
                {MAPS.map((m) => (
                  <button
                    key={m.id}
                    className={`btn !px-2 !py-1 !text-[10px] ${cfg.map === m.id ? "active" : ""}`}
                    onClick={click(() => set({ map: m.id }))}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
              <MapPreview cfg={cfg} />
            </div>
          </div>

          {/* right column: lords, difficulty, options */}
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#c4a86e] mb-1">
                Enemy lord
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {LORDS.map((l) => (
                  <button
                    key={l.id}
                    title={`${l.desc} — ${l.style}`}
                    className={`btn flex-col !items-start !gap-0 !py-1.5 ${cfg.lord === l.id ? "active" : ""}`}
                    onClick={click(() => set({ lord: l.id }))}
                  >
                    <span className="text-[11px] font-semibold">
                      {l.emblem} {l.name} <i className="text-[#9c8a63] not-italic text-[9px]">{l.title}</i>
                    </span>
                    <span className="text-[9px] text-[#9c8a63] leading-tight text-left">
                      {l.style}
                    </span>
                  </button>
                ))}
                <button
                  className={`btn !py-1.5 !text-[10px] ${cfg.lord === 4 ? "active" : ""}`}
                  title="A random lord each match"
                  onClick={click(() => set({ lord: 4 }))}
                >
                  🎲 Random lord
                </button>
              </div>
            </div>
            <Seg
              label="Difficulty"
              value={cfg.difficulty}
              options={DIFFICULTIES.map((d) => ({ v: d.id, l: d.name, tip: d.desc }))}
              onChange={(v) => set({ difficulty: v })}
            />
            <div className="flex flex-col gap-1.5">
              <Seg
                label="Map size"
                value={cfg.size}
                options={[
                  { v: "S" as const, l: "Small" },
                  { v: "M" as const, l: "Medium" },
                  { v: "L" as const, l: "Large" },
                  {
                    v: "XL" as const,
                    l: "XL",
                    tip: "Extra large (160x160 tiles, 2.4x Large). Optional — heavier on CPU/GPU; adaptive quality keeps it playable.",
                  },
                ]}
                onChange={(v) => set({ size: v })}
              />
              <Seg
                label="Epic army"
                value={cfg.epic ? 1 : 0}
                options={[
                  { v: 0 as const, l: "Off", tip: "Classic population ceiling (8 from the keep + 6 per house)." },
                  {
                    v: 1 as const,
                    l: "On",
                    tip: "Optional capacity for huge battles: pop 26 + 18 per house, richer start, cheaper upkeep, and the AI fields a proportionally larger army. Never required — turn it off on weaker machines.",
                  },
                ]}
                onChange={(v) => set({ epic: v === 1 })}
              />
              <Seg
                label="Richness"
                value={cfg.richness}
                options={[
                  { v: 0 as const, l: "Sparse" },
                  { v: 1 as const, l: "Normal" },
                  { v: 2 as const, l: "Rich" },
                ]}
                onChange={(v) => set({ richness: v })}
              />
              <Seg
                label="Start res"
                value={cfg.startRes}
                options={[
                  { v: 0 as const, l: "Low" },
                  { v: 1 as const, l: "Normal" },
                  { v: 2 as const, l: "High" },
                ]}
                onChange={(v) => set({ startRes: v })}
              />
              <Seg
                label="Game speed"
                value={settings.gameSpeed}
                options={[
                  { v: 0 as const, l: "Slow" },
                  { v: 1 as const, l: "Normal" },
                  { v: 2 as const, l: "Fast" },
                ]}
                onChange={(v) =>
                  setSettings({ ...settings, gameSpeed: v })
                }
              />
              <Seg
                label="No rush"
                value={cfg.noRushMin}
                options={[
                  { v: 0 as const, l: "Off" },
                  { v: 5 as const, l: "5 min" },
                  { v: 10 as const, l: "10 min" },
                ]}
                onChange={(v) => set({ noRushMin: v })}
              />
              <Seg
                label="Time limit"
                value={cfg.timeLimitMin}
                options={[
                  { v: 0 as const, l: "None" },
                  { v: 15 as const, l: "15m" },
                  { v: 25 as const, l: "25m" },
                  { v: 35 as const, l: "35m" },
                ]}
                onChange={(v) => set({ timeLimitMin: v })}
              />
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-[#9c8a63] w-[74px] shrink-0">
                  Seed
                </span>
                <span className="text-[11px] tabular-nums text-[#c9b98e]">
                  {cfg.seed}
                </span>
                <button
                  className="btn !px-2 !py-0.5 !text-[10px]"
                  onClick={click(() =>
                    set({ seed: (Math.random() * 1e9) | 0 }),
                  )}
                >
                  🎲 reroll
                </button>
              </div>
            </div>
          </div>
        </div>

        )}
        <div className="flex gap-3 justify-center mt-5">
          {tab === "skirmish" && hasSave && (
            <button
              className="btn !px-6 !py-2.5 font-medieval tracking-widest gold-title"
              onClick={click(() => {
                sfx.unlock();
                if (!game.continueSave()) game.startMatch(cfg);
              })}
            >
              ⚔ CONTINUE
            </button>
          )}
          {tab === "skirmish" && (
            <button
              className="btn !px-8 !py-2.5 font-medieval tracking-widest gold-title"
              onClick={click(() => {
                sfx.unlock();
                Game.clearSave();
                game.startMatch(cfg);
              })}
              autoFocus
            >
              ⚔ BEGIN MATCH
            </button>
          )}
        </div>
        {showSet && (
          <SettingsOverlay
            settings={settings}
            setSettings={setSettings}
            onClose={() => setShowSet(false)}
          />
        )}
        <div className="text-center text-[10px] text-[#6f5f3f] mt-2">
          Speed ×{SPEED_MULT[settings.gameSpeed]} · starting resources ×
          {START_RES_MULT[cfg.startRes]} · rations policy adjustable in-game
          ({RATIONS.length} tiers)
        </div>
      </div>
    </div>
  );
};

// ── settings overlay ─────────────────────────────────────────────────────────

const TABS = [
  "Gameplay",
  "Audio",
  "Graphics",
  "Accessibility",
  "Controls",
] as const;

const Toggle = ({
  label,
  value,
  onChange,
  tip,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  tip?: string;
}): React.ReactElement => (
  <button
    className="btn justify-between w-full !py-1.5"
    title={tip}
    onClick={click(() => onChange(!value))}
  >
    <span className="text-[11px]">{label}</span>
    <span className={value ? "text-[#8ce08a]" : "text-[#8a7a58]"}>
      {value ? "ON" : "OFF"}
    </span>
  </button>
);

const Slider = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}): React.ReactElement => (
  <div className="flex items-center gap-2 w-full">
    <span className="text-[11px] w-[110px] shrink-0">{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      className="w-full accent-[#d8b25c]"
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
    <span className="text-[10px] tabular-nums text-[#c9b98e] w-9 text-right">
      {fmt ? fmt(value) : value.toFixed(2)}
    </span>
  </div>
);

export const SettingsOverlay = ({
  settings,
  setSettings,
  onClose,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  onClose: () => void;
}): React.ReactElement => {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Gameplay");
  const set = (patch: Partial<Settings>) =>
    setSettings({ ...settings, ...patch });
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-[#0a0c08cc] pointer-events-auto anim-fadein"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="panel px-6 py-5 w-[560px] anim-rise">
        <div className="flex items-center mb-3">
          <h2 className="font-medieval gold-title text-xl tracking-widest">
            SETTINGS
          </h2>
          <button className="btn ml-auto !px-2.5 !py-1" onClick={click(onClose)}>
            ✕
          </button>
        </div>
        <div className="flex gap-1 mb-4">
          {TABS.map((t) => (
            <button
              key={t}
              className={`btn !py-1 !text-[11px] ${tab === t ? "active" : ""}`}
              onClick={click(() => setTab(t))}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 min-h-[240px]">
          {tab === "Gameplay" && (
            <>
              <Seg
                label="Game speed"
                value={settings.gameSpeed}
                options={[
                  { v: 0 as const, l: "Slow" },
                  { v: 1 as const, l: "Normal" },
                  { v: 2 as const, l: "Fast" },
                ]}
                onChange={(v) => set({ gameSpeed: v })}
              />
              <Seg
                label="HUD panels"
                value={settings.hudMode}
                options={[
                  {
                    v: "auto" as const,
                    l: "Auto-hide",
                    tip: "Panels collapse to edge rails; hover or click to expand",
                  },
                  {
                    v: "compact" as const,
                    l: "Compact",
                    tip: "Edge rails only; click a rail to pin its panel open",
                  },
                  {
                    v: "full" as const,
                    l: "Full",
                    tip: "Classic layout — every panel always visible",
                  },
                ]}
                onChange={(v) => set({ hudMode: v })}
              />
              <Toggle label="Tutorial / help" value={settings.tutorial} onChange={(v) => set({ tutorial: v })} />
              <Toggle label="Auto-save (30s)" value={settings.autosave} onChange={(v) => set({ autosave: v })} />
              <Toggle label="Pause when window loses focus" value={settings.pauseOnBlur} onChange={(v) => set({ pauseOnBlur: v })} />
              <Toggle label="Screen shake" value={settings.screenShake} onChange={(v) => set({ screenShake: v })} />
              <Toggle label="Fog of war (explore & vision)" value={settings.fog} onChange={(v) => set({ fog: v })} tip="Unexplored land is hidden; enemy units only visible within your vision." />
              <Toggle label="Camera smoothing" value={settings.cameraSmoothing} onChange={(v) => set({ cameraSmoothing: v })} />
              <Slider label="Camera pan speed" value={settings.panSpeed} min={0.6} max={1.8} step={0.1} onChange={(v) => set({ panSpeed: v })} fmt={(v) => `${v.toFixed(1)}x`} />
              <Slider label="Zoom speed" value={settings.zoomSpeed} min={0.6} max={1.8} step={0.1} onChange={(v) => set({ zoomSpeed: v })} fmt={(v) => `${v.toFixed(1)}x`} />
            </>
          )}
          {tab === "Audio" && (
            <>
              <Toggle label="Sound" value={settings.sound} onChange={(v) => set({ sound: v })} />
              <Slider label="Master volume" value={settings.masterVol} min={0} max={1} step={0.05} onChange={(v) => set({ masterVol: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="Music volume" value={settings.musicVol} min={0} max={1} step={0.05} onChange={(v) => set({ musicVol: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="SFX volume" value={settings.sfxVol} min={0} max={1} step={0.05} onChange={(v) => set({ sfxVol: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="Ambient volume" value={settings.ambientVol} min={0} max={1} step={0.05} onChange={(v) => set({ ambientVol: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Toggle label="Event alerts (horns)" value={settings.alerts} onChange={(v) => set({ alerts: v })} />
            </>
          )}
          {tab === "Graphics" && (
            <>
              <Seg
                label="Preset"
                value={settings.quality}
                options={[
                  { v: 0 as const, l: "Performance" },
                  { v: 1 as const, l: "Balanced" },
                  { v: 2 as const, l: "Quality" },
                ]}
                onChange={(v) => set({ quality: v })}
              />
              <Seg
                label="Renderer"
                value={settings.renderer}
                options={[
                  { v: "auto" as const, l: "Auto" },
                  { v: "3d" as const, l: "3D" },
                  { v: "2d" as const, l: "2D" },
                ]}
                onChange={(v) => set({ renderer: v })}
              />
              <Toggle
                label="Adaptive quality"
                value={settings.qualityAuto}
                onChange={(v) => set({ qualityAuto: v })}
              />
              <p className="text-[10px] text-[#9c8a63] leading-snug">
                Renderer changes apply on reload · Auto picks 3D (WebGL) when supported, else 2D · <b className="text-[#e8c877]">F3</b> opens the GPU profiler &amp; benchmark (device-reported)
              </p>
              <p className="text-[10px] text-[#9c8a63] leading-snug">
                Adaptive quality measures real frame &amp; sim cost and sheds detail in steps — particles, render scale, water/clouds, unit LOD, 3D shadows — before ever dropping to the 2D renderer (and only when Renderer is on Auto). The preset above is the ceiling; switch it off to pin that preset exactly. Current rung is shown in <b className="text-[#e8c877]">F3</b>.
              </p>
              <Toggle label="Shadows" value={settings.shadows} onChange={(v) => set({ shadows: v })} />
              <Toggle label="Particles" value={settings.particles} onChange={(v) => set({ particles: v })} />
              <Toggle label="Water effects" value={settings.waterFx} onChange={(v) => set({ waterFx: v })} />
              <Toggle label="Day / night cycle" value={settings.dayNight} onChange={(v) => set({ dayNight: v })} />
              <Toggle label="Reduced effects" value={settings.reducedFx} onChange={(v) => set({ reducedFx: v })} />
              <Seg
                label="UI scale"
                value={settings.uiScale}
                options={[
                  { v: 0 as const, l: "90%" },
                  { v: 1 as const, l: "100%" },
                  { v: 2 as const, l: "112%" },
                ]}
                onChange={(v) => set({ uiScale: v })}
              />
              <Slider label="Default zoom" value={settings.defaultZoom} min={0.8} max={1.4} step={0.05} onChange={(v) => set({ defaultZoom: v })} fmt={(v) => v.toFixed(2)} />
            </>
          )}
          {tab === "Accessibility" && (
            <>
              <Seg
                label="UI text size"
                value={settings.textSize}
                options={[
                  { v: 0 as const, l: "Small" },
                  { v: 1 as const, l: "Normal" },
                  { v: 2 as const, l: "Large" },
                ]}
                onChange={(v) => set({ textSize: v })}
              />
              <Toggle label="High contrast UI" value={settings.highContrast} onChange={(v) => set({ highContrast: v })} />
              <Toggle label="Reduced motion" value={settings.reducedMotion} onChange={(v) => set({ reducedMotion: v })} />
              <Toggle label="Clearer unit colors (blue/orange)" value={settings.clearColors} onChange={(v) => set({ clearColors: v })} />
            </>
          )}
          {tab === "Controls" && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-[#c9b98e]">
              <span><b className="text-[#e8c877]">Drag</b> box-select · <b className="text-[#e8c877]">Dbl-click</b> focus camera</span>
              <span><b className="text-[#e8c877]">Z / X</b> rotate camera (3D) · <b className="text-[#e8c877]">F3</b> profiler</span>
              <span><b className="text-[#e8c877]">Right-click</b> move/gather/attack/build</span>
              <span><b className="text-[#e8c877]">A</b> attack-move · <b className="text-[#e8c877]">S</b> stop</span>
              <span><b className="text-[#e8c877]">H / Tab</b> idle villagers</span>
              <span><b className="text-[#e8c877]">Q W E R T Y U I O P [ ]</b> build</span>
              <span><b className="text-[#e8c877]">1–5</b> groups · <b className="text-[#e8c877]">Ctrl+1–5</b> set</span>
              <span><b className="text-[#e8c877]">Space</b> center · <b className="text-[#e8c877]">F</b> focus selection</span>
              <span><b className="text-[#e8c877]">Home</b> fit kingdom · <b className="text-[#e8c877]">+/−</b> zoom</span>
              <span><b className="text-[#e8c877]">Arrows/edge/middle-drag</b> pan · <b className="text-[#e8c877]">Wheel</b> zoom</span>
              <span><b className="text-[#e8c877]">F1</b> cinematic mode · <b className="text-[#e8c877]">F2</b> pause · <b className="text-[#e8c877]">M</b> mute</span>
              <span><b className="text-[#e8c877]">Esc</b> cancel / deselect / close panels</span>
            </div>
          )}
        </div>
        <div className="flex justify-between mt-4">
          <button
            className="btn !py-1 !text-[10px]"
            onClick={click(() => setSettings({ ...DEFAULT_SETTINGS }))}
          >
            Reset defaults
          </button>
          <button className="btn !px-6 !py-1.5" onClick={click(onClose)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export type { HudSnapshot };
