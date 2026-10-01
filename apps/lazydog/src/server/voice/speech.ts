/**
 * Turn model output into something a TTS voice can read: models often emit
 * markdown even when told not to, and TTS would read the symbols aloud.
 */
export function toSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/[‑–—]/g, (c) => (c === "‑" ? "-" : ", "))
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
