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
  constructor(private readonly config: Config) {
    this.transport = config.MAIL_TRANSPORT === "smtp" ? nodemailer.createTransport(config.SMTP_URL) : null;
  }
  async send(mail: Mail) {
    if (this.config.MAIL_TRANSPORT === "memory") { this.sent.push(mail); return; }
    if (!this.transport) {
      // Dev without a mail server: the link is printed so the flow can still be completed by hand.
      this.log.log(`[mail:log] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
      return;
    }
    await this.transport.sendMail({ from: this.config.MAIL_FROM, ...mail });
  }
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
