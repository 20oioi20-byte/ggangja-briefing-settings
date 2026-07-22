// 브리핑 설정 UI 접속용 세션 토큰 서명/검증 (HMAC-SHA256, 무상태)
const SESSION_SECRET = Deno.env.get("BRIEFING_SESSION_SECRET")!;

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

export async function signSession(days = 30): Promise<{ token: string; exp: number }> {
  const exp = Date.now() + days * 24 * 60 * 60 * 1000;
  const payload = b64url(JSON.stringify({ exp }));
  const sig = await hmac(payload);
  return { token: `${payload}.${sig}`, exp };
}

export async function verifySession(token: string | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = await hmac(payload);
  if (sig !== expectedSig) return false;
  try {
    const { exp } = JSON.parse(b64urlDecode(payload));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}
