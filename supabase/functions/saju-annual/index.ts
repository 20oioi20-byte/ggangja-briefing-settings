import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Lunar from "https://esm.sh/lunar-javascript@1.7.7";
import { sendMail } from "../_shared/mail.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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
  const MOT_URL = Deno.env.get("MOT_GATEWAY_URL");
  const MOT_KEY = Deno.env.get("MOT_GATEWAY_KEY");
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

const KAKAO_REST_API_KEY = Deno.env.get("KAKAO_REST_API_KEY");
const KAKAO_CLIENT_SECRET = Deno.env.get("KAKAO_CLIENT_SECRET");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return { year: kst.getUTCFullYear(), month: kst.getUTCMonth() + 1, date: kst.getUTCDate() };
}

// ── 사주 천간지지 계산 ──
const STEMS_A = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const BRANCHES_A = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];

function getYearGanzhiA(year: number): string {
  const si = ((year - 4) % 10 + 10) % 10;
  const bi = ((year - 4) % 12 + 12) % 12;
  return STEMS_A[si] + BRANCHES_A[bi] + '年';
}

async function getEmails(): Promise<string[]> {
  const { data } = await supabase
    .from("settings").select("value").eq("key", "briefing_emails").single();
  const v = data?.value;
  if (!v) return ["20oioi20@gmail.com"];
  if (Array.isArray(v)) return v.map(String);
  return String(v).split(",").map(s => s.trim()).filter(Boolean);
}

async function getMembersByIds(ids: string[]) {
  const { data } = await supabase
    .from("saju_members").select("*").in("id", ids);
  return data || [];
}

function solarToLunarA(dateStr: string): string {
  try {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const solar = Lunar.Solar.fromYmd(y, mo, d);
    const lunar = solar.getLunar();
    const monthStr = lunar.isLeap() ? `윤${lunar.getMonth()}` : `${lunar.getMonth()}`;
    return `${lunar.getYear()}년 ${monthStr}월 ${lunar.getDay()}일`;
  } catch { return ''; }
}

function buildMemberInfo(m: any): string {
  const fields: string[] = [];
  if (m.name) fields.push(`이름: ${m.name}${m.name_hanja ? ` (${m.name_hanja})` : ''}`);
  if (m.gender) fields.push(`성별: ${m.gender}`);
  if (m.relationship) fields.push(`관계: ${m.relationship}`);
  if (m.birth_solar_date) {
    const lunarAuto = solarToLunarA(m.birth_solar_date);
    fields.push(`양력 생년월일: ${m.birth_solar_date}${m.birth_solar_time ? ` ${m.birth_solar_time}` : ''}`);
    if (lunarAuto && !m.birth_lunar_date) fields.push(`음력 생년월일 (자동계산): ${lunarAuto}${m.birth_solar_time ? ` ${m.birth_solar_time}` : ''}`);
  }
  if (m.birth_lunar_date) fields.push(`음력 생년월일: ${m.birth_lunar_date}${m.birth_lunar_time ? ` ${m.birth_lunar_time}` : ''}`);
  if (m.birthplace) fields.push(`태어난 곳: ${m.birthplace}`);
  if (m.current_location) fields.push(`현재 사는 곳: ${m.current_location}`);
  if (m.occupation) fields.push(`현재 하는 일: ${m.occupation}`);
  if (m.notes) fields.push(`기타: ${m.notes}`);
  return fields.join('\n');
}

// ── 개인 연간운세 분석 (토종비결) ──
async function analyzeAnnual(member: any, year: number): Promise<string> {
  const info = buildMemberInfo(member);
  const yearGanzhi = getYearGanzhiA(year);
  const prompt = `당신은 한국 전통 토정비결과 사주명리학에 정통한 전문가입니다.

${year}년(${yearGanzhi}) ${member.name}님의 연간운세를 전문적으로 분석해주세요.

【구성원 정보】
${info}

분석 기준:
- ${yearGanzhi}의 세운(歲運, 올해의 기운)이 해당 사주 원국에 미치는 영향을 중심으로 분석
- 십신(十神, 사주 해석의 10가지 관계)·십이운성(十二運星, 기운의 성장 단계)·지장간(地藏干, 지지 속에 숨은 천간) 등 명리학적 근거를 최소 한 문장 이상 구체적으로 제시 (막연한 결론이 아니라 "왜 그런지"를 설명)
- 추상적 표현 지양, 실생활 적용 가능한 구체적 조언

응답 언어 규칙 (매우 중요):
- 한자 단어(오행, 십신, 십이운성 등)는 반드시 한글 뜻으로 풀어서 작성하세요.
  예시: 甲木(갑목) → '나무의 기운', 歲運(세운) → '올해 들어오는 기운', 用神(용신) → '사주를 보완해주는 핵심 기운',
        大運(대운) → '10년 단위 큰 흐름', 財星(재성) → '재물의 기운', 官星(관성) → '명예와 직장의 기운',
        比劫(비겁) → '나와 비슷한 기운', 印星(인성) → '학문과 도움의 기운'
- 전문 용어를 쓸 때는 반드시 괄호로 한글 설명을 함께 붙이세요. 예) 식상(표현과 활동의 기운)
- 이름 한자 표기 등을 제외하고, 한자가 설명 없이 단독으로 나오면 안 됩니다 (항상 한글 뜻 병기)
- 전문 용어를 풀어 쓰되, 명리학적 근거 자체는 생략하지 말고 쉬운 말로 바꿔서 전달하세요

중요: 큰따옴표(") 사용 금지. 마크다운(#, **, |) 사용 금지.

1. ${year}년(${yearGanzhi}) 전체 운세 흐름 (5~7줄)
2. 월별 주요 운세 (1월~12월, 각 월 2~3줄)
3. 재물운 — 수입/지출/투자 관점 (3~4줄)
4. 직업/사업운 — 승진/이직/기회 (3~4줄)
5. 건강운 — 주의할 신체 부위와 시기 (3~4줄)
6. 관계/애정운 (3~4줄)
7. 주의해야 할 시기와 구체적 이유 (3~4줄)
8. 가장 좋은 기회의 시기와 활용법 (3~4줄)
9. ${year}년 핵심 종합 조언 3가지 (3~4줄)

구성원 정보가 부족한 부분은 가능한 범위에서 분석해주세요.`;

  return await callAI(prompt, 5000, 'annual') || "(연간운세 분석을 가져오지 못했습니다.)";
}

// ── 연간운세 메일 HTML ──
function buildAnnualHtml(member: any, annualText: string, year: number): string {
  const bodyHtml = annualText.replace(/\n/g, '<br>');
  return `
<div style="font-family:'Apple SD Gothic Neo',Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1a0040,#4a0080);padding:20px 24px">
    <h2 style="color:#fff;margin:0;font-size:18px;font-weight:700">🔮 연간운세 (토종비결)</h2>
    <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:14px">${year}년 ${member.name}${member.name_hanja ? ` (${member.name_hanja})` : ''}</p>
  </div>
  <div style="background:#fff;padding:20px 24px">
    <p style="margin:0;font-size:14px;color:#333;line-height:2">${bodyHtml}</p>
  </div>
  <div style="padding:10px 24px;background:#f5f0ff;text-align:center">
    <p style="margin:0;font-size:11px;color:#aaa">깡자동 연간운세 · KTIS 총괄 PM</p>
  </div>
</div>`;
}

async function refreshKakaoToken(refreshToken: string): Promise<string | null> {
  if (!KAKAO_REST_API_KEY || !KAKAO_CLIENT_SECRET) return null;
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("client_id", KAKAO_REST_API_KEY);
  params.append("client_secret", KAKAO_CLIENT_SECRET);
  params.append("refresh_token", refreshToken);
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json();
  if (!data.access_token) return null;
  if (data.refresh_token) {
    await supabase.from("settings").update({ value: data.refresh_token }).eq("key", "kakao_refresh_token");
  }
  return data.access_token;
}

async function sendEmail(member: any, annualText: string, year: number, emails: string[]) {
  const html = buildAnnualHtml(member, annualText, year);
  // sendMail이 실패 시 예외를 던지므로 그대로 전파 (runAnnual의 구성원별 try/catch에서 처리)
  await sendMail(emails.filter(Boolean), `[깡자동 연간운세] ${year}년 ${member.name} 토종비결`, html);
  console.log(`연간운세 메일 발송 성공 (${member.name})`);
}

async function sendKakao(member: any, annualText: string, year: number, accessToken: string | null) {
  if (!accessToken) return;
  const text = `🔮 연간운세 (토종비결)\n${year}년 ${member.name}\n\n${annualText}`;
  const body = new URLSearchParams();
  body.append('template_object', JSON.stringify({
    object_type: "text", text,
    link: {
      web_url: "https://ggangja-briefing-settings.vercel.app",
      mobile_web_url: "https://ggangja-briefing-settings.vercel.app",
    },
  }));
  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  console.log(`연간운세 카카오 (${member.name}):`, JSON.stringify(await res.json()));
}

async function runAnnual(memberIds: string[]) {
  const kst = getKST();
  const today = `${kst.year}년 ${kst.month}월 ${kst.date}일`;
  const [members, emails] = await Promise.all([getMembersByIds(memberIds), getEmails()]);
  if (members.length === 0) return { success: false, reason: "선택된 구성원 없음" };

  const { data: settings } = await supabase.from("settings").select("key,value").eq("key", "kakao_refresh_token").single();
  const kakaoRefreshToken = settings?.value || null;
  const kakaoToken = kakaoRefreshToken ? await refreshKakaoToken(kakaoRefreshToken) : null;

  const sent: string[] = [];
  const failed: { name: string; error: string }[] = [];

  // 한 명 처리 중 오류가 나도 나머지 구성원 발송은 계속 진행되도록 각자 독립적으로 처리
  for (const member of members) {
    try {
      const annualText = await analyzeAnnual(member, kst.year);
      const provider = lastAIProvider;
      await Promise.all([
        sendEmail(member, annualText, kst.year, emails),
        sendKakao(member, annualText, kst.year, kakaoToken),
      ]);
      await supabase.from("briefings").insert({
        date: today,
        content: JSON.stringify({ _type: "annual", _provider: provider, member: member.name, text: annualText }),
        sent_at: new Date().toISOString(),
        channel: "saju-annual",
      });
      sent.push(member.name);
    } catch (e) {
      console.error(`연간운세 처리 실패 (${member.name}):`, String(e));
      failed.push({ name: member.name, error: String(e).slice(0, 300) });
    }
  }
  if (failed.length > 0) console.error(`연간운세 일부 실패:`, JSON.stringify(failed));
  return { success: true, year: kst.year, sent, failed };
}

Deno.serve(async (_req) => {
  if (_req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await _req.json().catch(() => ({}));
    const memberIds: string[] = body.memberIds || [];

    if (memberIds.length === 0) {
      return new Response(JSON.stringify({ error: "memberIds 필요" }), {
        status: 400, headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    // 연간운세는 무조건 백그라운드 실행 (분석 시간 김)
    EdgeRuntime.waitUntil(runAnnual(memberIds));
    return new Response(JSON.stringify({
      success: true,
      message: `${memberIds.length}명 연간운세 분석 중입니다. 잠시 후 메일·카톡을 확인하세요.`,
    }), { headers: { "Content-Type": "application/json", ...CORS } });
  } catch (err) {
    console.error("연간운세 오류:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});