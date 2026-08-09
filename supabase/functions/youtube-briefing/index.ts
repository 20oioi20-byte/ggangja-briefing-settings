import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail } from "../_shared/mail.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

// 마지막으로 성공한 분석 경로 (히스토리 _provider)
let lastYtProvider = "Gemini";

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

// ── YouTube 분석 AI: 서강대 MOT(Gemini) → Gemini API ──
// 영상 직접 분석 실패 시 caption/description 기반 텍스트 요약에도 동일 순서 적용
async function callYoutubeTextAI(prompt: string): Promise<string> {
  const mot = resolveMotEndpoint();
  const GEM_KEY = Deno.env.get("GEMINI_API_KEY");
  // MOT 게이트웨이에서 쓰는 Gemini 계열 모델명 (여러 후보 시도)
  const motGeminiModels = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-flash",
    "google/gemini-2.5-flash",
  ];

  // 1순위: 서강대 MOT Gateway (Gemini)
  if (mot) {
    for (const model of motGeminiModels) {
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
            max_tokens: 1500,
            temperature: 0.3,
          }),
          signal: ac.signal,
        });
        clearTimeout(t);
        if (res.ok) {
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content ?? "";
          if (text.length > 20) {
            lastYtProvider = `Gateway(${model})`;
            console.log(`[YouTube] Gateway Gemini(${model}) 성공`);
            return text;
          }
        } else {
          const err = await res.text().catch(() => "");
          console.log(
            `[YouTube] Gateway ${model} 실패 (${res.status}) → 다음 | ${err.slice(0, 80)}`,
          );
        }
      } catch (e) {
        console.log(
          `[YouTube] Gateway ${model} 오류:`,
          String(e).slice(0, 60),
        );
      }
    }
    console.log("[YouTube] MOT Gemini 전부 실패 → Gemini API fallback");
  } else {
    console.log("[YouTube] MOT 미설정 → Gemini API 직접 사용");
  }

  // 2순위: Gemini API 직접 (텍스트)
  if (GEM_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEM_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1500, temperature: 0.3 },
          }),
        },
      );
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (text.length > 20) {
        lastYtProvider = "Gemini API";
        console.log("[YouTube] Gemini API 텍스트 fallback 성공");
        return text;
      }
    } catch (e) {
      console.log("[YouTube] Gemini API 텍스트 오류:", String(e).slice(0, 60));
    }
  }

  return "";
}

// ── YouTube description 조회 ──
async function fetchVideoDescription(videoId: string): Promise<string> {
  const YOUTUBE_API_KEY = Deno.env.get("YOUTUBE_API_KEY")!;
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`
  );
  const data = await res.json();
  const item = data.items?.[0]?.snippet;
  if (!item) return "";
  const desc = item.description || "";
  return desc.length >= 30 ? `제목: ${item.title}\n설명: ${desc.slice(0, 800)}` : "";
}
const YOUTUBE_API_KEY = Deno.env.get("YOUTUBE_API_KEY")!;
const KAKAO_REST_API_KEY = Deno.env.get("KAKAO_REST_API_KEY");
const KAKAO_CLIENT_SECRET = Deno.env.get("KAKAO_CLIENT_SECRET");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── 설정값 ──
const MAX_DURATION_MIN = 60;   // 60분 초과 영상 제외
const MAX_VIDEOS_PER_CHANNEL = 2;  // 채널당 하루 최대 2개

function getKST(): { hour: number; day: number } {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const jsDay = kst.getUTCDay();
  return { hour: kst.getUTCHours(), day: jsDay === 0 ? 7 : jsDay };
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

async function getChannels() {
  const { data } = await supabase
    .from("youtube_channels").select("*").eq("is_active", true).order("sort_order");
  return data || [];
}

// ISO 8601 duration → 분
function durationToMinutes(iso: string): number {
  const h = iso.match(/(\d+)H/);
  const m = iso.match(/(\d+)M/);
  const s = iso.match(/(\d+)S/);
  return (h ? +h[1] : 0) * 60 + (m ? +m[1] : 0) + (s ? +s[1] : 0) / 60;
}

// ── 채널의 최근 24시간 신규 영상 (60분 이하, 채널당 최대 2개) ──
async function getNewVideos(channel: any): Promise<any[]> {
  const playlistId = channel.uploads_playlist_id;
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=10&key=${YOUTUBE_API_KEY}`
  );
  const json = await res.json();
  if (json.error) {
    console.error(`채널 ${channel.channel_title} 오류:`, json.error.message);
    return [];
  }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const candidates: any[] = [];

  // 1차: 24시간 이내 + 미발송 영상 후보 수집
  for (const it of (json.items || [])) {
    const cd = it.contentDetails;
    const sn = it.snippet;
    const videoId = cd.videoId;
    const published = cd.videoPublishedAt || sn.publishedAt;
    if (now - new Date(published).getTime() > dayMs) continue;

    const { data: exist } = await supabase
      .from("youtube_sent").select("video_id").eq("video_id", videoId).maybeSingle();
    if (exist) continue;

    candidates.push({
      videoId,
      title: sn.title,
      channelTitle: channel.channel_title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: published,
    });
  }

  if (candidates.length === 0) return [];

  // 2차: 영상 길이 일괄 조회 (videos API)
  const ids = candidates.map(v => v.videoId).join(",");
  const durRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YOUTUBE_API_KEY}`
  );
  const durJson = await durRes.json();
  const durMap: Record<string, number> = {};
  for (const v of (durJson.items || [])) {
    durMap[v.id] = durationToMinutes(v.contentDetails.duration || "PT0S");
  }

  // 3차: 60분 이하만 필터 (최신순 유지)
  const filtered = candidates.filter(v => {
    const mins = durMap[v.videoId] ?? 0;
    if (mins > MAX_DURATION_MIN) {
      console.log(`제외(${mins.toFixed(0)}분): ${v.title}`);
      return false;
    }
    return true;
  });

  // 4차: 채널당 최대 2개 (최신순이므로 앞에서 자름)
  return filtered.slice(0, MAX_VIDEOS_PER_CHANNEL);
}

// ── 가짜 요약 / 분석 거부 감지 신호 ──
const BAD_SIGNALS = [
  "시청할 수 없", "볼 수 없", "직접 확인할 수 없", "링크가 제공되지",
  "죄송", "저는 텍스트", "영상을 직접", "요약 틀을 제공", "일반적으로",
  "실제 영상", "정확한 내용은", "알 수 없습니다", "모르겠습니다",
  "어떤 영상인지", "영상에 대한", "제공하지 않", "확인할 수 없",
  "구체적인 내용을", "붙여넣기", "스크립트를 제공", "형식 기준으로",
];

// ── 영상 분석: 1) 멀티모달 Gemini로 영상 자체를 직접 분석  2) 실패 시 자막/설명 기반 텍스트 분석 ──
async function analyzeVideo(video: any): Promise<{ summary: string; ok: boolean; failReason?: string }> {
  const direct = await analyzeVideoMultimodal(video);
  if (direct.ok && direct.summary) return direct;

  // 영상 직접 분석 실패(할당량 초과, 오류 등) 시 자막/설명 기반으로 폴백
  const textFallback = await analyzeVideoByText(video);
  if (textFallback.ok && textFallback.summary) return textFallback;

  return {
    summary: "",
    ok: false,
    failReason: direct.failReason || textFallback.failReason || "영상 분석 불가",
  };
}

// ── Gemini API 멀티모달 직접 분석 (YouTube URL) ──
async function analyzeVideoMultimodal(video: any): Promise<{ summary: string; ok: boolean; failReason?: string }> {
  const getErrMsg = (data: any): string => {
    if (!data?.error) return "";
    const msg = data.error.message || "";
    if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota"))
      return "무료 할당량 초과 (내일 자동 복구)";
    if (msg.includes("Too Many Requests")) return "API 요청 한도 초과";
    if (msg.includes("NOT_FOUND") || msg.includes("not found"))
      return "영상을 찾을 수 없음";
    return `API 오류: ${msg.slice(0, 60)}`;
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "이 유튜브 영상을 한국어로 핵심만 5~7줄로 요약해줘. 투자/경제/업무 관점에서 중요한 포인트 위주로. 불필요한 인사말 없이 바로 요약 내용만. 마크다운(#, **, |, - 등) 사용 금지, 일반 텍스트로만 작성.",
                },
                { file_data: { file_uri: video.url } },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 3000, temperature: 0.3 },
        }),
      },
    );
    const data = await res.json();

    if (data.error) {
      const reason = getErrMsg(data);
      console.log(`Gemini 멀티모달 오류 (${video.title}): ${reason}`);
      return { summary: "", ok: false, failReason: reason };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) {
      return { summary: "", ok: false, failReason: "응답 없음" };
    }

    const isFake = BAD_SIGNALS.some((sig) => text.includes(sig));
    if (isFake) {
      console.log(`가짜요약 감지 (${video.title}) — 자막/설명 경로로 폴백`);
      return { summary: "", ok: false, failReason: "분석 불가 (가짜 요약)" };
    }

    lastYtProvider = "Gemini API";
    return { summary: text, ok: true };
  } catch (e) {
    console.log(
      `Gemini 멀티모달 예외 (${video.title}):`,
      String(e).slice(0, 50),
    );
    return { summary: "", ok: false, failReason: String(e).slice(0, 80) };
  }
}

// ── 자막/설명 기반: MOT Gemini → Gemini API ──
async function analyzeVideoByText(video: any): Promise<{ summary: string; ok: boolean; failReason?: string; usedCaption?: boolean }> {
  // 자막 추출 시도
  let contextText = "";
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${video.videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' }
    });
    const html = await res.text();
    const capMatch = html.match(/"captionTracks":(\[.*?\])/);
    if (capMatch) {
      const tracks = JSON.parse(capMatch[1]);
      const track = tracks.find((t: any) => t.languageCode === 'ko') || tracks[0];
      if (track?.baseUrl) {
        const capRes = await fetch(track.baseUrl);
        const capXml = await capRes.text();
        const texts = [...capXml.matchAll(/<text[^>]*>(.*?)<\/text>/gs)].map(m =>
          m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/<[^>]+>/g,'')
        );
        contextText = texts.join(' ').replace(/\s+/g,' ').trim();
        if (contextText.length > 200) {
          console.log(`자막 추출 성공 (${contextText.length}자)`);
        }
      }
    }
  } catch(e) { /* 자막 없음 - description으로 진행 */ }

  // 자막 없으면 description 사용
  if (contextText.length < 200) {
    const desc = await fetchVideoDescription(video.videoId);
    if (!desc) {
      return { summary: '', ok: false, failReason: '영상 직접 분석 불가 (저작권 보호 또는 라이브 영상)' };
    }
    contextText = desc;
  }

  const usedCaption = contextText.length > 500;
  const prompt = usedCaption
    ? `다음은 유튜브 영상 "${video.title}"의 자막 전문입니다. 투자/경제/업무 관점에서 핵심만 5~7줄로 요약해줘. 인사말 없이 바로 요약만. 마크다운(#, **, |, - 등) 사용 금지, 일반 텍스트로만 작성.\n\n${contextText.slice(0, 6000)}`
    : `아래는 유튜브 영상의 제목과 설명입니다. 투자/경제/업무 관점에서 3~5줄로 요약해줘. 인사말 없이 바로 요약만. 정보가 부족해도 추측 가능한 범위에서 핵심 내용을 요약하고, "확인할 수 없다"거나 스크립트를 붙여달라는 식의 답변은 하지 마. 마크다운(#, **, |, - 등) 사용 금지, 일반 텍스트로만 작성.\n\n${contextText}`;

  const resultText = await callYoutubeTextAI(prompt);

  if (resultText && resultText.length > 30 && !BAD_SIGNALS.some(s => resultText.includes(s))) {
    const note = usedCaption ? '' : '\n\n※ 영상 직접 분석이 어려워 영상 설명 기반으로 요약했습니다.';
    return { summary: resultText + note, ok: true, usedCaption };
  }

  return { summary: '', ok: false, failReason: '영상 직접 분석 불가 (저작권 보호 또는 라이브 영상)', usedCaption };
}

// ── 메일 HTML (분석 성공/실패 구분) ──
function buildYoutubeHtml(video: any, summary: string, ok: boolean, failReason?: string): string {
  const body = ok
    ? `<div style="background:#f8f9fa;padding:16px;border-radius:8px;border-left:4px solid #ff0000">
         <p style="margin:0;font-size:14px;color:#333;line-height:1.9">${summary.replace(/\n/g, '<br>')}</p>
       </div>`
    : `<div style="background:#fff8e1;padding:16px;border-radius:8px;border-left:4px solid #f59e0b">
         <p style="margin:0;font-size:13px;color:#92660a;line-height:1.7">자동 요약을 제공하지 못했습니다.<br><span style="font-size:12px;color:#b45309">사유: ${failReason || '영상 분석 불가'}</span></p>
       </div>`;

  return `
<div style="font-family:'Apple SD Gothic Neo',Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
  <div style="background:#ff0000;padding:18px 24px">
    <h2 style="color:#fff;margin:0;font-size:17px;font-weight:700">📺 유튜브 브리핑</h2>
    <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:13px">${video.channelTitle}</p>
  </div>
  <div style="background:#fff;padding:20px 24px">
    <h3 style="margin:0 0 14px;font-size:16px;color:#1a1a1a;line-height:1.4">${video.title}</h3>
    ${body}
    <div style="margin-top:18px;text-align:center">
      <a href="${video.url}" target="_blank"
         style="display:inline-block;background:#ff0000;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">▶ 영상 보기</a>
    </div>
  </div>
  <div style="padding:10px 24px;background:#fafafa;text-align:center">
    <p style="margin:0;font-size:11px;color:#aaa">깡자동 유튜브 브리핑 · KTIS 총괄 PM</p>
  </div>
</div>`;
}

async function sendEmail(video: any, summary: string, ok: boolean, emails: string[], failReason?: string) {
  const html = buildYoutubeHtml(video, summary, ok, failReason);
  try {
    await sendMail(emails.filter(Boolean), `[깡자동 유튜브] ${video.channelTitle} - ${video.title}`, html);
    console.log(`메일 발송 성공 (${video.title})`);
  } catch (e) {
    console.error(`메일 발송 실패 (${video.title}):`, String(e).slice(0, 200));
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

async function sendKakao(video: any, summary: string, ok: boolean, accessToken: string | null, failReason?: string) {
  if (!accessToken) return;
  const summaryText = ok
    ? summary
    : `자동 요약을 제공하지 못했습니다.\n사유: ${failReason || '영상 분석 불가'}`;
  let text = `📺 유튜브 브리핑\n[${video.channelTitle}]\n\n${video.title}\n\n${summaryText}\n\n▶ 영상 보기\n${video.url}`;
  const body = new URLSearchParams();
  body.append('template_object', JSON.stringify({
    object_type: "text", text,
    link: { web_url: video.url, mobile_web_url: video.url },
  }));
  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  console.log(`카카오 발송 (${video.title}):`, JSON.stringify(await res.json()));
}

async function markSent(video: any) {
  await supabase.from("youtube_sent").insert({
    video_id: video.videoId, channel_title: video.channelTitle,
    video_title: video.title, sent_at: new Date().toISOString(),
  });
}

async function runBriefing(force: boolean): Promise<{ videosSent: number; videos: string[] }> {
  const { hour: currentHour, day: currentDay } = getKST();
  const settings = await getSettings();
  // youtube_* 전용키 우선, 없으면 briefing_* 하위호환
  // youtube_hours 전용키만 읽음 (공통키 fallback 제거 - 뉴스 설정과 독립)
  const ytHoursRaw = settings["youtube_hours"];
  const youtubeHours: number[] = ytHoursRaw
    ? (Array.isArray(ytHoursRaw) ? ytHoursRaw : JSON.parse(ytHoursRaw)).map(Number)
    : [9];  // 기본값 9시
  const briefingDays = parseDays(settings["youtube_days"] ?? settings["briefing_days"]);
  const paused = (settings["youtube_paused"] ?? settings["briefing_paused"]) === true
    || String(settings["youtube_paused"] ?? settings["briefing_paused"]) === "true";
  const kakaoRefreshToken = settings["kakao_refresh_token"] || null;

  if (!force) {
    if (paused || !youtubeHours.includes(currentHour) || !briefingDays.includes(currentDay)) {
      return { videosSent: 0, videos: [] };
    }
  }

  const [channels, emails] = await Promise.all([getChannels(), getEmails()]);
  const kakaoToken = kakaoRefreshToken ? await refreshKakaoToken(kakaoRefreshToken) : null;

  let totalSent = 0;
  const sentVideos: string[] = [];

  for (const channel of channels) {
    let newVideos: any[] = [];
    try {
      newVideos = await getNewVideos(channel);
    } catch (e) {
      console.error(`채널 조회 실패 (${channel.channel_title}):`, String(e).slice(0, 150));
      continue;
    }
    // 한 영상 처리 중 오류가 나도 나머지 영상/채널은 계속 진행되도록 독립적으로 처리
    for (const video of newVideos) {
      try {
        const { summary, ok, failReason } = await analyzeVideo(video);
        await Promise.all([
          sendEmail(video, summary, ok, emails, failReason),
          sendKakao(video, summary, ok, kakaoToken, failReason),
        ]);
        await markSent(video);
        totalSent++;
        sentVideos.push(`${channel.channel_title}: ${video.title} ${ok ? '(요약O)' : '(링크만)'}`);
      } catch (e) {
        console.error(`영상 처리 실패 (${channel.channel_title}: ${video.title}):`, String(e).slice(0, 150));
      }
    }
  }
  // 히스토리 저장
  if (totalSent > 0) {
    const ytProvider = lastYtProvider || (resolveMotEndpoint() ? "Gateway" : "Gemini API");
    await supabase.from("briefings").insert({
      date: new Date().toISOString().slice(0, 10),
      content: JSON.stringify({ _type: "youtube", _provider: ytProvider, videos: sentVideos }),
      sent_at: new Date().toISOString(),
      channel: "youtube",
    });
  }
  return { videosSent: totalSent, videos: sentVideos };
}

Deno.serve(async (_req) => {
  if (_req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  try {
    const url = new URL(_req.url);
    const force = url.searchParams.get("force") === "true";
    const isBrowser = _req.headers.get("origin") !== null;

    if (isBrowser && force) {
      EdgeRuntime.waitUntil(runBriefing(true));
      return new Response(JSON.stringify({
        success: true,
        message: "유튜브 브리핑을 백그라운드에서 실행 중입니다. 잠시 후 메일/카톡을 확인하세요.",
      }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    const result = await runBriefing(force);
    return new Response(JSON.stringify({ success: true, ...result }),
      { headers: { "Content-Type": "application/json", ...CORS } });

  } catch (err) {
    console.error("유튜브 브리핑 오류:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});