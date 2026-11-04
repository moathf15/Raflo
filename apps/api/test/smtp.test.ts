/** The real SMTP path (nodemailer), against a minimal local SMTP server. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, describe, it } from 'node:test';
import pino from 'pino';
import { loadConfig } from '../src/config';
import { createMailer } from '../src/lib/email';

type Server = { port: number; messages: string[]; close: () => void };

/** Speaks just enough SMTP to accept one message. With `silent`, accepts the connection and never greets. */
function smtpServer(silent = false): Promise<Server> {
  const messages: string[] = [];
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    sockets.add(s);
    if (silent) return;
    let inData = false, buf = '', data = '';
    s.write('220 test ESMTP\r\n');
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; messages.push(data); data = ''; s.write('250 queued\r\n'); }
          else data += line + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') s.write('250 test\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT') s.write('250 ok\r\n');
        else if (cmd === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({
    port: (srv.address() as net.AddressInfo).port, messages,
    close: () => { sockets.forEach((s) => s.destroy()); srv.close(); },
  })));
}

const quiet = pino({ level: 'silent' });
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

describe('SMTP mailer', () => {
  it('delivers the code by SMTP, in Arabic, to the right address', async () => {
    const s = await smtpServer(); servers.push(s);
    const cfg = loadConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'smtp', SMTP_URL: `smtp://127.0.0.1:${s.port}`, EMAIL_FROM: 'RIFLO <no-reply@riflo.test>' });
    await createMailer(cfg, quiet).sendLoginCode('visitor@example.com', '482913', 10);
    assert.equal(s.messages.length, 1);
    const msg = s.messages[0];
    assert.match(msg, /^To: visitor@example\.com$/m);
    assert.match(msg, /^From: RIFLO <no-reply@riflo\.test>$/m);
    assert.ok(msg.includes('482913'), 'the code is in the message');
  });

  it('gives up on a server that never answers instead of hanging the request', { timeout: 20_000 }, async () => {
    const s = await smtpServer(true); servers.push(s);
    const cfg = loadConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'smtp', SMTP_URL: `smtp://127.0.0.1:${s.port}`, EMAIL_FROM: 'no-reply@riflo.test' });
    const t0 = Date.now();
    await assert.rejects(createMailer(cfg, quiet).sendLoginCode('visitor@example.com', '111111', 10));
    const waited = Date.now() - t0;
    assert.ok(waited >= 9_000 && waited < 15_000, `timed out by the 10 s greeting limit (waited ${waited} ms)`);
  });
});
