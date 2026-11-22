import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Avatar } from '../components/Avatar';
import { useApi } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { onLive, type LiveEvent } from '../lib/live';
import { displayStatus, type Department, type Employee } from '../lib/types';
import { deskSpots, loungeSpots, MAP_H, MAP_W, meetingSeats, room, ROOMS, type Room } from './layout';

export const STATUS_COLORS: Record<string, string> = {
  idle: '#8d9aa8', thinking: '#6c5ce7', working: '#2e6b57', reading: '#1e88e5', writing: '#00897b', in_meeting: '#b45a33', collaborating: '#c46bd6',
  waiting_approval: '#d49a1a', blocked: '#c0392b', completed: '#2bb673', on_break: '#a7a29a'
};

interface Props {
  onSelect: (id: string) => void;
  onRoom: (r: Room) => void;
  focusId?: string | null;
}

/** The headquarters floor. Every avatar's position and animation is derived from its stored backend status. */
export function OfficeMap({ onSelect, onRoom, focusId }: Props) {
  const { t, lang } = useI18n();
  const emps = useApi<Employee[]>('/employees', ['employees.changed', 'meeting']);
  const depts = useApi<Department[]>('/departments');
  const busyRooms = useApi<{ room: string; status: string; title: string }[]>('/meetings', ['meeting']);
  const [live, setLive] = useState<Record<string, Partial<Employee>>>({});
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [, setTick] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // Patch statuses from the live stream so animations follow the backend immediately.
  useEffect(
    () =>
      onLive((e: LiveEvent) => {
        if (e.type === 'employee.status') {
          const emp = e.employee as Partial<Employee> & { id: string };
          setLive((s) => ({ ...s, [emp.id]: emp }));
        }
        if (e.type === 'meeting.speaking') setSpeaking((e.employeeId as string | null) ?? null);
      }),
    []
  );
  useEffect(() => {
    setLive({});
  }, [emps.data]);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const people = useMemo(() => (emps.data ?? []).map((e) => ({ ...e, ...(live[e.id] ?? {}) }) as Employee), [emps.data, live]);
  const meetingRoomOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of emps.data ?? []) if (e.current_meeting_id && e.current_meeting_room) m.set(e.current_meeting_id, e.current_meeting_room);
    return m;
  }, [emps.data]);

  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number; place: 'desk' | 'meeting' | 'lounge' }>();
    const byDept = new Map<string, Employee[]>();
    for (const e of people) byDept.set(e.department_id, [...(byDept.get(e.department_id) ?? []), e]);
    const desks = new Map<string, { x: number; y: number }>();
    for (const [d, list] of byDept) {
      const r = room(d) ?? room('projects')!;
      deskSpots(r, list.length).forEach((s, i) => desks.set(list[i].id, s));
    }
    const inMeeting = new Map<string, Employee[]>();
    const lounge: Employee[] = [];
    for (const e of people) {
      const rid = e.current_meeting_id ? meetingRoomOf.get(e.current_meeting_id) : null;
      if (rid) inMeeting.set(rid, [...(inMeeting.get(rid) ?? []), e]);
      else if (!e.active) lounge.push(e);
    }
    for (const [rid, list] of inMeeting) meetingSeats(room(rid)!, list.length).forEach((s, i) => pos.set(list[i].id, { ...s, place: 'meeting' }));
    loungeSpots(room('lounge')!, lounge.length).forEach((s, i) => pos.set(lounge[i].id, { ...s, place: 'lounge' }));
    for (const e of people) if (!pos.has(e.id)) pos.set(e.id, { ...(desks.get(e.id) ?? { x: 0, y: 0 }), place: 'desk' });
    return { pos, desks };
  }, [people, meetingRoomOf]);

  const deptName = (id: string) => {
    const d = depts.data?.find((x) => x.id === id);
    return d ? (lang === 'ar' ? d.name_ar : d.name_en) : id;
  };
  const deptColor = (id: string) => depts.data?.find((x) => x.id === id)?.color ?? '#8d9aa8';
  const activeRooms = new Set((busyRooms.data ?? []).filter((m) => m.status === 'running' || m.status === 'wrapping_up').map((m) => m.room));

  // Pan and zoom (pointer, wheel, keyboard).
  const scale = () => (svgRef.current ? MAP_W / svgRef.current.clientWidth : 1);
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) * scale();
    const dy = (e.clientY - d.y) * scale();
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const endDrag = () => {
    setTimeout(() => (drag.current = null), 0);
  };
  const zoom = (f: number) => setView((v) => {
    const k = Math.min(2.6, Math.max(0.6, v.k * f));
    const cx = MAP_W / 2;
    const cy = MAP_H / 2;
    return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
  });
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const onKey = (e: KeyboardEvent) => {
    const step = 60;
    const k: Record<string, () => void> = {
      ArrowLeft: () => setView((v) => ({ ...v, x: v.x + step })),
      ArrowRight: () => setView((v) => ({ ...v, x: v.x - step })),
      ArrowUp: () => setView((v) => ({ ...v, y: v.y + step })),
      ArrowDown: () => setView((v) => ({ ...v, y: v.y - step })),
      '+': () => zoom(1.15),
      '=': () => zoom(1.15),
      '-': () => zoom(1 / 1.15),
      '0': () => setView({ x: 0, y: 0, k: 1 })
    };
    if (k[e.key] && (e.target as Element).tagName === 'svg') {
      e.preventDefault();
      k[e.key]();
    }
  };
  const clicked = () => !drag.current?.moved;

  return (
    <div className="office-wrap">
      <svg
        ref={svgRef}
        className="office"
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        preserveAspectRatio="xMidYMid meet"
        tabIndex={0}
        aria-label={t.nav.office}
        role="application"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onKeyDown={onKey}
      >
        <defs>
          <pattern id="tiles" width="40" height="40" patternUnits="userSpaceOnUse">
            <rect width="40" height="40" fill="#f6f1e6" />
            <path d="M40 0H0V40" fill="none" stroke="#ebe3d2" strokeWidth="1" />
          </pattern>
          <pattern id="planks" width="26" height="120" patternUnits="userSpaceOnUse">
            <path d="M0 0V120" stroke="rgba(60,45,25,.07)" strokeWidth="1.5" />
            <path d="M0 74H26" stroke="rgba(60,45,25,.05)" />
          </pattern>
          <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#3b3326" floodOpacity="0.14" />
          </filter>
        </defs>
        <g style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: '0 0' }} className="office-world">
          <rect x="0" y="0" width={MAP_W} height={MAP_H} fill="url(#tiles)" />
          {ROOMS.map((r) => (
            <RoomShape
              key={r.id}
              r={r}
              label={r.kind === 'department' ? deptName(r.id) : t.rooms[r.id]}
              accent={r.kind === 'department' ? deptColor(r.id) : r.kind === 'meeting' ? '#b45a33' : '#2e6b57'}
              busy={activeRooms.has(r.id)}
              busyLabel={t.office.roomBusy}
              onOpen={() => clicked() && onRoom(r)}
            />
          ))}
          {/* Desks */}
          {people.map((e) => {
            const d = positions.desks.get(e.id);
            if (!d) return null;
            const here = positions.pos.get(e.id)?.place === 'desk';
            return <Desk key={`desk-${e.id}`} x={d.x} y={d.y} occupied={here} name={e.name.split(' ')[0]} color={deptColor(e.department_id)} status={displayStatus(e)} />;
          })}
          {/* People */}
          {[...people]
            .sort((a, b) => (positions.pos.get(a.id)?.y ?? 0) - (positions.pos.get(b.id)?.y ?? 0))
            .map((e) => {
              const p = positions.pos.get(e.id)!;
              const st = displayStatus(e);
              return (
                <Person
                  key={e.id}
                  e={e}
                  x={p.x}
                  y={p.y}
                  status={st}
                  speaking={speaking === e.id}
                  focused={focusId === e.id}
                  label={`${e.name}, ${lang === 'ar' && e.title_ar ? e.title_ar : e.title}: ${t.status[st] ?? st}${e.status_detail ? ` — ${e.status_detail}` : ''}`}
                  onOpen={() => clicked() && onSelect(e.id)}
                />
              );
            })}
        </g>
      </svg>
      <div className="office-controls" role="group">
        <button className="icon-btn" onClick={() => zoom(1.15)} aria-label="Zoom in">
          +
        </button>
        <button className="icon-btn" onClick={() => zoom(1 / 1.15)} aria-label="Zoom out">
          −
        </button>
        <button className="icon-btn" onClick={() => setView({ x: 0, y: 0, k: 1 })} aria-label={t.office.reset} title={t.office.reset}>
          ⟲
        </button>
      </div>
    </div>
  );
}

function RoomShape({ r, label, accent, onOpen, busy, busyLabel }: { r: Room; label: string; accent: string; onOpen: () => void; busy: boolean; busyLabel: string }) {
  const interactive = r.kind !== 'lounge';
  return (
    <g
      className={`room room-${r.kind}${busy ? ' room-busy' : ''}`}
      onClick={interactive ? onOpen : undefined}
      onKeyDown={(e) => interactive && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      tabIndex={interactive ? 0 : -1}
      role={interactive ? 'button' : undefined}
      aria-label={label}
    >
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="14" fill={r.floor} filter="url(#soft)" />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="14" fill="url(#planks)" pointerEvents="none" />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="14" fill="none" stroke="#cbbd9f" strokeWidth="5" className="room-wall" />
      {(() => {
        const w = Math.min(r.w - 28, label.length * 10 + 40);
        return (
          <>
            <rect x={r.x + 14} y={r.y + 12} width={w} height="34" rx="17" fill="#fffdf8" stroke={accent} strokeWidth="1.5" />
            <circle cx={r.x + 31} cy={r.y + 29} r="5.5" fill={accent} />
            {/* Centred, so Arabic (RTL) and English labels both stay inside the pill. */}
            <text x={r.x + 14 + 12 + w / 2} y={r.y + 35} textAnchor="middle" className="room-label">
              {label}
            </text>
          </>
        );
      })()}
      {r.kind === 'meeting' ? <MeetingFurniture r={r} /> : null}
      {r.kind === 'lounge' ? <LoungeFurniture r={r} /> : null}
      {r.kind === 'projects' ? <ProjectsFurniture r={r} /> : null}
      {r.id === 'executive' ? <CeoDesk r={r} /> : null}
      {busy ? (
        <g>
          <rect x={r.x + r.w - 86} y={r.y + 16} width="70" height="24" rx="12" fill="#b45a33" />
          <text x={r.x + r.w - 51} y={r.y + 32} textAnchor="middle" className="room-badge">
            {busyLabel}
          </text>
        </g>
      ) : null}
    </g>
  );
}

function MeetingFurniture({ r }: { r: Room }) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2 + 18;
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx={Math.min(r.w / 2 - 70, 80)} ry={Math.min(r.h / 2 - 90, 46)} fill="#8a6a46" stroke="#6f5434" strokeWidth="3" />
      <ellipse cx={cx} cy={cy - 3} rx={Math.min(r.w / 2 - 78, 72)} ry={Math.min(r.h / 2 - 98, 38)} fill="#9b7a53" />
      <rect x={cx - 26} y={r.y + r.h - 26} width="52" height="8" rx="4" fill="#5f5a50" opacity=".5" />
    </g>
  );
}

function LoungeFurniture({ r }: { r: Room }) {
  return (
    <g>
      <rect x={r.x + 40} y={r.y + 200} width="200" height="46" rx="18" fill="#2e6b57" />
      <rect x={r.x + 48} y={r.y + 190} width="184" height="22" rx="10" fill="#3d8068" />
      <circle cx={r.x + 330} cy={r.y + 120} r="32" fill="#e6d3b0" stroke="#cdb48a" strokeWidth="3" />
      <rect x={r.x + 300} y={r.y + 200} width="120" height="56" rx="10" fill="#d9cbb0" />
      <circle cx={r.x + r.w - 40} cy={r.y + 70} r="22" fill="#3d8068" />
      <circle cx={r.x + r.w - 40} cy={r.y + 70} r="12" fill="#2e6b57" />
      <rect x={r.x + 330} y={r.y + 210} width="16" height="22" rx="3" fill="#b45a33" />
    </g>
  );
}

function ProjectsFurniture({ r }: { r: Room }) {
  return (
    <g>
      <rect x={r.x + 30} y={r.y + 70} width={r.w - 60} height="90" rx="8" fill="#fffdf8" stroke="#cbbd9f" strokeWidth="2" />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={r.x + 44 + i * 58} y={r.y + 84} width="48" height="12" rx="3" fill={['#2e6b57', '#b45a33', '#6c5ce7'][i]} opacity=".8" />
          <rect x={r.x + 44 + i * 58} y={r.y + 104} width="40" height="10" rx="3" fill="#e9dcc4" />
          <rect x={r.x + 44 + i * 58} y={r.y + 120} width="44" height="10" rx="3" fill="#e9dcc4" />
        </g>
      ))}
      <rect x={r.x + 50} y={r.y + 190} width={r.w - 100} height="70" rx="10" fill="#8a6a46" />
    </g>
  );
}

function CeoDesk({ r }: { r: Room }) {
  return (
    <g>
      <rect x={r.x + r.w - 110} y={r.y + 70} width="80" height="40" rx="6" fill="#5b4329" />
      <rect x={r.x + r.w - 96} y={r.y + 60} width="22" height="14" rx="2" fill="#2b2b2b" />
      <text x={r.x + r.w - 70} y={r.y + 130} textAnchor="middle" className="desk-name">
        CEO
      </text>
    </g>
  );
}

function Desk({ x, y, occupied, name, color, status }: { x: number; y: number; occupied: boolean; name: string; color: string; status: string }) {
  const screenOn = occupied && !['idle', 'on_break', 'completed'].includes(status);
  return (
    <g className="desk" aria-hidden>
      <rect x={x - 44} y={y + 22} width="88" height="34" rx="6" fill="#a7835a" stroke="#8a6a46" strokeWidth="2" />
      <rect x={x - 16} y={y + 10} width="32" height="20" rx="3" fill="#2b2f36" />
      <rect x={x - 13} y={y + 13} width="26" height="14" rx="2" fill={screenOn ? color : '#4a4f57'} className={screenOn ? 'screen-on' : undefined} />
      <rect x={x - 4} y={y + 30} width="8" height="4" fill="#2b2f36" />
      <text x={x} y={y + 72} textAnchor="middle" className="desk-name">
        {name}
      </text>
    </g>
  );
}

function Person({ e, x, y, status, label, speaking, focused, onOpen }: { e: Employee; x: number; y: number; status: string; label: string; speaking: boolean; focused: boolean; onOpen: () => void }) {
  return (
    <g
      className={`person st-${status}${speaking ? ' speaking' : ''}${focused ? ' focused' : ''}`}
      style={{ transform: `translate(${x}px, ${y}px)` }}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onOpen}
      onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onOpen())}
    >
      <title>{label}</title>
      <ellipse cx="0" cy="24" rx="18" ry="5" fill="rgba(0,0,0,.12)" />
      <g className="body">
        <Avatar spec={e.avatar} size={52} x={-26} y={-32} />
      </g>
      <circle className="ring" cx="0" cy="-6" r="29" fill="none" stroke={STATUS_COLORS[status] ?? '#8d9aa8'} strokeWidth="3" />
      <StatusBubble status={status} />
    </g>
  );
}

/** The small indicator above each avatar, one shape per backend state. */
function StatusBubble({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? '#8d9aa8';
  const icon: Record<string, JSX.Element> = {
    thinking: (
      <g className="dots">
        <circle cx="-6" cy="0" r="2.2" fill="#fff" />
        <circle cx="0" cy="0" r="2.2" fill="#fff" />
        <circle cx="6" cy="0" r="2.2" fill="#fff" />
      </g>
    ),
    working: <path d="M-7 3h14M-5 -3h10" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" className="typing" />,
    reading: <path d="M-7 -4c3-1 5 0 7 1 2-1 4-2 7-1v8c-3-1-5 0-7 1-2-1-4-2-7-1z" fill="#fff" className="page" />,
    writing: <path d="M-5 5l9-9 2 2-9 9h-2z" fill="#fff" className="pen" />,
    in_meeting: <path d="M-6 -4h12v7h-7l-4 3v-3h-1z" fill="#fff" />,
    collaborating: (
      <g fill="#fff">
        <circle cx="-4" cy="-1" r="3" />
        <circle cx="4" cy="-1" r="3" />
        <path d="M-9 6c1-3 3-4 5-4s4 1 5 4M-1 6c1-3 3-4 5-4s4 1 5 4" />
      </g>
    ),
    waiting_approval: <path d="M-4 -6h8M-4 6h8M-3 -6c0 4 6 4 6 6s-6 2-6 6" stroke="#fff" strokeWidth="2" fill="none" className="hourglass" />,
    blocked: <text x="0" y="5" textAnchor="middle" fill="#fff" fontSize="15" fontWeight="700">!</text>,
    completed: <path d="M-6 0l4 4 8-8" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" className="check" />,
    on_break: <path d="M-5 -2h8v5a4 4 0 0 1-8 0zM3 0h2a2 2 0 0 1 0 4h-2" stroke="#fff" strokeWidth="1.8" fill="none" />
  };
  if (status === 'idle') return null;
  return (
    <g className="bubble" transform="translate(0,-50)">
      <rect x="-15" y="-11" width="30" height="22" rx="11" fill={c} stroke="#fff" strokeWidth="2" />
      {icon[status] ?? null}
    </g>
  );
}
