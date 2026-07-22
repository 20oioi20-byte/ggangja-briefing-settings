import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifySession } from "../_shared/session.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-briefing-token",
};

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...CORS } });
}
function fail(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── 테이블 리소스 정의 (settings 제외 - 별도 처리) ──
const TABLE_RESOURCES: Record<string, { table: string; order: string }> = {
  interests: { table: "briefing_interests", order: "sort_order.asc,id.asc" },
  members: { table: "saju_members", order: "sort_order.asc,created_at.asc" },
  channels: { table: "youtube_channels", order: "sort_order.asc,created_at.asc" },
};

async function handleTableResource(resource: string, action: string, body: any) {
  const def = TABLE_RESOURCES[resource];
  if (!def) return fail(400, `알 수 없는 리소스: ${resource}`);
  const { table, order } = def;

  if (action === "list") {
    let q = supabase.from(table).select("*");
    for (const part of order.split(",")) {
      const [c, d] = part.split(".");
      q = q.order(c, { ascending: d !== "desc" });
    }
    const { data, error } = await q;
    if (error) return fail(500, error.message);
    return ok(data || []);
  }
  if (action === "create") {
    const { data, error } = await supabase.from(table).insert(body.data).select();
    if (error) return fail(500, error.message);
    return ok(data);
  }
  if (action === "update") {
    const { data, error } = await supabase.from(table).update(body.data).eq("id", body.id).select();
    if (error) return fail(500, error.message);
    return ok(data);
  }
  if (action === "delete") {
    const { error } = await supabase.from(table).delete().eq("id", body.id);
    if (error) return fail(500, error.message);
    return ok({ success: true });
  }
  return fail(400, `알 수 없는 action: ${action}`);
}

async function handleSettings(action: string, body: any) {
  if (action === "get") {
    const { data, error } = await supabase.from("settings").select("key, value");
    if (error) return fail(500, error.message);
    const m: Record<string, any> = {};
    (data || []).forEach((r) => { m[r.key] = r.value; });
    return ok(m);
  }
  if (action === "set") {
    const { key, value } = body;
    const { data: existing } = await supabase.from("settings").select("key").eq("key", key).maybeSingle();
    if (existing) {
      const { error } = await supabase.from("settings").update({ value }).eq("key", key);
      if (error) return fail(500, error.message);
    } else {
      const { error } = await supabase.from("settings").insert({ key, value });
      if (error) return fail(500, error.message);
    }
    return ok({ success: true });
  }
  return fail(400, `알 수 없는 action: ${action}`);
}

async function handleBriefings() {
  const { data, error } = await supabase
    .from("briefings")
    .select("id,date,sent_at,channel,content")
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(60);
  if (error) return fail(500, error.message);
  return ok(data || []);
}

async function handleStorage(action: string, body: any) {
  const BUCKET = "kakao-files";
  if (action === "list") {
    const { data, error } = await supabase.storage.from(BUCKET).list("", {
      limit: 200, sortBy: { column: "created_at", order: "desc" },
    });
    if (error) return fail(500, error.message);
    return ok(data || []);
  }
  if (action === "upload") {
    const { fname, contentType, base64 } = body;
    if (!fname || !base64) return fail(400, "fname/base64 필요");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const { error } = await supabase.storage.from(BUCKET).upload(fname, bytes, {
      contentType: contentType || "application/octet-stream",
      upsert: false,
    });
    if (error) return fail(500, error.message);
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(fname);
    return ok({ success: true, fname, publicUrl: pub.publicUrl });
  }
  if (action === "delete") {
    const { name } = body;
    if (!name) return fail(400, "name 필요");
    const { error } = await supabase.storage.from(BUCKET).remove([name]);
    if (error) return fail(500, error.message);
    return ok({ success: true });
  }
  return fail(400, `알 수 없는 action: ${action}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = req.headers.get("x-briefing-token");
    if (!(await verifySession(token))) {
      return fail(401, "인증이 필요합니다 (세션이 만료되었거나 유효하지 않습니다)");
    }

    const body = await req.json().catch(() => ({}));
    const { resource, action } = body;
    if (!resource || !action) return fail(400, "resource/action 필요");

    if (resource === "settings") return await handleSettings(action, body);
    if (resource === "briefings") return await handleBriefings();
    if (resource === "storage") return await handleStorage(action, body);
    if (TABLE_RESOURCES[resource]) return await handleTableResource(resource, action, body);

    return fail(400, `알 수 없는 리소스: ${resource}`);
  } catch (err) {
    console.error("briefing-api 오류:", err);
    return fail(500, String(err));
  }
});
