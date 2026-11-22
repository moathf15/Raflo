import { systemPromptFor, toolingNote } from '../agents/context';
import { clip, searchKnowledge } from '../agents/knowledge';
import { loadEmployee, runAgent, RunError } from '../agents/runner';
import { toolsFor } from '../agents/tools';
import { postMessage, settleEmployee, setEmployeeStatus, type Ctx } from '../context';
import type { ChatMessage } from '../providers/types';

/** Reply to the owner in a direct conversation. Read-only tools only: work with side effects goes through tasks. */
export async function answerChat(ctx: Ctx, queueId: string) {
  const [q] = await ctx.db.query<{ id: string; channel_id: string; employee_id: string; message_id: string }>('SELECT * FROM hq_chat_queue WHERE id = $1', [queueId]);
  if (!q) return;
  const e = await loadEmployee(ctx, q.employee_id);
  if (!e) return;
  const rows = await ctx.db.query<{ id: string; author_type: string; body: string }>(
    `SELECT id, author_type, body FROM (SELECT * FROM hq_messages WHERE channel_id = $1 AND created_at <= (SELECT created_at FROM hq_messages WHERE id = $2) ORDER BY created_at DESC LIMIT 20) x ORDER BY created_at`,
    [q.channel_id, q.message_id]
  );
  const last = rows.pop();
  if (!last) return;
  // Earlier turns as alternating history (consecutive messages from the same side are merged).
  const history: ChatMessage[] = [];
  for (const r of rows) {
    const role = r.author_type === 'owner' ? 'user' : 'assistant';
    const prev = history[history.length - 1];
    if (prev && prev.role === role) (prev.content[0] as { text: string }).text += `\n\n${r.body}`;
    else history.push(role === 'user' ? { role, content: [{ type: 'text', text: r.body }] } : { role, content: [{ type: 'text', text: r.body }] });
  }
  while (history.length && history[0].role === 'assistant') history.shift();
  if (history.length && history[history.length - 1].role === 'user') history.pop();

  const knowledge = await searchKnowledge(ctx.db, { query: last.body, employeeId: e.id, departmentId: e.department_id, limit: 3 });
  const [work] = await ctx.db.query<{ open: string | null }>(
    `SELECT string_agg(title || ' [' || status || ']', '; ') AS open FROM (SELECT title, status FROM hq_tasks WHERE assignee_id = $1 AND status NOT IN ('completed', 'cancelled', 'rejected') ORDER BY updated_at DESC LIMIT 5) t`,
    [e.id]
  );
  const prompt = `${last.body}\n\n---\n(Context for you, not from the owner: your open tasks: ${work?.open ?? 'none'}.${
    knowledge.length ? ` Possibly relevant knowledge: ${knowledge.map((k) => `${k.title}: ${clip(k.body, 400)}`).join(' | ')}` : ''
  } ${await toolingNote(ctx, e, null)}\nThis is a direct conversation with the owner. Answer directly. If the request is substantial work, say so and suggest the owner assigns it as a task.)`;
  await setEmployeeStatus(ctx, e.id, 'thinking', 'Replying to the owner');
  try {
    const res = await runAgent(ctx, {
      kind: 'chat',
      employee: e,
      system: await systemPromptFor(ctx, e),
      prompt,
      history,
      tools: toolsFor(e, { allowSideEffects: false }).filter((t) => t.permission !== 'comms.send' && t.permission !== 'knowledge.write'),
      maxIterations: 6
    });
    await postMessage(ctx, q.channel_id, { type: 'employee', id: e.id }, res.text || '(no reply)', {}, res.runId);
    await ctx.db.query(`UPDATE hq_chat_queue SET status = 'done' WHERE id = $1`, [q.id]);
  } catch (err) {
    const msg = err instanceof RunError ? err.message : (err as Error).message;
    await ctx.db.query(`UPDATE hq_chat_queue SET status = 'failed', error = $2 WHERE id = $1`, [q.id, msg]);
    await postMessage(ctx, q.channel_id, { type: 'system' }, `${e.name} could not reply: ${msg}`);
  } finally {
    await settleEmployee(ctx, e.id);
  }
}
