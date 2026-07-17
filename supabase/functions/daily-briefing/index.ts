import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const NAVER_CLIENT_ID = Deno.env.get("NAVER_CLIENT_ID") || "";
const NAVER_CLIENT_SECRET = Deno.env.get("NAVER_CLIENT_SECRET") || "";
const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY")!;
const KAKAO_REST_API_KEY = Deno.env.get("KAKAO_REST_API_KEY");
const KAKAO_CLIENT_SECRET = Deno.env.get("KAKAO_CLIENT_SECRET");

// NCP API Hub (NAVER API HUB) — KEY-ID + KEY
// 시크릿 이름 호환: NCP_NAVER_API_KEY_ID / NCP_NAVER_API_KEY / NAVER_CLIENT_*
const NCP_KEY_ID =
  Deno.env.get("NCP_NAVER_API_KEY_ID") ||
  Deno.env.get("NCP_CLIENT_ID") ||
  Deno.env.get("NAVER_CLIENT_ID") ||
  "";
const NCP_KEY =
  Deno.env.get("NCP_NAVER_API_KEY") ||
  Deno.env.get("NCP_CLIENT_SECRET") ||
  Deno.env.get("NAVER_CLIENT_SECRET") ||
  "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/** 관심사당 브리핑에 실을 최대 기사 수 (수집 후보 extra와 별개) */
const BRIEFING_MAX_PER_INTEREST = 3;
/** 최신 기사 허용 창 (시간). 24h는 아침 발송 시 0건이 잦아 48h로 완화 */
const NEWS_MAX_AGE_HOURS = 48;

/** 마지막 사용된 AI / 뉴스 API (히스토리 _provider 기록용) */
let lastAIProvider = "Claude API";
let lastNewsApiProvider = "naver";

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

type NewsItem = {
  interestId: string | number;
  category: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
};

type PriorFingerprints = {
  urls: Set<string>;
  /** 정규화 전 원문 제목·한줄요약 (유사도 비교용) */
  texts: string[];
};

/** 제목/요약 비교용 정규화: 공백·구두점·언론 접두 제거 */
function normalizeText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/<\/?b>/g, "")
    .replace(/(속보|단독|종합|영상|포토|전문|특징주|공시)\s*/g, "")
    .replace(/[\s\[\]\(\)\{\}「」『』"'“”‘’·•…\-_=~|/\\<>]+/g, "")
    .replace(/[.,!?:;，。！？、·]/g, "")
    .trim();
}

/** URL 정규화: 트래킹 파라미터 제거 후 비교 */
function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    // 흔한 트래킹 파라미터 제거
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "ref"].forEach(
      (k) => x.searchParams.delete(k),
    );
    x.hash = "";
    let host = x.hostname.replace(/^www\./, "");
    return `${host}${x.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return (u || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function tokenizeForSim(s: string): Set<string> {
  const tokens = new Set<string>();
  const raw = (s || "").toLowerCase();
  for (const w of raw.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 2) tokens.add(w);
  }
  const n = normalizeText(s);
  // 한글 등 붙여쓴 문장용 bigram
  for (let i = 0; i < n.length - 1; i++) {
    tokens.add(n.slice(i, i + 2));
  }
  if (n.length >= 3) {
    for (let i = 0; i < n.length - 2; i++) {
      tokens.add(n.slice(i, i + 3));
    }
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 비슷한 내용 판정
 * - 동일/포함 제목
 * - 앞부분 긴 접두 일치
 * - 토큰 Jaccard (제목 / 제목+요약)
 */
function isSimilarContent(
  aTitle: string,
  aSummary: string,
  bTitle: string,
  bSummary = "",
  titleThreshold = 0.52,
  bodyThreshold = 0.48,
): boolean {
  const na = normalizeText(aTitle);
  const nb = normalizeText(bTitle);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // 한쪽이 다른 쪽을 포함 (같은 이슈 재전송)
  const minLen = Math.min(na.length, nb.length);
  if (minLen >= 10 && (na.includes(nb) || nb.includes(na))) return true;

  const prefixLen = Math.min(18, na.length, nb.length);
  if (prefixLen >= 12 && na.slice(0, prefixLen) === nb.slice(0, prefixLen)) {
    return true;
  }

  if (jaccard(tokenizeForSim(aTitle), tokenizeForSim(bTitle)) >= titleThreshold) {
    return true;
  }

  // 제목 ↔ 상대 요약
  if (bSummary && jaccard(tokenizeForSim(aTitle), tokenizeForSim(bSummary)) >= bodyThreshold + 0.05) {
    return true;
  }
  if (aSummary && jaccard(tokenizeForSim(aSummary), tokenizeForSim(bTitle)) >= bodyThreshold + 0.05) {
    return true;
  }

  // 요약끼리 (충분히 긴 경우만)
  if (
    aSummary &&
    bSummary &&
    aSummary.length >= 24 &&
    bSummary.length >= 24 &&
    jaccard(tokenizeForSim(aSummary), tokenizeForSim(bSummary)) >= bodyThreshold
  ) {
    return true;
  }

  // 제목+요약 합친 시그니처
  const sa = tokenizeForSim(`${aTitle} ${aSummary || ""}`);
  const sb = tokenizeForSim(`${bTitle} ${bSummary || ""}`);
  if (sa.size >= 8 && sb.size >= 8 && jaccard(sa, sb) >= bodyThreshold) {
    return true;
  }

  return false;
}

async function getRecentlySentFingerprints(): Promise<PriorFingerprints> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fromDate = sevenDaysAgo.toISOString().slice(0, 10);

  const { data } = await supabase
    .from("briefings")
    .select("content")
    .gte("date", fromDate);

  const urls = new Set<string>();
  const texts: string[] = [];
  const urlRegex = /"url"\s*:\s*"(https?:\/\/[^"]+)"/g;
  const titleRegex = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const onelineRegex = /"oneline"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

  for (const row of data || []) {
    const content = row.content || "";
    let m;
    while ((m = urlRegex.exec(content)) !== null) {
      urls.add(m[1]);
      urls.add(normalizeUrl(m[1]));
    }
    while ((m = titleRegex.exec(content)) !== null) {
      const t = m[1].replace(/\\n/g, " ").replace(/\\"/g, "'").trim();
      if (t) texts.push(t);
    }
    while ((m = onelineRegex.exec(content)) !== null) {
      const t = m[1].replace(/\\n/g, " ").replace(/\\"/g, "'").trim();
      if (t) texts.push(t);
    }
  }
  console.log(
    `최근 7일 지문: URL ${urls.size}개, 텍스트(제목·요약) ${texts.length}개`,
  );
  return { urls, texts };
}

/**
 * URL + 유사 내용 중복 제거
 * - 최근 7일 발송분과 비교
 * - 당일 수집분 내부 상호 비교 (최신 기사 우선 유지)
 */
function dedupeByUrlAndContent(
  news: NewsItem[],
  prior: PriorFingerprints,
): { kept: NewsItem[]; removedUrl: number; removedSimilar: number } {
  // 최신 기사 우선
  const sorted = [...news].sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  const kept: NewsItem[] = [];
  let removedUrl = 0;
  let removedSimilar = 0;

  for (const item of sorted) {
    const nUrl = normalizeUrl(item.url);
    if (prior.urls.has(item.url) || prior.urls.has(nUrl)) {
      removedUrl++;
      continue;
    }
    if (kept.some((k) => k.url === item.url || normalizeUrl(k.url) === nUrl)) {
      removedUrl++;
      continue;
    }

    // 최근 7일 발송 제목/한줄요약과 유사
    const hitPrior = prior.texts.some((t) =>
      isSimilarContent(item.title, item.summary, t, ""),
    );
    if (hitPrior) {
      removedSimilar++;
      console.log(`유사(7일내) 제외: ${item.title.slice(0, 40)}`);
      continue;
    }

    // 당일 배치 내부 유사
    const hitBatch = kept.some((k) =>
      isSimilarContent(item.title, item.summary, k.title, k.summary),
    );
    if (hitBatch) {
      removedSimilar++;
      console.log(`유사(배치내) 제외: ${item.title.slice(0, 40)}`);
      continue;
    }

    kept.push(item);
  }

  return { kept, removedUrl, removedSimilar };
}

// ══════════════════════════════════════════════
// AI Provider: 서강대 MOT(GPT-5.5) → Claude Sonnet 4.6 → Gemini
// ══════════════════════════════════════════════
function resolveMotEndpoint(): { url: string; key: string } | null {
  const MOT_URL =
    Deno.env.get("MOT_GATEWAY_URL") || Deno.env.get("SOGANG_MOT_API_URL") || "";
  const MOT_KEY =
    Deno.env.get("MOT_GATEWAY_KEY") || Deno.env.get("SOGANG_MOT_API_KEY") || "";
  if (!MOT_URL || !MOT_KEY) return null;
  const endpoint = MOT_URL.includes("/chat/completions")
    ? MOT_URL.trim()
    : MOT_URL.includes("/v1/")
      ? `${MOT_URL.trim().replace(/\/$/, "")}/chat/completions`
      : `${MOT_URL.trim().replace(/\/$/, "")}/v1/chat/completions`;
  return { url: endpoint, key: MOT_KEY };
}

async function callAI(
  prompt: string,
  maxTokens: number,
  taskType = "news",
): Promise<string> {
  const model = taskType === "news" || taskType === "saju" || taskType === "keyword"
    ? "gpt-5.5"
    : "gpt-5.5";
  const mot = resolveMotEndpoint();
  const ANT_KEY = Deno.env.get("ANTHROPIC_API_KEY") || ANTHROPIC_API_KEY;
  const GEM_KEY = Deno.env.get("GEMINI_API_KEY");

  // 1) 서강대 MOT Gateway (GPT-5.5)
  if (mot) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 45000);
      const res = await fetch(mot.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mot.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: ac.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content ?? "";
        if (text.length > 10) {
          lastAIProvider = `Gateway(${model})`;
          console.log(`[AI] Gateway(${model}) 성공`);
          return text;
        }
        console.log("[AI] Gateway 응답 비어있음 → Claude fallback");
      } else {
        const errBody = await res.text().catch(() => "");
        console.log(
          `[AI] Gateway HTTP ${res.status} → Claude | ${mot.url} | ${errBody.slice(0, 120)}`,
        );
      }
    } catch (e) {
      console.log(`[AI] Gateway 오류 → Claude: ${String(e).slice(0, 120)}`);
    }
  } else {
    console.log("[AI] MOT Gateway 미설정 → Claude 사용");
  }

  // 2) Claude Sonnet 4.6
  if (ANT_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANT_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      if (!data.error) {
        const text = data?.content?.[0]?.text ?? "";
        if (text) {
          lastAIProvider = "Claude API";
          console.log("[AI] Claude 성공");
          return text;
        }
      } else {
        console.log(
          `[AI] Claude 오류 → Gemini: ${data.error.message?.slice(0, 80)}`,
        );
      }
    } catch (e) {
      console.log(`[AI] Claude 오류 → Gemini: ${String(e).slice(0, 60)}`);
    }
  }

  // 3) Gemini (최후)
  if (GEM_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEM_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
          }),
        },
      );
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (text) {
        lastAIProvider = "Gemini";
        console.log("[AI] Gemini fallback 성공");
        return text;
      }
    } catch (e) {
      console.log(`[AI] Gemini 오류: ${String(e).slice(0, 60)}`);
    }
  }

  console.error(`[AI] 모든 Provider 실패 (${taskType})`);
  return "";
}

/** 개발자센터 네이버 검색 API */
async function fetchNaverDevelopersNews(
  query: string,
  display: number,
): Promise<any[] | null> {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    console.error("네이버 Developers 키 미설정");
    return null;
  }
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
      `네이버 Developers 오류 [q=${query}]:`,
      json.errorCode,
      json.errorMessage,
    );
    return null;
  }
  if (!res.ok) {
    console.error(
      `네이버 Developers HTTP ${res.status}:`,
      JSON.stringify(json).slice(0, 200),
    );
    return null;
  }
  return Array.isArray(json.items) ? json.items : [];
}

/**
 * NCP NAVER API HUB 뉴스 검색
 * GET https://naverapihub.apigw.ntruss.com/search/v1/news
 * Headers: X-NCP-APIGW-API-KEY-ID / X-NCP-APIGW-API-KEY
 */
async function fetchNcpHubNews(
  query: string,
  display: number,
): Promise<any[] | null> {
  if (!NCP_KEY_ID || !NCP_KEY) {
    console.error("NCP API Hub 키 미설정 (NCP_NAVER_API_KEY / KEY-ID)");
    return null;
  }
  const url =
    `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(query)}` +
    `&display=${display}&start=1&sort=date&format=json`;
  const res = await fetch(url, {
    headers: {
      "X-NCP-APIGW-API-KEY-ID": NCP_KEY_ID,
      "X-NCP-APIGW-API-KEY": NCP_KEY,
    },
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    console.error(`NCP 응답 파싱 실패 HTTP ${res.status}:`, text.slice(0, 200));
    return null;
  }
  if (!res.ok || json.error || json.errorCode || json.message) {
    console.error(
      `NCP API Hub 오류 [q=${query}] HTTP ${res.status}:`,
      text.slice(0, 200),
    );
    return null;
  }
  if (!Array.isArray(json.items)) {
    console.error("NCP 응답에 items 없음:", text.slice(0, 200));
    return null;
  }
  return json.items;
}

/**
 * 설정 news_api_provider 우선 + 오류 시 자동 폴백
 * - ncp: NCP API Hub → 실패 시 네이버 Developers
 * - naver: 네이버 Developers → 실패 시 NCP API Hub
 */
async function fetchNewsWithFallback(
  query: string,
  display: number,
  preferred: "ncp" | "naver",
): Promise<any[]> {
  const order: Array<"ncp" | "naver"> =
    preferred === "ncp" ? ["ncp", "naver"] : ["naver", "ncp"];

  for (const prov of order) {
    try {
      const items =
        prov === "ncp"
          ? await fetchNcpHubNews(query, display)
          : await fetchNaverDevelopersNews(query, display);
      // null = 인증/HTTP 실패 → 다음 프로바이더. [] = 성공이지만 결과 없음.
      if (items !== null) {
        lastNewsApiProvider = prov;
        if (prov !== preferred) {
          console.log(
            `[News] ${preferred} 실패 → ${prov} 폴백 성공 [q=${query}] ${items.length}건`,
          );
        } else {
          console.log(`[News] ${prov} 성공 [q=${query}] ${items.length}건`);
        }
        return items;
      }
    } catch (e) {
      console.error(`[News] ${prov} 예외:`, e);
    }
  }
  console.error(`[News] 모든 뉴스 API 실패 [q=${query}]`);
  return [];
}

/** @deprecated alias — 내부는 폴백 포함 fetch 사용 */
async function fetchNaverNews(
  query: string,
  display: number,
  preferred: "ncp" | "naver" = "ncp",
): Promise<any[]> {
  return fetchNewsWithFallback(query, display, preferred);
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
async function fetchAllNews(
  interests: any[],
  preferredNewsApi: "ncp" | "naver" = "ncp",
): Promise<{
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

    const bucket: NewsItem[] = [];

    try {
      // 키워드별로 나눠 수집 후 URL·유사내용 합침 (관심사당 최대 display건)
      const perKw = Math.min(
        100,
        Math.max(3, Math.ceil(display / keywords.length)),
      );

      for (const kw of keywords) {
        const items = await fetchNewsWithFallback(kw, perKw, preferredNewsApi);
        for (const a of items) {
          if (!isFresh(a.pubDate, maxAgeMs)) continue;
          const articleUrl = a.originallink || a.link;
          if (!articleUrl) continue;
          const nUrl = normalizeUrl(articleUrl);
          if (bucket.some((b) => b.url === articleUrl || normalizeUrl(b.url) === nUrl)) {
            continue;
          }
          const title = stripHtml(a.title);
          const summary = stripHtml(a.description);
          // 같은 관심사 내 비슷한 제목/요약이면 스킵 (최신 우선이므로 이미 들어 있으면 유지)
          if (
            bucket.some((b) =>
              isSimilarContent(title, summary, b.title, b.summary),
            )
          ) {
            continue;
          }
          bucket.push({
            interestId: interest.id,
            category: label,
            title,
            summary,
            url: articleUrl,
            publishedAt: a.pubDate,
          });
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      // 최신순 정렬 후 관심사 후보 상한(extra)
      const sorted = bucket.sort(
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

  // MOT GPT-5.5 → Claude 4.6 → Gemini
  const text = await callAI(prompt, 4000, "news");
  console.log("AI 응답 앞100자:", (text || "").slice(0, 100), "| provider:", lastAIProvider);
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

function attachMetaToBriefing(briefingText: string): string {
  // 히스토리 UI가 content._provider 를 읽음
  try {
    const parsed = parseBriefing(briefingText);
    if (parsed && typeof parsed === "object") {
      parsed._provider = lastAIProvider;
      parsed._news_api = lastNewsApiProvider;
      parsed._type = "news";
      return JSON.stringify(parsed);
    }
  } catch {}
  // 파싱 실패 시 래핑
  return JSON.stringify({
    _provider: lastAIProvider,
    _news_api: lastNewsApiProvider,
    _type: "news",
    summary: briefingText.slice(0, 500),
    news: [],
    insight: "",
    raw: briefingText,
  });
}

async function saveBriefing(briefingText: string, dateStr: string) {
  const content = attachMetaToBriefing(briefingText);
  await supabase.from("briefings").delete().eq("date", dateStr).eq("channel", "email+kakao");
  // channel 필터 delete가 스키마에 안 맞을 수 있어 기존 방식도 유지
  await supabase.from("briefings").delete().eq("date", dateStr);
  const { error } = await supabase.from("briefings").insert({
    date: dateStr,
    content,
    sent_at: new Date().toISOString(),
    channel: "email+kakao",
  });
  if (error) console.error("briefings 저장 실패:", JSON.stringify(error));
  else console.log("briefings 저장 완료:", dateStr, lastAIProvider, lastNewsApiProvider);
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

    const [interests, emails, priorFp] = await Promise.all([
      getInterests(),
      getEmails(),
      getRecentlySentFingerprints(),
    ]);

    console.log(`활성 관심사: ${interests.length}개`);

    // UI 설정: news_api_provider = ncp | naver (기본 ncp, 오류 시 자동 폴백)
    const rawProv = String(settings["news_api_provider"] || "ncp").toLowerCase();
    const preferredNewsApi: "ncp" | "naver" = rawProv === "naver" ? "naver" : "ncp";
    console.log(`뉴스 API 우선: ${preferredNewsApi} (NCP키:${NCP_KEY_ID ? "Y" : "N"}/${NCP_KEY ? "Y" : "N"}, 네이버Dev:${NAVER_CLIENT_ID ? "Y" : "N"})`);

    const { allNews, stats } = await fetchAllNews(interests, preferredNewsApi);
    console.log("수집 뉴스(중복제거 전):", allNews.length);

    const { kept: freshNews, removedUrl, removedSimilar } = dedupeByUrlAndContent(
      allNews,
      priorFp,
    );
    console.log(
      `중복 제거 후: ${freshNews.length}건 (URL ${removedUrl} + 유사내용 ${removedSimilar} 제외)`,
    );

    // 관심사당 브리핑 최대 3건 · 0건 관심사 생략
    // (URL·유사내용 중복은 위에서 관심사 교차 포함 이미 제거됨)
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
        duplicatesRemoved: removedUrl + removedSimilar,
        dedupe: { removedUrl, removedSimilar },
        preferredNewsApi,
        newsApiUsed: lastNewsApiProvider,
        aiProvider: lastAIProvider,
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
