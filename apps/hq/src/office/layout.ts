/** Floor plan in SVG user units. Rows: departments / meeting + lounge / departments. */
export interface Room {
  id: string;
  kind: 'department' | 'meeting' | 'lounge' | 'projects';
  x: number;
  y: number;
  w: number;
  h: number;
  floor: string;
}

export const MAP_W = 1680;
export const MAP_H = 1000;

export const ROOMS: Room[] = [
  { id: 'executive', kind: 'department', x: 40, y: 40, w: 300, h: 260, floor: '#efe3c8' },
  { id: 'management', kind: 'department', x: 360, y: 40, w: 300, h: 260, floor: '#ece4d2' },
  { id: 'development', kind: 'department', x: 680, y: 40, w: 460, h: 260, floor: '#e6e9ee' },
  { id: 'qa', kind: 'department', x: 1160, y: 40, w: 220, h: 260, floor: '#e3eee6' },
  { id: 'security', kind: 'department', x: 1400, y: 40, w: 240, h: 260, floor: '#efe2df' },
  { id: 'majlis', kind: 'meeting', x: 40, y: 330, w: 300, h: 300, floor: '#e9dcc4' },
  { id: 'summit', kind: 'meeting', x: 360, y: 330, w: 300, h: 300, floor: '#e9dcc4' },
  { id: 'lounge', kind: 'lounge', x: 680, y: 330, w: 460, h: 300, floor: '#e1eee8' },
  { id: 'huddle', kind: 'meeting', x: 1160, y: 330, w: 220, h: 300, floor: '#e9dcc4' },
  { id: 'projects', kind: 'projects', x: 1400, y: 330, w: 240, h: 300, floor: '#ece6da' },
  { id: 'design', kind: 'department', x: 40, y: 660, w: 340, h: 300, floor: '#efe4f0' },
  { id: 'marketing', kind: 'department', x: 400, y: 660, w: 250, h: 300, floor: '#f4e6d6' },
  { id: 'content', kind: 'department', x: 670, y: 660, w: 250, h: 300, floor: '#f3e3ea' },
  { id: 'business', kind: 'department', x: 940, y: 660, w: 230, h: 300, floor: '#dfeeee' },
  { id: 'data', kind: 'department', x: 1190, y: 660, w: 190, h: 300, floor: '#e3e5f6' },
  { id: 'operations', kind: 'department', x: 1400, y: 660, w: 240, h: 300, floor: '#e7eaee' }
];

export const room = (id: string) => ROOMS.find((r) => r.id === id);

/** Desk positions inside a department room (character stands at the returned point, desk drawn below it). */
export function deskSpots(r: Room, n: number): { x: number; y: number }[] {
  const cols = Math.max(1, Math.min(n, Math.floor((r.w - 30) / 100)));
  const rows = Math.ceil(n / cols);
  const cellW = (r.w - 30) / cols;
  const top = r.y + 92;
  const cellH = Math.min(118, (r.h - 104) / Math.max(rows, 1));
  return Array.from({ length: n }, (_, i) => ({ x: r.x + 15 + cellW * (i % cols) + cellW / 2, y: top + cellH * Math.floor(i / cols) + 20 }));
}

/** Seats around a meeting table. */
export function meetingSeats(r: Room, n: number): { x: number; y: number }[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2 + 18;
  const rx = Math.min(r.w / 2 - 40, 110);
  const ry = Math.min(r.h / 2 - 55, 80);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
    return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  });
}

export function loungeSpots(r: Room, n: number) {
  return Array.from({ length: n }, (_, i) => ({ x: r.x + 70 + (i % 6) * 62, y: r.y + 150 + Math.floor(i / 6) * 70 }));
}
