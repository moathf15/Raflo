import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';

export interface Mailer {
  sendLoginCode(to: string, code: string, ttlMinutes: number): Promise<void>;
}

/** Log lines identify an address by a short hash, never the address or the code (audit 3.2, 6.2). */
export const maskEmail = (email: string) => createHash('sha256').update(email).digest('hex').slice(0, 12);

function loginCodeMessage(code: string, ttlMinutes: number) {
  const text = `رمز الدخول إلى RIFLO: ${code}\n\nالرمز صالح لمدة ${ttlMinutes} دقائق ولمرة واحدة.\nإذا لم تطلب هذا الرمز فتجاهل هذه الرسالة؛ لن يتمكن أحد من الدخول دون الرمز.\n\nفريق RIFLO`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#faf7f1;font-family:Tahoma,Arial,sans-serif;color:#1c1b17">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:460px;background:#ffffff;border:1px solid #e6e1d6;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 24px;text-align:right">
<p style="margin:0 0 4px;font-size:20px;font-weight:bold;color:#0f4c3a">RIFLO</p>
<p style="margin:0 0 20px;font-size:15px">رمز الدخول إلى حسابك:</p>
<p style="margin:0 0 20px;font-size:32px;letter-spacing:6px;font-weight:bold;text-align:center;direction:ltr">${code}</p>
<p style="margin:0 0 8px;font-size:14px;color:#6b665c">الرمز صالح لمدة ${ttlMinutes} دقائق ولمرة واحدة.</p>
<p style="margin:0;font-size:14px;color:#6b665c">إذا لم تطلب هذا الرمز فتجاهل هذه الرسالة؛ لن يتمكن أحد من الدخول دون الرمز.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: `رمز الدخول إلى RIFLO: ${code}`, text, html };
}

export function createMailer(cfg: Config, log: FastifyBaseLogger): Mailer {
  if (cfg.EMAIL_PROVIDER === 'smtp') {
    if (!cfg.SMTP_URL || !cfg.EMAIL_FROM) throw new Error('SMTP_URL and EMAIL_FROM are required for EMAIL_PROVIDER=smtp');
    const transport = nodemailer.createTransport({ url: cfg.SMTP_URL, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
    return {
      async sendLoginCode(to, code, ttl) {
        const m = loginCodeMessage(code, ttl);
        await transport.sendMail({ from: cfg.EMAIL_FROM, to, subject: m.subject, text: m.text, html: m.html });
        log.info({ event: 'login_code_sent', to: maskEmail(to) });
      }
    };
  }
  // Development: nothing is sent and the code is never printed. Use AUTH_DEV_CODES to see it in the response.
  return {
    async sendLoginCode(to) {
      log.info({ event: 'login_code_created', to: maskEmail(to), provider: 'log' });
    }
  };
}
