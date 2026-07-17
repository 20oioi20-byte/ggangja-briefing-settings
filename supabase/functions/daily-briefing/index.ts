import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const NAVER_CLIENT_ID = Deno.env.get("NAVER_CLIENT_ID")!;
const NAVER_CLIENT_SECRET = Deno.env.get("NAVER_CLIENT_SECRET")!;
const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY")!;
const KAKAO_REST_API_KEY = Deno.env.get("KAKAO_REST_API_KEY");
const KAKAO_CLIENT_SECRET = Deno.env.get("KAKAO_CLIENT_SECRET");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/** 관심사당 브리핑에 실을 최대 기사 수 (수집 후보 extra와 별개) */
const BRIEFING_MAX_PER_INTEREST = 3;
/** 최신 기사 허용 창 (시간). 24h는 아침 발송 시 0건이 잦아 48h로 완화 */
const NEWS_MAX_AGE_HOURS = 48;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getKST(): { hour: number; day: number; dateStr: string } {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hour = kst.getUTCHours();
  const jsDay = kst.getUTCDay();
  const day = jsDay === 0 ? 7 : jsDay;
  const dateStr = kst.toISOString().slice(0, 10);
  return { hour, day, dateStr };
}

async function getSettings() {
  const { data } = await supabase.from("settings").select("key, value");
  const m: Record<string, any> = {};
  (data || []).forEach((r) => {
    m[r.key] = r.value;
  });
  return m;
}

function parseDays(v: any): number[] {
  if (!v) return [1, 2, 3, 4, 5];
  if (Array.isArray(v)) return v.map(Number);
  try {
    const p = JSON.parse(v);
    if (Array.isArray(p)) return p.map(Number);
  } catch {}
  return String(v)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Boolean);
}

function parseHours(v: any, fallbackHour: number): number[] {
  if (v == null || v === "") return [fallbackHour];
  if (Array.isArray(v)) {
    const arr = v.map(Number).filter((n) => n >= 0 && n <= 23);
    return arr.length ? arr : [fallbackHour];
  }
  try {
    const p = JSON.parse(v);
    if (Array.isArray(p)) {
      const arr = p.map(Number).filter((n) => n >= 0 && n <= 23);
      return arr.length ? arr : [fallbackHour];
    }
  } catch {}
  const n = Number(v);
  if (!isNaN(n) && n >= 0 && n <= 23) return [n];
  return [fallbackHour];
}

function toBool(v: any): boolean {
  return v === true || v === "true";
}

/** UI: "키워드 (쉼표 구분)" → 개별 검색어 배열 */
function splitKeywords(target: any): string[] {
  if (target == null) return [];
  return String(target)
    .split(/[,，\n;|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampDisplay(extra: any): number {
  const n = Number(extra);
  if (isNaN(n) || n < 1) return 10;
  return Math.min(100, Math.floor(n));
}

async function getInterests() {
  const { data, error } = await supabase
    .from("briefing_interests")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");
  if (error) {
    console.error("관심사 조회 실패:", JSON.stringify(error));
    return [];
  }
  return data || [];
}

async function getEmails(): Promise<string[]> {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "briefing_emails")
    .single();
  const v = data?.value;
  if (!v) return ["20oioi20@gmail.com"];
  if (Array.isArray(v)) return v.map(String);
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getRecentlySentUrls(): Promise<Set<string>> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fromDate = sevenDaysAgo.toISOString().slice(0, 10);

  const { data } = await supabase
    .from("briefings")
    .select("content")
    .gte("date", fromDate);

  const urls = new Set<string>();
  const urlRegex = /"url"\s*:\s*"(https?:\/\/[^"]+)"/g;
  for (const row of data || []) {
    const content = row.content || "";
    let match;
    while ((match = urlRegex.exec(content)) !== null) {
      urls.add(match[1]);
    }
  }
  console.log(`최근 7일 발송된 기사 URL: ${urls.size}건`);
  return urls;
}

type NewsItem = {
  interestId: string | number;
  category: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
};

async function fetchNaverNews(query: string, display: number): Promise<any[]> {
  const url =
    `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}` +
    `&display=${display}&sort=date`;
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
    },
  });
  const json = await res.json();
  if (json.errorCode || json.errorMessage) {
    console.error(
      `네이버 API 오류 [q=${query}]:`,
      json.errorCode,
      json.errorMessage,
    );
    return [];
  }
  if (!res.ok) {
    console.error(`네이버 HTTP ${res.status} [q=${query}]:`, JSON.stringify(json).slice(0, 200));
    return [];
  }
  return Array.isArray(json.items) ? json.items : [];
}

function isFresh(pubDate: string, maxAgeMs: number): boolean {
  const pub = new Date(pubDate).getTime();
  if (isNaN(pub)) return false;
  return Date.now() - pub <= maxAgeMs;
}

function stripHtml(s: string): string {
  return (s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, "'")
    .replace(/"/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * 관심사별 뉴스 수집
 * - target 쉼표/줄바꿈 키워드 분리 검색
 * - extra → 네이버 display (관심사당 후보 상한)
 * - 빈 키워드·0건 관심사는 생략
 */
async function fetchAllNews(interests: any[]): Promise<{
  allNews: NewsItem[];
  stats: { label: string; keywords: string[]; requested: number; collected: number; skipped?: string }[];
}> {
  const maxAgeMs = NEWS_MAX_AGE_HOURS * 60 * 60 * 1000;
  const allNews: NewsItem[] = [];
  const stats: {
    label: string;
    keywords: string[];
    requested: number;
    collected: number;
    skipped?: string;
  }[] = [];

  // UI 유형: news/stock/trend/custom — 활성+키워드 있으면 모두 뉴스 검색
  const candidates = interests.filter((i) => {
    const t = (i.type || "news").toLowerCase();
    return t === "news" || t === "stock" || t === "trend" || t === "custom";
  });

  for (const interest of candidates) {
    const label = interest.label || "기타";
    const keywords = splitKeywords(interest.target);
    const display = clampDisplay(interest.extra);

    if (keywords.length === 0) {
      console.log(`관심사 "${label}": 키워드 없음 → 생략`);
      stats.push({ label, keywords: [], requested: display, collected: 0, skipped: "키워드 없음" });
      continue;
    }

    const byUrl = new Map<string, NewsItem>();

    try {
      // 키워드별로 나눠 수집 후 URL 기준 합침 (관심사당 최대 display건)
      const perKw = Math.min(
        100,
        Math.max(3, Math.ceil(display / keywords.length)),
      );

      for (const kw of keywords) {
        const items = await fetchNaverNews(kw, perKw);
        for (const a of items) {
          if (!isFresh(a.pubDate, maxAgeMs)) continue;
          const articleUrl = a.originallink || a.link;
          if (!articleUrl || byUrl.has(articleUrl)) continue;
          byUrl.set(articleUrl, {
            interestId: interest.id,
            category: label,
            title: stripHtml(a.title),
            summary: stripHtml(a.description),
            url: articleUrl,
            publishedAt: a.pubDate,
          });
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      // 최신순 정렬 후 관심사 후보 상한(extra)
      const sorted = [...byUrl.values()].sort(
        (a, b) =>
          new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      );
      const capped = sorted.slice(0, display);
      allNews.push(...capped);
      stats.push({
        label,
        keywords,
        requested: display,
        collected: capped.length,
      });
      console.log(
        `관심사 "${label}": 키워드[${keywords.join(" | ")}] 요청상한=${display} → 수집=${capped.length}`,
      );
    } catch (e) {
      console.error(`관심사 "${label}" 수집 오류:`, e);
      stats.push({
        label,
        keywords,
        requested: display,
        collected: 0,
        skipped: String(e),
      });
    }
  }

  return { allNews, stats };
}

/**
 * 관심사당 브리핑 최대 BRIEFING_MAX_PER_INTEREST건.
 * 0건 관심사는 제외(생략).
 */
function capPerInterest(
  news: NewsItem[],
  maxPer = BRIEFING_MAX_PER_INTEREST,
): NewsItem[] {
  const groups = new Map<string, NewsItem[]>();
  for (const n of news) {
    const key = String(n.interestId ?? n.category);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }

  const out: NewsItem[] = [];
  for (const [, items] of groups) {
    if (items.length === 0) continue;
    const sorted = items.sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );
    out.push(...sorted.slice(0, maxPer));
  }
  return out;
}

async function generateBriefing(interests: any[], newsData: NewsItem[]) {
  const today = new Date().toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  // Claude에는 이미 관심사당 최대 3건만 전달. 0건 카테고리는 목록에 없음.
  const byCat: Record<string, number> = {};
  for (const n of newsData) {
    byCat[n.category] = (byCat[n.category] || 0) + 1;
  }
  const catLine = Object.entries(byCat)
    .map(([c, n]) => `${c}: ${n}건`)
    .join(", ");

  const payload = newsData.map(({ category, title, summary, url, publishedAt }) => ({
    category,
    title,
    summary,
    url,
    publishedAt,
  }));

  const prompt = `당신은 KTIS 총괄 PM 성호님의 AI 비서입니다.
오늘(${today}) 아침 브리핑을 작성해주세요.

규칙:
1. 아래 수집된 기사만 사용하세요. 없는 기사를 만들지 마세요.
2. 관심사(category)당 이미 최대 ${BRIEFING_MAX_PER_INTEREST}건으로 제한되어 있습니다. 전부 브리핑에 포함하세요.
3. 기사가 0건인 관심사는 목록에 없습니다 — 언급하지 말고 생략하세요.
4. 핵심만 간결하게. 각 oneline은 1문장.

수집 현황: 총 ${newsData.length}건 (${catLine || "없음"})
수집된 뉴스:
${JSON.stringify(payload, null, 2)}

응답은 반드시 아래 JSON 형식만 출력하세요. 설명, 마크다운, 코드블록 일절 없이 { 로 시작해서 } 로 끝나야 합니다.
중요: 모든 문자열 값 안에서는 큰따옴표(")를 절대 쓰지 마세요. 강조가 필요하면 작은따옴표(')를 쓰세요.
{"summary":"오늘의 핵심 요약 3줄 이내 줄바꿈은 \\n","news":[{"category":"카테고리명","title":"기사제목","url":"기사URL","oneline":"한줄요약"}],"insight":"오늘 주목할 점 1~2가지 줄바꿈은 \\n"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  if (data?.error) {
    console.error("Claude API 오류:", JSON.stringify(data.error));
  }
  const text = data?.content?.[0]?.text ?? "";
  console.log("Claude 응답 앞100자:", text.slice(0, 100));
  return text;
}

function parseBriefing(briefingText: string): any {
  let clean = briefingText.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end !== -1) clean = clean.slice(start, end + 1);

  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("1차 파싱 실패, 복구 시도:", e);
  }

  try {
    const summaryMatch = clean.match(/"summary":"((?:[^"\\]|\\.)*)"/);
    const insightMatch = clean.match(/"insight":"((?:[^"\\]|\\.)*)"/);

    const news: any[] = [];
    const newsBlockRegex =
      /"category":"([^"]*)"\s*,\s*"title":"(.*?)"\s*,\s*"url":"(https?:\/\/[^"]+)"\s*,\s*"oneline":"(.*?)"\s*}/g;
    let m;
    while ((m = newsBlockRegex.exec(clean)) !== null) {
      news.push({
        category: m[1],
        title: m[2].replace(/"/g, "'"),
        url: m[3],
        oneline: m[4].replace(/"/g, "'"),
      });
    }

    if (news.length > 0) {
      console.log(`2차 복구 성공: 뉴스 ${news.length}건`);
      return {
        summary: summaryMatch ? summaryMatch[1] : "",
        news,
        insight: insightMatch ? insightMatch[1] : "",
      };
    }
  } catch (e) {
    console.error("2차 복구도 실패:", e);
  }

  return null;
}

function buildHtml(briefingText: string, today: string): string {
  const parsed = parseBriefing(briefingText);

  if (!parsed) {
    return `
<div style="font-family:'Apple SD Gothic Neo',Arial,sans-serif;max-width:680px;margin:0 auto;color:#222">
  <div style="background:#4f6ef7;padding:20px 24px;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0;font-size:18px">🤖 깡자동 브리핑 - ${today}</h2>
  </div>
  <div style="background:#fff;padding:24px">
    <pre style="white-space:pre-wrap;font-family:inherit;line-height:1.8">${briefingText}</pre>
  </div>
</div>`;
  }

  const grouped: Record<string, any[]> = {};
  for (const n of parsed.news || []) {
    const cat = n.category || "기타";
    if (!grouped[cat]) grouped[cat] = [];
    // 안전장치: HTML에서도 관심사당 최대 3건
    if (grouped[cat].length < BRIEFING_MAX_PER_INTEREST) grouped[cat].push(n);
  }

  // 0건 카테고리는 애초에 grouped에 없음 → 생략
  const categoryBlocks = Object.entries(grouped)
    .map(([cat, items]) => {
      if (!items.length) return "";
      const rows = items
        .map(
          (n, i) => `
      <div style="margin-bottom:16px;padding-left:4px">
        <div style="margin-bottom:5px">
          <span style="color:#666;font-size:13px;margin-right:4px">${i + 1}.</span>
          <strong style="color:#1a1a1a;font-size:14px;line-height:1.5">${n.title || ""}</strong>
        </div>
        <div style="padding-left:18px;color:#555;font-size:13px;line-height:1.7">
          - ${n.oneline || ""}
          &nbsp;
          <a href="${n.url || "#"}" target="_blank"
             style="color:#4f6ef7;text-decoration:none;font-size:12px;font-weight:600">[출처]</a>
        </div>
      </div>`,
        )
        .join("");

      return `
      <div style="margin-bottom:28px">
        <div style="background:#f0f2ff;padding:8px 14px;border-left:4px solid #4f6ef7;margin-bottom:14px;border-radius:0 4px 4px 0">
          <strong style="color:#4f6ef7;font-size:14px">[${cat}]</strong>
        </div>
        ${rows}
      </div>`;
    })
    .filter(Boolean)
    .join("");

  const summaryHtml = (parsed.summary || "")
    .replace(/\\n/g, "<br>")
    .replace(/\n/g, "<br>");
  const insightHtml = (parsed.insight || "")
    .replace(/\\n/g, "<br>")
    .replace(/\n/g, "<br>");

  const newsSection = categoryBlocks
    ? categoryBlocks
    : `<p style="color:#888;font-size:14px;margin:0">오늘 수집된 뉴스가 없어 뉴스 섹션을 생략합니다.</p>`;

  return `
<div style="font-family:'Apple SD Gothic Neo',Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
  <div style="background:#4f6ef7;padding:20px 24px">
    <h2 style="color:#fff;margin:0;font-size:18px;font-weight:700">🤖 깡자동 브리핑</h2>
    <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:13px">${today}</p>
  </div>
  <div style="background:#f8f9ff;padding:16px 24px;border-left:4px solid #4f6ef7">
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#4f6ef7">📌 오늘의 핵심 요약</p>
    <p style="margin:0;line-height:1.9;font-size:14px;color:#333">${summaryHtml || "수집 뉴스 없음"}</p>
  </div>
  <div style="background:#fff;padding:20px 24px">
    ${newsSection}
  </div>
  <div style="background:#f8f9ff;padding:16px 24px;border-top:1px solid #e8eaff">
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#4f6ef7">💡 오늘 주목할 점</p>
    <p style="margin:0;font-size:14px;color:#444;line-height:1.8">${insightHtml || "-"}</p>
  </div>
  <div style="padding:10px 24px;background:#f0f2ff;text-align:center">
    <p style="margin:0;font-size:11px;color:#aaa">깡자동 AI 브리핑 · KTIS 총괄 PM</p>
  </div>
</div>`;
}

async function sendEmail(briefingText: string, emails: string[]) {
  const today = new Date().toLocaleDateString("ko-KR");
  const html = buildHtml(briefingText, today);
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
    },
    body: JSON.stringify({
      personalizations: [
        { to: emails.filter(Boolean).map((email) => ({ email })) },
      ],
      from: { email: "20oioi20@gmail.com", name: "깡자동 AI비서" },
      subject: `[깡자동] ${today} 아침 브리핑`,
      content: [{ type: "text/html", value: html }],
    }),
  });
  console.log("SendGrid 상태:", res.status);
}

async function refreshKakaoToken(refreshToken: string): Promise<string | null> {
  if (!KAKAO_REST_API_KEY || !KAKAO_CLIENT_SECRET) {
    console.log("카카오 API 키 미설정 - 갱신 불가");
    return null;
  }
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("client_id", KAKAO_REST_API_KEY);
  params.append("client_secret", KAKAO_CLIENT_SECRET);
  params.append("refresh_token", refreshToken);

  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json();
  if (!data.access_token) {
    console.error("카카오 토큰 갱신 실패:", JSON.stringify(data));
    return null;
  }
  if (data.refresh_token) {
    await supabase
      .from("settings")
      .update({ value: data.refresh_token })
      .eq("key", "kakao_refresh_token");
    console.log("카카오 refresh_token 갱신됨 (DB 업데이트 완료)");
  }
  return data.access_token;
}

async function sendKakao(briefingText: string, refreshToken: string | null) {
  if (!refreshToken) {
    console.log("카카오 refresh_token 없음 - 스킵");
    return;
  }

  const accessToken = await refreshKakaoToken(refreshToken);
  if (!accessToken) {
    console.log("카카오 access_token 발급 실패 - 스킵");
    return;
  }

  const parsed = parseBriefing(briefingText);
  let text = "🤖 깡자동 브리핑\n";
  text += `${new Date().toLocaleDateString("ko-KR")}\n\n`;

  if (parsed) {
    const summary = (parsed.summary || "").replace(/\\n/g, "\n");
    text += `📌 오늘의 핵심 요약\n${summary}\n\n`;

    const grouped: Record<string, any[]> = {};
    for (const n of parsed.news || []) {
      const cat = n.category || "기타";
      if (!grouped[cat]) grouped[cat] = [];
      if (grouped[cat].length < BRIEFING_MAX_PER_INTEREST) grouped[cat].push(n);
    }
    for (const [cat, items] of Object.entries(grouped)) {
      if (!items.length) continue;
      text += `[${cat}]\n`;
      items.forEach((n, i) => {
        text += `${i + 1}. ${n.title}\n`;
        if (n.url) text += `   [출처] ${n.url}\n`;
      });
      text += "\n";
    }
    if (Object.keys(grouped).length === 0) {
      text += "(오늘 수집 뉴스 없음 — 뉴스 섹션 생략)\n\n";
    }
    const insight = (parsed.insight || "").replace(/\\n/g, "\n");
    text += `💡 오늘 주목할 점\n${insight}`;
  } else {
    text += briefingText;
  }

  const body = new URLSearchParams();
  body.append(
    "template_object",
    JSON.stringify({
      object_type: "text",
      text,
      link: {
        web_url: "https://ggangja-briefing-settings.vercel.app",
        mobile_web_url: "https://ggangja-briefing-settings.vercel.app",
      },
    }),
  );

  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const result = await res.json();
  console.log("카카오 발송 결과:", JSON.stringify(result));
}

async function saveBriefing(briefingText: string, dateStr: string) {
  await supabase.from("briefings").delete().eq("date", dateStr).eq("channel", "email+kakao");
  // channel 필터 delete가 스키마에 안 맞을 수 있어 기존 방식도 유지
  await supabase.from("briefings").delete().eq("date", dateStr);
  const { error } = await supabase.from("briefings").insert({
    date: dateStr,
    content: briefingText,
    sent_at: new Date().toISOString(),
    channel: "email+kakao",
  });
  if (error) console.error("briefings 저장 실패:", JSON.stringify(error));
  else console.log("briefings 저장 완료:", dateStr);
}

/** 수집 0건이어도 발송 가능한 최소 브리핑 JSON */
function emptyNewsBriefing(): string {
  return JSON.stringify({
    summary: "오늘 조건에 맞는 신규 뉴스가 없어 뉴스 섹션을 생략합니다.",
    news: [],
    insight: "관심사 키워드·수집 건수·활성 여부를 설정 화면에서 확인해 주세요.",
  });
}

Deno.serve(async (_req) => {
  if (_req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const url = new URL(_req.url);
    const force = url.searchParams.get("force") === "true";

    const { hour: currentHour, day: currentDay, dateStr } = getKST();
    const settings = await getSettings();

    // UI 전용키(news_*) 우선, 공통키 하위호환
    const legacyHour = parseInt(String(settings["briefing_hour"] ?? "9"), 10) || 9;
    const briefingHours = parseHours(
      settings["news_hours"] ?? settings["briefing_hours"],
      legacyHour,
    );
    const briefingDays = parseDays(
      settings["news_days"] ?? settings["briefing_days"],
    );
    const paused = toBool(
      settings["news_paused"] ?? settings["briefing_paused"],
    );
    const kakaoRefreshToken = settings["kakao_refresh_token"] || null;

    console.log(
      `KST: ${currentHour}시 ${currentDay}요일 ${dateStr} / 시각: [${briefingHours}] / 요일: [${briefingDays}] / 일시정지: ${paused}`,
    );

    if (!force) {
      if (paused) {
        return new Response(
          JSON.stringify({ skipped: true, reason: "일시정지 중" }),
          { headers: { "Content-Type": "application/json", ...CORS } },
        );
      }
      if (!briefingHours.includes(currentHour)) {
        return new Response(
          JSON.stringify({
            skipped: true,
            reason: `발송 시간 아님 (현재 ${currentHour}시, 설정 ${briefingHours.join(",")}시)`,
          }),
          { headers: { "Content-Type": "application/json", ...CORS } },
        );
      }
      if (!briefingDays.includes(currentDay)) {
        return new Response(
          JSON.stringify({
            skipped: true,
            reason: `발송 요일 아님 (오늘 ${currentDay}요일, 설정 ${briefingDays})`,
          }),
          { headers: { "Content-Type": "application/json", ...CORS } },
        );
      }
    }

    const [interests, emails, sentUrls] = await Promise.all([
      getInterests(),
      getEmails(),
      getRecentlySentUrls(),
    ]);

    console.log(`활성 관심사: ${interests.length}개`);

    const { allNews, stats } = await fetchAllNews(interests);
    console.log("수집 뉴스(중복제거 전):", allNews.length);

    const freshNews = allNews.filter((n) => !sentUrls.has(n.url));
    console.log(
      `7일 중복 제거 후: ${freshNews.length}건 (${allNews.length - freshNews.length}건 제외)`,
    );

    // 관심사당 브리핑 최대 3건 · 0건 관심사 생략
    const forBriefing = capPerInterest(freshNews, BRIEFING_MAX_PER_INTEREST);
    console.log(
      `브리핑 확정: ${forBriefing.length}건 (관심사당 최대 ${BRIEFING_MAX_PER_INTEREST})`,
    );

    let briefing: string;
    if (forBriefing.length === 0) {
      console.log("브리핑 대상 뉴스 0건 → 뉴스 섹션 생략 템플릿");
      briefing = emptyNewsBriefing();
    } else {
      briefing = await generateBriefing(interests, forBriefing);
      if (!briefing || briefing.length < 10) {
        briefing = emptyNewsBriefing();
      }
    }

    await Promise.all([
      sendEmail(briefing, emails),
      sendKakao(briefing, kakaoRefreshToken),
      saveBriefing(briefing, dateStr),
    ]);

    return new Response(
      JSON.stringify({
        success: true,
        recipients: emails,
        collectStats: stats,
        collected: allNews.length,
        afterDedupe: freshNews.length,
        newsCount: forBriefing.length,
        maxPerInterest: BRIEFING_MAX_PER_INTEREST,
        duplicatesRemoved: allNews.length - freshNews.length,
        preview: briefing.slice(0, 200),
      }),
      { headers: { "Content-Type": "application/json", ...CORS } },
    );
  } catch (err) {
    console.error("메인 오류:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});
