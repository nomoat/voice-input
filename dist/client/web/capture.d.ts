import type { CaptureFactory } from '../session.js';
export declare function createResampler(sourceRate: number): (input: Float32Array) => Int16Array;
export interface WebCaptureOptions {
    constraints?: MediaTrackConstraints;
}
export declare function webCapture(options?: WebCaptureOptions): CaptureFactory;
