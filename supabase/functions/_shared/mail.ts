// Gmail SMTP(앱 비밀번호)로 메일 발송하는 공용 헬퍼
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// denomailer는 Subject 헤더를 아무 인코딩 없이 원문 그대로 씁니다 (`Subject: ` + 원문).
// 이메일 헤더는 7비트 아스키만 허용되므로, 한글 등 비아스키 문자가 그대로 들어가면
// 받는 쪽 메일 클라이언트가 헤더를 잘못 파싱해 본문까지 깨져 보이는 문제가 생깁니다.
// RFC 2047 encoded-word(=?UTF-8?B?...?=)로 직접 인코딩해서 넘겨주면
// denomailer는 이미 아스키인 이 문자열을 그대로(추가 가공 없이) 써주므로 문제가 해결됩니다.
// 인코딩된 word 하나가 너무 길면 중간에 잘못 줄바꿈될 위험이 있어, 짧게 여러 개로 잘라 이어붙입니다.
function encodeHeaderText(text: string): string {
  const CHARS_PER_WORD = 15;
  const words: string[] = [];
  for (let i = 0; i < text.length; i += CHARS_PER_WORD) {
    const slice = text.slice(i, i + CHARS_PER_WORD);
    const bytes = new TextEncoder().encode(slice);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    words.push(`=?UTF-8?B?${btoa(bin)}?=`);
  }
  return words.join("\r\n ");
}

export async function sendMail(to: string[], subject: string, html: string): Promise<void> {
  const GMAIL_USER = Deno.env.get("GMAIL_USER")!;
  const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
    },
  });

  try {
    await client.send({
      from: GMAIL_USER,
      to,
      subject: encodeHeaderText(subject),
      html,
    });
  } finally {
    await client.close();
  }
}
