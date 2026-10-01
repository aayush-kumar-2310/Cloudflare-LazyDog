import { Agent, type Connection } from "agents";
import {
  WorkersAIFluxSTT,
  WorkersAITTS,
  withVoice,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { lazyDog } from "../agent/client";

const VoiceAgent = withVoice(Agent, { historyLimit: 0, maxMessageCount: 200 });

/**
 * Speech in, speech out — and nothing else.
 *
 * `withVoice` provides the audio pipeline (Workers AI Flux STT with model
 * turn detection, sentence-chunked Workers AI TTS). The conversation itself
 * is not held here: each finished utterance becomes a turn on the user's
 * LazyDog (channel "voice"), so voice shares history, memory, tools, and the
 * activity log with every other channel. One bridge per user, same name as
 * the user's LazyDog.
 */
export class VoiceBridge extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI, { keyterms: ["LazyDog", "Cloudflare", "Workers"] });
  tts = new WorkersAITTS(this.env.AI);

  #activeSpeaker: string | null = null;

  // Push-to-talk UI: one speaker at a time per user.
  beforeCallStart(connection: Connection) {
    if (this.#activeSpeaker && this.#activeSpeaker !== connection.id) return false;
    this.#activeSpeaker = connection.id;
    return true;
  }

  onCallEnd(connection: Connection) {
    if (this.#activeSpeaker === connection.id) this.#activeSpeaker = null;
  }

  afterTranscribe(transcript: string) {
    // Ignore coughs and clicks that transcribe to a word or two.
    return transcript.trim().length < 3 ? null : transcript;
  }

  async onTurn(transcript: string, _context: VoiceTurnContext) {
    const agent = await lazyDog(this.env, this.name);
    return agent.voiceTurn(transcript);
  }
}
