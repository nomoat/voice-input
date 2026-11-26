export const TAP_MS = 350;
export const SLOP_PX = 12;
export const CANCEL_PX = 65;

export type Release = 'handsFree' | 'finish' | 'cancel';

export interface PressTrack {
  downAt: number;
  x: number;
  y: number;
  moved: boolean;
  cancelArmed: boolean;
}

export function press(at: number, x: number, y: number): PressTrack {
  return { downAt: at, x, y, moved: false, cancelArmed: false };
}

export function move(track: PressTrack, x: number, y: number): PressTrack {
  const moved = track.moved || Math.hypot(x - track.x, y - track.y) > SLOP_PX;
  return { ...track, moved, cancelArmed: track.y - y > CANCEL_PX };
}

export function isHold(track: PressTrack, at: number): boolean {
  return at - track.downAt >= TAP_MS || track.moved;
}

export function release(track: PressTrack, at: number): Release {
  if (track.cancelArmed) return 'cancel';
  if (!isHold(track, at)) return 'handsFree';
  return 'finish';
}
