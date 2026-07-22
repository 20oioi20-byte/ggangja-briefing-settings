import { signSession } from "../_shared/session.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { password } = await req.json().catch(() => ({}));
    const expected = Deno.env.get("BRIEFING_ACCESS_PASSWORD");
    if (!expected || password !== expected) {
      return new Response(JSON.stringify({ error: "비밀번호가 올바르지 않습니다" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    const { token, exp } = await signSession(30);
    return new Response(JSON.stringify({ token, exp }), {
      headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});
