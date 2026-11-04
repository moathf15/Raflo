import type { LatLng } from '@riflo/core';

const W = 358;
const H = 140;
const PAD = 22;

/** Schematic route map from real coordinates (north up). A real map tile layer can replace it later. */
export function DayMap({ stops, label }: { stops: LatLng[]; label: string }) {
  const lats = stops.map((s) => s.lat);
  const lngs = stops.map((s) => s.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const spanLat = Math.max(maxLat - minLat, 0.005);
  const spanLng = Math.max(maxLng - minLng, 0.005);
  const pts = stops.map((s) => ({
    x: PAD + ((s.lng - minLng) / spanLng) * (W - PAD * 2),
    y: PAD + ((maxLat - s.lat) / spanLat) * (H - PAD * 2)
  }));
  return (
    <div className="map">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none" role="img" aria-label={label}>
        <path d="M0 30 C80 50 120 10 200 30 S320 70 358 50" stroke="var(--sand-300)" strokeWidth="10" fill="none" />
        <path d="M0 105 C90 90 160 120 250 100 S330 90 358 102" stroke="var(--sand-300)" strokeWidth="6" fill="none" />
        <polyline points={pts.map((p) => `${p.x},${p.y}`).join(' ')} stroke="var(--palm-700)" strokeWidth="2.5" strokeDasharray="6 5" fill="none" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="10" fill="var(--palm-700)" />
            <text x={p.x} y={p.y + 4} fontSize="11" fill="#fff" textAnchor="middle" fontFamily="var(--font-display)">{i + 1}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
