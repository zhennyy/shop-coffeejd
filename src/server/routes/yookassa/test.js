// Вебхук ЮKassa: оплата засчитывается один раз, чужая сумма не засчитывается, посторонние события игнорируются
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const BUYER_ID = 5101;
let shop;
let actions;

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
});

test('оплата списывает склад, повтор не дублирует, чужая сумма не засчитывается', async () => {
  const [product] = await actions.productsInStock();
  const stockBefore = (await actions.findProduct(product.id)).stock;
  const response = await actions.buy(BUYER_ID, [[product.id, 2]]);
  assert.equal(response.status, 200);
  const payment = actions.lastPayment();
  payment.status = 'succeeded';
  assert.equal((await actions.sendPaymentWebhook(payment.id)).status, 200);
  assert.equal((await actions.sendPaymentWebhook(payment.id)).status, 200);
  assert.equal((await actions.findProduct(product.id)).stock, stockBefore - 2);
  assert.match((await actions.findOrder(response.body.id)).status, /paid/);
  // подделка суммы
  const secondResponse = await actions.buy(BUYER_ID, [[product.id, 1]]);
  const forgedPayment = actions.lastPayment();
  forgedPayment.status = 'succeeded';
  forgedPayment.amount = { value: '1.00', currency: 'RUB' };
  await actions.sendPaymentWebhook(forgedPayment.id);
  assert.doesNotMatch((await actions.findOrder(secondResponse.body.id)).status, /^paid/);
});

test('посторонние события и кривой id платежа просто подтверждаются', async () => {
  const sendEvent = (event) => fetch(shop.base + '/yookassa-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  const ordersBefore = await shop.database.order.count({ where: { status: 'paid' } });
  assert.equal((await sendEvent({ event: 'payment.canceled', object: { id: 'pay-1' } })).status, 200);
  assert.equal((await sendEvent({ event: 'payment.succeeded', object: { id: '../../etc' } })).status, 200);
  assert.equal(await shop.database.order.count({ where: { status: 'paid' } }), ordersBefore);
});
