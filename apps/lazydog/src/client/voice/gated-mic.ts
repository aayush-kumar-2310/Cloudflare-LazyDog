import type { VoiceAudioInput } from "agents/voice/client";

/** Resamples the mic to 16 kHz mono and posts 100 ms Float32 chunks. */
const WORKLET = `
class GatedCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = []; this.ratio = sampleRate / 16000; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += this.ratio) {
      const idx = Math.floor(i), frac = i - idx;
      this.buffer.push(idx + 1 < ch.length ? ch[idx] * (1 - frac) + ch[idx + 1] * frac : ch[idx]);
    }
    if (this.buffer.length >= 1600) {
      const chunk = new Float32Array(this.buffer);
      this.port.postMessage(chunk, [chunk.buffer]);
      this.buffer = [];
    }
    return true;
  }
}
registerProcessor("lazydog-gated-capture", GatedCaptureProcessor);`;

/**
 * Push-to-talk microphone for `useVoiceAgent`.
 *
 * Muting the stock client stops sending audio, and the streaming STT session
 * then times out — which also ends the call and cuts off reply playback. This
 * input instead always sends frames, but they are silence unless the gate is
 * open (button held), so nothing said between presses reaches the agent.
 */
export class GatedMicInput implements VoiceAudioInput {
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData: ((pcm: ArrayBuffer) => void) | null = null;
  open = false;

  #stream: MediaStream | null = null;
  #ctx: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;

  async start() {
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.#ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.#ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.#node = new AudioWorkletNode(this.#ctx, "lazydog-gated-capture");
    this.#node.port.onmessage = (event: MessageEvent<Float32Array>) => this.#frame(event.data);
    this.#ctx.createMediaStreamSource(this.#stream).connect(this.#node);
    // Keep the graph pulling audio without playing the mic back.
    const sink = this.#ctx.createGain();
    sink.gain.value = 0;
    this.#node.connect(sink).connect(this.#ctx.destination);
  }

  stop() {
    this.#node?.disconnect();
    this.#stream?.getTracks().forEach((t) => t.stop());
    void this.#ctx?.close();
    this.#node = null;
    this.#stream = null;
    this.#ctx = null;
    this.open = false;
  }

  #frame(samples: Float32Array) {
    const pcm = new DataView(new ArrayBuffer(samples.length * 2));
    let sum = 0;
    if (this.open) {
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        sum += s * s;
        pcm.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
      }
    } // closed gate: the buffer stays zero-filled (silence)
    this.onAudioLevel?.(this.open ? Math.sqrt(sum / samples.length) : 0);
    this.onAudioData?.(pcm.buffer);
  }
}
