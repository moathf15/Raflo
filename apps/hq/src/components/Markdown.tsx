import { Fragment, type ReactNode } from 'react';

/**
 * Small, safe Markdown renderer for agent output: builds React elements (never innerHTML), so model or repository
 * text cannot inject markup. Supports headings, lists, code blocks, tables, quotes, bold/italic/code and http(s) links.
 */
export function Markdown({ text }: { text: string }) {
  const lines = (text ?? '').replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++} className="md-code" dir="ltr">
          <code>{body.join('\n')}</code>
        </pre>
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as 'h3';
      out.push(<Tag key={key++}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i])) items.push(lines[i++].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ''));
      const L = ordered ? 'ol' : 'ul';
      out.push(
        <L key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it.replace(/^\[( |x)\]\s*/i, (m) => (m.includes('x') ? '☑ ' : '☐ ')))}</li>
          ))}
        </L>
      );
      continue;
    }
    if (line.startsWith('|') && lines[i + 1]?.match(/^\|?\s*:?-{2,}/)) {
      const row = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(row(lines[i++]));
      out.push(
        <div className="md-table" key={key++}>
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (line.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(<blockquote key={key++}>{inline(q.join(' '))}</blockquote>);
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*]\s|\s*\d+[.)]\s|>|\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }
  return <div className="md" dir="auto">{out}</div>;
}

function inline(s: string): ReactNode {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (m[1]) parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    else if (m[4])
      parts.push(
        <a key={k++} href={m[5]} target="_blank" rel="noopener noreferrer">
          {tok.slice(1, tok.indexOf(']'))}
        </a>
      );
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return <Fragment>{parts}</Fragment>;
}
