// Gmail SMTP(앱 비밀번호)로 메일 발송하는 공용 헬퍼
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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
      subject,
      html,
    });
  } finally {
    await client.close();
  }
}
