import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type ChipTone = 'open' | 'busy' | 'closed' | 'visited' | 'danger';

/** A state is always a word (and optional icon), never colour alone. */
export function Chip({ tone, icon, children }: { tone: ChipTone; icon?: IconName; children: ReactNode }) {
  return (
    <span className={`rf-chip rf-chip--${tone}`}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

/** Image slot shown until real photos come from the content team. */
export function ImageSlot({ height, radius, style }: { height: number; radius?: number; style?: CSSProperties }) {
  return (
    <div className="rf-img" style={{ height, borderRadius: radius, ...style }} aria-hidden="true">
      <svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMax slice">
        <path d="M30 100V58a20 20 0 0 1 40 0v42zM90 100V58a20 20 0 0 1 40 0v42z" fill="#d9cbb0" />
        <path d="M60 100V48a20 20 0 0 1 40 0v52z" fill="#cdbd9e" />
      </svg>
    </div>
  );
}

export interface StepItem {
  label: string;
}
export function Stepper({ steps, current, label }: { steps: StepItem[]; current: number; label: string }) {
  return (
    <ol className="rf-steps" aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.label} data-state={i < current ? 'done' : i === current ? 'current' : 'upcoming'} aria-current={i === current ? 'step' : undefined}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

export function Stamp({ name, date, planned, press, tilt = 0 }: { name: string; date: string; planned?: boolean; press?: boolean; tilt?: number }) {
  return (
    <div className={`rf-stamp ${planned ? 'rf-stamp--planned' : ''} ${press ? 'rf-stamp--press' : ''}`} style={{ transform: `rotate(${tilt}deg)` }}>
      <span className="rf-stamp__name">{name}</span>
      {!planned && <span className="rf-stamp__date">{date}</span>}
    </div>
  );
}

export function Switch({ label, icon, checked, onChange }: { label: string; icon?: IconName; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="rf-switch">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {icon && <Icon name={icon} size={18} color="var(--palm-700)" />}
        {label}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
