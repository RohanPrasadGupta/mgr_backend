import { Logger } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config";

export interface Mail { to: string; subject: string; text: string; html: string }
export const MAILER = Symbol("MAILER");

export class Mailer {
  private readonly log = new Logger("Mailer");
  private readonly transport: Transporter | null;
  /** Kept only with MAIL_TRANSPORT=memory (tests read the links from here). */
  readonly sent: Mail[] = [];
  constructor(private readonly config: Config, private readonly http: typeof fetch = fetch) {
    // Short timeouts: emails are sent inside the request, and nodemailer's defaults (2 min to connect, 10 min idle) would
    // hold a sign-up or "resend" open that long when the SMTP server is unreachable (e.g. a host that blocks port 465/587).
    this.transport = config.MAIL_TRANSPORT === "smtp"
      ? nodemailer.createTransport({ url: config.SMTP_URL, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 })
      : null;
    if (config.MAIL_TRANSPORT === "brevo") parseAddress(config.MAIL_FROM); // a bad sender fails at start-up, not on the first email
  }
  async send(mail: Mail) {
    if (this.config.MAIL_TRANSPORT === "memory") { this.sent.push(mail); return; }
    if (this.config.MAIL_TRANSPORT === "brevo") return this.sendBrevo(mail);
    if (!this.transport) {
      // Dev without a mail server: the link is printed so the flow can still be completed by hand.
      this.log.log(`[mail:log] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
      return;
    }
    await this.transport.sendMail({ from: this.config.MAIL_FROM, ...mail });
  }

  /** Brevo's HTTPS API (port 443), for hosts that block outgoing SMTP, e.g. Render's free plan. */
  private async sendBrevo(mail: Mail) {
    const res = await this.http(BREVO_URL, {
      method: "POST",
      headers: { "api-key": this.config.BREVO_API_KEY!, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: parseAddress(this.config.MAIL_FROM), to: [{ email: mail.to }], subject: mail.subject, htmlContent: mail.html, textContent: mail.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Brevo explains itself ({ code, message }); pass that on, never the request (it carries the key).
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new Error(`Brevo ${res.status}: ${body.message ?? body.code ?? res.statusText}`);
    }
  }
}

export const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

/** "MoneyMgr <hi@example.com>" or "hi@example.com" → { name?, email }. */
export function parseAddress(from: string): { name?: string; email: string } {
  const m = from.trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/);
  if (m) return { ...(m[1] ? { name: m[1] } : {}), email: m[2]! };
  if (/^[^<>\s]+@[^<>\s]+$/.test(from.trim())) return { email: from.trim() };
  throw new Error(`MAIL_FROM is not an email address: ${from}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function actionEmail(o: { name: string; intro: string; action: string; url: string; outro: string }) {
  const text = `Hi ${o.name},\n\n${o.intro}\n\n${o.action}: ${o.url}\n\n${o.outro}\n\n— MoneyMgr`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#15132b">
<p>Hi ${esc(o.name)},</p><p>${esc(o.intro)}</p>
<p><a href="${esc(o.url)}" style="display:inline-block;background:#9333ea;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">${esc(o.action)}</a></p>
<p style="color:#646287;font-size:13px">${esc(o.outro)}<br>If the button doesn't work, paste this link into your browser:<br>${esc(o.url)}</p>
<p style="color:#646287;font-size:13px">— MoneyMgr</p></div>`;
  return { text, html };
}
