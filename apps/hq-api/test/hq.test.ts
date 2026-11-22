import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addProvider, call, employeeId, ownerClient, promptText, startHq, stop, tmpDir, type Hq } from './helpers';

type Client = Awaited<ReturnType<typeof ownerClient>>;

describe('owner authentication and security', () => {
  let hq: Hq;
  before(async () => (hq = await startHq()));
  after(() => stop(hq));

  test('first owner needs the setup code; then setup is closed', async () => {
    const bad = await hq.app.inject({ method: 'POST', url: '/hq/v1/auth/setup', headers: { 'x-hq-csrf': '1' }, payload: { email: 'a@b.co', password: 'correct horse battery', name: 'X', setupCode: 'wrong-code' } });
    assert.equal(bad.statusCode, 403);
    const req = await ownerClient(hq);
    const again = await req('POST', '/hq/v1/auth/setup', { email: 'b@b.co', password: 'correct horse battery', name: 'Y', setupCode: hq.setupCode });
    assert.equal(again.status, 409);
  });

  test('every API route requires a session', async () => {
    const res = await hq.app.inject({ method: 'GET', url: '/hq/v1/employees' });
    assert.equal(res.statusCode, 401);
  });

  test('writes without the CSRF header or from another origin are refused', async () => {
    const login = await hq.app.inject({ method: 'POST', url: '/hq/v1/auth/login', headers: { 'x-hq-csrf': '1' }, payload: { email: 'owner@raflo.test', password: 'correct horse battery' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.match(String(login.headers['set-cookie']), /HttpOnly/i);
    assert.match(String(login.headers['set-cookie']), /SameSite=Strict/i);
    const noHeader = await hq.app.inject({ method: 'POST', url: '/hq/v1/projects', headers: { cookie }, payload: { name: 'X' } });
    assert.equal(noHeader.statusCode, 403);
    const evil = await hq.app.inject({ method: 'POST', url: '/hq/v1/projects', headers: { cookie, 'x-hq-csrf': '1', origin: 'https://evil.example' }, payload: { name: 'X' } });
    assert.equal(evil.statusCode, 403);
  });

  test('wrong passwords are limited', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await hq.app.inject({ method: 'POST', url: '/hq/v1/auth/login', headers: { 'x-hq-csrf': '1' }, payload: { email: 'intruder@raflo.test', password: 'nope' } })).statusCode;
    assert.equal(last, 429);
  });

  test('the organisation is seeded with 20 idle employees and no fabricated activity', async () => {
    const req = await ownerClient(hq);
    const emps = (await req('GET', '/hq/v1/employees')).body as { status: string }[];
    assert.equal(emps.length, 20);
    assert.ok(emps.every((e) => e.status === 'idle'));
    const dash = (await req('GET', '/hq/v1/dashboard')).body;
    assert.equal(dash.tasks.completed, 0);
    assert.equal(dash.usage.runs, 0);
    assert.equal(dash.setup.providers, 0);
  });
});

describe('providers, tasks, reviews and plans', () => {
  let hq: Hq;
  let req: Client;
  before(async () => {
    hq = await startHq();
    req = await ownerClient(hq);
  });
  after(() => stop(hq));

  test('without a provider a task is blocked with a clear reason (nothing pretends to run)', async () => {
    const fe = await employeeId(hq, 'frontend-developer');
    const { body } = await req('POST', '/hq/v1/tasks', { title: 'Audit the trip page', assignee_id: fe });
    await hq.worker.idle();
    const t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'blocked');
    assert.match(t.task.blocked_reason, /No AI provider is configured/);
    assert.equal(t.deliverables.length, 0);
  });

  test('provider API keys are encrypted at rest and never returned', async () => {
    await addProvider(req);
    const list = (await req('GET', '/hq/v1/providers')).body;
    assert.equal(list[0].api_key, '••••3456');
    const [row] = await hq.db.query<{ api_key_enc: string }>('SELECT api_key_enc FROM hq_providers');
    assert.ok(!row.api_key_enc.includes('sk-ant'));
    assert.match(row.api_key_enc, /^v1:/);
    const bad = await req('POST', '/hq/v1/providers', { kind: 'anthropic', label: 'x', model: 'claude-opus-5-5', api_key: 'sk-ant-xxxxxxxxxxxx', temperature: 0.5 });
    assert.equal(bad.status, 400);
  });

  test('an assigned task runs, produces a deliverable and records usage and cost', async () => {
    const fe = await employeeId(hq, 'frontend-developer');
    const statuses: string[] = [];
    const off = hq.ctx.bus.on((ev) => {
      if (ev.type === 'employee.status' && (ev.employee as { id: string }).id === fe) statuses.push((ev.employee as { status: string }).status);
    });
    const { body } = await req('POST', '/hq/v1/tasks', { title: 'Improve the trip planning interface', description: 'Make the day plan easier to scan', assignee_id: fe });
    await hq.worker.idle();
    off();
    const t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'completed');
    assert.equal(t.deliverables.length, 1);
    assert.equal(t.runs.length, 1);
    assert.equal(t.runs[0].status, 'succeeded');
    assert.equal(Number(t.runs[0].cost_usd).toFixed(3), '0.008');
    assert.deepEqual([statuses[0], statuses.at(-1)], ['working', 'completed']);
    // The role prompt is the system prompt; the task is in the user turn.
    const last = hq.calls.at(-1)!;
    assert.match(last.system, /Frontend Developer/);
    assert.match(last.system, /untrusted/);
    assert.match(promptText(last), /Improve the trip planning interface/);
  });

  test('QA independently reviews: changes requested, then the revision is approved', async () => {
    const be = await employeeId(hq, 'backend-developer');
    const qa = await employeeId(hq, 'qa-engineer');
    let reviews = 0;
    hq.setScript((r) => {
      if (r.tools.some((t) => t.name === 'submit_review')) {
        reviews++;
        return reviews === 1
          ? call('submit_review', { verdict: 'changes_requested', summary: 'Missing input validation', findings: [{ severity: 'major', title: 'No validation', detail: 'The endpoint accepts any body' }] })
          : call('submit_review', { verdict: 'approved', summary: 'Validation added', findings: [] });
      }
      return null;
    });
    const { body } = await req('POST', '/hq/v1/tasks', { title: 'Add a trips export endpoint', assignee_id: be, reviewer_id: qa, acceptance_criteria: 'Validates input' });
    await hq.worker.idle();
    const t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'completed');
    assert.equal(t.deliverables.length, 2);
    assert.deepEqual(t.reviews.map((r: { verdict: string }) => r.verdict).sort(), ['approved', 'changes_requested']);
    // The second execution saw the reviewer's findings.
    const revision = hq.calls.filter((c) => c.tools.some((x) => x.name === 'submit_deliverable')).at(-1)!;
    assert.match(promptText(revision), /Missing input validation/);
    hq.setScript(() => null);
  });

  test('an objective is planned by the Chief of Staff, approved, executed in dependency order and synthesised', async () => {
    hq.setScript((r) => {
      if (r.tools.some((t) => t.name === 'create_plan'))
        return call('create_plan', {
          summary: 'Requirements first, then a UX audit, then the report.',
          deliverables: ['Requirements', 'UX audit'],
          subtasks: [
            { key: 'req', title: 'Write requirements', description: 'Requirements for trip planning UX', assignee: 'business-analyst' },
            { key: 'ux', title: 'UX audit', description: 'Audit the trip planning journey', assignee: 'ux-researcher', reviewer: 'product-designer', depends_on: ['req'] }
          ]
        });
      return null;
    });
    const { body } = await req('POST', '/hq/v1/objectives', { objective: "Analyze Raflo's current user experience and prepare a complete improvement plan." });
    await hq.worker.idle();
    let t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'waiting_approval');
    assert.equal(t.children.length, 0, 'nothing runs before the owner approves');
    const approval = t.approvals.find((a: { kind: string }) => a.kind === 'plan');
    const ap = await req('POST', `/hq/v1/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    await hq.worker.idle();
    t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'completed');
    assert.equal(t.children.length, 3);
    assert.ok(t.children.every((c: { status: string }) => c.status === 'completed'));
    const req1 = t.children.find((c: { title: string }) => c.title === 'Write requirements');
    const ux = t.children.find((c: { title: string }) => c.title === 'UX audit');
    assert.ok(new Date(ux.started_at) >= new Date(req1.completed_at), 'dependent task started after its dependency finished');
    const synthesisCall = hq.calls.filter((c) => promptText(c).includes('Final report')).at(-1)!;
    assert.match(promptText(synthesisCall), /Results from tasks you depend on/);
    hq.setScript(() => null);
  });

  test('a plan with an unknown assignee or a cycle is rejected', async () => {
    const { validatePlan } = await import('../src/orchestrator/tasks');
    const team = [{ slug: 'a' }, { slug: 'b' }];
    const base = { summary: 's', deliverables: ['d'] };
    assert.ok(validatePlan({ ...base, subtasks: [{ key: 'x', title: 'x', description: 'xxxxxxxxxx', acceptance_criteria: '', assignee: 'zz', depends_on: [], priority: 'normal' }] }, team, 8).length);
    assert.ok(
      validatePlan(
        {
          ...base,
          subtasks: [
            { key: 'x', title: 'x', description: 'xxxxxxxxxx', acceptance_criteria: '', assignee: 'a', depends_on: ['y'], priority: 'normal' },
            { key: 'y', title: 'y', description: 'yyyyyyyyyy', acceptance_criteria: '', assignee: 'b', depends_on: ['x'], priority: 'normal' }
          ]
        },
        team,
        8
      ).some((p) => p.includes('cycle'))
    );
  });

  test('an employee can ask the owner for a decision; the answer resumes the task', async () => {
    const fin = await employeeId(hq, 'financial-analyst');
    let n = 0;
    hq.setScript((r) => {
      if (!r.tools.some((t) => t.name === 'submit_deliverable')) return null;
      n++;
      return n === 1
        ? call('submit_deliverable', { summary: 'Need a budget ceiling', content: 'Options: A) 10k B) 20k', outcome: 'needs_owner_decision', question: 'Which budget ceiling: 10k or 20k SAR?' })
        : null;
    });
    const { body } = await req('POST', '/hq/v1/tasks', { title: 'Marketing budget estimate', assignee_id: fin });
    await hq.worker.idle();
    let t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'waiting_approval');
    assert.match(t.task.owner_question, /budget ceiling/);
    await req('POST', `/hq/v1/tasks/${body.id}/answer`, { answer: '20k SAR' });
    await hq.worker.idle();
    t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'completed');
    assert.match(promptText(hq.calls.at(-1)!), /20k SAR/);
    hq.setScript(() => null);
  });

  test('the daily budget stops execution before the model is called', async () => {
    await req('PUT', '/hq/v1/settings/limits', { dailyBudgetUsd: 0 });
    const before = hq.calls.length;
    const pm = await employeeId(hq, 'project-manager');
    const { body } = await req('POST', '/hq/v1/tasks', { title: 'Sprint report', assignee_id: pm });
    await hq.worker.idle();
    const t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'blocked');
    assert.match(t.task.blocked_reason, /Daily AI budget reached/);
    assert.equal(hq.calls.length, before);
    await req('PUT', '/hq/v1/settings/limits', { dailyBudgetUsd: 5 });
  });

  test('a run that never submits a result stops at the step limit', async () => {
    await req('PUT', '/hq/v1/settings/limits', { maxToolIterations: 3, maxAttempts: 1 });
    hq.setScript((r) => (r.tools.some((t) => t.name === 'knowledge_search') ? call('knowledge_search', { query: 'loop forever' }) : null));
    const seo = await employeeId(hq, 'seo-specialist');
    const { body } = await req('POST', '/hq/v1/tasks', { title: 'Keyword research', assignee_id: seo });
    await hq.worker.idle();
    const t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'blocked');
    assert.match(t.task.blocked_reason, /Stopped after 3 steps/);
    hq.setScript(() => null);
    await req('PUT', '/hq/v1/settings/limits', { maxToolIterations: 12, maxAttempts: 2 });
  });

  test('confidential knowledge is not sent to the provider unless allowed', async () => {
    await req('POST', '/hq/v1/knowledge', { title: 'Investor terms', body: 'zebracorn valuation secret terms', confidential: true });
    await req('POST', '/hq/v1/knowledge', { title: 'Brand voice', body: 'zebracorn friendly and warm tone' });
    const cw = await employeeId(hq, 'content-writer');
    await req('POST', '/hq/v1/tasks', { title: 'Write zebracorn landing copy', assignee_id: cw });
    await hq.worker.idle();
    const text = promptText(hq.calls.at(-1)!);
    assert.match(text, /Brand voice/);
    assert.doesNotMatch(text, /Investor terms/);
  });

  test('performance is computed from stored outcomes', async () => {
    const perf = (await req('GET', '/hq/v1/performance')).body as { name: string; completed: number; accepted: number; runs: number }[];
    const be = perf.find((p) => p.name === 'Khalid Al-Shehri')!;
    assert.equal(be.completed, 1);
    assert.equal(be.accepted, 1);
    assert.ok(be.runs >= 2);
  });
});

describe('meetings', () => {
  let hq: Hq;
  let req: Client;
  before(async () => {
    hq = await startHq();
    req = await ownerClient(hq);
    await addProvider(req);
  });
  after(() => stop(hq));

  test('participants contribute in turns, respond to each other and the owner; minutes and action items are recorded', async () => {
    const ids = await Promise.all(['project-manager', 'ux-researcher', 'frontend-developer'].map((s) => employeeId(hq, s)));
    let turns = 0;
    hq.setScript((r) => {
      if (r.tools.some((t) => t.name === 'contribute')) {
        turns++;
        if (turns === 2) return call('contribute', { message: 'I disagree: search is the bigger issue. @project-manager?', stance: 'disagree', addressed_to: ['project-manager'], wants_to_continue: true });
      }
      return null;
    });
    hq.worker.paused = true;
    const { status, body } = await req('POST', '/hq/v1/meetings', {
      room: 'majlis',
      title: 'Q1 product priorities',
      objective: 'Agree on the top product priority',
      agenda: ['Biggest user friction'],
      type: 'product_planning',
      participant_ids: ids
    });
    assert.equal(status, 200);
    const busy = (await req('GET', '/hq/v1/employees')).body.filter((e: { current_meeting_id: string | null }) => e.current_meeting_id === body.id);
    assert.equal(busy.length, 3, JSON.stringify((await req('GET', `/hq/v1/meetings/${body.id}`)).body.events));
    // Let two people speak, then the owner joins in.
    let spoken = 0;
    const off = hq.ctx.bus.on((ev) => {
      if (ev.type === 'meeting.event' && (ev.event as { kind: string }).kind === 'speech' && ++spoken === 2) hq.worker.paused = true;
    });
    hq.worker.paused = false;
    hq.worker.wake();
    while (!hq.worker.paused) await new Promise((r) => setTimeout(r, 5));
    off();
    await new Promise((r) => setTimeout(r, 50));
    await req('POST', `/hq/v1/meetings/${body.id}/messages`, { text: 'Please consider Arabic-first users.' });
    hq.worker.paused = false;
    hq.worker.wake();
    await hq.worker.idle(60_000);
    const m = (await req('GET', `/hq/v1/meetings/${body.id}`)).body;
    assert.equal(m.meeting.status, 'completed');
    const speeches = m.events.filter((e: { kind: string }) => e.kind === 'speech');
    assert.ok(speeches.length >= 4, `a second round happened (got ${speeches.length})`);
    assert.ok(speeches.every((s: { run_id: string }) => s.run_id), 'every contribution comes from a recorded model run');
    assert.ok(m.events.some((e: { kind: string }) => e.kind === 'owner'));
    // Later speakers saw earlier contributions and the owner's message.
    const lastTurn = hq.calls.filter((c) => c.tools.some((t) => t.name === 'contribute')).at(-1)!;
    assert.match(promptText(lastTurn), /I disagree: search is the bigger issue/);
    assert.match(promptText(lastTurn), /Arabic-first users/);
    assert.equal(m.meeting.minutes.decisions[0], 'Prioritise onboarding');
    assert.equal(m.actionItems.length, 1);
    const free = (await req('GET', '/hq/v1/employees')).body.filter((e: { status: string }) => e.status === 'in_meeting');
    assert.equal(free.length, 0);
    const conv = await req('POST', `/hq/v1/meeting-action-items/${m.actionItems[0].id}/task`, {});
    assert.equal(conv.status, 200);
    await hq.worker.idle();
    const task = (await req('GET', `/hq/v1/tasks/${conv.body.taskId}`)).body;
    assert.equal(task.task.status, 'completed', task.task.blocked_reason);
    hq.setScript(() => null);
  });

  test('a direct conversation produces a real reply', async () => {
    const id = await employeeId(hq, 'marketing-manager');
    const [ch] = await hq.db.query<{ id: string }>(`SELECT id FROM hq_channels WHERE kind = 'direct' AND employee_id = $1`, [id]);
    await req('POST', `/hq/v1/channels/${ch.id}/messages`, { body: 'What channels should we try first?' });
    await hq.worker.idle();
    const { messages } = (await req('GET', `/hq/v1/channels/${ch.id}/messages`)).body;
    assert.equal(messages.length, 2);
    assert.equal(messages[1].author_type, 'employee');
    assert.ok(messages[1].run_id);
  });

  test('briefings store facts from the database and the written summary', async () => {
    const r = await req('POST', '/hq/v1/reports', { kind: 'daily_briefing' });
    assert.equal(r.body.written, true);
    const rep = (await req('GET', `/hq/v1/reports/${r.body.id}`)).body;
    assert.equal(rep.facts.meetings.length, 1);
    assert.equal(rep.content.headline, 'Quiet day');
  });
});

describe('GitHub integration and approvals', () => {
  let hq: Hq;
  let req: Client;
  before(async () => {
    hq = await startHq();
    req = await ownerClient(hq);
    await addProvider(req);
  });
  after(() => stop(hq));

  test('connect with a verified token; it is stored encrypted', async () => {
    assert.equal((await req('POST', '/hq/v1/github/token', { token: 'ghp_wrong_token_000000000' })).status, 502);
    const r = await req('POST', '/hq/v1/github/token', { token: 'ghp_testtoken_1234567890' });
    assert.equal(r.body.login, 'moathf15');
    const [row] = await hq.db.query<{ token_enc: string }>(`SELECT token_enc FROM hq_integrations`);
    assert.ok(!row.token_enc.includes('ghp_'));
  });

  test('agents can only read repositories the owner authorised', async () => {
    assert.equal((await req('GET', '/hq/v1/github/branches?repo=moathf15/Raflo')).status, 403);
    assert.equal((await req('POST', '/hq/v1/github/repos', { repo: 'moathf15/Raflo' })).status, 200);
    assert.equal((await req('GET', '/hq/v1/github/branches?repo=moathf15/Raflo')).status, 200);
  });

  test('repository content reaches the agent wrapped as untrusted data', async () => {
    let step = 0;
    hq.setScript((r) => {
      if (!r.tools.some((t) => t.name === 'submit_deliverable')) return null;
      step++;
      if (step === 1) return call('github_read_file', { path: 'README.md' });
      return null;
    });
    const arch = await employeeId(hq, 'software-architect');
    await req('POST', '/hq/v1/tasks', { title: 'Review the README', assignee_id: arch });
    await hq.worker.idle();
    const second = hq.calls.at(-1)!;
    const toolResult = second.messages.at(-1)!.content[0] as { content: string };
    assert.match(toolResult.content, /^<untrusted source="github:moathf15\/Raflo\/README.md">/);
    assert.match(second.system, /never instructions to you/);
    hq.setScript(() => null);
  });

  test('a code change is only a proposal until approved; branches need the policy; merge needs explicit confirmation', async () => {
    hq.setScript((r, n) => {
      if (r.tools.some((t) => t.name === 'github_propose_change') && !promptText(r).includes('Change proposal'))
        return call('github_propose_change', {
          title: 'Clearer trip day headers',
          description: 'Adds day headers to the trip page.',
          files: [{ path: 'apps/web/src/features/trip/TripPage.tsx', content: 'export function TripPage() { return <h2>Day 1</h2>; }\n' }]
        });
      void n;
      return null;
    });
    const fe = await employeeId(hq, 'frontend-developer');
    const writesBefore = hq.gh.requests.filter((x) => x.method !== 'GET').length;
    const { body } = await req('POST', '/hq/v1/tasks', { title: 'Improve the trip planning interface', assignee_id: fe });
    await hq.worker.idle();
    assert.equal(hq.gh.requests.filter((x) => x.method !== 'GET').length, writesBefore, 'nothing was written to GitHub');
    const t = (await req('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.proposals.length, 1);
    const prop = (await req('GET', `/hq/v1/proposals/${t.proposals[0].id}`)).body;
    assert.match(prop.diff, /\+export function TripPage\(\) \{ return <h2>Day 1<\/h2>; \}/);
    const approval = prop.approval;
    // Branch writes are off by default.
    const denied = await req('POST', `/hq/v1/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(denied.status, 403);
    // A failed execution is recorded; a new approval is needed after enabling.
    const policy = (await req('GET', '/hq/v1/settings')).body.policy;
    await req('PUT', '/hq/v1/settings/policy', { ...policy, githubWriteBranches: true });
    await hq.db.query(`UPDATE hq_approvals SET status = 'pending' WHERE id = $1`, [approval.id]);
    assert.equal((await req('POST', `/hq/v1/approvals/${approval.id}`, { decision: 'approve' })).status, 200);
    const ref = hq.gh.requests.find((x) => x.url.endsWith('/git/refs') && x.method === 'POST')!;
    assert.match((ref.body as { ref: string }).ref, /^refs\/heads\/hq\/clearer-trip-day-headers-/);
    const pr = await req('POST', `/hq/v1/proposals/${t.proposals[0].id}/pull-request`, {});
    assert.equal(pr.body.number, 42);
    const merge = await req('POST', `/hq/v1/proposals/${t.proposals[0].id}/merge`, { confirm: 42 });
    assert.equal(merge.status, 403, 'merging is disabled by default');
    hq.setScript(() => null);
  });

  test('HQ never writes the default or a protected branch', async () => {
    const { assertWritableBranch } = await import('../src/github/service');
    await assert.rejects(assertWritableBranch(hq.ctx, { default_branch: 'main' }, 'main'));
    await assert.rejects(assertWritableBranch(hq.ctx, { default_branch: 'develop' }, 'hq/../main'));
    await assert.rejects(assertWritableBranch(hq.ctx, { default_branch: 'develop' }, 'production'));
    await assertWritableBranch(hq.ctx, { default_branch: 'main' }, 'hq/feature-1');
  });

  test('GitHub issues are created only after approval, and issues can be assigned to employees', async () => {
    hq.setScript((r) => {
      if (r.tools.some((t) => t.name === 'github_request_issue') && !promptText(r).includes('Issue request submitted'))
        return call('github_request_issue', { title: 'Session cookie lacks rotation', body: 'Found during review: rotate on login.', labels: ['security'] });
      return null;
    });
    const sec = await employeeId(hq, 'security-engineer');
    await req('POST', '/hq/v1/tasks', { title: 'Security review of auth', assignee_id: sec });
    await hq.worker.idle();
    assert.ok(!hq.gh.requests.some((x) => x.url.endsWith('/issues') && x.method === 'POST'));
    const approvals = (await req('GET', '/hq/v1/approvals')).body;
    const issue = approvals.find((a: { kind: string }) => a.kind === 'github_issue');
    await req('POST', `/hq/v1/approvals/${issue.id}`, { decision: 'approve' });
    assert.ok(hq.gh.requests.some((x) => x.url.endsWith('/issues') && x.method === 'POST'));
    hq.setScript(() => null);

    const fe = await employeeId(hq, 'frontend-developer');
    const a = await req('POST', '/hq/v1/github/issues/assign', { repo: 'moathf15/Raflo', number: 3, assignee_id: fe });
    await hq.worker.idle();
    const t = (await req('GET', `/hq/v1/tasks/${a.body.id}`)).body;
    assert.equal(t.task.github_issue.number, 3);
    assert.match(promptText(hq.calls.at(-1)!), /<untrusted source="github issue">/);
  });

  test('the audit log records owner decisions', async () => {
    const log = (await req('GET', '/hq/v1/audit')).body as { action: string }[];
    for (const a of ['github.connect', 'approval.approve', 'github.pr_opened', 'github.branch_created']) assert.ok(log.some((l) => l.action === a), a);
  });
});

describe('persistence', () => {
  test('company data survives a restart', async () => {
    const dir = tmpDir();
    const hq1 = await startHq({ pgliteDir: dir });
    const req1 = await ownerClient(hq1);
    await addProvider(req1);
    const ba = await employeeId(hq1, 'business-analyst');
    const { body } = await req1('POST', '/hq/v1/tasks', { title: 'User stories for passport', assignee_id: ba });
    await hq1.worker.idle();
    await stop(hq1);

    const hq2 = await startHq({ pgliteDir: dir });
    assert.equal(hq2.setupCode, null);
    const req2 = await ownerClient(hq2);
    const t = (await req2('GET', `/hq/v1/tasks/${body.id}`)).body;
    assert.equal(t.task.status, 'completed');
    assert.equal(t.deliverables.length, 1);
    assert.equal((await req2('GET', '/hq/v1/employees')).body.length, 20);
    await stop(hq2);
  });

  test('an interrupted task resumes after a restart', async () => {
    const dir = tmpDir();
    const hq1 = await startHq({ pgliteDir: dir });
    const req1 = await ownerClient(hq1);
    await addProvider(req1);
    await hq1.worker.stop();
    const dev = await employeeId(hq1, 'devops-engineer');
    const { body } = await req1('POST', '/hq/v1/tasks', { title: 'Backup check', assignee_id: dev });
    // Simulate a crash mid-run: claimed, in progress, lease held.
    await hq1.db.query(`UPDATE hq_tasks SET status = 'in_progress', lease_until = now() + interval '30 minutes' WHERE id = $1`, [body.id]);
    await hq1.db.query(`INSERT INTO hq_runs (kind, task_id, employee_id, status) VALUES ('task', $1, $2, 'running')`, [body.id, dev]);
    await hq1.app.close();
    await hq1.db.close();

    const hq2 = await startHq({ pgliteDir: dir });
    await hq2.worker.idle();
    const [t] = await hq2.db.query<{ status: string }>('SELECT status FROM hq_tasks WHERE id = $1', [body.id]);
    assert.equal(t.status, 'completed');
    const runs = await hq2.db.query<{ status: string; error: string | null }>('SELECT status, error FROM hq_runs WHERE task_id = $1 ORDER BY started_at', [body.id]);
    assert.equal(runs[0].error, 'Interrupted by a restart');
    assert.equal(runs.at(-1)!.status, 'succeeded');
    await stop(hq2);
  });
});
