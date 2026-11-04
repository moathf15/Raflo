import type { ReactNode } from 'react';
import { Chip, type ChipTone } from './Display';
import { Icon, type IconName } from './Icon';

export interface StopCardProps {
  time: string;
  period: string;
  name: string;
  status?: { tone: ChipTone; label: string };
  description: string;
  meta?: { icon: IconName; text: string }[];
  onOpen?: () => void;
  /** Rendered after the body in edit mode (reorder / remove controls). */
  actions?: ReactNode;
}

/** The ticket: RIFLO's signature component. Stub sits on the inline-start side. */
export function StopCard({ time, period, name, status, description, meta = [], onOpen, actions }: StopCardProps) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
      <button type="button" className="rf-stop" onClick={onOpen}>
        <span className="rf-stop__stub">
          <span className="rf-stop__time">{time}</span>
          <span>{period}</span>
        </span>
        <span className="rf-stop__body">
          <span className="rf-stop__head">
            <span className="rf-stop__name">{name}</span>
            {status && <Chip tone={status.tone}>{status.label}</Chip>}
          </span>
          <span className="t-cap muted">{description}</span>
          {meta.length > 0 && (
            <span className="rf-stop__meta">
              {meta.map((m) => (
                <span key={m.text}>
                  <Icon name={m.icon} size={14} />
                  {m.text}
                </span>
              ))}
            </span>
          )}
        </span>
      </button>
      {actions}
    </div>
  );
}

export function Leg({ icon = 'car', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="rf-leg">
      <Icon name={icon} size={14} />
      {children}
    </div>
  );
}
