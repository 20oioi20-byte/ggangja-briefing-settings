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
      const t = setTimeout(() => ac.abort(), 45000);
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
  const jsDay = kst.getUTCDay();
  return {
    hour: kst.getUTCHours(),
    day: jsDay === 0 ? 7 : jsDay,
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth() + 1,
    date: kst.getUTCDate(),
  };
}

// ── 사주 천간지지 계산 ──
const STEMS = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const BRANCHES = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];

function getDayGanzhi(year: number, month: number, date: number): string {
  // 기준: 2024-01-01 = 癸未日 (index 19)
  const ref = new Date(Date.UTC(2024, 0, 1));
  const target = new Date(Date.UTC(year, month - 1, date));
  const diff = Math.round((target.getTime() - ref.getTime()) / 86400000);
  const idx = ((19 + diff) % 60 + 60) % 60;
  return STEMS[idx % 10] + BRANCHES[idx % 12] + '日';
}

function getYearGanzhi(year: number): string {
  const si = ((year - 4) % 10 + 10) % 10;
  const bi = ((year - 4) % 12 + 12) % 12;
  return STEMS[si] + BRANCHES[bi] + '年';
}

function getMonthGanzhi(year: number, month: number): string {
  const branchIdx = (month + 1) % 12;
  const yearStem = ((year - 4) % 10 + 10) % 10;
  const monthStemStart = [2, 4, 6, 8, 0][yearStem % 5];
  const monthsFromYin = ((branchIdx - 2 + 12) % 12);
  const stemIdx = (monthStemStart + monthsFromYin) % 10;
  return STEMS[stemIdx] + BRANCHES[branchIdx] + '月';
}

async function getSettings() {
  const { data } = await supabase.from("settings").select("key, value");
  const m: Record<string, any> = {};
  (data || []).forEach(r => { m[r.key] = r.value; });
  return m;
}

function parseDays(v: any): number[] {
  if (!v) return [1, 2, 3, 4, 5];
  if (Array.isArray(v)) return v.map(Number);
  try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map(Number); } catch {}
  return String(v).split(",").map(s => Number(s.trim())).filter(Boolean);
}

async function getEmails(): Promise<string[]> {
  const { data } = await supabase
    .from("settings").select("value").eq("key", "briefing_emails").single();
  const v = data?.value;
  if (!v) return ["20oioi20@gmail.com"];
  if (Array.isArray(v)) return v.map(String);
  return String(v).split(",").map(s => s.trim()).filter(Boolean);
}

async function getMembers() {
  const { data } = await supabase
    .from("saju_members").select("*").eq("is_active", true).order("sort_order");
  return data || [];
}

function solarToLunar(dateStr: string): string {
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
    const lunarAuto = solarToLunar(m.birth_solar_date);
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

// ── 오늘 날짜 라벨, 예: "8월 27일" ──
function buildDateLabel(kst: any): string {
  return `${kst.year}년 ${kst.month}월 ${kst.date}일`;
}

// ── Claude로 일일 사주 분석 (JSON 구조로 받음, 별점+한줄요약 위주) ──
async function analyzeSaju(members: any[], kst: any): Promise<any[]> {
  const dateLabel = buildDateLabel(kst);

  // 오늘 일진 계산
  const yearGanzhi = getYearGanzhi(kst.year);
  const monthGanzhi = getMonthGanzhi(kst.year, kst.month);
  const dayGanzhi = getDayGanzhi(kst.year, kst.month, kst.date);
  const todayGanzhi = `${yearGanzhi} ${monthGanzhi} ${dayGanzhi}`;

  const memberInfos = members.map(m => `【${m.name}】\n${buildMemberInfo(m)}`).join('\n\n');

  const prompt = `당신은 한국 전통 사주명리학에 정통하면서도, 딱딱한 설명 없이 재치있고 술술 읽히게 운세를 전달하는 데 능한 전문가입니다.

오늘: ${dateLabel} (오늘 일진: ${todayGanzhi})

위 일진을 정확히 반영하여 아래 가족 구성원 각자의 사주와 오늘 일진의 상호작용을 분석하고, 오늘 하루 운세를 알려주세요.

${memberInfos}

작성 지침 (매우 중요):
- 각 구성원의 일간과 오늘 일간의 관계(생극제화), 오늘 지지가 사주에 미치는 영향을 실제로 근거 삼아 분석하되, 왜 그런지 명리학적 근거(오행 상생상극 등)를 설명하는 문장은 절대 쓰지 마세요. 분석 결과만, 그것도 짧고 재미있게 표현하세요.
- 각 항목의 line은 한 문장, 20자 내외로 짧고 임팩트 있게. 이모지 1개 정도는 활용 가능.
- 성인(본인/배우자 등)은 애정운·건강운·가족운·재물운·직장운·관계운 6개 항목을 쓰세요.
- 미성년 자녀(초/중/고등학생 등)는 애정운·직장운 대신 교우관계운·학업운으로 바꿔서 6개 항목을 쓰세요 (가족운·건강운·재물운·관계운은 동일하게 사용).
- stars는 1~5 사이 정수(그 항목이 얼마나 좋은 하루인지).
- headline은 그 사람의 오늘 하루를 한 문장으로 위트있게 요약 (예: '밀어붙이면 통하는 날', '한 발 물러서면 편한 날').
- lucky는 한 줄(색상/방향/숫자/음식).

응답은 반드시 아래 JSON 형식만 출력하세요. 설명, 마크다운, 코드블록(#, **, |, --- 등) 없이 { 로 시작해서 } 로 끝나야 합니다.
중요 규칙:
1. 모든 문자열 값 안에서는 큰따옴표(")를 절대 쓰지 마세요. 작은따옴표(')를 쓰세요.
2. 기본정보(생년월일 등 원본 데이터)는 응답에 포함하지 마세요. 해석 결과만 담으세요.

{"members":[{"name":"이름","headline":"오늘 한 줄 요약","categories":[{"label":"애정운","stars":4,"line":"한 줄 요점"},{"label":"건강운","stars":3,"line":"..."},{"label":"가족운","stars":5,"line":"..."},{"label":"재물운","stars":2,"line":"..."},{"label":"직장운","stars":4,"line":"..."},{"label":"관계운","stars":3,"line":"..."}],"lucky":"행운의 색상/방향/숫자/음식 한 줄"}]}`;

  const text = await callAI(prompt, 4000, 'saju');
  return parseSajuJson(text, members);
}

// ── JSON 파싱 (다단계 복구) ──
function parseSajuJson(text: string, members: any[]): any[] {
  let clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1) clean = clean.slice(start, end + 1);

  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed.members) && parsed.members.length > 0) return parsed.members;
  } catch (e) {
    console.error("사주 JSON 파싱 실패:", e);
  }

  // 실패 시 원본 구성원 이름만으로 안내 메시지
  return members.map(m => ({
    name: m.name,
    headline: "오늘 운세 분석을 가져오지 못했습니다.",
    categories: [],
    lucky: "",
  }));
}

function starIcons(n: any): string {
  const num = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  return '★'.repeat(num) + '☆'.repeat(5 - num);
}

// ── 메일 HTML (통합 1통, 별점 카드형) ──
function buildSajuHtml(membersResult: any[], dateLabel: string): string {
  const cards = membersResult.map(m => {
    const rows = (m.categories || []).map((c: any) => `
      <tr>
        <td style="padding:6px 10px 6px 0;font-size:13px;color:#333;white-space:nowrap">${c.label || ''}</td>
        <td style="padding:6px 10px;font-size:13px;color:#f5a623;white-space:nowrap;letter-spacing:1px">${starIcons(c.stars)}</td>
        <td style="padding:6px 0;font-size:13px;color:#555">${c.line || ''}</td>
      </tr>`).join('');

    return `
    <div style="margin-bottom:22px;padding:16px;background:#faf8ff;border-radius:8px;border-left:4px solid #7b2ff7">
      <h3 style="margin:0 0 6px;font-size:16px;color:#4a0080">🔮 ${m.name}</h3>
      ${m.headline ? `<p style="margin:0 0 12px;font-size:13px;color:#7b2ff7;font-weight:600">"${m.headline}"</p>` : ''}
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      ${m.lucky ? `<p style="margin:12px 0 0;font-size:12px;color:#888">🍀 ${m.lucky}</p>` : ''}
    </div>`;
  }).join('');

  return `
<div style="font-family:'Apple SD Gothic Neo',Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#4a0080,#7b2ff7);padding:20px 24px">
    <h2 style="color:#fff;margin:0;font-size:18px;font-weight:700">🔮 사주 브리핑</h2>
    <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:13px">${dateLabel}</p>
  </div>
  <div style="background:#fff;padding:20px 24px">
    ${cards}
  </div>
  <div style="padding:10px 24px;background:#f9f5ff;text-align:center">
    <p style="margin:0;font-size:11px;color:#aaa">깡자동 사주 브리핑 · KTIS 총괄 PM</p>
  </div>
</div>`;
}

async function sendEmail(membersResult: any[], dateLabel: string, emails: string[]) {
  const html = buildSajuHtml(membersResult, dateLabel);
  try {
    await sendMail(emails.filter(Boolean), `[깡자동 사주] ${dateLabel} 오늘의 운세`, html);
    console.log("사주 메일 발송 성공");
  } catch (e) {
    console.error("사주 메일 발송 실패:", String(e).slice(0, 200));
  }
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

// ── 카카오: 구성원별 개별 발송 (유튜브 브리핑과 동일 패턴, 1000자 한계 회피) ──
async function sendKakaoPerMember(m: any, dateLabel: string, accessToken: string | null) {
  if (!accessToken) return;
  let text = `🔮 ${m.name}님의 오늘 사주\n${dateLabel}`;
  if (m.headline) text += `\n"${m.headline}"`;
  const catLines = (m.categories || []).map((c: any) => `${c.label} ${starIcons(c.stars)}\n${c.line || ''}`).join('\n\n');
  if (catLines) text += `\n\n${catLines}`;
  if (m.lucky) text += `\n\n🍀 ${m.lucky}`;

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
  console.log(`사주 카카오 발송(${m.name}):`, JSON.stringify(await res.json()));
}

async function runBriefing(force: boolean) {
  const kst = getKST();
  const settings = await getSettings();
  // saju_* 전용키 우선, 없으면 briefing_* 하위호환
  // saju_hours 전용키만 읽음 (공통키 fallback 제거 - 뉴스 설정과 독립)
  const sajuHoursRaw = settings["saju_hours"];
  const sajuHours: number[] = sajuHoursRaw
    ? (Array.isArray(sajuHoursRaw) ? sajuHoursRaw : JSON.parse(sajuHoursRaw)).map(Number)
    : [9];  // 기본값 9시
  const briefingDays = parseDays(settings["saju_days"] ?? settings["briefing_days"]);
  const paused = (settings["saju_paused"] ?? settings["briefing_paused"]) === true
    || String(settings["saju_paused"] ?? settings["briefing_paused"]) === "true";
  const kakaoRefreshToken = settings["kakao_refresh_token"] || null;

  if (!force) {
    if (paused) return { skipped: true, reason: "일시정지 중" };
    if (!sajuHours.includes(kst.hour)) return { skipped: true, reason: `발송 시간 아님 (현재 ${kst.hour}시)` };
    if (!briefingDays.includes(kst.day)) return { skipped: true, reason: `발송 요일 아님` };
  }

  const members = await getMembers();
  if (members.length === 0) return { skipped: true, reason: "등록된 구성원 없음" };

  const dateLabel = buildDateLabel(kst);
  const membersResult = await analyzeSaju(members, kst);

  const [emails, kakaoToken] = await Promise.all([
    getEmails(),
    kakaoRefreshToken ? refreshKakaoToken(kakaoRefreshToken) : Promise.resolve(null),
  ]);

  // 메일: 통합 1통 / 카톡: 구성원별 개별 발송
  await Promise.all([
    sendEmail(membersResult, dateLabel, emails),
    ...membersResult.map(m => sendKakaoPerMember(m, dateLabel, kakaoToken)),
  ]);

  // 히스토리 저장 (date 컬럼은 실제 date 타입이라 ISO 형식 사용, 날짜 라벨은 content에만 기록)
  const isoDate = `${kst.year}-${String(kst.month).padStart(2, '0')}-${String(kst.date).padStart(2, '0')}`;
  const sajuProvider = lastAIProvider;
  const { error: historyError } = await supabase.from("briefings").insert({
    date: isoDate,
    content: JSON.stringify({ _type: "saju", _provider: sajuProvider, date: dateLabel, members: membersResult }),
    sent_at: new Date().toISOString(),
    channel: "saju",
  });
  if (historyError) console.error("사주 히스토리 저장 실패:", JSON.stringify(historyError));

  return { success: true, memberCount: members.length, date: dateLabel };
}

Deno.serve(async (_req) => {
  if (_req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(_req.url);
    const force = url.searchParams.get("force") === "true";
    const isBrowser = _req.headers.get("origin") !== null;

    if (isBrowser && force) {
      EdgeRuntime.waitUntil(runBriefing(true));
      return new Response(JSON.stringify({
        success: true, message: "사주 브리핑을 백그라운드에서 실행 중입니다.",
      }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    const result = await runBriefing(force);
    return new Response(JSON.stringify(result),
      { headers: { "Content-Type": "application/json", ...CORS } });
  } catch (err) {
    console.error("사주 브리핑 오류:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});