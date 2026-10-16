import { memo } from "react";
import type { HudSnapshot } from "../game/types";

/**
 * "People" section of the popularity drawer (Phase 2).
 *  - one villager selected -> that person: mood, traits, needs, the reasons
 *    for their mood (built from the very numbers that produce it) and memories
 *  - otherwise -> a village summary with the unhappiest people
 * Pure presentation of HudSnapshot.mind / HudSnapshot.moods.
 */

const NEED_ROWS = [
  ["food", "Food"],
  ["safety", "Safety"],
  ["belonging", "Company"],
  ["purpose", "Purpose"],
] as const;

const barColor = (v: number): string =>
  v >= 55 ? "bg-[#8ce08a]" : v >= 40 ? "bg-[#e8c13c]" : "bg-[#e0503e]";

const signed = (d: number): string => (d > 0 ? `+${d}` : `${d}`);

export const MindSection = memo(
  ({ snap }: { snap: HudSnapshot }): React.ReactElement | null => {
    const m = snap.mind;
    const v = snap.moods;

    if (m) {
      return (
        <section
          className="mt-2 pt-2 border-t border-[#3a2a16]"
          aria-label={`${m.name}: ${m.label}, mood ${m.mood} of 100`}
          data-testid="mind-card"
        >
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="text-[11px] font-semibold text-[#f6ecd2] truncate">
              {m.name}
            </span>
            <span className="ml-auto text-[10px] text-[#c4a86e]">{m.label}</span>
            <span className="tabular-nums text-[11px] text-[#f6ecd2]">{m.mood}</span>
          </div>
          <div className="h-1 rounded bg-[#1c140c] mb-1.5 overflow-hidden">
            <div
              className={`h-full transition-[width] duration-300 ${barColor(m.mood)}`}
              style={{ width: `${m.mood}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {m.traits.map((t) => (
              <span
                key={t.id}
                title={t.blurb}
                className="text-[9.5px] px-1.5 py-[1px] rounded bg-[#2a1d0f] text-[#d8b25c] border border-[#4a3518]"
              >
                {t.name}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-[2px] mb-1.5">
            {NEED_ROWS.map(([id, label]) => (
              <div key={id} className="flex items-center gap-1.5 text-[9.5px]">
                <span className="w-[46px] text-[#9c8a63]">{label}</span>
                <div className="flex-1 h-[3px] rounded bg-[#1c140c] overflow-hidden">
                  <div
                    className={`h-full ${barColor(m.needs[id])}`}
                    style={{ width: `${m.needs[id]}%` }}
                  />
                </div>
                <span className="w-5 text-right tabular-nums text-[#8a7a58]">
                  {m.needs[id]}
                </span>
              </div>
            ))}
          </div>
          {m.why.length > 0 && (
            <div className="mb-1">
              <div className="text-[9px] uppercase tracking-wider text-[#c4a86e] mb-[2px]">
                Why they feel this way
              </div>
              {m.why.map((w, i) => (
                <div key={`${w.label}-${i}`} className="flex items-start gap-1.5 text-[10px] leading-snug">
                  <span
                    className={`w-7 shrink-0 text-right tabular-nums ${w.delta > 0 ? "text-[#8ce08a]" : "text-[#ff9d8f]"}`}
                  >
                    {signed(w.delta)}
                  </span>
                  <span className="text-[#c9b98e]">{w.text}</span>
                </div>
              ))}
            </div>
          )}
          {m.memories.length > 0 && (
            <div className="text-[9.5px] text-[#8a7a58] leading-snug">
              {m.memories.map((e, i) => (
                <div key={`${e.text}-${i}`}>
                  <span className={e.mag < 0 ? "text-[#ff9d8f]" : "text-[#8ce08a]"}>●</span>{" "}
                  {e.text}
                </div>
              ))}
            </div>
          )}
        </section>
      );
    }

    if (v.named === 0) return null;
    return (
      <section
        className="mt-2 pt-2 border-t border-[#3a2a16]"
        aria-label="People of the village"
        data-testid="mind-summary"
      >
        <div className="flex items-center text-[10px] mb-1">
          <span className="text-[11px] uppercase tracking-wider text-[#c4a86e]">People</span>
          <span className="ml-auto text-[#9c8a63]">
            {v.named} named · mood{" "}
            <span className="tabular-nums text-[#f6ecd2]">{v.avgMood}</span>
          </span>
        </div>
        {v.unhappy > 0 && (
          <div className="text-[10px] text-[#ff9d8f] mb-1">
            {v.unhappy} unhappy{v.desperate > 0 ? ` · ${v.desperate} desperate` : ""}
          </div>
        )}
        {v.worst.length > 0 && v.worst[0].mood < 55 && (
          <div className="text-[9.5px] text-[#8a7a58] leading-snug">
            Unhappiest:{" "}
            {v.worst
              .filter((p) => p.mood < 55)
              .map((p) => `${p.name} (${p.mood})`)
              .join(", ")}
          </div>
        )}
        <div className="text-[9px] text-[#6f5f3f] mt-1 leading-snug">
          Select a villager to see who they are and why they feel as they do.
        </div>
      </section>
    );
  },
);
MindSection.displayName = "MindSection";
