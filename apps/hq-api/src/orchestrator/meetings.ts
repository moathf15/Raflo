import { z } from 'zod';
import { systemPromptFor } from '../agents/context';
import { clip, searchKnowledge } from '../agents/knowledge';
import type { EmployeeRow } from '../agents/prompts';
import { runAgent, RunError } from '../agents/runner';
import { toolsFor } from '../agents/tools';
import { channelFor, notify, postMessage, setEmployeeStatus, settleEmployee, type Ctx } from '../context';

export const MEETING_TYPES = ['brainstorming', 'product_planning', 'technical_review', 'security_review', 'design_review', 'marketing_strategy', 'project_status', 'emergency', 'general'] as const;

const Contribution = z.object({
  message: z.string().min(1).max(4000).describe('What you say in the meeting, in first person. Be concise (under ~180 words).'),
  stance: z.enum(['proposal', 'agree', 'disagree', 'question', 'concern', 'information']),
  addressed_to: z.array(z.string()).max(5).default([]).describe('Slugs of participants you respond to or ask (or "owner").'),
  wants_to_continue: z.boolean().describe('True if you have an unresolved point or expect a reply on this agenda item.')
});

const ItemSummary = z.object({
  summary: z.string().min(1).max(3000),
  decisions: z.array(z.string().max(500)).max(10).default([]),
  open_questions: z.array(z.string().max(500)).max(10).default([])
});

const Minutes = z.object({
  executive_summary: z.string().min(1).max(5000),
  key_points: z.array(z.string().max(800)).max(20).default([]),
  decisions: z.array(z.string().max(800)).max(20).default([]),
  disagreements: z.array(z.string().max(800)).max(20).default([]),
  unresolved_questions: z.array(z.string().max(800)).max(20).default([]),
  action_items: z
    .array(z.object({ title: z.string().min(3).max(200), description: z.string().max(3000).default(''), assignee: z.string().describe('Employee slug'), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }))
    .max(20)
    .default([])
});
export type MinutesT = z.infer<typeof Minutes>;

interface MeetingRow {
  id: string;
  title: string;
  objective: string;
  agenda: string[];
  type: string;
  expected_output: string;
  project_id: string | null;
  status: string;
  moderator_id: string;
  max_rounds: number;
  progress: { item: number; round: number; spoken: string[]; eligible?: string[] | null; continuing?: string[]; ownerSpoke?: boolean };
  end_requested: boolean;
}

interface EventRow {
  id: string;
  kind: string;
  employee_id: string | null;
  agenda_index: number | null;
  content: string;
  data: Record<string, unknown>;
}

async function addEvent(ctx: Ctx, meetingId: string, ev: { kind: string; employeeId?: string | null; item?: number | null; content: string; data?: unknown; runId?: string | null }) {
  const [row] = await ctx.db.query(
    'INSERT INTO hq_meeting_events (meeting_id, kind, employee_id, agenda_index, content, data, run_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [meetingId, ev.kind, ev.employeeId ?? null, ev.item ?? null, ev.content, JSON.stringify(ev.data ?? {}), ev.runId ?? null]
  );
  ctx.bus.emit({ type: 'meeting.event', meetingId, event: row });
}

async function saveProgress(ctx: Ctx, id: string, progress: MeetingRow['progress'], extra: Record<string, unknown> = {}) {
  const keys = Object.keys(extra);
  await ctx.db.query(`UPDATE hq_meetings SET progress = $2${keys.map((k, i) => `, ${k} = $${i + 3}`).join('')} WHERE id = $1`, [id, JSON.stringify(progress), ...keys.map((k) => extra[k])]);
  ctx.bus.emit({ type: 'meeting.progress', meetingId: id, progress, ...extra });
}

/** Start a meeting: participants move to the room; the worker then runs it turn by turn. */
export async function startMeeting(
  ctx: Ctx,
  input: { room: string; title: string; objective: string; agenda: string[]; type: string; expectedOutput: string; participantIds: string[]; projectId?: string | null; maxRounds: number }
) {
  const people = await ctx.db.query<{ id: string; slug: string }>('SELECT id, slug FROM hq_employees WHERE id = ANY($1::uuid[]) AND active AND archived_at IS NULL', [input.participantIds]);
  if (people.length < 2) throw new Error('A meeting needs at least two active employees.');
  const moderator = people.find((p) => p.slug === 'project-manager') ?? people.find((p) => p.slug === 'chief-of-staff') ?? people[0];
  const agenda = input.agenda.length ? input.agenda : [input.objective];
  const [m] = await ctx.db.query<{ id: string }>(
    `INSERT INTO hq_meetings (room, title, objective, agenda, type, expected_output, project_id, moderator_id, max_rounds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [input.room, input.title, input.objective, JSON.stringify(agenda), input.type, input.expectedOutput, input.projectId ?? null, moderator.id, input.maxRounds]
  );
  for (const p of people) {
    await ctx.db.query('INSERT INTO hq_meeting_participants (meeting_id, employee_id) VALUES ($1, $2)', [m.id, p.id]);
    await setEmployeeStatus(ctx, p.id, 'in_meeting', input.title, { meetingId: m.id });
  }
  await addEvent(ctx, m.id, { kind: 'system', content: `Meeting started with ${people.length} participants. Objective: ${input.objective}` });
  ctx.bus.emit({ type: 'meeting', meetingId: m.id, status: 'running' });
  ctx.wake();
  return m.id;
}

/** Owner speaks in a running meeting. Participants see it on their next turn, and it guarantees another round. */
export async function ownerSays(ctx: Ctx, meetingId: string, text: string) {
  const [m] = await ctx.db.query<MeetingRow>('SELECT * FROM hq_meetings WHERE id = $1', [meetingId]);
  if (!m || (m.status !== 'running' && m.status !== 'wrapping_up')) throw new Error('The meeting is not running.');
  await addEvent(ctx, meetingId, { kind: 'owner', item: m.progress.item, content: text });
  await saveProgress(ctx, meetingId, { ...m.progress, ownerSpoke: true });
  ctx.wake();
}

function transcript(events: EventRow[], names: Map<string, string>, slugs: Map<string, string>, limit = 60) {
  const shown = events.slice(-limit);
  return shown
    .map((e) => {
      if (e.kind === 'speech') return `${names.get(e.employee_id!) ?? '?'} (${slugs.get(e.employee_id!) ?? '?'}) [${(e.data as { stance?: string }).stance ?? ''}]: ${e.content}`;
      if (e.kind === 'owner') return `OWNER (CEO): ${e.content}`;
      if (e.kind === 'topic') return `\n--- ${e.content} ---`;
      if (e.kind === 'item_summary') return `[Moderator summary] ${e.content}`;
      return `[${e.content}]`;
    })
    .join('\n');
}

/**
 * Run the next step of a meeting: one participant's turn, an agenda-item summary, or the minutes.
 * Each step is persisted before the next, so a restart resumes where the meeting was.
 */
export async function meetingStep(ctx: Ctx, meetingId: string): Promise<'continue' | 'done'> {
  const [m] = await ctx.db.query<MeetingRow>('SELECT * FROM hq_meetings WHERE id = $1', [meetingId]);
  if (!m || (m.status !== 'running' && m.status !== 'wrapping_up')) return 'done';
  const participants = await ctx.db.query<EmployeeRow>(
    'SELECT e.* FROM hq_meeting_participants p JOIN hq_employees e ON e.id = p.employee_id WHERE p.meeting_id = $1 ORDER BY (e.id = $2) DESC, e.sort',
    [m.id, m.moderator_id]
  );
  const names = new Map(participants.map((p) => [p.id, p.name]));
  const slugs = new Map(participants.map((p) => [p.id, p.slug]));
  const bySlug = new Map(participants.map((p) => [p.slug, p.id]));
  const events = await ctx.db.query<EventRow>('SELECT * FROM hq_meeting_events WHERE meeting_id = $1 ORDER BY id', [m.id]);
  const moderator = participants.find((p) => p.id === m.moderator_id) ?? participants[0];
  const p = { ...m.progress };

  try {
    if (m.end_requested || p.item >= m.agenda.length) {
      await writeMinutes(ctx, m, participants, moderator, events, names, slugs);
      return 'done';
    }
    const item = m.agenda[p.item];
    if (!events.some((e) => e.kind === 'topic' && e.agenda_index === p.item)) {
      await addEvent(ctx, m.id, { kind: 'topic', item: p.item, content: `Agenda item ${p.item + 1}/${m.agenda.length}: ${item}` });
      await saveProgress(ctx, m.id, { item: p.item, round: 0, spoken: [], eligible: null, continuing: [], ownerSpoke: false });
      return 'continue';
    }
    const eligible = p.eligible ?? participants.map((x) => x.id);
    const next = participants.find((x) => eligible.includes(x.id) && !p.spoken.includes(x.id));
    if (next) {
      const itemEvents = events.filter((e) => e.agenda_index === p.item || e.kind === 'item_summary' || e.kind === 'system');
      const knowledge = await searchKnowledge(ctx.db, { query: `${m.objective} ${item}`, employeeId: next.id, departmentId: next.department_id, projectId: m.project_id, limit: 3 });
      const prompt = `You are in a ${m.type.replace(/_/g, ' ')} meeting: "${m.title}".
Objective: ${m.objective}
Expected output: ${m.expected_output || 'decisions and action items'}
Agenda: ${m.agenda.map((a, i) => `${i + 1}. ${a}${i === p.item ? ' (current)' : ''}`).join(' ')}
Participants: ${participants.map((x) => `${x.name} (${x.slug}, ${x.title})`).join('; ')}. Moderator: ${moderator.name}.
${knowledge.length ? `\nRelevant company knowledge:\n${knowledge.map((k) => `- ${k.title}: ${clip(k.body, 600)}`).join('\n')}\n` : ''}
Transcript so far:
${transcript(itemEvents, names, slugs) || '(nobody has spoken yet on this item)'}

It is your turn (round ${p.round + 1}) on the current agenda item: "${item}". Contribute from your professional role: add new information, build on or challenge what others said (name them), ask for clarification, or answer questions addressed to you or the owner's remarks. Do not repeat points already made; if you have nothing new, say so briefly and set wants_to_continue false.${
        next.id === moderator.id ? ' As moderator, keep the discussion on track and make sure disagreements and questions are surfaced.' : ''
      } Call contribute.`;
      ctx.bus.emit({ type: 'meeting.speaking', meetingId: m.id, employeeId: next.id });
      const res = await runAgent(ctx, {
        kind: 'meeting_turn',
        employee: next,
        system: await systemPromptFor(ctx, next),
        prompt,
        tools: toolsFor(next, { allowSideEffects: false }).filter((t) => t.permission !== 'comms.send'),
        terminal: { name: 'contribute', description: 'Say your contribution in the meeting.', input: Contribution, status: ['collaborating', `Speaking in ${m.title}`] },
        textFallback: (text) => (text ? { message: clip(text, 3000), stance: 'information' as const, addressed_to: [], wants_to_continue: false } : null),
        meetingId: m.id,
        projectId: m.project_id,
        thinkingStatus: ['in_meeting', `Preparing to speak in ${m.title}`],
        maxIterations: 4
      });
      ctx.bus.emit({ type: 'meeting.speaking', meetingId: m.id, employeeId: null });
      const c = res.output!;
      await addEvent(ctx, m.id, { kind: 'speech', employeeId: next.id, item: p.item, content: c.message, data: { stance: c.stance, addressed_to: c.addressed_to }, runId: res.runId });
      await setEmployeeStatus(ctx, next.id, 'in_meeting', m.title);
      const continuing = new Set(p.continuing ?? []);
      if (c.wants_to_continue) continuing.add(next.id);
      for (const s of c.addressed_to) if (bySlug.has(s)) continuing.add(bySlug.get(s)!);
      await saveProgress(ctx, m.id, { ...p, spoken: [...p.spoken, next.id], continuing: [...continuing] });
      return 'continue';
    }
    // Round finished: another round if someone has an open point or the owner spoke, within the limit.
    const continuing = (p.continuing ?? []).filter((id) => names.has(id));
    const another = p.round + 1 < m.max_rounds && (continuing.length > 0 || p.ownerSpoke);
    if (another) {
      await saveProgress(ctx, m.id, { item: p.item, round: p.round + 1, spoken: [], eligible: p.ownerSpoke ? null : continuing, continuing: [], ownerSpoke: false });
      return 'continue';
    }
    // Moderator summarises the item.
    const itemEvents = events.filter((e) => e.agenda_index === p.item);
    const res = await runAgent(ctx, {
      kind: 'meeting_turn',
      employee: moderator,
      system: await systemPromptFor(ctx, moderator),
      prompt: `You moderate the meeting "${m.title}". Summarise the discussion of agenda item "${item}" accurately: only what was actually said below. List decisions that were actually agreed and questions still open.\n\nTranscript:\n${transcript(itemEvents, names, slugs, 80)}\n\nCall summarize_item.`,
      tools: [],
      terminal: { name: 'summarize_item', description: 'Summarise the agenda item.', input: ItemSummary, status: ['collaborating', 'Summarising'] },
      meetingId: m.id,
      thinkingStatus: ['in_meeting', `Moderating ${m.title}`],
      maxIterations: 2
    });
    const s = res.output!;
    await addEvent(ctx, m.id, { kind: 'item_summary', employeeId: moderator.id, item: p.item, content: s.summary, data: s, runId: res.runId });
    await saveProgress(ctx, m.id, { item: p.item + 1, round: 0, spoken: [], eligible: null, continuing: [], ownerSpoke: false });
    return 'continue';
  } catch (err) {
    const re = err instanceof RunError ? err : new RunError((err as Error).message, true, 'provider');
    await addEvent(ctx, m.id, { kind: 'system', content: `The meeting stopped: ${re.message}` });
    await ctx.db.query(`UPDATE hq_meetings SET status = 'failed', error = $2, ended_at = now(), lease_until = NULL WHERE id = $1`, [m.id, re.message]);
    await release(ctx, participants);
    ctx.bus.emit({ type: 'meeting', meetingId: m.id, status: 'failed' });
    await notify(ctx, 'meeting_failed', `Meeting stopped: ${m.title}`, re.message, `/meetings/${m.id}`);
    return 'done';
  }
}

async function release(ctx: Ctx, participants: EmployeeRow[]) {
  for (const p of participants) {
    await ctx.db.query('UPDATE hq_employees SET current_meeting_id = NULL WHERE id = $1', [p.id]);
    await settleEmployee(ctx, p.id);
  }
}

async function writeMinutes(ctx: Ctx, m: MeetingRow, participants: EmployeeRow[], moderator: EmployeeRow, events: EventRow[], names: Map<string, string>, slugs: Map<string, string>) {
  await ctx.db.query(`UPDATE hq_meetings SET status = 'wrapping_up' WHERE id = $1`, [m.id]);
  ctx.bus.emit({ type: 'meeting', meetingId: m.id, status: 'wrapping_up' });
  const spoke = events.some((e) => e.kind === 'speech');
  if (!spoke) {
    await ctx.db.query(`UPDATE hq_meetings SET status = 'cancelled', ended_at = now(), lease_until = NULL WHERE id = $1`, [m.id]);
    await addEvent(ctx, m.id, { kind: 'system', content: 'Meeting ended before anyone spoke. No minutes.' });
    await release(ctx, participants);
    ctx.bus.emit({ type: 'meeting', meetingId: m.id, status: 'cancelled' });
    return;
  }
  const res = await runAgent(ctx, {
    kind: 'minutes',
    employee: moderator,
    system: await systemPromptFor(ctx, moderator),
    prompt: `Write the minutes of the meeting "${m.title}" (${m.type.replace(/_/g, ' ')}). Objective: ${m.objective}. Expected output: ${m.expected_output || 'decisions and action items'}.
Record only what was actually said in the transcript; do not invent agreement. Capture real disagreements and unresolved questions. Action items must have an assignee from the participants (by slug) or another employee whose role clearly fits, and a realistic deadline when one was discussed.
Participants: ${participants.map((x) => `${x.name} (${x.slug})`).join(', ')}.

Transcript:
${transcript(events, names, slugs, 200)}

Call record_minutes.`,
    tools: [],
    terminal: { name: 'record_minutes', description: 'Record the meeting minutes.', input: Minutes, status: ['writing', 'Writing minutes'] },
    meetingId: m.id,
    thinkingStatus: ['in_meeting', `Writing minutes for ${m.title}`],
    maxIterations: 3
  });
  const minutes = res.output!;
  const all = await ctx.db.query<{ id: string; slug: string }>('SELECT id, slug FROM hq_employees WHERE archived_at IS NULL');
  const ids = new Map(all.map((x) => [x.slug, x.id]));
  for (const a of minutes.action_items)
    await ctx.db.query('INSERT INTO hq_meeting_action_items (meeting_id, title, description, assignee_id, deadline) VALUES ($1, $2, $3, $4, $5)', [m.id, a.title, a.description, ids.get(a.assignee) ?? null, a.deadline ?? null]);
  await ctx.db.query(`UPDATE hq_meetings SET status = 'completed', minutes = $2, ended_at = now(), lease_until = NULL WHERE id = $1`, [m.id, JSON.stringify(minutes)]);
  await ctx.db.query(`INSERT INTO hq_knowledge (scope, project_id, kind, title, body, source) VALUES ($1, $2, 'meeting_summary', $3, $4, $5)`, [
    m.project_id ? 'project' : 'company',
    m.project_id,
    `Meeting: ${m.title}`,
    `${minutes.executive_summary}\n\nDecisions:\n${minutes.decisions.map((d) => `- ${d}`).join('\n')}\n\nOpen questions:\n${minutes.unresolved_questions.map((d) => `- ${d}`).join('\n')}`,
    JSON.stringify({ meetingId: m.id })
  ]);
  await addEvent(ctx, m.id, { kind: 'system', content: 'Meeting ended. Minutes recorded.' });
  await release(ctx, participants);
  const ch = await channelFor(ctx, 'announcements');
  if (ch) await postMessage(ctx, ch, { type: 'system' }, `Meeting “${m.title}” ended: ${clip(minutes.executive_summary, 400)}`, { meetingId: m.id });
  ctx.bus.emit({ type: 'meeting', meetingId: m.id, status: 'completed' });
  await notify(ctx, 'meeting_done', `Minutes ready: ${m.title}`, minutes.executive_summary.slice(0, 300), `/meetings/${m.id}`);
}

/** Turn a meeting action item into a real task (owner action). */
export async function actionItemToTask(ctx: Ctx, itemId: string, ownerId: string) {
  const [a] = await ctx.db.query<{ id: string; meeting_id: string; title: string; description: string; assignee_id: string | null; deadline: string | null; task_id: string | null; project_id: string | null; mtitle: string }>(
    'SELECT a.*, m.project_id, m.title AS mtitle FROM hq_meeting_action_items a JOIN hq_meetings m ON m.id = a.meeting_id WHERE a.id = $1',
    [itemId]
  );
  if (!a) throw new Error('not_found');
  if (a.task_id) return a.task_id;
  const [t] = await ctx.db.query<{ id: string }>(
    `INSERT INTO hq_tasks (project_id, title, description, status, queue, assignee_id, deadline, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner') RETURNING id`,
    [a.project_id, a.title, `${a.description}\n\n(Action item from the meeting “${a.mtitle}”.)`, a.assignee_id ? 'assigned' : 'backlog', a.assignee_id ? 'execute' : null, a.assignee_id, a.deadline]
  );
  await ctx.db.query('UPDATE hq_meeting_action_items SET task_id = $2 WHERE id = $1', [a.id, t.id]);
  void ownerId;
  ctx.wake();
  return t.id;
}
