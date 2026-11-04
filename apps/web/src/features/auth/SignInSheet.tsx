import { ApiError, type SessionUser, type UserApi } from '@riflo/core';
import { Button, Sheet } from '@riflo/ui';
import { useState, type FormEvent } from 'react';
import { t } from '../../i18n';

/** Two steps: email → 6-digit code. Shown whenever an action needs an account. */
export function SignInSheet({ open, api, onDone }: { open: boolean; api: UserApi; onDone: (u: SessionUser | null) => void }) {
  return (
    <Sheet open={open} onClose={() => onDone(null)} label={t.auth.title}>
      {open && <Flow api={api} onDone={onDone} />}
    </Sheet>
  );
}

function errorText(e: unknown, fallback: string) {
  if (e instanceof ApiError) return e.code === 'rate_limited' ? t.auth.errors.rate : e.code === 'network' ? t.auth.errors.network : fallback;
  return fallback;
}

function Flow({ api, onDone }: { api: UserApi; onDone: (u: SessionUser | null) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError(t.auth.errors.email);
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.requestCode(email.trim());
      setDevCode(r.devCode ?? null);
      setStep('code');
    } catch (err) {
      setError(errorText(err, t.auth.errors.network));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.auth.verify(email.trim(), code.trim()));
    } catch (err) {
      setError(errorText(err, t.auth.errors.code));
    } finally {
      setBusy(false);
    }
  }

  return step === 'email' ? (
    <form onSubmit={send} style={{ display: 'grid', gap: 16, paddingBottom: 8 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 className="t-h2">{t.auth.title}</h2>
        <p className="t-sm muted">{t.auth.body}</p>
      </div>
      <label>
        <span className="rf-label">{t.auth.email}</span>
        <span className="rf-field"><input type="email" dir="ltr" autoComplete="email" required placeholder={t.auth.emailPlaceholder} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></span>
      </label>
      {error && <p className="field-error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" block loading={busy}>{t.auth.send}</Button>
    </form>
  ) : (
    <form onSubmit={verify} style={{ display: 'grid', gap: 16, paddingBottom: 8 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 className="t-h2">{t.auth.codeTitle}</h2>
        <p className="t-sm muted">{t.auth.codeBody(email.trim())}</p>
      </div>
      <label>
        <span className="rf-label">{t.auth.code}</span>
        <span className="rf-field"><input inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ letterSpacing: 6, fontFamily: 'var(--font-display)', fontSize: 22 }} autoFocus /></span>
      </label>
      {devCode && <p className="rf-sample" style={{ justifySelf: 'start' }} data-testid="dev-code">{t.auth.devCode(devCode)}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" block loading={busy}>{t.auth.verify}</Button>
      <button type="button" className="link" onClick={() => { setStep('email'); setCode(''); setError(null); }}>{t.auth.changeEmail}</button>
    </form>
  );
}
