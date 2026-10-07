/**
 * Persistent player settings. Plain data + localStorage; the App pushes the
 * object into Game/Renderer/Audio via game.applySettings().
 */
export interface Settings {
  // GAMEPLAY
  gameSpeed: 0 | 1 | 2; // slow / normal / fast
  tutorial: boolean;
  autosave: boolean;
  pauseOnBlur: boolean;
  screenShake: boolean;
  cameraSmoothing: boolean;
  fog: boolean;
  panSpeed: number; // 0.6 – 1.8
  zoomSpeed: number; // 0.6 – 1.8
  /**
   * HUD density. "auto" collapses big panels to edge rails that expand on
   * hover/click; "compact" only expands on explicit click; "full" is the
   * classic always-visible layout.
   */
  hudMode: "auto" | "compact" | "full";
  // AUDIO
  sound: boolean;
  masterVol: number;
  musicVol: number;
  sfxVol: number;
  ambientVol: number;
  alerts: boolean;
  // GRAPHICS
  quality: 0 | 1 | 2; // performance / balanced / quality
  /**
   * Adaptive quality: measure real frame/sim cost and walk the quality ladder
   * down (particles, DPR, water/cloud effects, unit LOD, 3D shadows) before
   * the game becomes a slideshow — and back up when headroom returns. Quality
   * above is the ceiling; switching this off pins that ceiling exactly.
   */
  qualityAuto: boolean;
  renderer: "auto" | "3d" | "2d";
  shadows: boolean;
  particles: boolean;
  waterFx: boolean;
  dayNight: boolean;
  reducedFx: boolean;
  uiScale: 0 | 1 | 2; // 90% / 100% / 112%
  defaultZoom: number; // 0.8 – 1.4
  // ACCESSIBILITY
  textSize: 0 | 1 | 2;
  highContrast: boolean;
  reducedMotion: boolean;
  clearColors: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  gameSpeed: 1,
  tutorial: true,
  autosave: true,
  pauseOnBlur: true,
  screenShake: true,
  cameraSmoothing: true,
  fog: false,
  panSpeed: 1,
  zoomSpeed: 1,
  hudMode: "auto",
  sound: true,
  masterVol: 0.8,
  musicVol: 0.5,
  sfxVol: 0.9,
  ambientVol: 0.5,
  alerts: true,
  quality: 1,
  qualityAuto: true,
  renderer: "auto",
  shadows: true,
  particles: true,
  waterFx: true,
  dayNight: true,
  reducedFx: false,
  uiScale: 1,
  defaultZoom: 1,
  textSize: 1,
  highContrast: false,
  reducedMotion: false,
  clearColors: false,
};

export const SETTINGS_KEY = "castle-dominion-settings-v1";

export function loadSettings(): Settings {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export const SPEED_MULT = [0.6, 1, 1.6] as const;
