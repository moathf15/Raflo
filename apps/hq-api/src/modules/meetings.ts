import { z } from 'zod';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/http';
import { getSetting } from '../lib/settings';
import { actionItemToTask, MEETING_TYPES, ownerSays, startMeeting } from '../orchestrator/meetings';
import { idParam, type Module } from './core';

export const ROOMS = ['majlis', 'summit', 'huddle'] as const;

export const meetingsModule: Module = (app, ctx, auth) => {
  app.get('/hq/v1/meetings', async (req) => {
    await auth.viewer(req);
    return ctx.db.query(`SELECT m.id, m.room, m.title, m.type, m.status, m.created_at, m.ended_at, m.objective,
      (SELECT array_agg(employee_id) FROM hq_meeting_participants p WHERE p.meeting_id = m.id) AS participant_ids,
      (SELECT count(*)::int FROM hq_meeting_events e WHERE e.meeting_id = m.id AND e.kind = 'speech') AS contributions
      FROM hq_meetings m ORDER BY m.created_at DESC LIMIT 200`);
  });

  app.post('/hq/v1/meetings', async (req) => {
    const o = await auth.owner(req);
    const limits = await getSetting(ctx.db, 'limits');
    const b = z
      .object({
        room: z.enum(ROOMS),
        title: z.string().min(3).max(200),
        objective: z.string().min(5).max(5000),
        agenda: z.array(z.string().min(2).max(300)).max(8).default([]),
        type: z.enum(MEETING_TYPES),
        expected_output: z.string().max(2000).default(''),
        participant_ids: z.array(z.uuid()).min(2).max(limits.maxMeetingParticipants),
        project_id: z.uuid().nullable().default(null),
        max_rounds: z.number().int().min(1).max(limits.maxMeetingRounds).default(limits.maxMeetingRounds)
      })
      .parse(req.body);
    const [busy] = await ctx.db.query<{ title: string }>(`SELECT title FROM hq_meetings WHERE room = $1 AND status IN ('running', 'wrapping_up')`, [b.room]);
    if (busy) throw new HttpError(409, 'room_busy', `The room is in use by “${busy.title}”.`);
    const [inMeeting] = await ctx.db.query<{ name: string }>('SELECT name FROM hq_employees WHERE id = ANY($1::uuid[]) AND current_meeting_id IS NOT NULL', [b.participant_ids]);
    if (inMeeting) throw new HttpError(409, 'participant_busy', `${inMeeting.name} is already in a meeting.`);
    if (!(await ctx.providers.hasAny())) throw new HttpError(409, 'no_provider', 'Configure an AI provider before holding a meeting.');
    const id = await startMeeting(ctx, {
      room: b.room,
      title: b.title,
      objective: b.objective,
      agenda: b.agenda,
      type: b.type,
      expectedOutput: b.expected_output,
      participantIds: b.participant_ids,
      projectId: b.project_id,
      maxRounds: b.max_rounds
    });
    await audit(ctx.db, { type: 'owner', id: o.id }, 'meeting.start', 'meeting', id, { title: b.title, participants: b.participant_ids.length });
    return { id };
  });

  app.get('/hq/v1/meetings/:id', async (req) => {
    await auth.viewer(req);
    const id = idParam(req.params);
    const [m] = await ctx.db.query('SELECT * FROM hq_meetings WHERE id = $1', [id]);
    if (!m) throw notFound();
    const [participants, events, actionItems, usage] = await Promise.all([
      ctx.db.query('SELECT e.id, e.name, e.title, e.slug, e.avatar, e.department_id FROM hq_meeting_participants p JOIN hq_employees e ON e.id = p.employee_id WHERE p.meeting_id = $1 ORDER BY e.sort', [id]),
      ctx.db.query('SELECT * FROM hq_meeting_events WHERE meeting_id = $1 ORDER BY id', [id]),
      ctx.db.query('SELECT a.*, e.name AS assignee_name FROM hq_meeting_action_items a LEFT JOIN hq_employees e ON e.id = a.assignee_id WHERE a.meeting_id = $1', [id]),
      ctx.db.query(`SELECT count(*)::int AS runs, coalesce(sum(cost_usd), 0)::float AS cost_usd, coalesce(sum(input_tokens + output_tokens + cache_read_tokens), 0)::int AS tokens FROM hq_runs WHERE meeting_id = $1`, [id])
    ]);
    return { meeting: m, participants, events, actionItems, usage: usage[0] };
  });

  app.post('/hq/v1/meetings/:id/messages', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
    try {
      await ownerSays(ctx, id, b.text);
    } catch (e) {
      throw new HttpError(409, 'meeting_not_running', (e as Error).message);
    }
    await audit(ctx.db, { type: 'owner', id: o.id }, 'meeting.owner_message', 'meeting', id);
    return { ok: true };
  });

  /** End early: the moderator writes minutes from what was said so far. */
  app.post('/hq/v1/meetings/:id/end', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    await ctx.db.query(`UPDATE hq_meetings SET end_requested = true WHERE id = $1 AND status = 'running'`, [id]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'meeting.end', 'meeting', id);
    ctx.wake();
    return { ok: true };
  });

  app.post('/hq/v1/meeting-action-items/:id/task', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ assignee_id: z.uuid().nullable().optional() }).parse(req.body ?? {});
    if (b.assignee_id !== undefined) await ctx.db.query('UPDATE hq_meeting_action_items SET assignee_id = $2 WHERE id = $1 AND task_id IS NULL', [id, b.assignee_id]);
    const taskId = await actionItemToTask(ctx, id, o.id);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'meeting.action_to_task', 'task', taskId);
    return { taskId };
  });
};
