export declare const VOICE_RMS = 200;
export declare function frameRms(frame: Buffer): number;
export declare class PauseDetector {
    private peak;
    private silentRun;
    update(rms: number): {
        silent: boolean;
        silentFrames: number;
        voice: boolean;
    };
    reset(): void;
}
