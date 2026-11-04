import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'solid';
interface Common {
  variant?: Variant;
  block?: boolean;
  small?: boolean;
  icon?: IconName;
  loading?: boolean;
  children?: ReactNode;
}

const cls = ({ variant = 'secondary', block, small }: Common, extra?: string) =>
  ['rf-btn', `rf-btn--${variant}`, block && 'rf-btn--block', small && 'rf-btn--sm', extra].filter(Boolean).join(' ');

/** Primary (terracotta) at most once per screen. */
export function Button({ variant, block, small, icon, loading, children, className, ...rest }: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} aria-busy={loading || undefined} className={cls({ variant, block, small }, className)}>
      {icon && <Icon name={icon} size={small ? 16 : 18} />}
      {children}
    </button>
  );
}

/** Same look as Button, for navigation. Works with any router via `as`-free plain anchors or router Links passed as children. */
export function ButtonLink({ variant, block, small, icon, children, className, ...rest }: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...rest} className={cls({ variant, block, small }, className)}>
      {icon && <Icon name={icon} size={small ? 16 : 18} />}
      {children}
    </a>
  );
}

export function IconButton({ icon, label, bare, ...rest }: { icon: IconName; label: string; bare?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} aria-label={label} className={`rf-icon-btn ${bare ? 'rf-icon-btn--bare' : ''} ${rest.className ?? ''}`}>
      <Icon name={icon} />
    </button>
  );
}
