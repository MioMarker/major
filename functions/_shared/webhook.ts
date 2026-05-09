// functions/_shared/webhook.ts
//
// HMAC-SHA256 signature verification for GitHub webhooks. GitHub sends the
// computed signature in the `X-Hub-Signature-256` header as `sha256=<hex>`.
// We compute the same MAC over the raw request body and compare in constant
// time.
//
// `GITHUB_WEBHOOK_SECRET` is set per-repo in GitHub and stored as an edge
// function secret — never hardcoded.

export async function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const computed = Array.from(new Uint8Array(macBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time string compare on equal-length hex strings.
  if (provided.length !== computed.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ computed.charCodeAt(i);
  }
  return diff === 0;
}
