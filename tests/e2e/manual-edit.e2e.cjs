// Manual scheduling ticket (4 Nov 2026): edits that break a day are refused, another day is offered,
// and the "could not fit" list is rebuilt after every edit. Run by run.sh against the full stack.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const u = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = []; u.on('pageerror', e => errs.push(e.message)); u.on('console', m => m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_FAILED/.test(m.text()) && errs.push(m.text()));
  const ok = (s) => console.log('✓', s);
  await u.goto('http://localhost:4173/');
  await u.getByRole('button', { name: 'خطط رحلتك الأولى' }).click();
  const start = await u.locator('input[type=date]').first().inputValue();
  const next = new Date(new Date(start + 'T00:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
  await u.locator('input[type=date]').nth(1).fill(next);
  await u.locator('input[type=time]').first().fill('19:00');
  await u.getByRole('button', { name: 'التالي' }).click();
  await u.getByRole('button', { name: 'إنشاء الخطة' }).click();
  await u.waitForSelector('.rf-stop');
  const day1 = await u.locator('.rf-stop').count(); ok('plan: day 1 (from 19:00) has ' + day1 + ' stop');

  // 1) Adding a place to the full short day is refused, with another day offered.
  await u.getByRole('button', { name: 'تعديل' }).click();
  await u.getByRole('button', { name: 'إضافة مكان' }).click();
  const pick = u.locator('.rf-sheet .list-row, [role=dialog] .list-row').first();
  const added = (await pick.locator('.t-label').innerText()).trim();
  await pick.click();
  await u.getByRole('alert').waitFor();
  const alertText = (await u.getByRole('alert').innerText()).replace(/\s+/g, ' ');
  if ((await u.locator('.rf-stop').count()) !== day1) throw new Error('the refused place was added anyway');
  ok('refused on the full day: ' + alertText);
  await u.screenshot({ path: '/tmp/e2e_refused.png' });
  await u.getByRole('alert').getByRole('button', { name: /أضفه لليوم 2/ }).click();
  const tab2 = u.getByRole('tab').nth(1);
  if ((await tab2.getAttribute('aria-selected')) !== 'true') throw new Error('did not switch to day 2');
  ok('suggestion applied: moved to day 2 (' + await u.locator('.rf-stop').count() + ' stops)');

  // 2) Removing a wanted place puts it back on the list with the day it fits on; adding it back removes it.
  // Remove a planned (wanted) stop, not the one just added.
  await u.locator('.rf-stop').filter({ hasNotText: added }).first().locator('xpath=..').getByRole('button', { name: 'حذف' }).click();
  await u.getByText(/يتسع في اليوم \d إن أردت/).first().waitFor();
  ok('removed place is listed again: ' + (await u.getByText(/يتسع في اليوم \d إن أردت/).first().innerText()));
  const before = await u.locator('#unscheduled-title').innerText();
  await u.locator('section[aria-labelledby=unscheduled-title]').getByRole('button', { name: /أضفه لليوم/ }).first().click();
  const after = await u.locator('#unscheduled-title').count() ? await u.locator('#unscheduled-title').innerText() : '(list empty)';
  if (after === before) throw new Error('list not rebuilt after adding back');
  ok('added back from the list: "' + before + '" → "' + after + '"');
  await u.screenshot({ path: '/tmp/e2e_list.png', fullPage: true });
  if (errs.length) throw new Error('console errors: ' + JSON.stringify(errs));
  console.log('no console or page errors');
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
