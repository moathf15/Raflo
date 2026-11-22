import type { AvatarSpec } from '../lib/types';

const FALLBACK: AvatarSpec = { skin: '#c68863', hair: '#2a1b10', style: 'short', outfit: '#546e7a' };

/** Hair / head covering drawn over a 64×64 head-and-shoulders figure. */
function Hair({ a }: { a: AvatarSpec }) {
  switch (a.style) {
    case 'hijab':
      return <path d="M14 34c0-13 8-22 18-22s18 9 18 22c0 6-2 10-4 13H18c-2-3-4-7-4-13z" fill={a.hair === '#1f1a17' ? '#2d2a4a' : shade(a.outfit, -25)} />;
    case 'shemagh':
      return (
        <g>
          <path d="M13 30c0-12 8-19 19-19s19 7 19 19l-3 14H16z" fill="#f3f0ea" />
          <path d="M13 30c0-12 8-19 19-19s19 7 19 19" fill="none" stroke="#c0392b" strokeWidth="2" strokeDasharray="3 3" />
          <rect x="17" y="17" width="30" height="4" rx="2" fill="#1b1b1b" />
        </g>
      );
    case 'long':
      return <path d="M17 30c0-11 6-17 15-17s15 6 15 17v16h-5V30H22v16h-5z" fill={a.hair} />;
    case 'bun':
      return (
        <g fill={a.hair}>
          <circle cx="32" cy="11" r="5" />
          <path d="M19 29c0-9 5-14 13-14s13 5 13 14c-3-4-8-6-13-6s-10 2-13 6z" />
        </g>
      );
    case 'curly':
      return (
        <g fill={a.hair}>
          {[20, 25, 31, 37, 43].map((x, i) => (
            <circle key={x} cx={x} cy={i % 2 ? 17 : 19} r="5.5" />
          ))}
        </g>
      );
    case 'bald':
      return <path d="M20 28c1-2 3-3 4-3M44 28c-1-2-3-3-4-3" stroke={a.hair} strokeWidth="2" />;
    default:
      return <path d="M19 28c0-9 5-14 13-14s13 5 13 14c-3-3-6-5-13-5s-10 2-13 5z" fill={a.hair} />;
  }
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amt));
  return `#${[c(n >> 16), c((n >> 8) & 255), c(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Procedural avatar (no external images). */
export function Avatar({ spec, size = 40, title, x, y }: { spec?: AvatarSpec | null; size?: number; title?: string; x?: number; y?: number }) {
  const a = spec ?? FALLBACK;
  const covered = a.style === 'hijab' || a.style === 'shemagh';
  return (
    <svg width={size} height={size} x={x} y={y} viewBox="0 0 64 64" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} className="avatar">
      {title ? <title>{title}</title> : null}
      <circle cx="32" cy="32" r="32" fill="var(--avatar-bg, #efe6d4)" />
      <path d="M10 64c2-12 10-18 22-18s20 6 22 18z" fill={a.outfit} />
      {covered ? null : <rect x="28" y="38" width="8" height="8" fill={a.skin} />}
      {a.style === 'hijab' ? <Hair a={a} /> : null}
      <ellipse cx="32" cy="30" rx="11" ry="12.5" fill={a.skin} />
      <circle cx="28" cy="30" r="1.4" fill="#2b2118" />
      <circle cx="36" cy="30" r="1.4" fill="#2b2118" />
      <path d="M29 36c2 1.5 4 1.5 6 0" stroke="#7a4a32" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      {a.style !== 'hijab' ? <Hair a={a} /> : null}
    </svg>
  );
}
