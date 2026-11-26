import { FRAME_SAMPLES } from '../protocol.js';

export const VOICE_RMS = 200;

export function frameRms(frame: Buffer): number {
  const samples = Math.min(FRAME_SAMPLES, Math.floor(frame.length / 2));
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = frame.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

export class PauseDetector {
  private peak = 0;
  private silentRun = 0;

  update(rms: number): { silent: boolean; silentFrames: number; voice: boolean } {
    this.peak = Math.max(rms, this.peak * 0.99);
    const threshold = Math.max(110, this.peak * 0.12);
    const silent = rms < threshold;
    this.silentRun = silent ? this.silentRun + 1 : 0;
    return { silent, silentFrames: this.silentRun, voice: rms >= VOICE_RMS };
  }

  reset(): void {
    this.silentRun = 0;
  }
}
