/**
 * Dual-engine Loud Alarm System for New Order Alerts
 * 1. Primary: Web Audio API synthesized urgent emergency siren (works with zero asset loading latency)
 * 2. Secondary: HTML5 Audio element fallback using /new_order_alarm.mp3
 * 3. Haptic: Mobile device vibration pattern
 */

class AlarmManager {
  private audioCtx: AudioContext | null = null;
  private isPlaying: boolean = false;
  private timerId: any = null;
  private vibrationInterval: any = null;
  private fallbackAudio: HTMLAudioElement | null = null;
  private isUnlocked: boolean = false;

  constructor() {
    if (typeof window !== "undefined") {
      // Create fallback audio element
      try {
        this.fallbackAudio = new Audio("/new_order_alarm.mp3");
        this.fallbackAudio.loop = true;
        this.fallbackAudio.preload = "auto";
      } catch (e) {
        console.warn("[Alarm] Fallback audio element init:", e);
      }

      // Pre-bind unlock on first user gesture
      const unlock = () => {
        this.unlockAudio();
        window.removeEventListener("click", unlock);
        window.removeEventListener("touchstart", unlock);
        window.removeEventListener("keydown", unlock);
      };
      window.addEventListener("click", unlock, { once: true });
      window.addEventListener("touchstart", unlock, { once: true });
      window.addEventListener("keydown", unlock, { once: true });
    }
  }

  public unlockAudio(): boolean {
    try {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          this.audioCtx = new AudioContextClass();
        }
      }
      if (this.audioCtx && this.audioCtx.state === "suspended") {
        this.audioCtx.resume();
      }
      this.isUnlocked = true;
      return true;
    } catch (e) {
      console.warn("[Alarm] Audio context unlock error:", e);
      return false;
    }
  }

  public isAudioUnlocked(): boolean {
    return this.isUnlocked && this.audioCtx?.state === "running";
  }

  /**
   * Synthesize a loud, fast repeating dual-frequency emergency alarm pulse
   */
  private playSirenBeep(highTone: boolean) {
    if (!this.audioCtx) return;
    try {
      if (this.audioCtx.state === "suspended") {
        this.audioCtx.resume();
      }

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      // Urgent dual-tone siren: 880Hz (A5) and 1250Hz (E6)
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(
        highTone ? 1250 : 880,
        this.audioCtx.currentTime
      );

      // Fast attack, sustained loud volume, quick decay
      gain.gain.setValueAtTime(0.01, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.85, this.audioCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.18);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.2);
    } catch (err) {
      console.warn("[Alarm] Siren synth error:", err);
    }
  }

  /**
   * Start the continuous loud repeating alarm
   */
  public startAlarm() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.unlockAudio();

    // Start fallback audio element if available
    if (this.fallbackAudio) {
      try {
        this.fallbackAudio.currentTime = 0;
        const playPromise = this.fallbackAudio.play();
        if (playPromise) {
          playPromise.catch((err) => {
            console.warn("[Alarm] Audio element play prevented (using Web Audio synth):", err);
          });
        }
      } catch (e) {
        // Fallback to Web Audio
      }
    }

    // Rapid dual-tone siren loop: 220ms per pulse
    let isHigh = false;
    this.playSirenBeep(isHigh);
    this.timerId = setInterval(() => {
      if (!this.isPlaying) {
        clearInterval(this.timerId);
        return;
      }
      isHigh = !isHigh;
      this.playSirenBeep(isHigh);
    }, 220);

    // Mobile vibration pattern: 300ms vibrate, 150ms rest, 300ms vibrate
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate([300, 150, 300, 150, 600]);
        this.vibrationInterval = setInterval(() => {
          if (!this.isPlaying) {
            clearInterval(this.vibrationInterval);
            return;
          }
          navigator.vibrate([300, 150, 300, 150, 600]);
        }, 1600);
      } catch (e) {
        console.warn("[Alarm] Vibration failed:", e);
      }
    }
  }

  /**
   * Stop the alarm immediately
   */
  public stopAlarm() {
    this.isPlaying = false;

    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    if (this.vibrationInterval) {
      clearInterval(this.vibrationInterval);
      this.vibrationInterval = null;
    }

    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(0);
      } catch (e) {
        // ignore
      }
    }

    if (this.fallbackAudio) {
      try {
        this.fallbackAudio.pause();
        this.fallbackAudio.currentTime = 0;
      } catch (e) {
        // ignore
      }
    }
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }
}

export const alarmAudio = new AlarmManager();
