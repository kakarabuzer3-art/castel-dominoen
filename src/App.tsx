import { useEffect, useRef, useState } from "react";
import { sfx } from "./game/audio";
import { Game } from "./game/engine";
import { loadSettings, saveSettings, type Settings } from "./game/settings";
import { Hud } from "./ui/Hud";

export default function App(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());

  const setSettings = (s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
    gameRef.current?.applySettings(s);
  };
  const gameRef = useRef<Game | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const s0 = loadSettings();
    const g = new Game(canvasRef.current, undefined, undefined, s0);
    g.applySettings(s0);
    gameRef.current = g;
    setGame(g);
    // debug/test hook (used by the headless browser test)
    (window as unknown as { __game: Game }).__game = g;
    // initial snapshot push so the HUD renders the menu state
    g.publish(true);
    return () => {
      g.dispose();
      gameRef.current = null;
      setGame(null);
    };
  }, []);

  useEffect(() => {
    const unlock = () => sfx.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && game) {
        if (game.phase === "menu") {
          e.preventDefault();
          game.startGame();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game]);

  const zoom = [0.9, 1, 1.12][settings.uiScale] * [0.94, 1, 1.08][settings.textSize];
  return (
    <main
      className={`relative w-full h-full overflow-hidden bg-[#0d0f0a] select-none ${settings.highContrast ? "hc" : ""}`}
      aria-label="Castle Dominion — medieval kingdom real-time strategy game"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        aria-label="Game world viewport"
      />
      {game && (
        <div data-hud className="absolute inset-0 pointer-events-none" style={{ zoom }}>
          <Hud game={game} settings={settings} setSettings={setSettings} />
        </div>
      )}
    </main>
  );
}
