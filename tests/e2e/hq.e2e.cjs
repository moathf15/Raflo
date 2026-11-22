// Raflo AI HQ in a real browser: owner setup, provider, GitHub, office, task execution, code-change approval,
// a multi-agent meeting, dashboard and Arabic RTL. Runs against apps/hq-api/test/e2e-server.ts (scripted provider).
const { chromium } = require('playwright');
const BASE = process.env.HQ_E2E_URL ?? 'http://localhost:8099';
const SHOTS = process.env.HQ_E2E_SHOTS ?? '/tmp';

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  // HTTP errors are checked by URL: only the deliberate refusal below is expected.
  const expected = [/\/hq\/v1\/approvals\/[0-9a-f-]+$/];
  p.on('response', (r) => r.status() >= 400 && r.url().includes('/hq/v1/') && !expected.some((x) => x.test(r.url())) && errs.push(`HTTP ${r.status()} ${r.url()}`));
  p.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::|Failed to load resource/.test(m.text()) && errs.push(`console: ${m.text()}`));
  const step = (s) => console.log('✓', s);
  const nav = (n) => p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: n });
  const shot = (n) => p.screenshot({ path: `${SHOTS}/hq_${n}.png` });

  await p.goto(BASE);
  await p.getByLabel('Name').fill('Moath');
  await p.getByLabel('Setup code').fill('e2e-setup-code');
  await p.getByLabel('Email').fill('owner@raflo.test');
  await p.getByLabel('Password').fill('correct horse battery staple');
  await p.getByRole('button', { name: 'Create owner' }).click();
  await p.waitForSelector('svg.office g.person');
  const people = await p.locator('g.person').count();
  if (people !== 20) throw new Error(`expected 20 employees on the map, got ${people}`);
  step('owner created; office shows 20 employees');
  await p.getByText('Before your employees can work').waitFor();
  await shot('1_office_setup');

  // Provider
  await nav('Settings').click();
  await p.getByRole('button', { name: 'Add provider' }).click();
  await p.getByLabel('API key').fill('sk-ant-e2e-key-0000000000');
  await p.getByRole('button', { name: 'Save' }).click();
  await p.getByText('••••0000').waitFor();
  step('provider added; key masked');

  // GitHub
  await nav('GitHub').click();
  await p.getByLabel('Fine-grained personal access token').fill('ghp_testtoken_1234567890');
  await p.getByRole('button', { name: 'Verify and connect' }).click();
  await p.getByText('Connected as moathf15').waitFor();
  await p.getByRole('button', { name: 'Authorise repository' }).click();
  await p.locator('code', { hasText: 'moathf15/Raflo' }).first().waitFor();
  step('GitHub connected and repository authorised');

  // Office → profile → assign
  await nav('Office').click();
  await p.locator('g.person[aria-label^="Omar Haddad"]').click();
  await p.getByRole('dialog', { name: 'Omar Haddad' }).waitFor();
  await shot('2_profile');
  await p.getByRole('button', { name: 'Assign task' }).click();
  await p.getByLabel('Title').fill('Improve the trip planning interface');
  await p.getByLabel('Description').fill('Make each day of the trip plan easier to scan.');
  await p.getByRole('dialog', { name: 'Assign task' }).getByRole('button', { name: 'Start' }).click();
  await p.getByRole('dialog', { name: 'Assign task' }).waitFor({ state: 'detached' });
  await p.getByRole('dialog', { name: 'Omar Haddad' }).getByRole('button', { name: 'Close' }).first().click();
  // The avatar's state follows the backend: thinking/reading/writing while the run is in progress.
  const omar = p.locator('g.person[aria-label^="Omar Haddad"]');
  await p.waitForFunction(() => /(Thinking|Working|Reading|Writing)/.test(document.querySelector('g.person[aria-label^="Omar Haddad"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 15000 });
  step(`avatar shows live state: ${(await omar.getAttribute('aria-label')).split(':')[1].split('—')[0].trim()}`);
  await shot('3_office_working');
  await p.waitForFunction(() => /Completed a task/.test(document.querySelector('g.person[aria-label^="Omar Haddad"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 30000 });
  step('task completed (status from backend)');

  // Task detail + approval of code change with diff
  await nav('Tasks').click();
  await p.getByRole('link', { name: 'Improve the trip planning interface' }).first().click();
  await p.getByText('Did the work as asked.').waitFor();
  await p.getByText('Clearer trip day headers').waitFor();
  step('deliverable and code-change proposal visible on the task');
  await shot('4_task');
  await nav(/^Approvals/).click();
  await p.getByRole('button', { name: 'Review the diff' }).click();
  await p.locator('.diff .add', { hasText: 'Day 1' }).waitFor();
  step('diff preview shows the proposed change');
  await shot('5_diff');
  await p.getByRole('button', { name: /Approve and commit/ }).click();
  await p.getByText(/Enable "Create hq\/\* branches"/).waitFor();
  step('branch creation refused until enabled in permissions');
  await p.keyboard.press('Escape');

  // Meeting
  await nav('Meetings').click();
  await p.getByRole('button', { name: 'New meeting' }).click();
  await p.getByLabel('Title').fill('Q1 product priorities');
  await p.getByLabel('Objective').fill('Agree on the top product priority for Q1');
  await p.getByLabel('Agenda').fill('Biggest user friction');
  for (const name of ['Faisal Al-Qahtani', 'Yousef Al-Amri', 'Omar Haddad']) await p.locator('label.invite', { hasText: name }).click();
  await p.getByRole('button', { name: 'Start meeting' }).click();
  await p.waitForURL(/\/meetings\/[0-9a-f-]{36}$/);
  await p.locator('.transcript .line').first().waitFor({ timeout: 20000 });
  step('meeting started; first contribution in the transcript');
  await p.getByLabel('Your message').fill('Please keep Arabic-first users in mind.');
  await p.getByRole('button', { name: 'Send' }).click();
  await p.locator('.transcript .line.owner').waitFor();
  await shot('6_meeting_live');
  await p.getByRole('heading', { name: 'Minutes' }).waitFor({ timeout: 60000 });
  await p.getByRole('button', { name: 'Create task' }).first().click();
  await p.getByRole('link', { name: 'Open task →' }).waitFor();
  step('minutes recorded; action item turned into a task');
  await shot('7_meeting_minutes');

  // Dashboard
  await nav('Dashboard').click();
  await p.getByText('AI runs').waitFor();
  const runs = Number(await p.locator('.stat', { hasText: 'AI runs' }).locator('.stat-value').textContent());
  if (!(runs > 3)) throw new Error(`dashboard runs ${runs}`);
  step(`dashboard shows ${runs} recorded AI runs`);
  await shot('8_dashboard');

  // Arabic RTL
  await p.getByRole('button', { name: 'Language' }).click();
  if ((await p.getAttribute('html', 'dir')) !== 'rtl') throw new Error('not RTL');
  await nav('المكتب').click();
  await p.waitForSelector('svg.office');
  await shot('9_office_ar');
  step('Arabic: dir=rtl and translated navigation');

  // Keyboard: focus the map and an employee, open with Enter.
  await p.getByRole('button', { name: 'Language' }).click();
  await p.locator('g.person[aria-label^="Noura"]').focus();
  await p.keyboard.press('Enter');
  await p.getByRole('dialog', { name: 'Noura Al-Harbi' }).waitFor();
  step('keyboard: Enter on a focused employee opens the profile');

  // Mobile layout
  await p.setViewportSize({ width: 390, height: 844 });
  await p.reload();
  await p.waitForSelector('svg.office');
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error('horizontal overflow at phone width');
  await shot('10_mobile');
  step('phone width: no horizontal scroll');

  if (errs.length) throw new Error(errs.join('\n'));
  step('no console errors');
  await b.close();
})().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
