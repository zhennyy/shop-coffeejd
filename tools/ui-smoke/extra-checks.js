const { BUYER_ID, OWNER_ID } = require('./test-data');
const { closeSheetByVeil, tabButton, VIEWPORT } = require('./browser');

// Действия без скриншотов: проверяем, что кнопки работают и не сыплют ошибками (и найденные баги не вернулись)
async function runExtraChecks(runner, shop) {
  const { openPage, check, settle } = runner;
  const buyer = await openPage(BUYER_ID, { name: 'buyer-extra' });
  await buyer.locator('#grid .card', { hasText: 'Улун Те Гуан Инь' }).locator('.add').click();
  await tabButton(buyer, 'Корзина').click();
  await settle(buyer);
  await buyer.locator('#v-cart .freebar .bar').click();
  check(
    'клик по полосе «до бесплатной доставки» не показывает пустой тост',
    !(await buyer.evaluate(() => document.getElementById('toast').classList.contains('on'))),
  );
  await tabButton(buyer, 'Заказы').click();
  await buyer.waitForSelector('#v-orders .order');
  await buyer.locator('#v-orders .seg button', { hasText: 'Пауза' }).click();
  await buyer.waitForSelector('#v-orders .sub >> text=на паузе');
  const subscription = await shop.database.subscription.findFirst({ where: { chat_id: BUYER_ID } });
  check(
    'регулярный заказ поставлен на паузу',
    subscription && !subscription.active,
    JSON.stringify(subscription && subscription.active),
  );
  const linksBefore = (await buyer.evaluate(() => window.__telegramLog.links)).length;
  await buyer.locator('#v-orders .btn.pay').first().click();
  await settle(buyer, { keepToast: true });
  // подставная ЮKassa не отдаёт ссылку повторно — сервер честно отвечает 410 «ссылка устарела»; главное, что ответ дошёл до покупателя
  const linkOpened = (await buyer.evaluate(() => window.__telegramLog.links)).length === linksBefore + 1;
  const toastText = await buyer.locator('#toast').innerText();
  check(
    '«Оплатить» у неоплаченного заказа: ссылка или понятная ошибка',
    linkOpened || /устарела/.test(toastText),
    toastText,
  );
  await tabButton(buyer, 'AI-подбор').click();
  await buyer.fill('#aiQ', 'что-нибудь к десерту');
  await buyer.click('#aiGo');
  await buyer.waitForSelector('#aiGrid .empty');
  check('AI-подбор отвечает', /ничего не нашлось/.test(await buyer.locator('#aiGrid').innerText()));
  await tabButton(buyer, 'Корзина').click();
  await buyer.evaluate(() => window.Telegram.WebApp.MainButton.callback());
  await buyer.waitForSelector('#coConsent');
  await buyer.locator('.consent-check a').click();
  const openedLinks = await buyer.evaluate(() => window.__telegramLog.links);
  check(
    'ссылка на согласие открывается через Telegram и не ставит галочку',
    /\/shop\/legal\/consent\.html$/.test(openedLinks.at(-1) || '') && !(await buyer.isChecked('#coConsent')),
    openedLinks.at(-1),
  );
  await buyer.context().close();

  const owner = await openPage(OWNER_ID, { name: 'owner-extra' });
  await tabButton(owner, 'Админка').click();
  await owner.waitForSelector('#admBody .order');
  await owner.locator('#admBody .order').first().locator('.mini', { hasText: 'Написать' }).click();
  await owner.waitForSelector('#msgs');
  check('«Написать» из заказа открывает чат', true);
  const orderChip = owner.locator('#admBody .chips.small .chip').first();
  if (await orderChip.count()) {
    await orderChip.click();
    await owner.waitForSelector('#admBody .order.flash');
    check('из чата можно перейти к заказу', true);
  }
  await owner.locator('.chips.adm .chip', { hasText: 'Товары' }).click();
  await owner.waitForSelector('#admBody .aline');
  await owner.locator('#admBody .aline', { hasText: 'Чайное путешествие' }).click();
  const bundleRows = () => owner.locator('#bundleBox .crow').count();
  const rowsAtStart = await bundleRows();
  await owner.locator('#sheet .btn', { hasText: 'Добавить товар в набор' }).click();
  check('в набор добавляется строка', (await bundleRows()) === rowsAtStart + 1);
  await owner.locator('#bundleBox .crow').last().locator('.mini').click();
  check('строка набора удаляется', (await bundleRows()) === rowsAtStart);
  await owner
    .locator('#sheet .x')
    .click({ timeout: 3000 })
    .catch(() => {});
  check(
    'крестик в редакторе товара с фото закрывает шторку',
    !(await owner.evaluate(() => document.body.classList.contains('open'))),
  );
  await closeSheetByVeil(owner).catch(() => {});
  // Enter в поле названия не должен отправлять «фото по ссылке» (первая кнопка формы)
  const photoUrlRequests = [];
  owner.on('request', (request) => {
    if (request.url().includes('/photo-url')) photoUrlRequests.push(request.url());
  });
  await owner.locator('#admBody .aline', { hasText: 'Колумбия' }).first().click();
  await owner.locator('#pform input[name="name"]').press('Enter');
  await settle(owner, { keepToast: true });
  check('Enter в редакторе не отправляет фото по ссылке', photoUrlRequests.length === 0, photoUrlRequests.join(' '));
  if (await owner.evaluate(() => document.body.classList.contains('open'))) await closeSheetByVeil(owner);
  await owner.locator('.chips.adm .chip', { hasText: 'Настройки' }).click();
  await owner.waitForSelector('#admBody .prow');
  check(
    'настройки не шире экрана телефона',
    (await owner.evaluate(() => document.documentElement.scrollWidth)) <= VIEWPORT.width,
    String(await owner.evaluate(() => document.documentElement.scrollWidth)),
  );
  await owner.locator('#admBody .prow', { hasText: 'COFFEE10' }).locator('.sw i').click();
  await settle(owner, { keepToast: true });
  const promo = await shop.database.promoCode.findFirst({ where: { code: 'COFFEE10' } });
  check('промокод выключается переключателем', promo && !promo.active, JSON.stringify(promo && promo.active));
  await owner.locator('#admBody .prow', { hasText: 'AUTUMN15' }).locator('.mini').click();
  await settle(owner, { keepToast: true });
  check('промокод удаляется', !(await shop.database.promoCode.findFirst({ where: { code: 'AUTUMN15' } })));
  await owner.context().close();
}

module.exports = { runExtraChecks };
