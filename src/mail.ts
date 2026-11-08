import PostalMime from "postal-mime";
import { type Settings, isEnabledDomain } from "./db";
import { type Env, sha256Hex, splitAddress } from "./util";

const MAX_TEXT = 100_000;
const MAX_HTML = 400_000;

export interface StoredMessage {
  from_addr: string;
  from_name: string;
  subject: string;
  text: string;
  html: string;
  messageId?: string;
  date?: string;
  size: number;
}

export async function parseRaw(raw: ReadableStream | ArrayBuffer | Uint8Array, size: number): Promise<StoredMessage> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer", maxNestingDepth: 32 });
  let text = email.text || "";
  if (!text && email.html) text = htmlToText(email.html);
  return {
    from_addr: (email.from?.address || "").toLowerCase(),
    from_name: email.from?.name || "",
    subject: email.subject || "(无主题)",
    text,
    html: email.html || "",
    messageId: email.messageId,
    date: email.date,
    size,
  };
}

export function htmlToText(html: string) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

const OTP_KEYWORD = /(验证码|校验码|动态码|确认码|激活码|安全码|verification|verify|one[- ]time|passcode|otp|pin|code)/i;
const OTP_NEAR = /(?:验证码|校验码|动态码|确认码|激活码|安全码|code|otp|passcode|pin)(?:\s*(?:is|为|是|:|：))?[^A-Za-z0-9\n]{0,12}([A-Z0-9]{4,8})(?![A-Za-z0-9])/i;

/** Best-effort extraction of a verification code so users can copy it straight from the list. */
export function extractOtp(subject: string, text: string): string | null {
  const haystack = `${subject}\n${text}`.slice(0, 4000);
  if (!OTP_KEYWORD.test(haystack)) return null;
  const near = haystack.match(OTP_NEAR);
  if (near && /\d/.test(near[1])) return near[1];
  const digits = haystack.match(/(?<![\d.,:/-])\d{4,8}(?![\d.,:/-])/g) || [];
  const year = new Date().getUTCFullYear();
  const pick = digits.find((d) => !(d.length === 4 && Math.abs(Number(d) - year) <= 1));
  return pick || null;
}

export async function storeMessage(env: Env, mailboxId: number, msg: StoredMessage) {
  const key =
    msg.messageId?.trim() || (await sha256Hex(`${msg.from_addr}|${msg.subject}|${msg.date}|${msg.text.slice(0, 500)}`));
  const preview = msg.text.replace(/\s+/g, " ").trim().slice(0, 160);
  const parsedDate = msg.date ? Date.parse(msg.date) : Number.NaN;
  const receivedAt = Number.isFinite(parsedDate) && parsedDate < Date.now() + 86400_000 ? parsedDate : Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO messages (mailbox_id, msg_key, from_addr, from_name, subject, preview, otp, text_body, html_body, size, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      mailboxId,
      key.slice(0, 500),
      msg.from_addr.slice(0, 320),
      msg.from_name.slice(0, 200),
      msg.subject.slice(0, 500),
      preview,
      extractOtp(msg.subject, msg.text),
      msg.text.slice(0, MAX_TEXT),
      msg.html.length > MAX_HTML ? null : msg.html,
      msg.size,
      receivedAt,
    ),
    env.DB.prepare("UPDATE mailboxes SET last_mail_at = MAX(last_mail_at, ?) WHERE id = ?").bind(receivedAt, mailboxId),
  ]);
  return (result[0].meta.changes ?? 0) > 0;
}

/** Cloudflare Email Routing → Email Worker: real-time, zero-polling ingestion. */
export async function handleIncomingEmail(message: ForwardableEmailMessage, env: Env, settings: Settings) {
  const address = message.to.trim().toLowerCase();
  const [, domain] = splitAddress(address);
  const mailbox = (await isEnabledDomain(env, domain))
    ? await env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(address).first<{ id: number }>()
    : null;
  if (!mailbox) {
    message.setReject("Mailbox does not exist");
    return;
  }

  let parsed: StoredMessage;
  if (message.rawSize > 5 * 1024 * 1024) {
    parsed = {
      from_addr: message.from.toLowerCase(),
      from_name: "",
      subject: message.headers.get("subject") || "(无主题)",
      text: "邮件体积超过 5MB，未保存正文。",
      html: "",
      messageId: message.headers.get("message-id") || undefined,
      date: message.headers.get("date") || undefined,
      size: message.rawSize,
    };
  } else {
    parsed = await parseRaw(message.raw, message.rawSize);
  }
  await storeMessage(env, mailbox.id, parsed);
  if (settings.forward_to) await message.forward(settings.forward_to).catch(() => undefined);
}
