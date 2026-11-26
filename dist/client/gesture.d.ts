export declare const TAP_MS = 350;
export declare const SLOP_PX = 12;
export declare const CANCEL_PX = 65;
export type Release = 'handsFree' | 'finish' | 'cancel';
export interface PressTrack {
    downAt: number;
    x: number;
    y: number;
    moved: boolean;
    cancelArmed: boolean;
}
export declare function press(at: number, x: number, y: number): PressTrack;
export declare function move(track: PressTrack, x: number, y: number): PressTrack;
export declare function isHold(track: PressTrack, at: number): boolean;
export declare function release(track: PressTrack, at: number): Release;
