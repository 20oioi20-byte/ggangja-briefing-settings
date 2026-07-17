const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

// ══════════════════════════════════════════════
// AI Provider 자동 선택 + 자동 Failover
// ══════════════════════════════════════════════
let lastAIProvider = "Claude";  // 마지막으로 사용된 AI Provider

function selectModel(taskType: string): string {
  const TASK_MODELS: Record<string, string> = {
    'news':'gpt-5.5','saju':'gpt-5.5','annual':'gpt-5.5','keyword':'gpt-5.5','general':'gpt-5.5',
  };
  return TASK_MODELS[taskType] || 'gpt-5.5';
}
async function callAI(prompt: string, maxTokens: number, taskType = 'general'): Promise<string> {
  const MOT_URL = Deno.env.get("MOT_GATEWAY_URL") || Deno.env.get("SOGANG_MOT_API_URL");
  const MOT_KEY = Deno.env.get("MOT_GATEWAY_KEY") || Deno.env.get("SOGANG_MOT_API_KEY");
  const ANT_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const GEM_KEY = Deno.env.get("GEMINI_API_KEY");
  const model   = selectModel(taskType);
  // ── 1순위: 학교 Gateway ──
  if (MOT_URL && MOT_KEY) {
    // URL 스마트 조합:
    // - 이미 /chat/completions 포함 → 그대로 사용
    // - /v1/ 이미 포함 (예: /v1/gateway) → /chat/completions만 추가
    // - 그 외 → /v1/chat/completions 추가
    const endpoint = MOT_URL.includes('/chat/completions')
      ? MOT_URL.trim()
      : MOT_URL.includes('/v1/')
        ? `${MOT_URL.trim().replace(/\/$/, '')}/chat/completions`
        : `${MOT_URL.trim().replace(/\/$/, '')}/v1/chat/completions`;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 25000);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Authorization": `Bearer ${MOT_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.3 }),
        signal: ac.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content ?? "";
        if (text.length > 10) { lastAIProvider = `Gateway(${model})`; console.log(`[AI] Gateway(${model}) 성공`); return text; }
        else { console.log(`[AI] Gateway 응답 비어있음 → Claude fallback`); }
      } else {
        const errBody = await res.text().catch(() => '');
        console.log(`[AI] Gateway HTTP ${res.status} → Claude fallback | endpoint:${endpoint} | ${errBody.slice(0, 100)}`);
      }
    } catch(e) {
      console.log(`[AI] Gateway 오류 → Claude fallback: ${String(e).slice(0, 100)}`);
    }
  } else {
    console.log(`[AI] Gateway 미설정(URL:${MOT_URL ? '있음' : '없음'} KEY:${MOT_KEY ? '있음' : '없음'}) → Claude 직접 사용`);
  }
  // ── 2순위: Claude ──
  if (ANT_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":ANT_KEY,"anthropic-version":"2023-06-01"},
        body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:maxTokens,messages:[{role:"user",content:prompt}]}),
      });
      const data = await res.json();
      if (!data.error) {
        const text = data?.content?.[0]?.text ?? "";
        if (text) { lastAIProvider = "Claude API"; console.log(`[AI] Claude 성공`); return text; }
      } else { console.log(`[AI] Claude 오류 → Gemini: ${data.error.message?.slice(0,80)}`); }
    } catch(e) { console.log(`[AI] Claude 오류 → Gemini: ${String(e).slice(0,60)}`); }
  }
  // ── 3순위: Gemini ──
  if (GEM_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEM_KEY}`,
        {method:"POST",headers:{"Content-Type":"application/json"},
         body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:maxTokens,temperature:0.3}})}
      );
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (text) { lastAIProvider = "Gemini"; console.log(`[AI] Gemini fallback 성공`); return text; }
    } catch(e) { console.log(`[AI] Gemini 오류: ${String(e).slice(0,60)}`); }
  }
  console.error(`[AI] 모든 Provider 실패 (${taskType})`); return "";
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { label } = await req.json();
    if (!label) return new Response(JSON.stringify({ error: "label 필요" }), { status: 400, headers: { "Content-Type": "application/json", ...CORS } });

    const keywords = await callAI(
      `네이버 뉴스 검색 API용 최적 키워드를 추천해줘. 관심사: "${label}". 쉼표로 구분된 4~6개 검색어만 출력. 설명 없이 키워드만. 예시: "KB손해보험, KB손보, KB손해보험 콜센터, KB손보 AICC"`,
      200, 'keyword'
    );
    return new Response(JSON.stringify({ keywords }), { headers: { "Content-Type": "application/json", ...CORS } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
  }
});