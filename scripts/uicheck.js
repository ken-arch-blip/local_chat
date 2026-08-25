const { chromium } = require('playwright');
const BASE = 'http://localhost:3016';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];

  async function page(ctx, label) {
    const p = await ctx.newPage();
    p.on('console', m => { if (m.type() === 'error') errors.push(label + ': ' + m.text()); });
    p.on('pageerror', e => errors.push(label + ' PAGEERROR: ' + e.message));
    return p;
  }

  /* ---- landing page ---- */
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const landing = await page(ctx1, 'landing');
  await landing.goto(BASE, { waitUntil: 'networkidle' });
  await landing.waitForTimeout(800);

  const hasLoco = await landing.evaluate(() => document.documentElement.classList.contains('has-scroll-smooth'));
  console.log('landing: locomotive active =', hasLoco);
  console.log('landing: h1 =', JSON.stringify(await landing.locator('h1').first().innerText()));
  await landing.screenshot({ path: '/tmp/shot-landing-top.png' });

  // Drive Locomotive's own API — raw wheel events fight the smooth-scroll layer.
  await landing.evaluate(() => window.huddleScroll.scrollTo('#what', { duration: 300 }));
  await landing.waitForTimeout(1800);
  const revealed = await landing.locator('.card.is-revealed').count();
  console.log('landing: revealed cards =', revealed, 'of', await landing.locator('.card').count());
  await landing.screenshot({ path: '/tmp/shot-landing-features.png' });

  await landing.evaluate(() => window.huddleScroll.scrollTo('#showcase-section', { offset: 300, duration: 300 }));
  await landing.waitForTimeout(2000);
  const activeStep = await landing.locator('.step.is-active').count();
  const mockMsgs = await landing.locator('.mock-msg').count();
  console.log('landing: active step =', activeStep, '| mock messages =', mockMsgs);
  await landing.screenshot({ path: '/tmp/shot-landing-showcase.png' });

  /* ---- app: two users in one channel ---- */
  const stamp = Date.now().toString(36);
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const A = await page(ctxA, 'appA');
  const B = await page(ctxB, 'appB');

  async function signUp(p, user, name) {
    await p.goto(BASE + '/app.html#register', { waitUntil: 'networkidle' });
    await p.fill('#f-username', user);
    await p.fill('#f-display', name);
    await p.fill('#f-password', 'hunter22');
    await p.click('#auth-submit');
    await p.waitForSelector('#app:not([hidden])', { timeout: 8000 });
  }

  await signUp(A, 'ui' + stamp, 'Ada Lovelace');
  console.log('app: A signed in, rail present =', await A.locator('#rail').isVisible());
  await A.screenshot({ path: '/tmp/shot-app-empty.png' });

  // Create a server
  await A.click('#rail-add');
  await A.waitForSelector('.modal');
  await A.fill('#m-name', 'UI Test Crew');
  await A.click('[data-x="ok"]');
  await A.waitForSelector('.modal', { state: 'hidden', timeout: 8000 });
  await A.waitForTimeout(500);
  console.log('app: sidebar title =', JSON.stringify(await A.locator('#sidebar-title').innerText()));
  console.log('app: channels rendered =', await A.locator('.channel').count());

  // Grab invite code
  await A.click('#server-menu-btn');
  await A.waitForSelector('#inv');
  const invite = await A.inputValue('#inv');
  await A.click('[data-x="cancel"]');
  console.log('app: invite code =', invite);

  // B joins
  await signUp(B, 'ui2' + stamp, 'Grace Hopper');
  await B.click('#rail-add');
  await B.waitForSelector('.modal');
  await B.click('[data-t="join"]');
  await B.fill('#m-code', invite);
  await B.click('[data-x="ok"]');
  await B.waitForSelector('.modal', { state: 'hidden', timeout: 8000 });
  await B.waitForTimeout(700);
  console.log('app: B joined, members visible =', await B.locator('.member').count());
  await A.waitForTimeout(600);
  console.log('app: A sees B as online =', await A.locator('.member.online').count() === 2,
              '| offline =', await A.locator('.member.offline').count());

  // A sends, B receives live
  await A.waitForTimeout(500);
  await A.fill('#msg-input', 'first message from Ada');
  await A.press('#msg-input', 'Enter');
  await A.waitForTimeout(300);
  await A.fill('#msg-input', 'and a follow-up, same author');
  await A.press('#msg-input', 'Enter');
  await B.waitForSelector('text=first message from Ada', { timeout: 6000 });
  console.log('app: live message delivery = OK');

  // B replies + reacts
  await B.fill('#msg-input', 'hi Ada — check `this code` and https://example.com');
  await B.press('#msg-input', 'Enter');
  await A.waitForSelector('text=hi Ada', { timeout: 6000 });
  console.log('app: code rendered =', await A.locator('.msg .text code').count() > 0);
  console.log('app: link rendered =', await A.locator('.msg .text a').count() > 0);

  const target = A.locator('.msg').filter({ hasText: 'hi Ada' }).first();
  await target.hover();
  await target.locator('[data-act="react"]').first().click();
  await A.waitForSelector('#ctx-menu:not([hidden])');
  await A.locator('#ctx-menu button').first().click();
  await B.waitForSelector('.reaction', { timeout: 6000 });
  console.log('app: reaction synced =', await B.locator('.reaction:not(.add)').count());

  // A replies to B's message
  await target.hover();
  await target.locator('[data-act="reply"]').click();
  await A.fill('#msg-input', 'replying to you');
  await A.press('#msg-input', 'Enter');
  await B.waitForSelector('.reply-ref', { timeout: 6000 });
  console.log('app: reply reference rendered = OK');

  // Typing indicator
  await B.waitForTimeout(400);
  await B.click('#msg-input');
  await B.type('#msg-input', 'typing something', { delay: 30 });
  await A.waitForTimeout(1200);
  const typingText = await A.locator('#typing-text').innerText();
  console.log('app: typing indicator =', JSON.stringify(typingText));

  // Edit own message
  await B.fill('#msg-input', '');
  const own = A.locator('.msg').filter({ hasText: 'first message from Ada' }).first();
  await own.hover();
  await own.locator('[data-act="edit"]').click();
  await A.fill('.edit-box textarea', 'first message from Ada (edited)');
  await A.press('.edit-box textarea', 'Enter');
  await B.waitForSelector('text=(edited)', { timeout: 6000 });
  console.log('app: edit synced = OK');
  await A.waitForTimeout(400);
  console.log('app: edit box closed after save =', await A.locator('.edit-box').count() === 0);

  await A.screenshot({ path: '/tmp/shot-app-chat.png' });
  await B.screenshot({ path: '/tmp/shot-app-chat-b.png' });

  // Day separator + grouping
  console.log('app: day separators =', await A.locator('.day-sep').count());
  console.log('app: grouped messages =', await A.locator('.msg.grouped').count());

  // DMs
  await A.click('#rail-dms');
  await A.waitForTimeout(400);
  await A.click('.group-label button');
  await A.waitForSelector('#d-user');
  await A.fill('#d-user', 'ui2' + stamp);
  await A.waitForTimeout(500);
  await A.click('[data-x="ok"]');
  await A.waitForTimeout(900);
  console.log('app: DM header =', JSON.stringify(await A.locator('#header-title').innerText()));
  await A.fill('#msg-input', 'private note');
  await A.press('#msg-input', 'Enter');
  await A.waitForTimeout(600);
  await A.screenshot({ path: '/tmp/shot-app-dm.png' });

  // B should show an unread badge for the DM
  await B.waitForTimeout(700);
  const badge = await B.locator('#rail-dms .badge').count();
  console.log('app: B unread DM badge =', badge);

  // Settings modal
  await A.click('#btn-settings');
  await A.waitForSelector('.color-row');
  await A.screenshot({ path: '/tmp/shot-app-settings.png' });
  await A.click('[data-x="cancel"]');

  // Mobile layout
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const M = await page(ctxM, 'mobile');
  await M.goto(BASE + '/app.html', { waitUntil: 'networkidle' });
  await M.waitForTimeout(600);
  await M.screenshot({ path: '/tmp/shot-mobile-auth.png' });

  const ML = await page(ctxM, 'mobileLanding');
  await ML.goto(BASE, { waitUntil: 'networkidle' });
  await ML.waitForTimeout(900);
  await ML.screenshot({ path: '/tmp/shot-mobile-landing.png' });

  await browser.close();

  console.log('\n--- console errors ---');
  if (!errors.length) console.log('none');
  else errors.forEach(e => console.log(' !', e));
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
