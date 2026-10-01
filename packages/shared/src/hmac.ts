const encoder = new TextEncoder();

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** HMAC-SHA256 of `message`, hex encoded. */
export async function hmacSha256Hex(
  secret: string,
  message: string
): Promise<string> {
  const key = await hmacKey(secret, "sign");
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Constant-time verification of a hex HMAC-SHA256 signature. */
export async function verifyHmacSha256Hex(
  secret: string,
  message: string,
  signatureHex: string
): Promise<boolean> {
  const signature = fromHex(signatureHex);
  if (!signature || signature.length !== 32) return false;
  const key = await hmacKey(secret, "verify");
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(message));
}
