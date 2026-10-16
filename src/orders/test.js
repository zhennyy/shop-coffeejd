// Сообщения о заказе: владельцу в Telegram (зарубежный сервис) — без персональных данных покупателя (152-ФЗ),
// покупателю — его собственный адрес можно.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../server/test-helpers');

const BUYER_ID = 5301;
const BUYER_PHONE = '+7 911 555-66-77';
const BUYER_STREET = 'Невский проспект, 28, кв. 14';
const BUYER_FULL_NAME = 'Анна Сергеевна Петрова';
let shop;
let actions;
let orders;
let paidOrder;

const messagesTo = (chatId) => shop.sent.filter((message) => String(message.chat) === String(chatId));
const assertNoPersonalData = (text, where) => {
  assert.doesNotMatch(text, /911|555-66-77|555/, `${where}: нет телефона`);
  assert.doesNotMatch(text, /Невский|кв\. 14/, `${where}: нет адреса`);
  assert.doesNotMatch(text, /Петрова|Сергеевна|Анна/, `${where}: нет имени`);
};

before(async () => {
  process.env.SHOP_URL = 'https://coffee.test/shop/';
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
  orders = require('./index');
  await require('../customers').setName(BUYER_ID, BUYER_FULL_NAME);
  const [product] = await actions.productsInStock();
  await actions.clearCart(BUYER_ID);
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', {
    delivery: 'city',
    city: 'Санкт-Петербург',
    address: BUYER_STREET,
    phone: BUYER_PHONE,
    consent: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await actions.payLastOrder();
  paidOrder = await orders.getOrder(response.body.id);
  assert.equal(paidOrder.base, 'paid');
});

test('новый заказ владельцу: код, сумма, состав, город, статус — без телефона, адреса и имени', () => {
  const ownerMessage = messagesTo(testHelpers.OWNER_ID).find((message) => /Новый заказ/.test(message.text));
  assert.ok(ownerMessage, 'владелец получил уведомление');
  const text = ownerMessage.text;
  assert.match(text, new RegExp(`№ ${paidOrder.code}`));
  assert.match(text, /Итого/);
  assert.match(text, /Санкт-Петербург/, 'город можно');
  assert.match(text, /Статус/);
  assert.match(text, /Контакты и адрес — в админке/);
  assert.match(text, new RegExp(`tg://user\\?id=${BUYER_ID}`), 'ссылка на покупателя в Telegram осталась');
  assertNoPersonalData(text, 'новый заказ');
  const buttons = ownerMessage.extra.reply_markup.inline_keyboard.flat();
  assert.ok(
    buttons.some((button) => button.callback_data === `reply:${BUYER_ID}`),
    'кнопка «Написать покупателю»',
  );
  assert.ok(
    buttons.some((button) => button.web_app && /tab=admin/.test(button.web_app.url)),
    'кнопка «Открыть админку»',
  );
});

test('сообщения о статусе и оценке владельцу тоже без персональных данных', async () => {
  for (const status of ['assembling', 'shipped', 'delivered', 'cancelled']) {
    const order = { ...paidOrder, base: status, status, track: status === 'shipped' ? 'RA123' : null };
    assertNoPersonalData(await orders.ownerText(order), `статус ${status}`);
  }
  await orders.changeStatus(shop.bot, paidOrder.id, 'delivered');
  await orders.rateOrder(shop.bot, BUYER_ID, paidOrder.id, 4);
  const ratingMessage = messagesTo(testHelpers.OWNER_ID).find((message) => /оценил/.test(message.text));
  assert.ok(ratingMessage, 'владелец узнал об оценке');
  assertNoPersonalData(ratingMessage.text, 'оценка');
});

test('покупателю его собственный адрес показывать можно', () => {
  const buyerMessage = messagesTo(BUYER_ID).find((message) => /оплата получена/.test(message.text));
  assert.ok(buyerMessage);
  assert.match(buyerMessage.text, /Невский/);
});
