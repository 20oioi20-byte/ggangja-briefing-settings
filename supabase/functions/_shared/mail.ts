// Gmail SMTP(앱 비밀번호)로 메일 발송하는 공용 헬퍼.
//
// denomailer 라이브러리의 Subject 인코딩(quotedPrintableEncodeInline)이 소문자 16진수
// escape(RFC 2045는 대문자 요구)를 쓰고, 긴 제목에서 줄바꿈을 잘못 끼워넣는 버그가 있어
// 엄격한 수신 클라이언트에서 헤더 파싱이 깨졌습니다. 라이브러리를 고칠 수 없어(외부 URL
// 모듈) denomailer 의존성을 완전히 제거하고 Gmail SMTP에 직접 TLS로 접속해 발송합니다.
// 제목/본문 모두 대소문자 구분 문제가 없는 Base64로 인코딩하고, 제목은 여러 조각으로
// 접어붙이지(fold) 않고 길이에 상관없이 통째로 하나의 encoded-word로 인코딩합니다.

import { TextLineStream } from "https://deno.land/std@0.208.0/streams/text_line_stream.ts";

function toBinaryString(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return bin;
}

// RFC 2047 encoded-word - 헤더(제목 등)에 비아스키 문자가 있을 때 사용
function encodeHeaderWord(text: string): string {
  if (!/[^\x00-\x7f]/.test(text)) return text;
  const bytes = new TextEncoder().encode(text);
  return `=?UTF-8?B?${btoa(toBinaryString(bytes))}?=`;
}

// 본문을 RFC 2045대로 76자마다 줄바꿈된 Base64로 인코딩
function encodeBodyBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const b64 = btoa(toBinaryString(bytes));
  return (b64.match(/.{1,76}/g) ?? [b64]).join("\r\n");
}

export async function sendMail(to: string[], subject: string, html: string): Promise<void> {
  const GMAIL_USER = Deno.env.get("GMAIL_USER")!;
  const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
  const toEmails = to.filter(Boolean);
  if (toEmails.length === 0) return;

  const conn = await Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 });
  const encoder = new TextEncoder();
  const lineReader = conn.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())
    .getReader();

  async function readResponse(): Promise<string> {
    const collected: string[] = [];
    while (true) {
      const { value, done } = await lineReader.read();
      if (done || value === undefined) throw new Error("서버 연결이 조기 종료되었습니다.");
      collected.push(value);
      if (/^\d{3} /.test(value)) return collected.join("\n");
    }
  }
  async function writeAll(data: Uint8Array) {
    let offset = 0;
    while (offset < data.length) offset += await conn.write(data.subarray(offset));
  }
  async function sendCmd(line: string): Promise<string> {
    await writeAll(encoder.encode(line + "\r\n"));
    return readResponse();
  }
  function assertOk(res: string, code: string, step: string) {
    if (!res.startsWith(code)) throw new Error(`${step} 실패: ${res.split("\n")[0]}`);
  }

  try {
    assertOk(await readResponse(), "220", "SMTP 접속");
    assertOk(await sendCmd("EHLO smtp.gmail.com"), "250", "EHLO");
    assertOk(await sendCmd("AUTH LOGIN"), "334", "AUTH LOGIN");
    assertOk(await sendCmd(btoa(GMAIL_USER)), "334", "사용자 인증");
    assertOk(await sendCmd(btoa(GMAIL_APP_PASSWORD)), "235", "비밀번호 인증");

    assertOk(await sendCmd(`MAIL FROM:<${GMAIL_USER}>`), "250", "MAIL FROM");
    for (const rcpt of toEmails) {
      assertOk(await sendCmd(`RCPT TO:<${rcpt}>`), "250", `RCPT TO(${rcpt})`);
    }
    assertOk(await sendCmd("DATA"), "354", "DATA");

    const headerLines = [
      `From: ${encodeHeaderWord("깡자동 AI비서")} <${GMAIL_USER}>`,
      `To: ${toEmails.map((e) => `<${e}>`).join(", ")}`,
      `Subject: ${encodeHeaderWord(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      `Content-Type: text/html; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
    ];
    const message = headerLines.join("\r\n") + "\r\n\r\n" + encodeBodyBase64(html) + "\r\n.\r\n";
    await writeAll(encoder.encode(message));
    assertOk(await readResponse(), "250", "메일 전송");
    await sendCmd("QUIT").catch(() => {});
  } finally {
    try {
      lineReader.releaseLock();
    } catch {
      // ignore
    }
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}
