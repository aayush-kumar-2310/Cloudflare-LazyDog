import { useVoiceAgent } from "@cloudflare/voice/react";
import { useRef } from "react";

// Keep streaming a little silence after release so the STT model sees the end of the turn.
const RELEASE_TAIL_MS = 700;

/**
 * Push-to-talk. The call (WebSocket + mic) opens on first press and stays
 * open muted; holding the button unmutes. The reply is spoken back and also
 * lands in the chat transcript, because the turn runs on the same LazyDog.
 */
export function VoiceButton({ userId }: { userId: string }) {
  const voice = useVoiceAgent({ agent: "VoiceBridge", name: userId });
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);

  const press = async () => {
    holding.current = true;
    if (release.current) clearTimeout(release.current);
    if (voice.status === "idle") await voice.startCall();
    else if (voice.isMuted) voice.toggleMute();
  };

  const letGo = () => {
    if (!holding.current) return;
    holding.current = false;
    release.current = setTimeout(() => {
      if (!voice.isMuted) voice.toggleMute();
    }, RELEASE_TAIL_MS);
  };

  const talking = voice.status !== "idle" && !voice.isMuted;
  const label =
    voice.status === "idle"
      ? "Hold to talk"
      : talking
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
          talking ? "bg-red-600 text-white" : "border border-zinc-300 dark:border-zinc-700"
        }`}
        style={talking ? { boxShadow: `0 0 0 ${2 + voice.audioLevel * 12}px rgb(220 38 38 / 0.35)` } : undefined}
      >
        🎙 {label}
      </button>
      {voice.status !== "idle" && (
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
