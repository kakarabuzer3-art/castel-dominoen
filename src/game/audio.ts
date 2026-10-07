/**
 * Synthesized sound effects via WebAudio — no audio assets.
 * All calls are safe no-ops in headless environments or when muted.
 */
type SfxName =
  | "click"
  | "place"
  | "complete"
  | "train"
  | "chop"
  | "mine"
  | "arrow"
  | "hit"
  | "explode"
  | "horn"
  | "victory"
  | "defeat"
  | "error";

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private ambientSrc: AudioBufferSourceNode | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  enabled = true;
  alerts = true;
  private vols = { master: 0.8, music: 0.5, sfx: 0.9, ambient: 0.5 };
  private lastPlayed: Record<string, number> = {};

  /** must be called from a user gesture at least once */
  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.ambientBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.master);
      this.ambientBus.connect(this.master);
      this.applyVols();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (this.enabled) {
      this.startAmbient();
      this.startMusic();
    }
  }

  configure(cfg: {
    sound: boolean;
    master: number;
    music: number;
    sfx: number;
    ambient: number;
    alerts: boolean;
  }): void {
    this.enabled = cfg.sound;
    this.alerts = cfg.alerts;
    this.vols = {
      master: cfg.master,
      music: cfg.music,
      sfx: cfg.sfx,
      ambient: cfg.ambient,
    };
    this.applyVols();
    if (cfg.sound && this.ctx) {
      this.startAmbient();
      this.startMusic();
    } else if (!cfg.sound) {
      this.stopAmbient();
      this.stopMusic();
    }
  }

  private applyVols(): void {
    if (!this.ctx || !this.master || !this.sfxBus || !this.musicBus || !this.ambientBus)
      return;
    this.master.gain.value = this.enabled ? this.vols.master * 0.5 : 0;
    this.sfxBus.gain.value = this.vols.sfx;
    this.musicBus.gain.value = this.vols.music * 0.5;
    this.ambientBus.gain.value = this.vols.ambient * 0.35;
  }

  /** desert wind / forest air: looped filtered noise */
  private startAmbient(): void {
    if (!this.ctx || !this.ambientBus || this.ambientSrc) return;
    const len = this.ctx.sampleRate * 3;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.2;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 420;
    const g = this.ctx.createGain();
    g.gain.value = 0.5;
    src.connect(f).connect(g).connect(this.ambientBus);
    src.start();
    this.ambientSrc = src;
  }

  private stopAmbient(): void {
    if (this.ambientSrc) {
      try {
        this.ambientSrc.stop();
      } catch {
        /* already stopped */
      }
      this.ambientSrc = null;
    }
  }

  /** generative medieval-flavoured drone & melody, scheduled lightly */
  private startMusic(): void {
    if (this.musicTimer !== null || !this.ctx) return;
    const scale = [146.83, 174.61, 196.0, 220.0, 261.63, 293.66, 349.23]; // D dorian
    const playBar = () => {
      if (!this.ctx || !this.musicBus) return;
      const step = this.musicStep++;
      // drone every 4 bars
      if (step % 4 === 0) {
        const root = scale[0] / 2;
        for (const det of [0, 0.7]) {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = "triangle";
          o.frequency.value = root + det;
          g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
          g.gain.linearRampToValueAtTime(0.16, this.ctx.currentTime + 1.2);
          g.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 7.5);
          o.connect(g).connect(this.musicBus);
          o.start();
          o.stop(this.ctx.currentTime + 8);
        }
      }
      // sparse plucked melody
      if (Math.random() < 0.75) {
        const n = scale[(Math.random() * scale.length) | 0];
        const t0 = this.ctx.currentTime + Math.random() * 2.4;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = "sine";
        o.frequency.value = n * (Math.random() < 0.3 ? 2 : 1);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
        o.connect(g).connect(this.musicBus);
        o.start(t0);
        o.stop(t0 + 1.8);
      }
    };
    playBar();
    this.musicTimer = window.setInterval(playBar, 3800);
  }

  private stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.unlock();
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol = 0.5,
    slideTo?: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.sfxBus ?? this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, vol = 0.4, freq = 1200, q = 0.8, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.sfxBus ?? this.master);
    src.start(t0);
  }

  play(name: SfxName): void {
    if (!this.enabled || typeof window === "undefined") return;
    if (name === "horn" && !this.alerts) return;
    if (!this.ctx) return; // not unlocked yet → silent
    const now = performance.now();
    // rate-limit repetitive sounds
    const gap = name === "chop" || name === "mine" || name === "hit" || name === "arrow" ? 90 : 40;
    if (now - (this.lastPlayed[name] ?? 0) < gap) return;
    this.lastPlayed[name] = now;

    switch (name) {
      case "click":
        this.tone(660, 0.06, "triangle", 0.25);
        break;
      case "error":
        this.tone(180, 0.14, "square", 0.18, 120);
        break;
      case "place":
        this.tone(220, 0.1, "triangle", 0.4, 160);
        this.noise(0.08, 0.2, 500, 1);
        break;
      case "complete":
        this.tone(523, 0.1, "triangle", 0.35);
        this.tone(659, 0.1, "triangle", 0.35, undefined, 0.09);
        this.tone(784, 0.16, "triangle", 0.35, undefined, 0.18);
        break;
      case "train":
        this.tone(392, 0.08, "square", 0.16);
        this.tone(523, 0.1, "square", 0.14, undefined, 0.07);
        break;
      case "chop":
        this.noise(0.07, 0.35, 900, 1.4);
        this.tone(140, 0.06, "triangle", 0.25, 90);
        break;
      case "mine":
        this.noise(0.06, 0.3, 2400, 2);
        this.tone(800, 0.05, "square", 0.1, 600);
        break;
      case "arrow":
        this.noise(0.09, 0.22, 3000, 1.2);
        this.tone(900, 0.08, "sine", 0.12, 300);
        break;
      case "hit":
        this.noise(0.06, 0.3, 700, 1);
        this.tone(220, 0.05, "square", 0.14, 140);
        break;
      case "explode":
        this.noise(0.4, 0.5, 220, 0.6);
        this.tone(90, 0.35, "sine", 0.4, 40);
        break;
      case "horn":
        this.tone(196, 0.5, "sawtooth", 0.22);
        this.tone(261, 0.5, "sawtooth", 0.18, undefined, 0.05);
        this.tone(196, 0.6, "sawtooth", 0.2, undefined, 0.45);
        break;
      case "victory":
        this.tone(523, 0.16, "triangle", 0.4);
        this.tone(659, 0.16, "triangle", 0.4, undefined, 0.15);
        this.tone(784, 0.16, "triangle", 0.4, undefined, 0.3);
        this.tone(1046, 0.5, "triangle", 0.4, undefined, 0.45);
        break;
      case "defeat":
        this.tone(392, 0.3, "triangle", 0.35, 330);
        this.tone(311, 0.35, "triangle", 0.35, 262, 0.28);
        this.tone(233, 0.7, "triangle", 0.35, 196, 0.56);
        break;
    }
  }
}

export const sfx = new Sfx();
export type { SfxName };
