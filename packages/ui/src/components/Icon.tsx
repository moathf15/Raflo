import type { ReactNode } from 'react';

// Outline icons on a 24px grid, 1.5 stroke, drawn with currentColor (Tabler-style).
const PATHS: Record<string, ReactNode> = {
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="M9 6l6 6-6 6" />,
  forward: <path d="M15 6l-6 6 6 6" />,
  share: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" /></>,
  pin: <><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" /><circle cx="12" cy="10" r="2.2" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  car: <><path d="M5 16v-5l2-5h10l2 5v5" /><path d="M4 16h16" /><circle cx="7.5" cy="16.5" r="1.5" /><circle cx="16.5" cy="16.5" r="1.5" /></>,
  wallet: <><rect x="3.5" y="6" width="17" height="13" rx="2" /><path d="M16 12.5h4.5" /><path d="M6 6l9-2.5V6" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></>,
  bookmark: <path d="M6 4h12v16l-6-4-6 4z" />,
  home: <path d="M4 11l8-7 8 7v9h-5v-6h-6v6H4z" />,
  compass: <><circle cx="12" cy="12" r="8.5" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></>,
  passport: <><rect x="5" y="3" width="14" height="18" rx="2" /><circle cx="12" cy="10" r="3" /><path d="M9 16h6" /></>,
  edit: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  check: <path d="M5 12l5 5 9-10" />,
  star: <path d="M12 4l2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2l.9-5.5-4-3.9 5.5-.8z" />,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.5-3 2.8-5 5.5-5s5 2 5.5 5" /><path d="M16 5.5a3 3 0 0 1 0 5.5M18 14.5c1.5.7 2.3 2.3 2.5 4.5" /></>,
  moon: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />,
  alert: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5M12 16h.01" /></>,
  chart: <path d="M4 20h16M7 16v-5M12 16V7M17 16v-8" />,
  board: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M10 4v16M16 4v10" /></>,
  route: <><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6" /></>,
  flag: <path d="M6 21V4M6 4h11l-2 4 2 4H6" />,
  refresh: <path d="M19 12a7 7 0 1 1-2-5M19 4v4h-4" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, color = 'currentColor', strokeWidth = 1.5, label }: { name: IconName; size?: number; color?: string; strokeWidth?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {PATHS[name]}
    </svg>
  );
}
