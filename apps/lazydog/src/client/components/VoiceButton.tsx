import { useVoiceAgent } from "@cloudflare/voice/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { GatedMicInput } from "../voice/gated-mic";

// A short tail after release so the end of the last word isn't clipped.
const RELEASE_TAIL_MS = 250;
// Hang up after this long without a press, once nothing is being said.
const IDLE_HANGUP_MS = 60_000;

/**
 * Push-to-talk. The first press starts a call; holding opens the mic gate,
 * releasing closes it (silence keeps the STT session alive, so replies are
 * never cut off). Each utterance becomes a turn on the user's LazyDog, so it
 * also lands in the chat transcript.
 */
export function VoiceButton({ userId }: { userId: string }) {
  const mic = useMemo(() => new GatedMicInput(), []);
  const voice = useVoiceAgent({ agent: "VoiceBridge", name: userId, audioInput: mic });
  const [holding, setHolding] = useState(false);
  const tail = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUse = useRef(Date.now());

  useEffect(() => {
    if (voice.status === "idle") return;
    const timer = setInterval(() => {
      if (!mic.open && voice.status === "listening" && Date.now() - lastUse.current > IDLE_HANGUP_MS) {
        voice.endCall();
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [voice.status]);

  const press = async () => {
    if (tail.current) clearTimeout(tail.current);
    lastUse.current = Date.now();
    setHolding(true);
    mic.open = true;
    if (voice.status === "idle") await voice.startCall();
  };

  const letGo = () => {
    setHolding(false);
    lastUse.current = Date.now();
    tail.current = setTimeout(() => {
      mic.open = false;
    }, RELEASE_TAIL_MS);
  };

  const label = holding
    ? "Listening…"
    : voice.status === "thinking"
      ? "Thinking…"
      : voice.status === "speaking"
        ? "Speaking…"
        : "Hold to talk";

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          void press();
        }}
        onPointerUp={letGo}
        onPointerCancel={letGo}
        title={voice.error ?? "Push to talk"}
        className={`h-10 select-none rounded-lg px-3 text-sm ${
          holding ? "bg-red-600 text-white" : "border border-zinc-300 dark:border-zinc-700"
        }`}
        style={holding ? { boxShadow: `0 0 0 ${2 + voice.audioLevel * 12}px rgb(220 38 38 / 0.35)` } : undefined}
      >
        🎙 {label}
      </button>
      {voice.status !== "idle" && !holding && (
        <button type="button" onClick={voice.endCall} className="mt-0.5 text-[10px] text-zinc-500 underline">
          end voice
        </button>
      )}
      {voice.interimTranscript && (
        <span className="max-w-40 truncate text-[10px] text-zinc-500">{voice.interimTranscript}</span>
      )}
    </div>
  );
}
