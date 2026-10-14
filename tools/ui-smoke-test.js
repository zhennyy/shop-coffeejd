// Проверка мини-приложения в браузере (Playwright): поднимает магазин на временной базе,
// открывает витрину как покупатель и как владелица с подменённым Telegram WebApp,
// снимает скриншоты всех экранов, проходит основные сценарии и собирает ошибки консоли.
//
//   node tools/ui-smoke-test.js --out /tmp/cb-ui/after                  — снять скриншоты
//   node tools/ui-smoke-test.js --out /tmp/cb-ui/after --compare /tmp/cb-ui/before — и сравнить попиксельно
//
// Нужен Chromium для Playwright (PLAYWRIGHT_BROWSERS_PATH). В основной `npm test` не входит.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const helpers = require('../src/server/test-helpers'); // задаёт BOT_TOKEN, временную базу и порт

const BUYER_ID = 2002;
const SECOND_BUYER_ID = 2003;
const OWNER_ID = helpers.OWNER_ID;
const VIEWPORT = { width: 390, height: 844 };
const DAY_MS = 24 * 3600 * 1000;

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : null;
}
const outputDir = readArgument('--out') || '/tmp/cb-ui/latest';
const compareDir = readArgument('--compare');

// Дата заказа/сообщения «N дней назад» в формате базы — одинаковая при повторных прогонах в тот же день
function daysAgo(days, time) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10) + ' ' + time;
}

// ---------- тестовые данные ----------
async function prepareShop(shop, samplePhotoPng) {
  const actions = helpers.createShopActions(shop);
  const ownerCall = (method, urlPath, body) => shop.call(OWNER_ID, method, urlPath, body);
  const expectOk = (response, what) => { if (response.status !== 200) throw new Error(`${what}: ${response.status} ${JSON.stringify(response.body)}`); return response.body; };

  expectOk(await ownerCall('POST', '/shop-api/admin/stock-import', { sample: 'tea' }), 'пример чая');
  await actions.createProduct({ name: 'Помол под турку', price: '50', stock: '100', is_addon: true, addon_for: '*', category: 'Услуги' });
  expectOk(await ownerCall('POST', '/shop-api/admin/delivery', { otherPrice: '900', freeFrom: '5000', pickup: true, pickupAddress: 'СПб, ул. Рубинштейна, 1 — ежедневно 10:00–20:00' }), 'доставка');
  // геокодер без интернета: точка отправки — (0,0), любой другой адрес ≈ 2 км
  require('../src/delivery').setGeocoder(async (address) => (/Невский проспект, 1$/.test(address) ? { lat: 0, lon: 0 } : { lat: 0.02, lon: 0 }));
  const settings = expectOk(await ownerCall('GET', '/shop-api/admin/settings'), 'настройки');
  expectOk(await ownerCall('POST', '/shop-api/admin/delivery2', {
    postEnabled: true, distanceEnabled: true, originAddress: 'Санкт-Петербург, Невский проспект, 1', tiers: '5 : 200\n15 : 450',
    carriers: settings.delivery2.post.carriers.map((carrier) => ({ id: carrier.id, name: carrier.name, price: String(Math.round(carrier.price / 100) || 350) })),
  }), 'доставка 2');
  expectOk(await ownerCall('POST', '/shop-api/admin/promos', { code: 'COFFEE10', percent: '10', max_uses: '50' }), 'промокод');

  // фото: у первого товара — настоящее, у набора «Дегустация» — битое (проверяем заглушку)
  fs.writeFileSync(path.join(path.dirname(process.env.DB_PATH), 'uploads', 'sample.png'), samplePhotoPng);
  await shop.database.product.update({ where: { id: 1 }, data: { photo_url: '/uploads/sample.png' } });
  await shop.database.product.update({ where: { id: 7 }, data: { photo_url: 'AgACAgIAAxkBAAIBROKEN' } });

  // заказы: у покупателя — доставленный (с оценкой) и неоплаченный; у второго — курьер в сборке и самовывоз оплачен
  expectOk(await actions.buy(BUYER_ID, [[1, 2]]), 'заказ 1');
  await actions.payLastOrder();
  const firstOrder = await shop.database.order.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  await shop.database.order.update({ where: { id: firstOrder.id }, data: { delivery_method: 'pickup', rating: 5 } });
  for (const status of ['assembling', 'shipped', 'delivered']) expectOk(await ownerCall('POST', `/shop-api/admin/orders/${firstOrder.id}/status`, { status }), 'статус ' + status);
  expectOk(await shop.call(BUYER_ID, 'POST', '/shop-api/subscriptions', { order_id: firstOrder.id, days: 30 }), 'подписка');
  expectOk(await actions.buy(BUYER_ID, [[8, 1]]), 'заказ 2');

  await actions.clearCart(SECOND_BUYER_ID);
  await actions.setCart(SECOND_BUYER_ID, [[3, 1], [9, 1]]);
  expectOk(await shop.call(SECOND_BUYER_ID, 'POST', '/shop-api/order', { delivery: 'city', city: 'Санкт-Петербург', address: 'Невский проспект, 10, кв. 5', phone: '+7 900 111-22-33', promo: 'COFFEE10' }), 'заказ 3');
  await actions.payLastOrder();
  const courierOrder = await shop.database.order.findFirst({ where: { chat_id: SECOND_BUYER_ID }, orderBy: { id: 'desc' } });
  expectOk(await ownerCall('POST', `/shop-api/admin/orders/${courierOrder.id}/status`, { status: 'assembling' }), 'сборка');
  expectOk(await actions.buy(SECOND_BUYER_ID, [[5, 1]]), 'заказ 4');
  await actions.payLastOrder();

  await shop.database.message.createMany({ data: [
    { chat_id: SECOND_BUYER_ID, from_owner: 0, text: 'Здравствуйте! А Иргачефф бывает в зёрнах по 1 кг?', is_read: 1, created_at: daysAgo(1, '10:15:00') },
    { chat_id: SECOND_BUYER_ID, from_owner: 1, text: 'Да, есть — уже в каталоге 🙂', is_read: 1, created_at: daysAgo(1, '10:20:00') },
    { chat_id: SECOND_BUYER_ID, from_owner: 0, photo: 'AgACAgIAAxkBAAIBPHOTO', is_read: 0, created_at: daysAgo(0, '08:05:00') },
    { chat_id: SECOND_BUYER_ID, from_owner: 0, text: 'Вот так выглядит пачка, которую я брала', is_read: 0, created_at: daysAgo(0, '08:06:00') },
  ] });
  await normalizeOrders(shop);
}

// Коды и даты заказов случайные/текущие — делаем их одинаковыми, чтобы скриншоты сравнивались
async function normalizeOrders(shop) {
  const allOrders = await shop.database.order.findMany({ orderBy: { id: 'asc' } });
  for (const order of allOrders) {
    await shop.database.order.update({ where: { id: order.id }, data: { order_code: `CJ-${100 + order.id}`, created_at: daysAgo(6 - order.id, `1${order.id}:30:00`) } });
  }
}

// ---------- браузер ----------
function telegramMock({ initData, colorScheme }) {
  // выполняется в странице до её скриптов: подменяем Telegram.WebApp и запоминаем, что с ним делали
  window.__telegramLog = { links: [], confirms: [], closed: false };
  const buttonState = (extra) => ({ isVisible: false, show() { this.isVisible = true; }, hide() { this.isVisible = false; }, onClick(callback) { this.callback = callback; }, ...extra });
  window.Telegram = { WebApp: {
    initData, colorScheme, ready() {}, expand() {}, close() { window.__telegramLog.closed = true; },
    MainButton: buttonState({ text: '', params: {}, setParams(params) { this.params = { ...params }; this.text = params.text; }, showProgress() {}, hideProgress() {} }),
    BackButton: buttonState({}),
    HapticFeedback: { impactOccurred() {} },
    showConfirm(text, callback) { window.__telegramLog.confirms.push(text); callback(true); },
    openLink(url) { window.__telegramLog.links.push(url); },
  } };
}

async function makeSamplePhoto(browser) {
  const page = await browser.newPage({ viewport: { width: 240, height: 240 } });
  await page.setContent('<body style="margin:0"><div style="width:240px;height:240px;background:linear-gradient(135deg,#6b3e1f,#d9a066);display:grid;place-items:center;font:700 80px sans-serif;color:#fff">JD</div></body>');
  const png = await page.screenshot();
  await page.close();
  return png;
}

function createRunner(browser, baseUrl) {
  const report = { screens: [], consoleErrors: [], expectedNetworkErrors: [], checks: [] };
  fs.mkdirSync(outputDir, { recursive: true });

  async function openPage(userId, { colorScheme = 'light', name }) {
    const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    await context.addInitScript(telegramMock, { initData: helpers.initData(userId), colorScheme });
    // настоящий telegram-web-app.js перезаписал бы подмену — отдаём пустой скрипт; внешнюю сеть не трогаем
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => (route.request().url().includes('telegram.org')
      ? route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }) : route.abort()));
    const page = await context.newPage();
    let inFlight = 0;
    page.on('request', () => { inFlight++; });
    page.on('requestfinished', () => { inFlight--; });
    page.on('requestfailed', () => { inFlight--; });
    page.inFlight = () => inFlight;
    page.on('pageerror', (error) => report.consoleErrors.push(`[${name}] pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = `[${name}] ${message.text()} ${message.location().url || ''}`;
      // заранее известные 404: битое фото товара и фото из чата (подставной Telegram их не отдаёт)
      if (/Failed to load resource/.test(message.text()) && /\/shop-photo\/7|\/shop-api\/admin\/photo\//.test(message.location().url || '')) report.expectedNetworkErrors.push(text);
      else report.consoleErrors.push(text);
    });
    await page.goto(baseUrl + '/shop/');
    await page.waitForSelector('#grid .card');
    await settle(page);
    return page;
  }

  async function settle(page, { keepToast = false } = {}) {
    for (let quietChecks = 0, attempts = 0; quietChecks < 3 && attempts < 100; attempts++) {
      await page.waitForTimeout(100);
      quietChecks = page.inFlight() === 0 ? quietChecks + 1 : 0;
    }
    await page.waitForTimeout(300);
    if (!keepToast) await page.waitForFunction(() => !document.getElementById('toast').classList.contains('on'), null, { timeout: 4000 });
  }

  async function snap(page, name, options = {}) {
    await settle(page, options);
    const file = path.join(outputDir, name + '.png');
    // спрятанный тост на длинном скриншоте может попасть в кадр, а в нём случайный код заказа — скрываем его на время съёмки;
    // то же для закрытой шторки: её прокрутка зависит от того, как Playwright докручивал до кнопок
    await page.evaluate(() => {
      const toast = document.getElementById('toast');
      if (!toast.classList.contains('on')) toast.style.visibility = 'hidden';
      if (!document.body.classList.contains('open')) document.getElementById('sheet').style.visibility = 'hidden';
    });
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    await page.evaluate(() => { document.getElementById('toast').style.visibility = ''; document.getElementById('sheet').style.visibility = ''; });
    const telegramState = await page.evaluate(() => {
      const webApp = window.Telegram.WebApp;
      return { mainButton: webApp.MainButton.isVisible ? webApp.MainButton.text : null, backButton: webApp.BackButton.isVisible, toast: document.getElementById('toast').classList.contains('on') ? document.getElementById('toast').textContent : null, sheetScrollTop: document.getElementById('sheet').scrollTop };
    });
    report.screens.push({ name, ...telegramState });
  }

  function check(description, passed, details = '') {
    report.checks.push({ description, passed: Boolean(passed), details });
    if (!passed) console.error('ПРОВАЛ:', description, details);
  }

  return { report, openPage, snap, settle, check };
}

const pressMainButton = (page) => page.evaluate(() => window.Telegram.WebApp.MainButton.callback());
// закрыть шторку тапом по затемнению над ней (у редактора товара крестик был перекрыт фото)
const closeSheetByVeil = (page) => page.locator('#veil').click({ position: { x: 10, y: 10 } });
const tabButton = (page, label) => page.locator('#tabs button', { hasText: label });

async function runBuyerScreens(runner, shop) {
  const { openPage, snap, check } = runner;
  const page = await openPage(BUYER_ID, { name: 'buyer' });
  await snap(page, 'b01-catalog');

  await page.locator('#chips .chip', { hasText: 'Чай' }).click();
  await page.locator('#tools .chip').click();
  await page.selectOption('#tools select', 'asc');
  await snap(page, 'b02-catalog-tea-in-stock-cheap-first');
  await page.selectOption('#tools select', '');
  await page.locator('#tools .chip').click();
  await page.locator('#chips .chip', { hasText: 'Все' }).click();
  await page.fill('#q', 'улун');
  await snap(page, 'b03-search');
  await page.fill('#q', 'нет такого');
  await snap(page, 'b04-search-empty');
  await page.fill('#q', '');

  await page.locator('#grid .card', { hasText: 'Эфиопия' }).click();
  await snap(page, 'b05-sheet-variants');
  await page.locator('#sheet .chip', { hasText: '1 кг' }).click();
  await page.locator('#sheet .act .add').click();
  await snap(page, 'b06-sheet-variant-added');
  await page.locator('#sheet .act .step button', { hasText: '+' }).click();
  await page.locator('#sheet .arow .add').first().click();
  await snap(page, 'b07-sheet-qty-and-addon');
  await page.locator('#sheet .x').click();

  const weightCard = page.locator('#grid .card', { hasText: 'на развес' }).first();
  await weightCard.click();
  await snap(page, 'b08-sheet-weight');
  await page.locator('#sheet .wbox .chip').nth(1).click();
  await snap(page, 'b09-sheet-weight-preset');
  await closeSheetByVeil(page);

  await page.locator('#grid .card', { hasText: 'Набор' }).first().click();
  await snap(page, 'b10-sheet-bundle');
  await page.locator('#sheet .x').click();
  await page.locator('#grid .card', { hasText: 'Колумбия' }).locator('.pick').click();
  await page.locator('#sheet .x').click();
  await page.locator('#grid .card', { hasText: 'Улун Те Гуан Инь' }).locator('.add').click();
  await snap(page, 'b11-catalog-with-cart');

  await tabButton(page, 'Корзина').click();
  await snap(page, 'b12-cart');
  await page.locator('#v-cart .line', { hasText: 'Улун' }).locator('.step button', { hasText: '+' }).click();
  await snap(page, 'b13-cart-plus');

  await pressMainButton(page);
  await snap(page, 'b14-checkout-city');
  await page.selectOption('#coCity', '__other');
  await snap(page, 'b15-checkout-other-city');
  await page.locator('.tile', { hasText: 'Самовывоз' }).click();
  await snap(page, 'b16-checkout-pickup');
  await page.locator('.tile', { hasText: 'СДЭК' }).click();
  await snap(page, 'b17-checkout-post');
  await page.locator('.tile', { hasText: 'по расстоянию' }).click();
  await snap(page, 'b18-checkout-distance');
  await page.locator('.tile', { hasText: 'Курьер' }).click();
  await page.selectOption('#coCity', 'Санкт-Петербург');
  await pressMainButton(page);
  await snap(page, 'b19-checkout-address-error', { keepToast: true });
  await page.fill('#coPromo', 'COFFEE10');
  await page.locator('[class~="btn"]', { hasText: 'Применить' }).click();
  await snap(page, 'b20-checkout-promo');

  // сценарий: самовывоз → оплата → заказ виден в «Мои заказы»
  await page.locator('.tile', { hasText: 'Самовывоз' }).click();
  await page.fill('#coPhone', '+7 900 123-45-67');
  await pressMainButton(page);
  await page.waitForSelector('#v-orders.on .order');
  await runner.settle(page);
  const links = await page.evaluate(() => window.__telegramLog.links);
  check('после оформления открыта ссылка на оплату', links.length === 1 && links[0].startsWith('https://pay.test/'), JSON.stringify(links));
  await normalizeOrders(shop);
  await tabButton(page, 'Каталог').click();
  await tabButton(page, 'Заказы').click();
  await page.waitForSelector('#v-orders .order');
  await snap(page, 'b21-orders-after-checkout');
  const ordersText = await page.locator('#v-orders').innerText();
  check('новый заказ виден в «Мои заказы»', /CJ-105/.test(ordersText) && /Ждёт оплат|ждём оплату/i.test(ordersText), ordersText.slice(0, 200));
  check('корзина пуста после заказа', (await page.locator('#cartCount').innerText()) === '');

  await page.locator('#v-orders button', { hasText: 'Повторять регулярно' }).first().click();
  await snap(page, 'b22-subscription-picker');
  await page.locator('button', { hasText: 'Закрыть' }).last().click();

  await tabButton(page, 'AI-подбор').click();
  await snap(page, 'b23-ai');
  await page.locator('#aiHints .chip').first().click();
  await snap(page, 'b24-ai-result');

  await page.locator('#lang button', { hasText: 'EN' }).click();
  await tabButton(page, 'Catalog').click();
  await snap(page, 'b25-catalog-en');
  await tabButton(page, 'Orders').click();
  await snap(page, 'b26-orders-en');
  await page.locator('#lang button', { hasText: 'RU' }).click();

  await page.locator('#v-orders button', { hasText: 'Повторить заказ' }).first().click();
  await page.waitForSelector('#v-cart.on .line');
  await snap(page, 'b27-cart-after-repeat');
  await page.locator('#v-cart .linkbtn', { hasText: 'Очистить' }).click();
  await snap(page, 'b28-cart-cleared');
  await page.context().close();

  const dark = await openPage(BUYER_ID, { name: 'buyer-dark', colorScheme: 'dark' });
  await snap(dark, 'b29-catalog-dark');
  await dark.locator('#grid .card', { hasText: 'Эфиопия' }).click();
  await snap(dark, 'b30-sheet-dark');
  await dark.context().close();
}

async function runOwnerScreens(runner, shop) {
  const { openPage, snap, check } = runner;
  const page = await openPage(OWNER_ID, { name: 'owner' });
  await snap(page, 'o01-catalog-owner');
  await tabButton(page, 'Админка').click();
  await page.waitForSelector('#admBody .order');
  await snap(page, 'o02-admin-orders');
  await page.locator('#admBody .chip', { hasText: 'Все' }).click();
  await snap(page, 'o03-admin-orders-all');
  await page.locator('#admBody .chip', { hasText: 'В работе' }).click();

  // сценарий: смена статуса заказа (курьер: «Отправить» → трек-номер)
  const courierOrder = page.locator('#admBody .order', { hasText: 'Невский' });
  await courierOrder.locator('.btn', { hasText: 'Отправить' }).click();
  await snap(page, 'o04-track-sheet');
  await page.fill('#trackIn', 'RA123456789RU');
  await page.click('#trackGo');
  await snap(page, 'o05-order-shipped', { keepToast: true });
  const shipped = await shop.database.order.findFirst({ where: { address: { contains: 'Невский' } } });
  check('статус заказа сменился на «отправлен» с трек-номером', shipped.status === 'shipped' && shipped.track === 'RA123456789RU', `${shipped.status} ${shipped.track}`);
  await page.locator('#admBody .order', { hasText: 'Самовывоз' }).first().locator('.btn', { hasText: 'Начать сборку' }).click();
  await snap(page, 'o06-order-assembling');

  await page.locator('.chips.adm .chip', { hasText: 'Статистика' }).click();
  await page.waitForSelector('#admBody .kpis');
  await snap(page, 'o07-stats');
  await page.locator('#admBody .seg button', { hasText: '7 дней' }).click();
  await snap(page, 'o08-stats-7-days');
  await page.locator('#admBody .bars .bar').last().click();
  await snap(page, 'o09-stats-bar-tip', { keepToast: true });

  await page.locator('.chips.adm .chip', { hasText: 'Товары' }).click();
  await page.waitForSelector('#admBody .aline');
  await snap(page, 'o10-products');
  await page.locator('#admBody .aline', { hasText: 'Колумбия' }).first().click();
  await snap(page, 'o11-editor-variant');
  await closeSheetByVeil(page);
  await page.locator('#admBody .btn', { hasText: 'Новый товар' }).click();
  await snap(page, 'o12-editor-new');
  await closeSheetByVeil(page);
  await page.locator('#admBody .aline', { hasText: 'Набор' }).first().click();
  await snap(page, 'o13-editor-bundle');
  await closeSheetByVeil(page);

  // сценарий: правка товара
  await page.locator('#admBody .aline', { hasText: 'Улун Те Гуан Инь' }).click();
  await snap(page, 'o14-editor-existing');
  await page.fill('#pform input[name="name"]', 'Улун Те Гуан Инь, новый урожай');
  await page.fill('#pform input[name="stock"]', '42');
  await page.locator('#pform .btn', { hasText: 'Сохранить' }).click();
  await snap(page, 'o15-products-after-edit', { keepToast: true });
  const edited = await shop.database.product.findFirst({ where: { name: { startsWith: 'Улун Те Гуан Инь' } } });
  check('товар изменён', edited.name === 'Улун Те Гуан Инь, новый урожай' && edited.stock === 42, `${edited.name} ${edited.stock}`);

  await page.locator('.chips.adm .chip', { hasText: 'Чаты' }).click();
  await page.waitForSelector('#admBody .aline');
  await snap(page, 'o16-chats');
  await page.locator('#admBody .aline').first().click();
  await page.waitForSelector('#msgs');
  await snap(page, 'o17-chat');
  await page.fill('#reply', 'Спасибо! Отложила для вас пачку 🙂');
  await page.click('#sendReply');
  await page.waitForFunction(() => document.querySelectorAll('#msgs .msg.me').length === 2);
  await page.locator('#admBody .mini', { hasText: 'Чаты' }).click();
  await page.waitForSelector('#admBody .aline');

  await page.locator('.chips.adm .chip', { hasText: 'Настройки' }).click();
  await page.waitForSelector('#admBody .box');
  await snap(page, 'o18-settings');
  await page.fill('#pcode', 'AUTUMN15');
  await page.fill('#ppct', '15');
  await page.locator('#admBody .btn', { hasText: 'Создать промокод' }).click();
  await snap(page, 'o19-settings-promo-added', { keepToast: true });
  await page.context().close();
}

async function compareScreens(browser) {
  const results = [];
  const page = await browser.newPage();
  for (const file of fs.readdirSync(outputDir).filter((name) => name.endsWith('.png')).sort()) {
    const beforeFile = path.join(compareDir, file);
    if (!fs.existsSync(beforeFile)) { results.push({ file, status: 'нет пары' }); continue; }
    const after = fs.readFileSync(path.join(outputDir, file));
    const before = fs.readFileSync(beforeFile);
    if (after.equals(before)) { results.push({ file, status: 'совпадает' }); continue; }
    // байты разные — считаем отличающиеся пиксели в canvas
    const differentPixels = await page.evaluate(async ([beforeBase64, afterBase64]) => {
      const load = (base64) => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.src = 'data:image/png;base64,' + base64; });
      const [beforeImage, afterImage] = await Promise.all([load(beforeBase64), load(afterBase64)]);
      if (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height) return `размер ${beforeImage.width}×${beforeImage.height} → ${afterImage.width}×${afterImage.height}`;
      const pixels = (image) => { const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data; };
      const beforePixels = pixels(beforeImage), afterPixels = pixels(afterImage);
      // разница цвета в 1–2 единицы — шум растеризации Chromium (бывает и между двумя прогонами без изменений)
      const NOISE_LEVEL = 2;
      let count = 0;
      for (let offset = 0; offset < beforePixels.length; offset += 4) {
        const channelDifference = Math.max(...[0, 1, 2].map((channel) => Math.abs(beforePixels[offset + channel] - afterPixels[offset + channel])));
        if (channelDifference > NOISE_LEVEL) count++;
      }
      return count;
    }, [before.toString('base64'), after.toString('base64')]);
    // несколько пикселей на краях теней и размытия иногда отличаются и между двумя прогонами одной версии
    const MAX_NOISE_PIXELS = 16;
    if (typeof differentPixels === 'number' && differentPixels <= MAX_NOISE_PIXELS) results.push({ file, status: 'совпадает', noisePixels: differentPixels });
    else results.push({ file, status: `отличается: ${differentPixels}${typeof differentPixels === 'number' ? ' пикс.' : ''}` });
  }
  await page.close();
  const beforeState = JSON.parse(fs.readFileSync(path.join(compareDir, 'report.json'), 'utf8')).screens;
  const afterState = JSON.parse(fs.readFileSync(path.join(outputDir, 'report.json'), 'utf8')).screens;
  for (const screen of afterState) {
    const pair = beforeState.find((item) => item.name === screen.name);
    if (pair && JSON.stringify(pair) !== JSON.stringify(screen)) results.push({ file: screen.name, status: `Telegram-кнопки/тост: ${JSON.stringify(pair)} → ${JSON.stringify(screen)}` });
  }
  return results;
}

async function main() {
  const browser = await chromium.launch();
  const samplePhoto = await makeSamplePhoto(browser);
  const shop = await helpers.start();
  await prepareShop(shop, samplePhoto);
  const runner = createRunner(browser, shop.base);
  try {
    await runBuyerScreens(runner, shop);
    await runOwnerScreens(runner, shop);
  } catch (error) {
    runner.report.consoleErrors.push('сценарий прерван: ' + error.message);
    console.error(error);
  }
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(runner.report, null, 2));
  const { report } = runner;
  console.log(`Экранов: ${report.screens.length} → ${outputDir}`);
  console.log(`Проверки: ${report.checks.filter((item) => item.passed).length}/${report.checks.length} пройдено`);
  console.log(`Ошибки консоли: ${report.consoleErrors.length}`, report.consoleErrors);
  console.log(`Ожидаемые 404 (битые фото): ${report.expectedNetworkErrors.length}`);
  let failed = report.consoleErrors.length > 0 || report.checks.some((item) => !item.passed);
  if (compareDir) {
    const results = await compareScreens(browser);
    const mismatches = results.filter((item) => item.status !== 'совпадает');
    const noisy = results.filter((item) => item.noisePixels);
    console.log(`Сравнение с ${compareDir}: совпало ${results.length - mismatches.length} из ${results.length}`
      + (noisy.length ? ` (из них ${noisy.length} с шумом сглаживания: ${noisy.map((item) => `${item.file} ${item.noisePixels} пикс.`).join(', ')})` : ''));
    mismatches.forEach((item) => console.log('  ✗', item.file, item.status));
    failed = failed || mismatches.length > 0;
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
