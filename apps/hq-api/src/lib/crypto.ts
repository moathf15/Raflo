import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config } from '../config';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (pw: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((ok, fail) => scryptCb(pw, salt, len, SCRYPT, (err, key) => (err ? fail(err) : ok(key))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const expected = Buffer.from(k, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), expected.length);
  return timingSafeEqual(expected, got);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** AES-256-GCM for credentials at rest. Ciphertext format: v1:<iv>:<tag>:<data>, base64 parts. */
export interface Vault {
  encrypt(plain: string): string;
  decrypt(enc: string): string;
}

function parseKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('HQ_ENCRYPTION_KEY must be 32 bytes (base64 or hex)');
  return key;
}

export function createVault(key: Buffer): Vault {
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
    },
    decrypt(enc) {
      const [v, iv, tag, data] = enc.split(':');
      if (v !== 'v1') throw new Error('unknown ciphertext version');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    }
  };
}

/** The key from HQ_ENCRYPTION_KEY; in development only, a key generated once and kept next to the local database. */
export function loadVault(cfg: Config): Vault {
  if (cfg.HQ_ENCRYPTION_KEY) return createVault(parseKey(cfg.HQ_ENCRYPTION_KEY));
  if (cfg.NODE_ENV === 'production') throw new Error('HQ_ENCRYPTION_KEY is required in production');
  if (cfg.NODE_ENV === 'test') return createVault(randomBytes(32));
  const file = resolve(dirname(resolve(cfg.HQ_PGLITE_DIR)), 'hq.key');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return createVault(parseKey(readFileSync(file, 'utf8').trim()));
}

/** Show only the last characters of a secret. */
export const maskSecret = (s: string) => (s.length <= 8 ? '••••' : `••••${s.slice(-4)}`);
