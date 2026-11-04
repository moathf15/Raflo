const { chromium } = require('playwright');
const WEB = 'http://localhost:4173/', ADMIN = 'http://localhost:4174/';
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const watch = (p, tag) => { p.on('pageerror', e => errs.push(`${tag} pageerror: ${e.message}`)); p.on('console', m => m.type() === 'error' && !/fonts\.g|ERR_TUNNEL/.test(m.text()) && errs.push(`${tag} console: ${m.text()}`)); };
  const step = (s) => console.log('✓', s);
  const u = await b.newPage({ viewport: { width: 390, height: 844 } }); watch(u, 'web');
  const shot = (p, n) => p.screenshot({ path: `/tmp/e2e_${n}.png` });

  await u.goto(WEB);
  await u.getByRole('button', { name: 'خطط رحلتك الأولى' }).click(); step('guest sees first-visit home');
  await u.getByRole('button', { name: 'التالي' }).click();
  await u.getByRole('button', { name: 'إنشاء الخطة' }).click();
  await u.waitForURL(/#\/trips\/draft/); await u.waitForSelector('.rf-stop'); step('guest built a plan via API');
  await shot(u, '1plan');
  // Review 4 Nov: a multi-day trip uses every day, instead of filling the first one or two.
  const tabs = u.getByRole('tab');
  const perDay = [];
  for (let i = 0; i < await tabs.count(); i++) { await tabs.nth(i).click(); perDay.push(await u.locator('.rf-stop').count()); }
  if (perDay.length !== 3 || perDay.some((n) => n === 0)) throw new Error('days not spread: ' + perDay.join('/'));
  step('3-day plan spread over every day: ' + perDay.join(' / '));
  await tabs.first().click();
  await u.getByRole('button', { name: 'حفظ الرحلة' }).click();
  await u.getByLabel('البريد الإلكتروني').fill('sara@example.com');
  await u.getByRole('button', { name: 'أرسل الرمز' }).click();
  const dev = await u.getByTestId('dev-code').textContent(); const code = dev.match(/\d{6}/)[0];
  await shot(u, '2code');
  await u.getByLabel('رمز الدخول').fill(code);
  await u.getByRole('button', { name: 'تأكيد' }).click();
  await u.waitForURL(/#\/trips\/[0-9a-f-]{36}/, { timeout: 8000 }); step('signed in with code, trip saved on server');
  const jsCookies = await u.evaluate(() => document.cookie);
  if (jsCookies.includes('riflo_session')) throw new Error('session cookie is readable by page scripts');
  step('session cookie is HttpOnly (not visible to page scripts)');
  await u.waitForSelector('.rf-stop');
  await u.locator('.rf-stop').first().click();
  await u.getByRole('radio', { name: '5 / 5' }).click();
  await u.getByRole('button', { name: 'ختم الزيارة في جوازي' }).click();
  await u.getByText('زرت هذا المكان').waitFor(); step('visit logged → stamp');
  await shot(u, '3stamp');
  await u.keyboard.press('Escape');
  await u.getByRole('link', { name: 'جوازي' }).click().catch(async () => { await u.goto(WEB + '#/passport'); });
  await u.goto(WEB + '#/passport'); await u.waitForSelector('.rf-stamp');
  const stats = await u.locator('.stats .t-num').allTextContents(); step('passport stats ' + stats.join('/'));
  if (stats.join('/') !== '1/1/3') throw new Error('unexpected stats ' + stats);
  await shot(u, '4passport');

  const a = await b.newPage({ viewport: { width: 1440, height: 900 } }); watch(a, 'admin');
  await a.goto(ADMIN);
  await a.getByLabel('البريد الإلكتروني').fill('admin@riflo.local');
  await a.getByRole('button', { name: 'أرسل الرمز' }).click();
  const acode = (await a.getByTestId('dev-code').textContent()).match(/\d{6}/)[0];
  await a.getByLabel('رمز الدخول').fill(acode);
  await a.getByRole('button', { name: 'دخول' }).click();
  await a.getByRole('heading', { name: 'نظرة عامة' }).waitFor();
  await a.waitForSelector('.kpi__value');
  const kpis = await a.locator('.kpi__value').allTextContents(); step('admin KPIs ' + kpis.join(' | '));
  // registered, active, trips saved, planning completion (same session), 90-day return (no eligible users yet)
  if (kpis.join('|') !== '1|1|1|100%|—') throw new Error('KPIs not as defined: ' + kpis);
  await shot(a, '5overview');
  await a.goto(ADMIN + '#/content'); await a.waitForSelector('.item');
  const card = a.locator('.item', { hasText: 'متحف دار المدينة' });
  await card.getByRole('button', { name: 'إكمال' }).click();
  await a.getByRole('button', { name: 'حفظ ونشر' }).click();
  await a.getByText('لا يمكن النشر قبل إضافة').first().waitFor(); step('publishing an incomplete place is refused with the missing fields');
  await a.locator('label:has-text("يفتح") input').fill('09:00');
  await a.locator('label:has-text("يغلق") input').fill('17:00');
  await a.locator('label:has-text("التكلفة للشخص") input').fill('20');
  await a.getByRole('button', { name: 'حفظ ونشر' }).click();
  await a.locator('section[aria-label="منشور"] .item', { hasText: 'متحف دار المدينة' }).waitFor(); step('editor completed and published a draft');
  await shot(a, '6board');

  await u.goto(WEB + '#/explore'); await u.waitForSelector('.list-row');
  await u.getByText('متحف دار المدينة').first().waitFor(); step('user now sees the newly published place');
  await shot(u, '7explore');
  await u.goto(WEB + '#/plan/new'); await u.getByRole('button', { name: 'التالي' }).click();
  await u.getByText('من جوازك').waitFor(); step('next trip pre-filled from passport');
  await shot(u, '8prefill');

  const p2 = await b.newPage(); watch(p2, 'web2');
  await p2.goto(WEB + '#/passport'); await p2.getByText('جوازك ينتظرك').waitFor(); step('a new guest browser sees the sign-in prompt, not someone else\'s data');
  await b.close();
  if (errs.length) { console.error('CONSOLE ERRORS', JSON.stringify(errs)); process.exit(1); }
  console.log('no console or page errors');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
