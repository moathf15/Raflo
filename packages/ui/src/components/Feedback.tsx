import { useEffect, type ReactNode } from 'react';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rf-state">
      <span className="rf-state__icon"><Icon name={icon} size={28} /></span>
      <p className="t-h3">{title}</p>
      {body && <p className="t-sm muted" style={{ maxWidth: 300 }}>{body}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title, body, retryLabel, onRetry, extra }: { title: string; body: string; retryLabel: string; onRetry: () => void; extra?: ReactNode }) {
  return (
    <div className="rf-state rf-state--error" role="alert">
      <span className="rf-state__icon"><Icon name="alert" size={30} /></span>
      <p className="t-h2">{title}</p>
      <p className="t-body muted" style={{ maxWidth: 300 }}>{body}</p>
      <Button variant="secondary" icon="refresh" onClick={onRetry} style={{ minWidth: 180 }}>{retryLabel}</Button>
      {extra}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: number | string; height?: number }) {
  return <span className="rf-skel" style={{ display: 'block', width, height }} />;
}

export function Sheet({ open, onClose, label, children, footer }: { open: boolean; onClose: () => void; label: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="rf-sheet-backdrop" onClick={onClose}>
      <div className="rf-sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="rf-sheet__handle"><span /></div>
        <div className="rf-sheet__body">{children}</div>
        {footer && <div style={{ padding: '12px 16px 20px', borderTop: '1px solid var(--line)' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return message ? <div className="rf-toast" role="status">{message}</div> : null;
}
