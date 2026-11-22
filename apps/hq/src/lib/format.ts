const locale = (lang: string) => (lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB');

export function fmtDate(d: string | Date | null | undefined, lang = 'en') {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(d: string | Date | null | undefined, lang = 'en') {
  if (!d) return '—';
  return new Date(d).toLocaleString(locale(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(d: string | Date, lang = 'en') {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar' : 'en', { numeric: 'auto' });
  if (Math.abs(s) < 60) return rtf.format(-s, 'second');
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (Math.abs(s) < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

export const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function fmtDuration(sec: number) {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}
