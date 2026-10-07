import { useEffect, useRef, useState } from "react";
import type { Game } from "../game/engine";

interface BenchResult {
  fps: number;
  renderer: string;
  quality: number;
  date: number;
  recommended: number;
}

const BENCH_KEY = "castle-dominion-gpu-bench";

export function loadBench(): BenchResult | null {
  try {
    const raw = localStorage.getItem(BENCH_KEY);
    return raw ? (JSON.parse(raw) as BenchResult) : null;
  } catch {
    return null;
  }
}

/** In-game performance profiler / GPU benchmark (F3). */
export const Profiler = ({
  game,
  onClose,
}: {
  game: Game;
  onClose: () => void;
}): React.ReactElement => {
  const [fps, setFps] = useState(0);
  const [bench, setBench] = useState<BenchResult | null>(() => loadBench());
  const [benching, setBenching] = useState(false);
  const [, force] = useState(0);
  const frames = useRef(0);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      frames.current++;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const iv = setInterval(() => {
      setFps(frames.current);
      frames.current = 0;
      force((x) => x + 1);
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(iv);
    };
  }, []);

  const runBenchmark = () => {
    if (benching) return;
    setBenching(true);
    const samples: number[] = [];
    let n = 0;
    const t0 = performance.now();
    const tick = () => {
      n++;
      const el = performance.now() - t0;
      if (el < 4000) requestAnimationFrame(tick);
      else {
        const measured = Math.round((n * 1000) / el);
        samples.push(measured);
        const recommended = measured >= 50 ? 2 : measured >= 32 ? 1 : 0;
        const res: BenchResult = {
          fps: measured,
          renderer: game.renderer?.kind ?? "2d",
          quality: game.settings.quality,
          date: Date.now(),
          recommended,
        };
        try {
          localStorage.setItem(BENCH_KEY, JSON.stringify(res));
        } catch {
          /* ignore */
        }
        setBench(res);
        setBenching(false);
      }
    };
    requestAnimationFrame(tick);
  };

  const st =
    game.renderer?.kind === "3d" ? game.renderer.stats() : null;

  return (
    <div
      className="absolute top-14 left-1/2 -translate-x-1/2 panel px-4 py-3 w-[300px] z-40 pointer-events-auto anim-rise"
      role="dialog"
      aria-label="Performance profiler"
    >
      <div className="flex items-center mb-2">
        <span className="text-[11px] uppercase tracking-wider text-[#c4a86e]">
          Profiler (F3)
        </span>
        <button className="btn ml-auto !px-2 !py-0.5" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
        <span className="text-[#9c8a63]">Renderer</span>
        <span className="text-right text-[#e8c877]">{game.renderer?.kind}</span>
        <span className="text-[#9c8a63]">FPS (this device)</span>
        <span className="text-right">{fps}</span>
        <span className="text-[#9c8a63]">Frame ms (render)</span>
        <span className="text-right">{game.perfFrameMs.toFixed(2)}</span>
        <span className="text-[#9c8a63]">Frame ms (rAF gap)</span>
        <span className="text-right">{game.perfIntervalMs.toFixed(2)}</span>
        <span className="text-[#9c8a63]">Tick ms (sim)</span>
        <span className="text-right">{game.perfTickMs.toFixed(2)}</span>
        <span className="text-[#9c8a63]">Units / particles</span>
        <span className="text-right">
          {game.units.length} / {game.particles.length}
        </span>
        <span className="text-[#9c8a63]">Map / epic</span>
        <span className="text-right">
          {game.grid.w}×{game.grid.h} / {game.cfg.epic ? "on" : "off"}
        </span>
        <span className="text-[#9c8a63]">Scene load</span>
        <span className="text-right">{Math.round(game.sceneLoad())}</span>
        <span className="text-[#9c8a63]">Adaptive quality</span>
        <span className="text-right text-[#e8c877]">
          {game.perf.state.auto
            ? `tier ${game.perf.state.tier}/${game.perf.state.cap}`
            : "off"}
        </span>
        <span className="text-[#9c8a63]">Render scale</span>
        <span className="text-right">
          {Math.round(game.perf.state.dprScale * 100)}%
        </span>
        <span className="text-[#9c8a63]">Particle budget</span>
        <span className="text-right">
          {game.perf.state.particleCap} / draw {game.perf.state.particleDraw}
        </span>
        <span className="text-[#9c8a63]">Unit detail</span>
        <span className="text-right">
          {["blobs", "simple", "full", "full"][game.perf.state.unitDetail]}
        </span>
        <span className="col-span-2 text-[10px] text-[#9c8a63] leading-snug">
          {game.perf.state.reason}
          {game.perf.state.fellBackTo2D ? " (auto 2D fallback fired)" : ""}
        </span>
        {st && (
          <>
            <span className="text-[#9c8a63]">Draw calls</span>
            <span className="text-right">{st.calls}</span>
            <span className="text-[#9c8a63]">Triangles</span>
            <span className="text-right">{st.tris}</span>
            <span className="text-[#9c8a63]">Instances</span>
            <span className="text-right">{st.instances}</span>
          </>
        )}
      </div>
      <button
        className="btn w-full justify-center mt-2 !py-1.5"
        onClick={runBenchmark}
        disabled={benching}
      >
        {benching ? "Benchmarking 4s…" : "Run 4s GPU benchmark"}
      </button>
      {bench && (
        <div className="text-[10px] text-[#9c8a63] mt-1.5 leading-snug">
          Last device benchmark: <b className="text-[#c9b98e]">{bench.fps} fps</b>{" "}
          on {bench.renderer} / quality {bench.quality} → recommended preset{" "}
          {["Performance", "Balanced", "Quality"][bench.recommended]}.
          <br />
          <i>(device-reported; headless CI numbers are not representative)</i>
        </div>
      )}
    </div>
  );
};
