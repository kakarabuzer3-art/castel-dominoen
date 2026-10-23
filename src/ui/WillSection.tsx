import { memo } from "react";
import { DECREE, WILL, type DecreeKind } from "../game/minds";
import type { HudSnapshot } from "../game/types";

/**
 * "Castle will" section of the popularity drawer (Phase 3b-2).
 *  - how steady the castle's people are (resolve 0..100) and what that means
 *  - a visible countdown when the gates are about to open
 *  - the two decrees: reassure your own people, or whisper among the enemy's
 * Pure presentation of HudSnapshot.moods; the buttons call back into the game.
 */

const LABEL = { steady: "Steady", wavering: "Wavering", breaking: "Losing heart" } as const;
const COLOR = {
  steady: { text: "text-[#8ce08a]", bar: "bg-[#8ce08a]" },
  wavering: { text: "text-[#e8c13c]", bar: "bg-[#e8c13c]" },
  breaking: { text: "text-[#ff9d8f]", bar: "bg-[#e0503e]" },
} as const;

const DECREES: Array<{ kind: DecreeKind; name: string; blurb: string }> = [
  {
    kind: "reassure",
    name: "Reassure",
    blurb:
      "Address your own people: every bad rumor they hold loses most of its grip, and they remember your word for a while.",
  },
  {
    kind: "whisper",
    name: "Whisper",
    blurb:
      "Send agents to plant the rumor “the keep is doomed” among the enemy's people. It is not true; it spreads, then fades.",
  },
];

export const WillSection = memo(
  ({
    snap,
    onDecree,
  }: {
    snap: HudSnapshot;
    onDecree: (kind: DecreeKind) => void;
  }): React.ReactElement | null => {
    const v = snap.moods;
    if (v.named === 0) return null;
    const c = COLOR[v.will];
    const gold = snap.res.gold;

    return (
      <section
        className="mt-2 pt-2 border-t border-[#3a2a16]"
        aria-label={`Castle will: ${LABEL[v.will]}, resolve ${v.resolve} of 100`}
        data-testid="will-section"
      >
        <div className="flex items-center text-[10px] mb-1">
          <span className="text-[11px] uppercase tracking-wider text-[#c4a86e]">Castle will</span>
          <span className={`ml-auto ${c.text}`} data-testid="will-state">
            {LABEL[v.will]}{" "}
            <span className="tabular-nums text-[#f6ecd2]">{v.resolve}</span>
          </span>
        </div>
        <div
          className="relative h-1.5 rounded bg-[#1c140c] mb-1 overflow-hidden"
          title={`Below ${WILL.waverBelow}: wavering. At ${WILL.breakBelow} or less while an army stands at the gates: the people may open them.`}
        >
          <div
            className={`h-full transition-[width] duration-300 ${c.bar}`}
            style={{ width: `${v.resolve}%` }}
          />
          <div
            className="absolute top-0 bottom-0 w-px bg-[#6f5f3f]"
            style={{ left: `${WILL.breakBelow}%` }}
          />
          <div
            className="absolute top-0 bottom-0 w-px bg-[#6f5f3f]"
            style={{ left: `${WILL.waverBelow}%` }}
          />
        </div>
        {v.yieldIn >= 0 && (
          <div
            className="text-[10px] cost-bad mb-1 leading-snug"
            role="status"
            aria-live="polite"
            data-testid="will-countdown"
          >
            ⚠ Your people may open the gates in{" "}
            <span className="tabular-nums">{v.yieldIn}</span>s — feed them, reassure them, or drive the army back.
          </div>
        )}
        <div className="flex gap-1">
          {DECREES.map((d) => {
            const wait = v.decree[d.kind];
            const cost = DECREE[d.kind].gold;
            const broke = gold < cost;
            const disabled = snap.replayMode || wait > 0 || broke;
            return (
              <button
                key={d.kind}
                type="button"
                disabled={disabled}
                onClick={() => onDecree(d.kind)}
                title={`${d.blurb} Costs ${cost} gold.`}
                aria-label={`${d.name} decree, ${cost} gold${wait > 0 ? `, ready in ${wait} seconds` : ""}`}
                data-testid={`decree-${d.kind}`}
                className="flex-1 text-[10px] px-1.5 py-1 rounded border border-[#4a3518] bg-[#2a1d0f] text-[#d8b25c] enabled:hover:bg-[#3a2814] disabled:opacity-50 disabled:cursor-not-allowed pointer-events-auto"
              >
                <span className="block">{d.name}</span>
                <span className={`block tabular-nums ${wait > 0 ? "text-[#9c8a63]" : broke ? "cost-bad" : "cost-good"}`}>
                  {wait > 0 ? `${wait}s` : `${cost} gold`}
                </span>
              </button>
            );
          })}
        </div>
        <div className="text-[9px] text-[#6f5f3f] mt-1 leading-snug">
          A castle whose people lose heart while an army stands at its gates may open them — for either side.
        </div>
      </section>
    );
  },
);
WillSection.displayName = "WillSection";
