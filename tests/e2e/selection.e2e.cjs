// Source-of-truth ticket (4 Nov 2026), in a real browser against the full stack:
// a place outside the interests, added to a day and then removed from it, stays known to the server
// (it is listed again after a reload), and leaves the trip only through "remove from trip".
const { chromium } = require('playwright');
const WEB = 'http://localhost:4173/';
(async () => {
  const b = await chromium.launch(); const u = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; u.on('pageerror', e => errs.push(e.message)); u.on('console', m => m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_FAILED/.test(m.text()) && errs.push(m.text()));
  const ok = (s) => console.log('✓', s);
  const list = () => u.locator('section[aria-labelledby=unscheduled-title]');

  await u.goto(WEB);
  await u.getByRole('button', { name: 'خطط رحلتك الأولى' }).click();
  await u.getByRole('button', { name: 'التالي' }).click();
  await u.getByRole('button', { name: 'إنشاء الخطة' }).click();
  await u.waitForSelector('.rf-stop');
  await u.getByRole('button', { name: 'حفظ الرحلة' }).click();
  await u.getByLabel('البريد الإلكتروني').fill('selection@example.com');
  await u.getByRole('button', { name: 'أرسل الرمز' }).click();
  const code = (await u.getByTestId('dev-code').textContent()).match(/\d{6}/)[0];
  await u.getByLabel('رمز الدخول').fill(code);
  await u.getByRole('button', { name: 'تأكيد' }).click();
  await u.waitForURL(/#\/trips\/[0-9a-f-]{36}/); const url = u.url(); ok('trip saved');

  // 1–2. Add a place outside the trip's interests (a museum) to day 1, save.
  await u.getByRole('button', { name: 'تعديل' }).click();
  await u.getByRole('button', { name: 'إضافة مكان' }).click();
  const museum = u.locator('[role=dialog] .list-row, .rf-sheet .list-row').filter({ hasText: 'متاحف' }).first();
  const name = (await museum.locator('.t-label').innerText()).trim();
  await museum.click();
  if (await u.getByRole('alert').count()) throw new Error('could not add: ' + await u.getByRole('alert').innerText());
  await u.getByRole('button', { name: /حفظ/ }).last().click(); await u.waitForTimeout(800);
  ok(`added "${name}" (not an interest) to day 1 and saved`);

  // 3. Remove it from the day, save. (The client keeps no list of its own after a reload.)
  await u.reload(); await u.waitForSelector('.rf-stop');
  await u.getByRole('button', { name: 'تعديل' }).click();
  await u.locator('.rf-stop').filter({ hasText: name }).locator('xpath=..').getByRole('button', { name: 'حذف' }).click();
  await u.getByRole('button', { name: /حفظ/ }).last().click(); await u.waitForTimeout(800);
  ok('removed it from its day and saved');

  // 5. Reload: the server still knows it and lists it with a day it fits on.
  await u.goto('about:blank'); await u.goto(url); await u.waitForSelector('.rf-stop');
  const row = list().locator('.list-row').filter({ hasText: name });
  await row.waitFor();
  ok('after reload it is still listed by the server: ' + (await row.innerText()).replace(/\s+/g, ' '));

  // Explicit removal: gone, and stays gone after reload.
  await row.getByRole('button', { name: 'إزالة من الرحلة' }).click();
  await u.getByText('أُزيل المكان من رحلتك').waitFor();
  await u.goto('about:blank'); await u.goto(url); await u.waitForSelector('.rf-stop');
  if (await list().locator('.list-row').filter({ hasText: name }).count()) throw new Error('came back after explicit removal');
  ok('"remove from trip" takes it out for good');
  await b.close();
  if (errs.length) throw new Error('console errors: ' + JSON.stringify(errs));
  console.log('no console or page errors');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
