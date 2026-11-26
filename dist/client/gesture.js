export const TAP_MS = 350;
export const SLOP_PX = 12;
export const CANCEL_PX = 65;
export function press(at, x, y) {
    return { downAt: at, x, y, moved: false, cancelArmed: false };
}
export function move(track, x, y) {
    const moved = track.moved || Math.hypot(x - track.x, y - track.y) > SLOP_PX;
    return { ...track, moved, cancelArmed: track.y - y > CANCEL_PX };
}
export function isHold(track, at) {
    return at - track.downAt >= TAP_MS || track.moved;
}
export function release(track, at) {
    if (track.cancelArmed)
        return 'cancel';
    if (!isHold(track, at))
        return 'handsFree';
    return 'finish';
}
