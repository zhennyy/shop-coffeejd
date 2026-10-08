// Витрина: корзина, повтор заказа, подписки, чужие заказы
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const BUYER_ID = 5201;
let shop;
let actions;
let subscriptions;

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
  subscriptions = require('../../../subscriptions');
});

test('корзина: несуществующий товар, больше остатка, вес — шагом и от минимума', async () => {
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: 'abc', qty: 1 })).status, 404);
  const [product] = await actions.productsInStock();
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: product.id, qty: product.stock + 1 })).status, 400);
  const weightProductId = await actions.createProduct({ name: 'Кофе на развес для корзины', unit: 'g', price: 480, stock: 5000, step: 50, min_qty: 100 });
  for (const wrongQuantity of [50, 130, 75]) {
    assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: weightProductId, qty: wrongQuantity })).status, 400, 'qty ' + wrongQuantity);
  }
  const accepted = await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: weightProductId, qty: 300 });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.cart[weightProductId], 300);
  await actions.clearCart(BUYER_ID);
});

test('повтор заказа: корзина собирается с учётом остатка, чужой заказ недоступен', async () => {
  const [product] = await actions.productsInStock();
  const orderResponse = await actions.buy(BUYER_ID, [[product.id, 1]]);
  assert.equal(orderResponse.status, 200);
  await actions.payLastOrder();
  const repeated = await shop.call(BUYER_ID, 'POST', `/shop-api/orders/${orderResponse.body.id}/repeat`);
  assert.equal(repeated.status, 200);
  assert.ok(repeated.body.added >= 1);
  await actions.clearCart(BUYER_ID);
  assert.equal((await shop.call(BUYER_ID + 1, 'POST', `/shop-api/orders/${orderResponse.body.id}/repeat`)).status, 404);
  assert.equal((await shop.call(BUYER_ID + 1, 'POST', `/shop-api/orders/${orderResponse.body.id}/pay`, {})).status, 404);
});

test('подписки: создание, ограничения, запуск, нехватка, дубли, чужая подписка', async () => {
  const SUBSCRIBER_ID = 5202;
  const [product] = await actions.productsInStock();
  await actions.setCart(SUBSCRIBER_ID, [[product.id, 1]]);
  const orderResponse = await shop.call(SUBSCRIBER_ID, 'POST', '/shop-api/order', { delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', phone: '89001234567' });
  assert.equal(orderResponse.status, 200);
  const subscribe = (chatId, body) => shop.call(chatId, 'POST', '/shop-api/subscriptions', body);
  assert.equal((await subscribe(SUBSCRIBER_ID, { order_id: orderResponse.body.id, days: 14 })).status, 400); // не оплачен
  await shop.database.order.update({ where: { id: orderResponse.body.id }, data: { status: 'paid' } });
  assert.equal((await subscribe(SUBSCRIBER_ID, { order_id: orderResponse.body.id, days: 5 })).status, 400);
  assert.equal((await subscribe(SUBSCRIBER_ID + 1, { order_id: orderResponse.body.id, days: 14 })).status, 400); // чужой заказ
  const created = await subscribe(SUBSCRIBER_ID, { order_id: orderResponse.body.id, days: 14 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const subscriptionId = created.body.id;
  const changeSubscription = (chatId, action) => shop.call(chatId, 'POST', `/shop-api/subscriptions/${subscriptionId}`, { action });
  assert.equal((await changeSubscription(SUBSCRIBER_ID, 'взлом')).status, 400);
  assert.equal((await changeSubscription(SUBSCRIBER_ID + 1, 'delete')).status, 400);
  assert.equal((await changeSubscription(SUBSCRIBER_ID, 'skip')).status, 200);
  // срок наступил
  const makeDue = () => shop.database.subscription.update({ where: { id: subscriptionId }, data: { next_date: '2000-01-01' } });
  await makeDue();
  shop.sent.length = 0;
  const ordersBefore = await shop.database.order.count();
  assert.equal(await subscriptions.runDueSubscriptions(shop.bot), 1);
  assert.equal(await subscriptions.runDueSubscriptions(shop.bot), 0); // повторный запуск — без дубля
  assert.equal(await shop.database.order.count(), ordersBefore + 1);
  assert.ok(shop.sent.some((message) => message.chat === SUBSCRIBER_ID && message.extra?.reply_markup));
  // нехватка: переносы, затем пауза
  await shop.database.product.update({ where: { id: product.id }, data: { stock: 0 } });
  for (let attempt = 0; attempt < 3; attempt++) {
    await makeDue();
    await subscriptions.runDueSubscriptions(shop.bot);
  }
  assert.equal((await shop.database.subscription.findUnique({ where: { id: subscriptionId } })).active, 0);
  await shop.database.product.update({ where: { id: product.id }, data: { stock: product.stock } });
  assert.equal(await shop.database.order.count(), ordersBefore + 1);
  assert.equal((await changeSubscription(SUBSCRIBER_ID, 'resume')).status, 200);
  assert.equal((await changeSubscription(SUBSCRIBER_ID, 'delete')).status, 200);
});

test('подписка и повтор заказа с весовым товаром и набором', async () => {
  const weightProductId = await actions.createProduct({ name: 'Весовой для подписки', unit: 'g', price: 500, stock: 3000, step: 50, min_qty: 100 });
  const componentId = await actions.createProduct({ name: 'Компонент П', price: 100, stock: 10 });
  const bundleId = await actions.createProduct({ name: 'Набор для подписки', price: 700, stock: 0, bundle: [{ product_id: componentId, qty: 2 }] });
  const SUBSCRIBER_ID = 6100;
  const response = await actions.buy(SUBSCRIBER_ID, [[weightProductId, 250], [bundleId, 1]]);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await actions.payLastOrder();
  assert.equal((await actions.findProduct(weightProductId)).stock, 2750);
  assert.equal((await actions.findProduct(componentId)).stock, 8);
  const repeated = await shop.call(SUBSCRIBER_ID, 'POST', `/shop-api/orders/${response.body.id}/repeat`);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.cart[weightProductId], 250);
  const created = await shop.call(SUBSCRIBER_ID, 'POST', '/shop-api/subscriptions', { order_id: response.body.id, days: 7 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const subscriptionList = await shop.call(SUBSCRIBER_ID, 'GET', '/shop-api/subscriptions');
  const weightItem = subscriptionList.body.subscriptions[0].items.find((subscriptionItem) => subscriptionItem.name.includes('Весовой'));
  assert.equal(weightItem.unit, 'g');
  await shop.database.subscription.update({ where: { id: created.body.id }, data: { next_date: '2000-01-01' } });
  shop.sent.length = 0;
  assert.equal(await subscriptions.runDueSubscriptions(shop.bot), 1);
  assert.ok(shop.sent.some((message) => message.chat === SUBSCRIBER_ID && /250 г/.test(message.text)), 'в сообщении граммы');
  const latestOrder = await shop.database.order.findFirst({ where: { chat_id: SUBSCRIBER_ID }, orderBy: { id: 'desc' } });
  assert.equal(latestOrder.total, 250 * 500 + 70000);
});
