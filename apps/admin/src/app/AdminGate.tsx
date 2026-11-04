import { ApiError, type SessionUser } from '@riflo/core';
import { Button, Skeleton } from '@riflo/ui';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ar as t } from '../i18n/ar';
import { useServices } from './services';

const isStaff = (role: string) => role === 'editor' || role === 'admin';

/** Only editors and admins get past this. The mock (preview) is always signed in. */
export function AdminGate({ children }: { children: ReactNode }) {
  const { api, user, setUser } = useServices();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api.auth.current().then((u) => setUser(u), () => setUser(null)).finally(() => setChecked(true));
  }, [api, setUser]);

  if (!checked) return <div className="gate"><Skeleton height={200} /></div>;
  if (user && isStaff(user.role)) return <>{children}</>;
  return (
    <div className="gate">
      <div className="panel gate__card">
        <p className="side__brand" style={{ color: 'var(--palm-700)', margin: 0 }}>{t.brand} <span>{t.area}</span></p>
        {user ? (
          <>
            <p className="t-body" role="alert">{t.auth.noAccess}</p>
            <Button onClick={() => { api.auth.signOut(); setUser(null); }}>{t.auth.signOut}</Button>
          </>
        ) : (
          <SignIn onDone={setUser} />
        )}
      </div>
    </div>
  );
}

function SignIn({ onDone }: { onDone: (u: SessionUser) => void }) {
  const { api } = useServices();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const message = (e: unknown, fallback: string) => (e instanceof ApiError ? (e.code === 'rate_limited' ? t.auth.rate : e.code === 'network' ? t.auth.network : fallback) : fallback);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (step === 'email') {
        if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError(t.auth.invalidEmail);
        const r = await api.auth.requestCode(email.trim());
        setDevCode(r.devCode ?? null);
        setStep('code');
      } else {
        onDone(await api.auth.verify(email.trim(), code.trim()));
      }
    } catch (err) {
      setError(message(err, step === 'email' ? t.auth.network : t.auth.invalidCode));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
      <div>
        <h1 className="t-h2">{t.auth.title}</h1>
        <p className="t-sm muted">{t.auth.body}</p>
      </div>
      {step === 'email' ? (
        <label className="form-field"><span>{t.auth.email}</span><input type="email" dir="ltr" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
      ) : (
        <label className="form-field"><span>{t.auth.code}</span><input inputMode="numeric" dir="ltr" maxLength={6} required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></label>
      )}
      {devCode && step === 'code' && <p className="rf-sample" style={{ justifySelf: 'start' }} data-testid="dev-code">{t.auth.devCode(devCode)}</p>}
      {error && <p className="err" role="alert" style={{ color: 'var(--danger-700)', fontSize: 13 }}>{error}</p>}
      <Button type="submit" variant="solid" loading={busy}>{step === 'email' ? t.auth.send : t.auth.verify}</Button>
      {step === 'code' && <button type="button" className="link" onClick={() => setStep('email')} style={{ background: 'none', border: 0, color: 'var(--palm-700)', cursor: 'pointer' }}>{t.auth.changeEmail}</button>}
    </form>
  );
}
