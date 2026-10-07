/**
 * Adaptive performance governor (Phase 10, Checkpoint B).
 *
 * Watches the *measured* frame and simulation cost and walks an explicit
 * quality ladder down before the player ever sees a slideshow — and back up
 * again when the machine recovers. Design rules:
 *
 *  1. It only ever changes **presentation** budgets (particles drawn/spawned,
 *     device-pixel-ratio scale, water/cloud/glow effects, unit level-of-detail,
 *     3D shadows and terrain tessellation). It never changes simulation
 *     rules, never consumes the deterministic RNG and never touches state that
 *     feeds `stateHash()`, so lockstep multiplayer and replays are unaffected.
 *  2. It is **optional and bounded**: the user's Graphics → Quality choice is
 *     the ceiling, "Adaptive quality" can be switched off entirely, and the
 *     ladder can never push a player off the renderer they explicitly picked.
 *  3. Automatic 3D → 2D fallback is the *last* rung, latched once, and only
 *     when the renderer preference is "auto".
 */

export type Tier = 0 | 1 | 2 | 3;

export interface QualityState {
  /** adaptive governor enabled (Settings → Graphics → Adaptive quality) */
  auto: boolean;
  /** effective rung of the ladder, 3 = everything on */
  tier: Tier;
  /** ceiling derived from Settings → Quality (0/1/2 → 1/2/3) */
  cap: Tier;
  /** how many rungs below the ceiling we currently sit */
  degraded: number;
  dprScale: number;
  /** engine-side particle spawn budget */
  particleCap: number;
  /** renderer-side particle draw budget */
  particleDraw: number;
  /** 0 = far blobs, 1 = simplified, 2 = full detail */
  unitDetail: 0 | 1 | 2;
  waterFx: boolean;
  clouds: boolean;
  glow: boolean;
  shadows3d: boolean;
  /** 1 = halve 3D terrain tessellation */
  terrainLod: 0 | 1;
  /** human readable, surfaced in the F3 profiler */
  reason: string;
  /** measured inputs (EMA, ms): true frame cost and sim cost within it */
  frameMs: number;
  tickMs: number;
  /** rough scene load estimate: units + buildings*1.5 + tiles/2000 */
  load: number;
  samples: number;
  /** set once when the governor itself gave up on 3D */
  fellBackTo2D: boolean;
}

interface TierFx {
  dprScale: number;
  particleCap: number;
  particleDraw: number;
  unitDetail: 0 | 1 | 2;
  waterFx: boolean;
  clouds: boolean;
  glow: boolean;
  shadows3d: boolean;
  terrainLod: 0 | 1;
}

/** the ladder, index = tier */
export const TIER_FX: TierFx[] = [
  {
    dprScale: 0.7,
    particleCap: 90,
    particleDraw: 120,
    unitDetail: 0,
    waterFx: false,
    clouds: false,
    glow: false,
    shadows3d: false,
    terrainLod: 1,
  },
  {
    dprScale: 0.85,
    particleCap: 180,
    particleDraw: 220,
    unitDetail: 1,
    waterFx: true,
    clouds: false,
    glow: true,
    shadows3d: false,
    terrainLod: 1,
  },
  {
    dprScale: 1,
    particleCap: 300,
    particleDraw: 380,
    unitDetail: 2,
    waterFx: true,
    clouds: true,
    glow: true,
    shadows3d: true,
    terrainLod: 0,
  },
  {
    dprScale: 1,
    particleCap: 420,
    particleDraw: 520,
    unitDetail: 2,
    waterFx: true,
    clouds: true,
    glow: true,
    shadows3d: true,
    terrainLod: 0,
  },
];

/**
 * Thresholds in ms. `frame` is the *true* frame cost — the wall-clock gap
 * between rAF callbacks (or the JS render time when that is somehow larger).
 * It must not be the JS-side render duration alone: WebGL submission returns
 * before the GPU finishes, which under-reported a 4 fps scene as 11 ms and
 * stopped the ladder from ever descending.
 *   bad  > 26 ms  → below ~38 fps
 *   good < 18 ms  → above ~55 fps (a healthy 60 Hz frame is 16.7 ms)
 * `tick` is the sim cost inside that frame (up to 6 ticks of catch-up).
 */
const BAD_FRAME = 26;
const BAD_TICK = 14;
const GOOD_FRAME = 18;
const GOOD_TICK = 6;
/** scene load above which we pre-emptively drop a rung (XL map / epic army) */
const HEAVY_LOAD = 850;
const VERY_HEAVY_LOAD = 1500;
const DOWN_COOLDOWN = 1.5;
const UP_COOLDOWN = 3;
const GOOD_HOLD = 4;
const FALLBACK_HOLD = 6;

export function tierFromQuality(quality: 0 | 1 | 2): Tier {
  return (quality + 1) as Tier;
}

export class PerfGovernor {
  state: QualityState = {
    auto: true,
    tier: 3,
    cap: 3,
    degraded: 0,
    ...TIER_FX[3],
    reason: "full quality",
    frameMs: 0,
    tickMs: 0,
    load: 0,
    samples: 0,
    fellBackTo2D: false,
  };

  private evalT = 0;
  private goodT = 0;
  private badT = 0;
  /** seconds spent below the frame threshold — the fallback latch's signal */
  private slowFrameT = 0;
  private cooldown = 0;
  private fallbackAsked = false;

  /** call on a new match: clears history, keeps the user's ceiling */
  reset(opts?: { auto?: boolean; cap?: Tier; load?: number }): void {
    const cap = opts?.cap ?? this.state.cap;
    const auto = opts?.auto ?? this.state.auto;
    this.evalT = 0;
    this.goodT = 0;
    this.badT = 0;
    this.slowFrameT = 0;
    this.cooldown = 0;
    this.fallbackAsked = false;
    let tier = cap;
    let reason = "user quality preset";
    // pre-emptive degradation: a huge map or an epic army starts one rung down
    // (two on very heavy scenes) so the first seconds are smooth instead of
    // waiting for a slideshow to be measured.
    const load = opts?.load ?? 0;
    if (auto) {
      if (load >= VERY_HEAVY_LOAD && cap > 1) {
        tier = 1;
        reason = "huge scene — starting reduced";
      } else if (load >= HEAVY_LOAD && cap > 2) {
        tier = 2;
        reason = "large scene — starting reduced";
      }
    }
    this.apply(tier, reason, cap, auto);
    this.state.load = load;
    this.state.frameMs = 0;
    this.state.tickMs = 0;
    this.state.samples = 0;
    this.state.fellBackTo2D = false;
  }

  setAuto(auto: boolean): void {
    if (this.state.auto === auto) return;
    this.state.auto = auto;
    if (!auto) this.apply(this.state.cap, "adaptive quality off", this.state.cap, false);
    else this.reset({ auto: true, cap: this.state.cap, load: this.state.load });
  }

  setCap(cap: Tier): void {
    if (this.state.cap === cap) return;
    this.reset({ cap, auto: this.state.auto, load: this.state.load });
  }

  private apply(tier: Tier, reason: string, cap = this.state.cap, auto = this.state.auto): void {
    const fx = TIER_FX[tier];
    this.state = {
      ...this.state,
      ...fx,
      tier,
      cap,
      auto,
      degraded: cap - tier,
      reason,
    };
  }

  /**
   * Feed one rendered frame. `dt` is wall seconds since the previous sample.
   * Cheap: the ladder is only re-evaluated ~2x per second.
   */
  sample(dt: number, frameMs: number, tickMs: number, load: number): void {
    const s = this.state;
    s.frameMs = frameMs;
    s.tickMs = tickMs;
    s.load = load;
    s.samples++;
    if (!s.auto) return;

    this.evalT += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const bad = frameMs > BAD_FRAME || tickMs > BAD_TICK;
    const good = frameMs < GOOD_FRAME && tickMs < GOOD_TICK;
    this.badT = bad ? this.badT + dt : 0;
    this.goodT = good ? this.goodT + dt : 0;
    this.slowFrameT = frameMs > BAD_FRAME ? this.slowFrameT + dt : 0;

    if (this.evalT < 0.5) return;
    this.evalT = 0;

    if (bad && this.cooldown <= 0 && s.tier > 0) {
      this.apply(
        (s.tier - 1) as Tier,
        `frame ${frameMs.toFixed(1)} ms / sim ${tickMs.toFixed(1)} ms — reducing detail`,
      );
      this.goodT = 0;
      this.cooldown = DOWN_COOLDOWN;
      return;
    }
    if (good && this.goodT >= GOOD_HOLD && this.cooldown <= 0 && s.tier < s.cap) {
      this.apply(
        (s.tier + 1) as Tier,
        `headroom recovered (frame ${frameMs.toFixed(1)} ms) — restoring detail`,
      );
      this.badT = 0;
      this.cooldown = UP_COOLDOWN;
    }
  }

  /**
   * True once, when the bottom rung is still not enough. The engine uses this
   * to switch a 3D renderer back to 2D — only when the player left the
   * renderer on "auto" (it guards that itself, so the latch is never spent on
   * a page that is already 2D). The trigger is *frame*-driven: if the sim is
   * the bottleneck, swapping rasterisers would not help and only costs the
   * player the 3D view.
   */
  shouldFallBackTo2D(): boolean {
    const s = this.state;
    if (this.fallbackAsked || !s.auto || s.fellBackTo2D) return false;
    if (s.tier > 0 || this.slowFrameT < FALLBACK_HOLD) return false;
    this.fallbackAsked = true;
    s.fellBackTo2D = true;
    s.reason = "still slow at minimum detail — switched to the 2D renderer";
    return true;
  }

  /** let the engine re-arm the fallback latch after it actually switched */
  clearFallbackLatch(): void {
    this.fallbackAsked = false;
  }
}
