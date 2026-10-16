// Экраны покупателя: каталог, карточки, корзина, оформление (все способы доставки), заказы, AI, язык, тёмная тема.
const { normalizeOrders, BUYER_ID } = require('./test-data');
const { pressMainButton, closeSheetByVeil, tabButton } = require('./browser');

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
  // 152-ФЗ: без галочки согласия оплатить нельзя — подсказка, заказ не создаётся, ссылка на оплату не открывается
  check('галочка согласия не отмечена заранее', !(await page.isChecked('#coConsent')));
  const ordersBeforeConsent = await shop.database.order.count();
  await pressMainButton(page);
  await snap(page, 'b20a-checkout-consent-required', { keepToast: true });
  check(
    'без согласия оплата заблокирована',
    (await shop.database.order.count()) === ordersBeforeConsent &&
      (await page.evaluate(() => window.__telegramLog.links.length)) === 0 &&
      /Отметьте согласие/.test(await page.locator('#toast').innerText()),
    await page.locator('#toast').innerText(),
  );
  await page.check('#coConsent');
  await snap(page, 'b20b-checkout-consent-given');
  await pressMainButton(page);
  await page.waitForSelector('#v-orders.on .order');
  await runner.settle(page);
  const links = await page.evaluate(() => window.__telegramLog.links);
  check(
    'после оформления открыта ссылка на оплату',
    links.length === 1 && links[0].startsWith('https://pay.test/'),
    JSON.stringify(links),
  );
  await normalizeOrders(shop);
  await tabButton(page, 'Каталог').click();
  await tabButton(page, 'Заказы').click();
  await page.waitForSelector('#v-orders .order');
  await snap(page, 'b21-orders-after-checkout');
  const ordersText = await page.locator('#v-orders').innerText();
  check(
    'новый заказ виден в «Мои заказы»',
    /CJ-105/.test(ordersText) && /Ждёт оплат|ждём оплату/i.test(ordersText),
    ordersText.slice(0, 200),
  );
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
  await dark.locator('#sheet .x').click();
  await dark.locator('#grid .card', { hasText: 'Улун Те Гуан Инь' }).locator('.add').click();
  await tabButton(dark, 'Корзина').click();
  await pressMainButton(dark);
  await dark.locator('.tile', { hasText: 'Самовывоз' }).click();
  await snap(dark, 'b31-checkout-dark');
  await dark.check('#coConsent');
  await snap(dark, 'b32-checkout-dark-consent-given');
  await dark.context().close();
  await shop.database.cartItem.deleteMany({ where: { chat_id: BUYER_ID } }); // дальше проверки начинают с пустой корзины
}

module.exports = { runBuyerScreens };
