import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sfx } from "../game/audio";
import {
  BUILDING_DEFS,
  BUILD_ORDER,
  MARKET,
  RATIONS,
  RES_ORDER,
  TAXES,
  UNIT_DEFS,
  UPGRADES,
  canAfford,
} from "../game/constants";
import { Game } from "../game/engine";
import type {
  BuildingType,
  HudSnapshot,
  Resources,
  TutorialFlags,
  UnitType,
} from "../game/types";
import { BuildIcon, HappyIcon, PopIcon, ResIcon, UnitIcon } from "./icons";
import { SettingsOverlay, SetupScreen } from "./Setup";
import { MODES } from "../game/constants";
import type { Settings } from "../game/settings";
import { Profiler } from "./Profiler";

const fmt = (n: number): string => Math.floor(n).toString();

const fmtTime = (t: number): string => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const click = (fn: () => void) => () => {
  sfx.play("click");
  fn();
};

const Tip = ({
  text,
  children,
  below = false,
}: {
  text: React.ReactNode;
  children: React.ReactNode;
  below?: boolean;
}): React.ReactElement => (
  <span className="tip">
    {children}
    <span className={`tipbox ${below ? "tipbox-below" : ""}`}>{text}</span>
  </span>
);

const Cost = ({
  cost,
  res,
}: {
  cost: Partial<Resources>;
  res: Resources;
}): React.ReactElement => (
  <span className="flex items-center gap-1.5 text-[10px] leading-none">
    {(Object.keys(cost) as Array<keyof Resources>)
      .filter((k) => (cost[k] ?? 0) > 0)
      .map((k) => (
        <span
          key={k}
          className={res[k] >= (cost[k] ?? 0) ? "cost-good" : "cost-bad"}
        >
          {cost[k]}
        </span>
      ))}
  </span>
);

const RES_TIP: Record<string, string> = {
  food: "Food — from Farms. Trains villagers & army.",
  wood: "Wood — villagers chop trees. Lumber Camps boost it.",
  stone: "Stone — mined from rock deposits. Walls & towers.",
  gold: "Gold — from gold veins or the Market. Elite units & upgrades.",
};

// ── top resource bar ─────────────────────────────────────────────────────────

const TopBar = memo(
  ({
    snap,
    game,
    onSettings,
    onCine,
    isFs,
    onFullscreen,
  }: {
    snap: HudSnapshot;
    game: Game;
    onSettings: () => void;
    onCine: () => void;
    isFs: boolean;
    onFullscreen: () => void;
  }) => (
  <header
    data-testid="hud-topbar"
    className="absolute top-2 left-1/2 -translate-x-1/2 panel px-4 py-1.5 flex items-center gap-3.5 text-sm z-20 anim-rise"
    aria-label="Resources and game controls"
  >
    {RES_ORDER.map((k) => (
      <Tip key={k} text={RES_TIP[k]} below>
        <span className="flex items-center gap-1.5">
          <span className="w-5 h-5 inline-block">
            <ResIcon kind={k} />
          </span>
          <span className="tabular-nums font-semibold text-[#f6ecd2] min-w-9">
            {fmt(snap.res[k])}
          </span>
        </span>
      </Tip>
    ))}
    <span className="w-px h-5 bg-[#4d3b2688]" />
    <Tip below text="Population — each unit needs 1. Houses add +6.">
      <span className="flex items-center gap-1.5">
        <span className="w-5 h-5 inline-block">
          <PopIcon />
        </span>
        <span className="tabular-nums">
          {snap.popCur}/{snap.popCap}
        </span>
      </span>
    </Tip>
    <span className="w-px h-5 bg-[#4d3b2688]" />
    <span className="tabular-nums text-[#c9b98e]" title="Game time">
      {fmtTime(snap.time)}
    </span>
    {snap.net && (
      <span
        className="flex items-center gap-1.5 text-[11px]"
        title={`Multiplayer room ${snap.net.room} — seat ${snap.net.seat + 1}`}
      >
        <span className={snap.net.connected && !snap.net.waiting ? "text-[#8ce08a]" : "text-[#e8c13c]"}>
          ⚡{snap.net.room}
        </span>
        <span className="tabular-nums text-[#9c8a63]">
          {snap.net.waiting ? "waiting…" : `${snap.net.ping}ms`}
        </span>
        <button
          className="btn !px-1.5 !py-0.5 !text-[9px]"
          onClick={click(() => {
            (game.netClient as { close?: () => void } | null)?.close?.();
            game.netAbort();
          })}
          title="Leave match"
        >
          ✕
        </button>
      </span>
    )}
    <span className="w-px h-5 bg-[#4d3b2688]" />
    <button
      className="btn !px-2.5 !py-1"
      onClick={click(() => game.togglePause())}
      title="Pause / resume (F2)"
      aria-label={snap.paused ? "Resume game" : "Pause game"}
    >
      {snap.paused ? "▶" : "❚❚"}
    </button>
    <button
      className={`btn !px-2.5 !py-1 ${snap.speed === 2 ? "active" : ""}`}
      onClick={click(() => game.toggleSpeed())}
      title="Game speed"
      aria-label={`Game speed ${snap.speed}x`}
    >
      x{snap.speed}
    </button>
    <button
      className={`btn !px-2.5 !py-1 ${snap.muted ? "" : "active"}`}
      onClick={click(() => game.toggleMute())}
      title="Sound on/off (M)"
      aria-label={snap.muted ? "Unmute sound" : "Mute sound"}
    >
      {snap.muted ? "🔇" : "🔊"}
    </button>
    <button
      className="btn !px-2.5 !py-1"
      onClick={click(onCine)}
      title="Cinematic mode (F1) — hide the HUD, keep camera control"
      aria-label="Cinematic mode (F1)"
      data-testid="btn-cinematic"
    >
      🎥
    </button>
    <button
      className={`btn !px-2.5 !py-1 ${isFs ? "active" : ""}`}
      onClick={click(onFullscreen)}
      title={isFs ? "Exit fullscreen" : "Fullscreen"}
      aria-label="Toggle fullscreen"
      data-testid="btn-fullscreen"
    >
      {isFs ? "🗗" : "⛶"}
    </button>
    <button
      className="btn !px-2.5 !py-1"
      onClick={click(onSettings)}
      title="Settings"
      aria-label="Open settings"
    >
      ⚙
    </button>
  </header>
));
TopBar.displayName = "TopBar";

// ── popularity panel ─────────────────────────────────────────────────────────

const PopularityPanel = memo(
  ({ snap, game }: { snap: HudSnapshot; game: Game }): React.ReactElement => (
    <aside
      className="panel pointer-events-auto px-3 py-2 w-[236px] anim-slidein"
      aria-label="Popularity and kingdom policy"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="w-5 h-5 inline-block">
          <HappyIcon level={snap.popularity} />
        </span>
        <span className="text-[11px] uppercase tracking-wider text-[#c4a86e]">
          Popularity
        </span>
        <span className="ml-auto tabular-nums text-sm font-semibold text-[#f6ecd2]">
          {snap.popularity}%
        </span>
      </div>
      <div className="h-1.5 rounded bg-[#1c140c] mb-1.5 overflow-hidden">
        <div
          className={`h-full transition-[width] duration-300 ${snap.popularity >= 65 ? "bg-[#8ce08a]" : snap.popularity <= 30 ? "bg-[#e0503e]" : "bg-[#e8c13c]"}`}
          style={{ width: `${snap.popularity}%` }}
        />
      </div>
      {snap.famine && (
        <div className="text-[10px] cost-bad mb-1">
          ⚠ FAMINE — no food left! Build farms or buy grain.
        </div>
      )}
      <div className="flex flex-col gap-[2px] mb-1.5">
        {snap.popFactors.map((f) => (
          <div key={f.label} className="flex items-center text-[10px]">
            <span className="text-[#9c8a63]">{f.label}</span>
            <span
              className={`ml-auto tabular-nums ${f.value > 0 ? "text-[#8ce08a]" : f.value < 0 ? "text-[#ff9d8f]" : "text-[#8a7a58]"}`}
            >
              {f.value > 0 ? `+${f.value}` : f.value}/min
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 mb-1">
        <span className="text-[10px] text-[#9c8a63] w-12">Rations</span>
        {RATIONS.map((r) => (
          <Tip
            key={r.id}
            text={
              <span>
                <b className="text-[#e8c877]">{r.name} rations</b> — {r.desc}
                <br />
                Popularity {r.pop > 0 ? `+${r.pop}` : r.pop}/min · food use ×{r.mult}
              </span>
            }
          >
            <button
              className={`btn !px-1.5 !py-0.5 !text-[10px] ${snap.ration === r.id ? "active" : ""}`}
              onClick={click(() => game.setRation(r.id))}
            >
              {r.name.slice(0, 3)}
            </button>
          </Tip>
        ))}
      </div>
      <div className="flex items-center gap-1 mb-1">
        <span className="text-[10px] text-[#9c8a63] w-12">Taxes</span>
        {TAXES.map((tx) => (
          <Tip
            key={tx.id}
            text={
              <span>
                <b className="text-[#e8c877]">{tx.name} taxes</b> — {tx.desc}
                <br />
                Popularity {tx.pop > 0 ? `+${tx.pop}` : tx.pop}/min · +{tx.rate} gold/head/s
              </span>
            }
          >
            <button
              className={`btn !px-1.5 !py-0.5 !text-[10px] ${snap.tax === tx.id ? "active" : ""}`}
              onClick={click(() => game.setTax(tx.id))}
            >
              {tx.name.slice(0, 3)}
            </button>
          </Tip>
        ))}
      </div>
      {snap.granary > 0 || snap.innsActive > 0 ? (
        <div className="text-[9.5px] text-[#8a7a58]">
          {snap.granary > 0 && (
            <>
              Granary reserve:{" "}
              <span className="tabular-nums text-[#c9b98e]">{snap.granary}</span>{" "}
              food ·{" "}
            </>
          )}
          {snap.innsActive > 0 && (
            <>
              {snap.innsActive} inn{snap.innsActive > 1 ? "s" : ""} serving ale
            </>
          )}
        </div>
      ) : null}
      <div className="text-[9px] text-[#6f5f3f] mt-1 leading-snug">
        ≥65%: peasants immigrate · ≤30%: they leave · high = faster work
      </div>
    </aside>
  ),
);
PopularityPanel.displayName = "PopularityPanel";

// ── tutorial tracker ─────────────────────────────────────────────────────────

const TUT_ITEMS: Array<{ key: keyof TutorialFlags; label: string }> = [
  { key: "gather", label: "Gather: right-click a tree or farm with villagers" },
  { key: "house", label: "Build a House (Q) for population" },
  { key: "farm", label: "Build a Farm (W) for food" },
  { key: "villager", label: "Train a Villager at the Keep" },
  { key: "barracks", label: "Build a Barracks (E)" },
  { key: "military", label: "Train a military unit" },
  { key: "wall", label: "Place a Wall or Tower (R / T)" },
  { key: "attack", label: "Send an army: A + click (attack-move)" },
];

const TutorialPanel = memo(
  ({ snap, game }: { snap: HudSnapshot; game: Game }): React.ReactElement | null => {
    if (snap.tutorialSkipped) return null;
    const done = TUT_ITEMS.filter((i) => snap.tut[i.key]).length;
    if (done === TUT_ITEMS.length) return null;
    const current = TUT_ITEMS.find((i) => !snap.tut[i.key]);
    return (
      <aside
        className="panel pointer-events-auto px-3 py-2 w-[248px] anim-slidein"
        aria-label="Tutorial objectives"
      >
        <div className="flex items-center mb-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[#c4a86e]">
            Tutorial {done}/{TUT_ITEMS.length}
          </span>
          <button
            className="ml-auto text-[10px] text-[#9c8a63] hover:text-[#e8c877]"
            onClick={click(() => game.skipTutorial())}
          >
            skip
          </button>
        </div>
        <div className="flex flex-col gap-1">
          {TUT_ITEMS.map((i) => (
            <div
              key={i.key}
              className={`flex items-start gap-1.5 text-[10.5px] leading-snug ${
                snap.tut[i.key]
                  ? "text-[#7da568]"
                  : i.key === current?.key
                    ? "text-[#f0e6cc]"
                    : "text-[#8a7a58]"
              }`}
            >
              <span className="mt-[1px]">
                {snap.tut[i.key] ? "✓" : i.key === current?.key ? "▶" : "○"}
              </span>
              <span className={i.key === current?.key ? "font-semibold" : ""}>
                {i.label}
              </span>
            </div>
          ))}
        </div>
      </aside>
    );
  },
);
TutorialPanel.displayName = "TutorialPanel";

// ── command card (selection) ─────────────────────────────────────────────────

const TrainButton = ({
  type,
  snap,
  game,
}: {
  type: UnitType;
  snap: HudSnapshot;
  game: Game;
}): React.ReactElement => {
  const def = UNIT_DEFS[type];
  const afford = canAfford(snap.res, def.cost);
  const popOk = snap.popCur < snap.popCap;
  return (
    <Tip
      text={
        <span>
          <b className="text-[#e8c877]">{def.name}</b> — {def.desc}
          <br />
          HP {def.hp} · DMG {def.dmg} · {def.trainTime}s
        </span>
      }
    >
      <button
        className="btn flex-col !items-start !gap-0.5 !px-2 !py-1.5 w-[104px]"
        disabled={!afford || !popOk}
        onClick={click(() => game.uiTrain(type))}
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold">
          <span className="w-4 h-4 inline-block">
            <UnitIcon type={type} />
          </span>
          {def.name}
        </span>
        <span className="flex items-center gap-1 ml-0.5">
          <Cost cost={def.cost} res={snap.res} />
          <span className="text-[9px] text-[#9c8a63] ml-auto">
            {def.trainTime}s
          </span>
        </span>
        {!popOk && <span className="text-[9px] cost-bad">need housing</span>}
      </button>
    </Tip>
  );
};

const CommandCard = memo(
  ({ snap, game }: { snap: HudSnapshot; game: Game }): React.ReactElement => {
    const sel = snap.sel;
    return (
      <section
        className="panel pointer-events-auto px-3 py-2 min-w-[340px] max-w-[480px] z-20 anim-rise"
        aria-label="Selection and commands"
      >
        {snap.attackMoveMode && (
          <div className="text-[11px] text-[#ff9d8f] mb-1">
            ⚔ Attack-move armed — left-click a target point (Esc to cancel)
          </div>
        )}
        {snap.placement && (
          <div className="text-[11px] text-[#8ce08a] mb-1">
            Placing {BUILDING_DEFS[snap.placement].name} —{" "}
            {snap.placement === "wall" || snap.placement === "gate"
              ? "drag to draw a line"
              : "left-click to build"}{" "}
            (right-click / Esc to cancel)
          </div>
        )}
        {!sel && !snap.placement && (
          <div className="text-[11px] text-[#9c8a63] leading-relaxed py-1">
            <b className="text-[#c9b98e]">Drag</b> select ·{" "}
            <b className="text-[#c9b98e]">Right-click</b> move/gather/attack ·{" "}
            <b className="text-[#c9b98e]">Dbl-click</b> focus ·{" "}
            <b className="text-[#c9b98e]">A</b> attack-move ·{" "}
            <b className="text-[#c9b98e]">S</b> stop ·{" "}
            <b className="text-[#c9b98e]">Tab</b> idle villagers ·{" "}
            <b className="text-[#c9b98e]">1-5</b> groups (Ctrl to set) ·{" "}
            <b className="text-[#c9b98e]">F</b> focus ·{" "}
            <b className="text-[#c9b98e]">Home</b> fit kingdom ·{" "}
            <b className="text-[#c9b98e]">Space</b> center ·{" "}
            <b className="text-[#c9b98e]">F1</b> cinematic
          </div>
        )}
        {sel?.kind === "units" && (
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5 items-center">
              {(Object.entries(sel.counts) as Array<[UnitType, number]>).map(
                ([t, n]) => (
                  <Tip key={t} text={UNIT_DEFS[t].name}>
                    <span className="flex items-center gap-1 bg-[#2c2214aa] rounded-md px-2 py-1 border border-[#4d3b2688]">
                      <span className="w-4 h-4 inline-block">
                        <UnitIcon type={t} />
                      </span>
                      <span className="tabular-nums text-xs">{n}</span>
                    </span>
                  </Tip>
                ),
              )}
            </div>
            <div className="flex gap-1.5 ml-auto">
              <button
                className="btn !py-1.5"
                onClick={click(() => game.uiStop())}
                title="Stop (S)"
              >
                ■ Stop
              </button>
              {sel.hasMilitary && (
                <button
                  className={`btn !py-1.5 ${snap.attackMoveMode ? "active" : ""}`}
                  onClick={click(() => game.uiAttackMove())}
                  title="Attack-move (A): move while engaging everything on the way"
                >
                  ⚔ Attack
                </button>
              )}
              {sel.hasMilitary && (
                <button
                  className="btn !py-1.5"
                  onClick={click(() => game.cycleFormation())}
                  title="Cycle move formation (V): loose / line / column"
                >
                  ⠿ {["Loose", "Line", "Column"][snap.formation]}
                </button>
              )}
            </div>
          </div>
        )}
        {sel?.kind === "building" && sel.bType && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-5 h-5 inline-block text-[#d8b25c]">
                <BuildIcon type={sel.bType} />
              </span>
              <span className="font-semibold text-[13px]">
                {BUILDING_DEFS[sel.bType].name}
              </span>
              <span className="ml-auto text-[11px] tabular-nums text-[#c9b98e]">
                {Math.ceil(sel.bHp ?? 0)}/{sel.bMaxHp} HP
              </span>
            </div>
            <div className="h-1.5 rounded bg-[#1c140c] mb-2 overflow-hidden">
              <div
                className="h-full bg-[#69d44f] transition-[width] duration-200"
                style={{ width: `${((sel.bHp ?? 0) / (sel.bMaxHp || 1)) * 100}%` }}
              />
            </div>
            {!sel.bBuilt ? (
              <div className="text-[11px]">
                <div className="flex justify-between mb-1">
                  <span className="text-[#d8b25c]">
                    Under construction — {Math.floor((sel.bProgress ?? 0) * 100)}%
                  </span>
                  <span className="text-[#9c8a63]">
                    {sel.bBuilders ?? 0} builder{(sel.bBuilders ?? 0) === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-[#1c140c] overflow-hidden">
                  <div
                    className="h-full bg-[#d8b25c] transition-[width] duration-200"
                    style={{ width: `${(sel.bProgress ?? 0) * 100}%` }}
                  />
                </div>
                {(sel.bBuilders ?? 0) === 0 && (
                  <div className="text-[10px] cost-bad mt-1">
                    Select villagers, then right-click this site to build.
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-end gap-2 flex-wrap">
                <div className="flex gap-1.5 flex-wrap">
                  {(sel.canTrain ?? []).map((t) => (
                    <TrainButton key={t} type={t} snap={snap} game={game} />
                  ))}
                </div>
                <div className="ml-auto text-right">
                  {sel.bQueue && sel.bQueue.length > 0 && (
                    <>
                      <div className="flex gap-1 justify-end mb-1">
                        {sel.bQueue.map((q, i) => (
                          <span
                            key={i}
                            className={`w-4 h-4 inline-block ${i === 0 ? "text-[#e8c877]" : "text-[#7d6a45]"}`}
                          >
                            <UnitIcon type={q} />
                          </span>
                        ))}
                      </div>
                      <div className="h-1.5 w-[104px] rounded bg-[#1c140c] overflow-hidden">
                        <div
                          className="h-full bg-[#e8c877] transition-[width] duration-200"
                          style={{ width: `${(sel.bQueueT ?? 0) * 100}%` }}
                        />
                      </div>
                    </>
                  )}
                  <div className="text-[9px] text-[#9c8a63] mt-1">
                    right-click map to set rally
                  </div>
                </div>
              </div>
            )}
            {sel.bBuilt && sel.bType && (
              <UpgradePanel
                bType={sel.bType}
                research={sel.bResearch ?? null}
                snap={snap}
                game={game}
              />
            )}
            {sel.bBuilt && sel.bType === "market" && (
              <MarketPanel snap={snap} game={game} />
            )}
          </div>
        )}
      </section>
    );
  },
);
CommandCard.displayName = "CommandCard";

// ── upgrades & market ────────────────────────────────────────────────────────

const UpgradePanel = ({
  bType,
  research,
  snap,
  game,
}: {
  bType: BuildingType;
  research: { id: string; t: number } | null;
  snap: HudSnapshot;
  game: Game;
}): React.ReactElement | null => {
  const available = UPGRADES.filter(
    (u) => u.at === bType && !snap.upgrades.includes(u.id),
  );
  if (!available.length && !research) return null;
  const researching = research
    ? UPGRADES.find((u) => u.id === research.id)
    : null;
  return (
    <div className="mt-2 pt-2 border-t border-[#3a2d1c88]">
      <div className="text-[10px] uppercase tracking-wider text-[#9c8a63] mb-1">
        Upgrades
      </div>
      {researching && research && (
        <div className="mb-1.5">
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-[#e8c877]">{researching.name}</span>
            <span className="text-[#9c8a63]">
              {Math.floor(research.t * 100)}%
            </span>
          </div>
          <div className="h-1.5 rounded bg-[#1c140c] overflow-hidden">
            <div
              className="h-full bg-[#e8c877] transition-[width] duration-200"
              style={{ width: `${research.t * 100}%` }}
            />
          </div>
        </div>
      )}
      <div className="flex gap-1.5 flex-wrap">
        {available.map((u) => (
          <Tip key={u.id} text={<span><b className="text-[#e8c877]">{u.name}</b> — {u.desc}</span>}>
            <button
              className="btn flex-col !items-start !gap-0.5 !px-2 !py-1.5 w-[118px]"
              disabled={!canAfford(snap.res, u.cost) || !!research}
              onClick={click(() => game.uiResearch(u.id))}
            >
              <span className="text-[11px] font-semibold">{u.name}</span>
              <span className="flex items-center gap-1">
                <Cost cost={u.cost} res={snap.res} />
                <span className="text-[9px] text-[#9c8a63] ml-auto">
                  {u.time}s
                </span>
              </span>
            </button>
          </Tip>
        ))}
      </div>
    </div>
  );
};

const MarketPanel = ({
  snap,
  game,
}: {
  snap: HudSnapshot;
  game: Game;
}): React.ReactElement => (
  <div className="mt-2 pt-2 border-t border-[#3a2d1c88]">
    <div className="text-[10px] uppercase tracking-wider text-[#9c8a63] mb-1">
      Trade
    </div>
    <div className="flex gap-1.5 flex-wrap">
      {(Object.keys(MARKET) as Array<keyof typeof MARKET>).map((k) => (
        <button
          key={k}
          className="btn !py-1.5 !text-[11px]"
          disabled={!canAfford(snap.res, MARKET[k].give)}
          title={MARKET[k].label}
          onClick={click(() => game.uiExchange(k))}
        >
          {MARKET[k].label}
        </button>
      ))}
    </div>
  </div>
);

// ── build palette ────────────────────────────────────────────────────────────

const HOTKEYS = ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "[", "]"];

const BuildPalette = memo(
  ({ snap, game }: { snap: HudSnapshot; game: Game }): React.ReactElement => (
    <section className="panel pointer-events-auto px-2.5 py-2 z-20 anim-rise" aria-label="Build menu">
      <div className="text-[10px] uppercase tracking-wider text-[#9c8a63] mb-1.5 px-0.5">
        Build <span className="text-[#6f5f3f]">(Q–P)</span>
      </div>
      <div className="grid grid-cols-6 gap-1.5">
        {BUILD_ORDER.map((t: BuildingType, i) => {
          const def = BUILDING_DEFS[t];
          const afford = canAfford(snap.res, def.cost);
          return (
            <Tip
              key={t}
              text={
                <span>
                  <b className="text-[#e8c877]">{def.name}</b> — {def.desc}
                </span>
              }
            >
              <button
                className={`btn flex-col !items-start !gap-0.5 !px-2 !py-1.5 w-[84px] ${snap.placement === t ? "active" : ""}`}
                disabled={!afford}
                onClick={click(() =>
                  game.setPlacement(snap.placement === t ? null : t),
                )}
              >
                <span className="kbd">{HOTKEYS[i]}</span>
                <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <span className="w-4 h-4 inline-block text-[#d8b25c]">
                    <BuildIcon type={t} />
                  </span>
                  {def.name}
                </span>
                <span className="ml-0.5">
                  <Cost cost={def.cost} res={snap.res} />
                </span>
              </button>
            </Tip>
          );
        })}
      </div>
    </section>
  ),
);
BuildPalette.displayName = "BuildPalette";

// ── minimap ──────────────────────────────────────────────────────────────────

const MinimapPanel = ({
  game,
  mode,
}: {
  game: Game;
  mode: Settings["hudMode"];
}): React.ReactElement => {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    game.setMinimapCanvas(ref.current);
    return () => game.setMinimapCanvas(null);
  }, [game]);
  const big = mode === "full" || pinned || (mode === "auto" && hover);
  return (
    <aside
      className="panel pointer-events-auto p-1.5 z-20 anim-rise relative"
      aria-label="Minimap"
      data-testid="minimap"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <canvas
        ref={ref}
        width={200}
        height={200}
        className={`rounded-md cursor-crosshair transition-[width,height] duration-200 ${
          big ? "w-[188px] h-[188px]" : "w-[84px] h-[84px]"
        }`}
        style={{ imageRendering: "pixelated" }}
        aria-label="Strategic minimap — click to move the camera"
      />
      {mode !== "full" && (
        <button
          className="btn rail-pin"
          onClick={click(() => setPinned((p) => !p))}
          aria-label={big ? "Shrink minimap" : "Expand minimap"}
          title={big ? "Shrink minimap" : "Pin minimap open"}
          data-testid="minimap-pin"
        >
          {big ? "✕" : "⤢"}
        </button>
      )}
    </aside>
  );
};

// ── toasts ───────────────────────────────────────────────────────────────────

const Toasts = memo(
  ({ snap, compact }: { snap: HudSnapshot; compact: boolean }): React.ReactElement => (
  <div
    className={`absolute ${compact ? "bottom-[232px]" : "bottom-[248px]"} left-3 flex flex-col gap-1 z-20 pointer-events-none`}
    role="log"
    aria-live="polite"
  >
    {snap.messages.map((m) => (
      <div
        key={m.id}
        className={`panel !rounded-md px-2.5 py-1 text-[11px] max-w-[280px] anim-slidein ${
          m.kind === "bad"
            ? "!border-[#8e3a2a] text-[#ff9d8f]"
            : m.kind === "good"
              ? "!border-[#3a6b2a] text-[#8ce08a]"
              : "text-[#d8cba5]"
        }`}
      >
        {m.text}
      </div>
    ))}
  </div>
));
Toasts.displayName = "Toasts";

// ── HUD drawers & edge rails ─────────────────────────────────────────────────

/**
 * A drawer wraps any HUD panel. In "full" mode the panel is always shown.
 * In "auto"/"compact" modes a small edge chip (tab) is shown instead:
 *  - auto:    hover expands, leaving collapses (after a grace period)
 *  - compact: only an explicit click on the tab / chevron expands
 * Clicking the corner button pins (or unpins) the panel open.
 */
const DrawerPanel = ({
  mode,
  align,
  label,
  testId,
  tab,
  tabAsButton = true,
  children,
}: {
  mode: Settings["hudMode"];
  align: string;
  label: string;
  testId?: string;
  tab: React.ReactNode;
  tabAsButton?: boolean;
  children: React.ReactNode;
}): React.ReactElement => {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const timer = useRef<number | null>(null);
  const clearT = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearT, []);
  const full = mode === "full";
  const open = full || pinned || (mode === "auto" && hover);
  return (
    <div
      className={`${align} z-20 pointer-events-none`}
      data-testid={testId}
      data-drawer={label}
      onMouseEnter={() => {
        clearT();
        if (mode === "auto") setHover(true);
      }}
      onMouseLeave={() => {
        if (mode === "auto" && !pinned)
          timer.current = window.setTimeout(() => setHover(false), 260);
      }}
    >
      {!open ? (
        tabAsButton ? (
          <button
            className="btn rail-tab pointer-events-auto !px-2.5 !py-1.5 !text-[11px]"
            onClick={click(() => setPinned(true))}
            aria-label={`Expand ${label}`}
            title={`${label} — click to pin open${mode === "auto" ? " (or hover)" : ""}`}
          >
            {tab}
          </button>
        ) : (
          <div className="relative">
            {tab}
            <button
              className="btn rail-expand pointer-events-auto"
              onClick={click(() => setPinned(true))}
              aria-label={`Expand ${label}`}
              title={`Expand ${label}`}
            >
              ⯅
            </button>
          </div>
        )
      ) : (
        <div className="relative anim-drawerin">
          {children}
          {!full && (
            <button
              className="btn rail-pin pointer-events-auto"
              onClick={click(() => {
                if (pinned) {
                  setPinned(false);
                  setHover(false);
                } else setPinned(true);
              })}
              aria-label={pinned ? `Collapse ${label}` : `Pin ${label} open`}
              title={pinned ? "Collapse panel" : "Pin panel open"}
            >
              {pinned ? "✕" : "📌"}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** thin one-line command summary shown while the command drawer is collapsed */
const CommandStrip = ({ snap }: { snap: HudSnapshot }): React.ReactElement => {
  const sel = snap.sel;
  return (
    <div
      className="panel pointer-events-auto px-3 py-1.5 flex items-center gap-2 text-[11px] min-w-[260px] max-w-[520px]"
      data-testid="cmd-strip"
    >
      {snap.placement ? (
        <span className="text-[#8ce08a]">
          Placing {BUILDING_DEFS[snap.placement].name} — left-click to build ·
          right-click / Esc cancels
        </span>
      ) : snap.attackMoveMode ? (
        <span className="text-[#ff9d8f]">
          ⚔ Attack-move armed — left-click a target point (Esc to cancel)
        </span>
      ) : sel?.kind === "units" ? (
        <span className="flex items-center gap-2">
          {(Object.entries(sel.counts) as Array<[UnitType, number]>).map(
            ([t, n]) => (
              <span key={t} className="flex items-center gap-1">
                <span className="w-4 h-4 inline-block">
                  <UnitIcon type={t} />
                </span>
                <span className="tabular-nums">{n}</span>
              </span>
            ),
          )}
          <span className="text-[#8a7a58] ml-1">⯅ commands</span>
        </span>
      ) : sel?.kind === "building" && sel.bType ? (
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 inline-block text-[#d8b25c]">
            <BuildIcon type={sel.bType} />
          </span>
          <span>{BUILDING_DEFS[sel.bType].name}</span>
          <span className="text-[#8a7a58] ml-1">⯅ commands</span>
        </span>
      ) : (
        <span className="text-[#9c8a63]">
          <b className="text-[#c9b98e]">Drag</b> select ·{" "}
          <b className="text-[#c9b98e]">Right-click</b> command ·{" "}
          <b className="text-[#c9b98e]">Q…</b> build ·{" "}
          <b className="text-[#c9b98e]">F1</b> cinematic
        </span>
      )}
    </div>
  );
};
CommandStrip.displayName = "CommandStrip";

/** icon-only build rail shown while the build drawer is collapsed */
const BuildRail = memo(
  ({ snap, game }: { snap: HudSnapshot; game: Game }): React.ReactElement => (
    <section className="panel pointer-events-auto px-1.5 py-1.5" aria-label="Build quick rail">
      <div className="grid grid-cols-2 gap-1">
        {BUILD_ORDER.map((t: BuildingType, i) => {
          const def = BUILDING_DEFS[t];
          const afford = canAfford(snap.res, def.cost);
          return (
            <button
              key={t}
              className={`btn !p-1 !w-[34px] !h-[32px] flex items-center justify-center ${snap.placement === t ? "active" : ""}`}
              disabled={!afford}
              onClick={click(() =>
                game.setPlacement(snap.placement === t ? null : t),
              )}
              aria-label={`Build ${def.name}`}
              title={`${def.name} (${HOTKEYS[i]})`}
            >
              <span className="w-[20px] h-[20px] inline-block text-[#d8b25c]">
                <BuildIcon type={t} />
              </span>
              <span className="kbd">{HOTKEYS[i]}</span>
            </button>
          );
        })}
      </div>
    </section>
  ),
);
BuildRail.displayName = "BuildRail";

/** right-edge camera controls — accessibility fallback for wheel/pinch zoom */
const ZoomControls = ({ game }: { game: Game }): React.ReactElement => (
  <div
    className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1 z-20 pointer-events-none"
    data-testid="zoom-controls"
    aria-label="Camera controls"
  >
    <button
      className="btn pointer-events-auto !px-2.5 !py-1"
      onClick={click(() => game.zoomBy(1.18))}
      aria-label="Zoom in"
      title="Zoom in (+)"
    >
      +
    </button>
    <button
      className="btn pointer-events-auto !px-2.5 !py-1"
      onClick={click(() => game.zoomBy(1 / 1.18))}
      aria-label="Zoom out"
      title="Zoom out (−)"
    >
      −
    </button>
    <button
      className="btn pointer-events-auto !px-2 !py-1"
      onClick={click(() => game.fitKingdom())}
      aria-label="Fit kingdom"
      title="Fit kingdom (Home)"
    >
      ⌂
    </button>
    <button
      className="btn pointer-events-auto !px-2 !py-1"
      onClick={click(() => game.focusSelection())}
      aria-label="Focus selection"
      title="Focus selection (F)"
    >
      ◎
    </button>
  </div>
);

/** F1 cinematic / photo mode: letterbox bars + fading hint, zero HUD */
const CinematicOverlay = (): React.ReactElement => (
  <div
    data-testid="cine-bars"
    className="absolute inset-0 pointer-events-none z-40"
    aria-hidden="true"
  >
    <div className="cine-bar absolute top-0 left-0 right-0 h-[6.5vh]" />
    <div className="cine-bar cine-bar-b absolute bottom-0 left-0 right-0 h-[6.5vh]" />
    <div className="cine-hint absolute top-[8.5vh] left-1/2 -translate-x-1/2 text-[11px] text-[#c9b98e] bg-[#0a0c08cc] border border-[#4d3b2688] rounded-full px-3.5 py-1 whitespace-nowrap">
      🎥 Cinematic mode — pan/zoom still active · <b>F1</b> or <b>Esc</b> to
      exit
    </div>
  </div>
);

// ── overlays ─────────────────────────────────────────────────────────────────

const EndOverlay = ({
  snap,
  game,
}: {
  snap: HudSnapshot;
  game: Game;
}): React.ReactElement => {
  const win = snap.phase === "victory";
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[#0a0c08d9] pointer-events-auto anim-fadein"
      role="dialog"
      aria-modal="true"
      aria-label={win ? "Victory screen" : "Defeat screen"}
    >
      <div className="panel px-12 py-9 text-center max-w-[480px] anim-rise">
        <h1
          className={`font-medieval text-5xl font-bold tracking-wide mb-3 ${win ? "gold-title anim-glow" : "text-[#e0503e]"}`}
        >
          {win ? "VICTORY" : "DEFEAT"}
        </h1>
        <p className="text-[13px] text-[#c9b98e] mb-5">
          {win
            ? snap.missionName
              ? "Mission complete — the campaign continues!"
              : "The enemy keep lies in ruins. The realm is yours!"
            : "Your keep has fallen. The realm mourns…"}
        </p>
        <div className="grid grid-cols-3 gap-3 mb-6 text-center">
          <div className="bg-[#221a10aa] rounded-lg py-2 border border-[#4d3b2688]">
            <div className="text-lg tabular-nums text-[#e8c877]">
              {fmtTime(snap.time)}
            </div>
            <div className="text-[10px] text-[#9c8a63] uppercase">Duration</div>
          </div>
          <div className="bg-[#221a10aa] rounded-lg py-2 border border-[#4d3b2688]">
            <div className="text-lg tabular-nums text-[#8ce08a]">{snap.kills}</div>
            <div className="text-[10px] text-[#9c8a63] uppercase">Kills</div>
          </div>
          <div className="bg-[#221a10aa] rounded-lg py-2 border border-[#4d3b2688]">
            <div className="text-lg tabular-nums text-[#ff9d8f]">{snap.losses}</div>
            <div className="text-[10px] text-[#9c8a63] uppercase">Losses</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 mb-4 text-center text-[10px]">
          <div className="bg-[#221a10aa] rounded-lg py-1.5 border border-[#4d3b2688]">
            <div className="tabular-nums text-[#a3e07a] text-[13px]">
              {snap.stats.gathered.wood + snap.stats.gathered.food + snap.stats.gathered.stone + snap.stats.gathered.gold}
            </div>
            <div className="text-[#9c8a63]">Gathered</div>
          </div>
          <div className="bg-[#221a10aa] rounded-lg py-1.5 border border-[#4d3b2688]">
            <div className="tabular-nums text-[#8fb7ff] text-[13px]">{snap.stats.trained}</div>
            <div className="text-[#9c8a63]">Trained</div>
          </div>
          <div className="bg-[#221a10aa] rounded-lg py-1.5 border border-[#4d3b2688]">
            <div className="tabular-nums text-[#e8c877] text-[13px]">{snap.stats.built}</div>
            <div className="text-[#9c8a63]">Built</div>
          </div>
          <div className="bg-[#221a10aa] rounded-lg py-1.5 border border-[#4d3b2688]">
            <div className="tabular-nums text-[#c9b98e] text-[13px]">{snap.stats.peakPop}</div>
            <div className="text-[#9c8a63]">Peak pop</div>
          </div>
        </div>
        {snap.achievements.length > 0 && (
          <div className="mb-4 text-[10px] text-[#9c8a63]">
            🏅 {snap.achievements.join(" · ")}
          </div>
        )}
        <button
          className="btn !px-8 !py-2.5 font-medieval tracking-widest gold-title mx-auto"
          onClick={click(() => game.restart())}
          autoFocus
        >
          ⚔ PLAY AGAIN
        </button>
      </div>
    </div>
  );
};

// ── root HUD ─────────────────────────────────────────────────────────────────

export const Hud = ({
  game,
  settings,
  setSettings,
}: {
  game: Game;
  settings: Settings;
  setSettings: (s: Settings) => void;
}): React.ReactElement => {
  const snap = useSyncExternalStore(game.subscribe, game.getSnapshot);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfiler, setShowProfiler] = useState(false);
  const [cine, setCine] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const hudMode = settings.hudMode ?? "auto";
  const full = hudMode === "full";

  // track native fullscreen state (graceful fallback when unavailable)
  useEffect(() => {
    const h = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  // F1 cinematic · F3 profiler · Esc closes the top-most layer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "F1") {
        e.preventDefault();
        setCine((v) => !v);
      } else if (e.code === "F3") {
        e.preventDefault();
        setShowProfiler((x) => !x);
      } else if (e.key === "Escape") {
        if (showSettings) setShowSettings(false);
        else if (showProfiler) setShowProfiler(false);
        else setCine(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings, showProfiler]);

  // cinematic only makes sense inside a live match
  useEffect(() => {
    if (snap.phase !== "playing" && cine) setCine(false);
  }, [snap.phase, cine]);

  const toggleFullscreen = () => {
    try {
      if (document.fullscreenElement) {
        const p = document.exitFullscreen?.();
        if (p) void p.catch(() => undefined);
        return;
      }
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => void;
      };
      if (el.requestFullscreen)
        void el.requestFullscreen().catch(() =>
          game.msg("Fullscreen was blocked by the browser.", "info"),
        );
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else game.msg("Fullscreen is not supported in this browser.", "info");
    } catch {
      game.msg("Fullscreen is not available here.", "info");
    }
  };

  const objText =
    snap.mode === "survival"
      ? `Survive ${Math.ceil(snap.timeLeft / 60)} min`
      : snap.mode === "siege"
        ? "Crack the keep in time"
        : "Destroy the enemy keep";
  const tutDone = TUT_ITEMS.filter((i2) => snap.tut[i2.key]).length;
  const showTutorial =
    !snap.missionName && !snap.tutorialSkipped && tutDone < TUT_ITEMS.length;
  const objDone = snap.objectives.filter((o) => o.done).length;

  return (
    <div className="absolute inset-0 pointer-events-none">
      {!cine && (
        <div className="pointer-events-auto">
          <TopBar
            snap={snap}
            game={game}
            onSettings={() => setShowSettings(true)}
            onCine={() => setCine(true)}
            isFs={isFs}
            onFullscreen={toggleFullscreen}
          />
        </div>
      )}
      {snap.phase === "playing" && !cine && (
        <>
          <Toasts snap={snap} compact={!full} />
          <DrawerPanel
            mode={hudMode}
            align={full ? "absolute top-24 left-3" : "absolute top-14 left-3"}
            label="Popularity"
            testId="drawer-pop"
            tab={
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-4 inline-block">
                  <HappyIcon level={snap.popularity} />
                </span>
                <span className="tabular-nums">{snap.popularity}%</span>
              </span>
            }
          >
            <PopularityPanel snap={snap} game={game} />
          </DrawerPanel>
          {showTutorial && (
            <DrawerPanel
              mode={hudMode}
              align="absolute top-14 right-3"
              label="Tutorial"
              testId="drawer-tut"
              tab={
                <span>
                  📜 Tutorial {tutDone}/{TUT_ITEMS.length}
                </span>
              }
            >
              <TutorialPanel snap={snap} game={game} />
            </DrawerPanel>
          )}
          {snap.missionName && (
            <DrawerPanel
              mode={hudMode}
              align="absolute top-14 right-3"
              label="Mission objectives"
              testId="drawer-mission"
              tab={
                <span>
                  ◎ {objDone}/{snap.objectives.length} objectives
                </span>
              }
            >
              <aside
                className="panel pointer-events-auto px-3 py-2 w-[248px] anim-slidein"
                aria-label="Mission objectives"
              >
                <div className="text-[10px] uppercase tracking-wider text-[#c4a86e] mb-1">
                  {snap.missionName}
                </div>
                <div className="flex flex-col gap-1">
                  {snap.objectives.map((o) => (
                    <div
                      key={o.label}
                      className={`flex items-start gap-1.5 text-[10.5px] leading-snug ${o.done ? "text-[#7da568]" : "text-[#f0e6cc]"}`}
                    >
                      <span className="mt-[1px]">{o.done ? "✓" : "○"}</span>
                      <span>{o.label}</span>
                    </div>
                  ))}
                </div>
              </aside>
            </DrawerPanel>
          )}
          {snap.replayMode && snap.replay && (
            <div
              className="pointer-events-auto absolute top-14 left-1/2 -translate-x-1/2 panel px-4 py-2 flex items-center gap-2.5 z-30 anim-rise w-[560px]"
              aria-label="Replay playback controls"
            >
              <span className="text-[11px] font-semibold text-[#e8c877] shrink-0">
                ⏵ REPLAY
              </span>
              <button
                className="btn !px-2 !py-0.5 !text-[10px]"
                title="Restart replay"
                onClick={click(() => game.replaySeek(0))}
              >
                ⏮
              </button>
              <button
                className="btn !px-2 !py-0.5 !text-[10px]"
                title="Back 10s"
                onClick={click(() => game.replaySeek(snap.replay!.time - 10))}
              >
                -10s
              </button>
              <button
                className="btn !px-2.5 !py-0.5 !text-[10px]"
                title="Play/pause"
                onClick={click(() => game.togglePause())}
              >
                {snap.replay.paused ? "▶" : "❚❚"}
              </button>
              <button
                className="btn !px-2 !py-0.5 !text-[10px]"
                title="Forward 10s"
                onClick={click(() => game.replaySeek(snap.replay!.time + 10))}
              >
                +10s
              </button>
              <input
                type="range"
                aria-label="Replay timeline"
                min={0}
                max={Math.max(1, Math.round(snap.replay.duration))}
                step={1}
                value={Math.round(snap.replay.time)}
                className="flex-1 accent-[#d8b25c]"
                onChange={(e) => game.replaySeek(parseFloat(e.target.value))}
              />
              <span className="text-[10px] tabular-nums text-[#c9b98e] shrink-0 w-[76px] text-right">
                {fmtTime(snap.replay.time)} / {fmtTime(snap.replay.duration)}
              </span>
              <button
                className="btn !px-2 !py-0.5 !text-[10px]"
                title="Playback speed"
                onClick={click(() => game.toggleSpeed())}
              >
                x{snap.speed}
              </button>
              <button
                className="btn !px-2 !py-0.5 !text-[10px]"
                title="Exit replay"
                onClick={click(() => game.exitReplay())}
              >
                ✕
              </button>
            </div>
          )}
          <div className="absolute bottom-3 left-3 pointer-events-none">
            <MinimapPanel game={game} mode={hudMode} />
          </div>
          <DrawerPanel
            mode={hudMode}
            align="absolute bottom-3 left-1/2 -translate-x-1/2"
            label="Commands"
            testId="drawer-cmd"
            tabAsButton={false}
            tab={<CommandStrip snap={snap} />}
          >
            <CommandCard snap={snap} game={game} />
          </DrawerPanel>
          <DrawerPanel
            mode={hudMode}
            align="absolute bottom-3 right-3"
            label="Build menu"
            testId="drawer-build"
            tabAsButton={false}
            tab={<BuildRail snap={snap} game={game} />}
          >
            <BuildPalette snap={snap} game={game} />
          </DrawerPanel>
          {full ? (
            <section
              className="absolute top-16 left-3 panel px-3 py-1.5 text-[11px] z-20 anim-slidein"
              aria-label="Objectives and army overview"
            >
              <span className="text-[#9c8a63]">Objective:</span>{" "}
              <span className="text-[#e8c877]">{objText}</span>
              <span className="mx-1 text-[#4d3b26]">|</span>
              <span className="text-[#9c8a63]">
                {MODES.find((m) => m.id === snap.mode)?.name ?? "Skirmish"} · vs{" "}
                {snap.lordName} ({snap.difficultyName})
              </span>
              {snap.timeLeft > 0 && (
                <>
                  <span className="mx-1 text-[#4d3b26]">|</span>
                  <span className="tabular-nums text-[#e8c13c]">
                    ⏳ {fmtTime(snap.timeLeft)}
                  </span>
                </>
              )}
              <span className="mx-2 text-[#4d3b26]">|</span>
              <span className="text-[#9c8a63]">Villagers</span>{" "}
              <span className="tabular-nums">{snap.villagers}</span>
              <span className="mx-2 text-[#4d3b26]">|</span>
              <span className="text-[#9c8a63]">Army</span>{" "}
              <span className="tabular-nums">{snap.army}</span>
            </section>
          ) : (
            !snap.replayMode && (
              <div
                data-testid="objective-chip"
                className="absolute top-[52px] left-1/2 -translate-x-1/2 panel !rounded-full px-3 py-[3px] text-[10.5px] z-10 pointer-events-none flex items-center gap-2.5 anim-rise whitespace-nowrap"
              >
                <span className="text-[#e8c877]">◎ {objText}</span>
                {snap.timeLeft > 0 && (
                  <span className="tabular-nums text-[#e8c13c]">
                    ⏳ {fmtTime(snap.timeLeft)}
                  </span>
                )}
                <span className="text-[#9c8a63]">
                  vs {snap.lordName} ({snap.difficultyName})
                </span>
                <span className="text-[#9c8a63]">👷 {snap.villagers}</span>
                <span className="text-[#9c8a63]">⚔ {snap.army}</span>
              </div>
            )
          )}
          <ZoomControls game={game} />
          {snap.paused && (
            <div className="absolute top-[50%] left-1/2 -translate-x-1/2 -translate-y-1/2 panel px-8 py-3 font-medieval text-2xl gold-title tracking-[0.3em] z-30 anim-rise">
              PAUSED
            </div>
          )}
        </>
      )}
      {snap.phase === "playing" && cine && <CinematicOverlay />}
      {snap.phase === "menu" && (
        <div className="pointer-events-auto">
          <SetupScreen
            game={game}
            settings={settings}
            setSettings={setSettings}
          />
        </div>
      )}
      {showSettings && (
        <SettingsOverlay
          settings={settings}
          setSettings={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showProfiler && (
        <Profiler game={game} onClose={() => setShowProfiler(false)} />
      )}
      {(snap.phase === "victory" || snap.phase === "defeat") && (
        <EndOverlay snap={snap} game={game} />
      )}
    </div>
  );
};
