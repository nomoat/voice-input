import { SAMPLE_RATE } from '../../protocol.js';
export function createResampler(sourceRate) {
    if (!Number.isFinite(sourceRate) || sourceRate < 8000 || sourceRate > 192_000)
        throw new Error('Unsupported microphone sample rate');
    const ratio = sourceRate / SAMPLE_RATE;
    let fill = 0;
    let sum = 0;
    return (input) => {
        const out = [];
        for (let i = 0; i < input.length; i++) {
            const sample = input[i];
            let remaining = 1;
            while (remaining > 1e-9) {
                const take = Math.min(remaining, ratio - fill);
                sum += sample * take;
                fill += take;
                remaining -= take;
                if (fill >= ratio - 1e-9) {
                    const value = Math.max(-1, Math.min(1, sum / ratio));
                    out.push(Math.round(value * (value < 0 ? 32768 : 32767)));
                    fill = 0;
                    sum = 0;
                }
            }
        }
        return Int16Array.from(out);
    };
}
const WORKLET = `class VoiceInputTap extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.size = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) {
        let s = 0;
        for (let c = 0; c < input.length; c++) s += input[c][i] || 0;
        this.buffer[this.size++] = s / input.length;
        if (this.size === this.buffer.length) { this.port.postMessage(this.buffer.slice(0)); this.size = 0; }
      }
    }
    return true;
  }
}
registerProcessor('voice-input-tap', VoiceInputTap);`;
async function tapLoaded(context) {
    if (!context.audioWorklet)
        return false;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
        await context.audioWorklet.addModule(url);
        return true;
    }
    catch {
        return false;
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
export function webCapture(options = {}) {
    return async (sink) => {
        const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!Context || !navigator.mediaDevices?.getUserMedia)
            throw new Error('Microphone is not available');
        const context = new Context();
        let stream;
        let stopped = false;
        const cleanup = [];
        const stop = () => {
            if (stopped)
                return;
            stopped = true;
            for (const fn of cleanup.splice(0)) {
                try {
                    fn();
                }
                catch {
                    undefined;
                }
            }
            stream?.getTracks().forEach((t) => t.stop());
            void context.close().catch(() => undefined);
        };
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...options.constraints },
            });
            if (context.state === 'suspended')
                await context.resume();
            const resample = createResampler(context.sampleRate);
            const source = context.createMediaStreamSource(stream);
            const deliver = (data) => {
                if (!stopped)
                    sink.samples(resample(data));
            };
            if (await tapLoaded(context)) {
                const node = new AudioWorkletNode(context, 'voice-input-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
                node.port.onmessage = (event) => deliver(event.data);
                source.connect(node);
                cleanup.push(() => {
                    node.port.onmessage = null;
                    source.disconnect();
                    node.disconnect();
                });
            }
            else {
                const node = context.createScriptProcessor(2048, 1, 1);
                node.onaudioprocess = (event) => deliver(event.inputBuffer.getChannelData(0));
                source.connect(node);
                node.connect(context.destination);
                cleanup.push(() => {
                    node.onaudioprocess = null;
                    source.disconnect();
                    node.disconnect();
                });
            }
            const track = stream.getAudioTracks()[0];
            if (track) {
                const ended = () => sink.interrupted();
                const muted = () => sink.interrupted();
                const unmuted = () => sink.resumed();
                track.addEventListener('ended', ended);
                track.addEventListener('mute', muted);
                track.addEventListener('unmute', unmuted);
                cleanup.push(() => {
                    track.removeEventListener('ended', ended);
                    track.removeEventListener('mute', muted);
                    track.removeEventListener('unmute', unmuted);
                });
            }
            const onState = () => {
                if (context.state === 'interrupted')
                    sink.interrupted();
                else if (context.state === 'running')
                    sink.resumed();
            };
            context.addEventListener('statechange', onState);
            cleanup.push(() => context.removeEventListener('statechange', onState));
        }
        catch (error) {
            stop();
            throw error;
        }
        return { stop };
    };
}
