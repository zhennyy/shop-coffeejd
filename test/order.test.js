const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let shop;
let delivery;
let subscriptions;
const BUYER_ID = 5001;

const productsInStock = () => shop.database.product.findMany({ where: { stock: { gt: 5 } }, select: { id: true, price: true, stock: true }, orderBy: { id: 'asc' } });
const findOrder = (orderId) => shop.database.order.findUnique({ where: { id: orderId } });
const countCartRows = (chatId) => shop.database.cartItem.count({ where: { chat_id: chatId } });
const clearCart = (chatId) => shop.database.cartItem.deleteMany({ where: { chat_id: chatId } });
const setProductStock = (productId, stock) => shop.database.product.update({ where: { id: productId }, data: { stock } });
const countOrders = () => shop.database.order.count();
const setCart = async (chatId, productQuantities) => {
  for (const [productId, quantity] of productQuantities) {
    const response = await shop.call(chatId, 'POST', '/shop-api/cart', { product_id: productId, qty: quantity });
    assert.equal(response.status, 200);
  }
};
const receiptSum = (receipt) => receipt.items.reduce((sum, position) => sum + Math.round(parseFloat(position.amount.value) * 100) * position.quantity, 0);
const lastPayment = () => [...shop.payments.values()].pop();
const sendWebhook = (paymentId) => fetch(shop.base + '/yookassa-webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'payment.succeeded', object: { id: paymentId } }),
});

before(async () => {
  shop = await helpers.start();
  delivery = require('../src/delivery');
  subscriptions = require('../src/subscriptions');
  // точка отправки (0,0); геокодер: «Дальняя» ≈ 111 км, «Ближняя» ≈ 2.2 км, «Средняя» ≈ 11 км
  delivery.setGeocoder(async (address) => {
    if (/дальн/i.test(address)) return { lat: 1, lon: 0 };
    if (/ближн/i.test(address)) return { lat: 0.02, lon: 0 };
    if (/средн/i.test(address)) return { lat: 0.1, lon: 0 };
    return null;
  });
  await delivery.saveDeliveryOptions({
    post: { enabled: true, carriers: [{ id: 'cdek', name: 'СДЭК', price: 35000 }, { id: 'russianpost', name: 'Почта России', price: 30000 }] },
    distance: { enabled: true, origin: { address: 'x', lat: 0, lon: 0 }, tiers: [{ km: 5, price: 20000 }, { km: 15, price: 35000 }] },
  });
});

test('самовывоз: заказ создан, доставка 0, корзина очищена', async () => {
  const [product] = await productsInStock();
  await setCart(BUYER_ID, [[product.id, 2]]);
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '+7 900 123-45-67' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const order = await findOrder(response.body.id);
  assert.equal(order.total, product.price * 2);
  assert.equal(order.delivery_method, 'pickup');
  assert.equal(await countCartRows(BUYER_ID), 0);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup' })).status, 400); // корзина пуста
});

test('СДЭК: фиксированная цена перевозчика; неизвестный перевозчик отклоняется', async () => {
  const [product] = await productsInStock();
  await setCart(BUYER_ID, [[product.id, 1]]);
  const rejected = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'post', carrier: 'xx', city: 'Казань', address: 'ул. Баумана, 1' });
  assert.equal(rejected.status, 400);
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'post', carrier: 'cdek', city: 'Казань', address: 'ул. Баумана, 1', phone: '89001234567' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const order = await findOrder(response.body.id);
  assert.equal(order.carrier, 'cdek');
  assert.ok(order.total >= product.price); // бесплатная доставка от порога допустима
});

test('по расстоянию: ступени, слишком далеко, адрес не найден, котировка совпадает с заказом', async () => {
  const [product] = await productsInStock();
  await setCart(BUYER_ID, [[product.id, 1]]);
  const quote = await shop.call(BUYER_ID, 'POST', '/shop-api/delivery-quote', { delivery: 'distance', city: 'Москва', address: 'Ближняя улица 5' });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.delivery, 20000);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const tooFar = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'distance', city: 'Москва', address: 'Дальняя улица 5', phone: '89001234567' });
  assert.equal(tooFar.status, 400);
  assert.match(tooFar.body.error, /Далеко/);
  const notFound = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'distance', city: 'Москва', address: 'Неизвестная улица 5', phone: '89001234567' });
  assert.equal(notFound.status, 400);
  const accepted = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'distance', city: 'Москва', address: 'Средняя улица 5', phone: '89001234567' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await findOrder(accepted.body.id)).total, product.price + 35000);
});

test('валидация контакта и чек 54-ФЗ: сумма позиций равна платежу', async () => {
  process.env.YOOKASSA_RECEIPTS = 'on';
  const [firstProduct, secondProduct] = await productsInStock();
  await setCart(BUYER_ID, [[firstProduct.id, 3], [secondProduct.id, 2]]);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup' })).status, 400);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '123' })).status, 400);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup', email: 'abc' })).status, 400);
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', email: 'a@b.ru' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const payment = lastPayment();
  assert.ok(payment.body.receipt, 'чек есть');
  assert.equal(receiptSum(payment.body.receipt), Math.round(parseFloat(payment.body.amount.value) * 100));
  assert.equal(payment.body.receipt.customer.email, 'a@b.ru');
  process.env.YOOKASSA_RECEIPTS = 'off';
});

test('сбой создания оплаты: заказ отменён, корзина сохранена', async () => {
  const axios = require('axios');
  const originalPost = axios.post;
  const [product] = await productsInStock();
  await setCart(BUYER_ID, [[product.id, 1]]);
  axios.post = async () => { throw new Error('boom'); };
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  axios.post = originalPost;
  assert.equal(response.status, 502);
  const latestOrder = await shop.database.order.findFirst({ orderBy: { id: 'desc' }, select: { status: true } });
  assert.equal(latestOrder.status, 'cancelled');
  assert.equal(await countCartRows(BUYER_ID), 1);
  await clearCart(BUYER_ID);
});

test('нехватка товара при оформлении', async () => {
  const [product] = await productsInStock();
  await setCart(BUYER_ID, [[product.id, 1]]);
  await setProductStock(product.id, 0);
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  await setProductStock(product.id, product.stock);
  assert.equal(response.status, 400);
  await clearCart(BUYER_ID);
});

test('вебхук ЮKassa: оплата списывает склад, повтор не дублирует, чужая сумма не засчитывается', async () => {
  const [product] = await productsInStock();
  await setCart(BUYER_ID, [[product.id, 2]]);
  const stockBefore = (await shop.database.product.findUnique({ where: { id: product.id } })).stock;
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  assert.equal(response.status, 200);
  const payment = lastPayment();
  payment.status = 'succeeded';
  assert.equal((await sendWebhook(payment.id)).status, 200);
  assert.equal((await sendWebhook(payment.id)).status, 200);
  assert.equal((await shop.database.product.findUnique({ where: { id: product.id } })).stock, stockBefore - 2);
  assert.match((await findOrder(response.body.id)).status, /paid/);
  // подделка суммы
  await setCart(BUYER_ID, [[product.id, 1]]);
  const secondResponse = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  const forgedPayment = lastPayment();
  forgedPayment.status = 'succeeded';
  forgedPayment.amount = { value: '1.00', currency: 'RUB' };
  await sendWebhook(forgedPayment.id);
  assert.doesNotMatch((await findOrder(secondResponse.body.id)).status, /^paid/);
});

test('без подписи Telegram доступа нет', async () => {
  assert.equal((await shop.call(null, 'GET', '/shop-api/checkout-info')).status, 401);
  assert.equal((await shop.call(null, 'POST', '/shop-api/order', {})).status, 401);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/admin/delivery2', {})).status, 403);
});

test('повтор заказа: корзина собирается с учётом остатка', async () => {
  const paidOrder = await shop.database.order.findFirst({ where: { chat_id: BUYER_ID, status: { startsWith: 'paid' } }, orderBy: { id: 'desc' } })
    || await shop.database.order.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  const response = await shop.call(BUYER_ID, 'POST', `/shop-api/orders/${paidOrder.id}/repeat`);
  assert.equal(response.status, 200);
  assert.ok(response.body.added >= 1);
  await clearCart(BUYER_ID);
  assert.equal((await shop.call(BUYER_ID + 1, 'POST', `/shop-api/orders/${paidOrder.id}/repeat`)).status, 404); // чужой заказ
});

test('подписки: создание, ограничения, запуск, нехватка, дубли, чужая подписка', async () => {
  const SUBSCRIBER_ID = 5002;
  const [product] = await productsInStock();
  await setCart(SUBSCRIBER_ID, [[product.id, 1]]);
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
  assert.equal((await changeSubscription(SUBSCRIBER_ID + 1, 'delete')).status, 400);
  assert.equal((await changeSubscription(SUBSCRIBER_ID, 'skip')).status, 200);
  // срок наступил
  const makeDue = () => shop.database.subscription.update({ where: { id: subscriptionId }, data: { next_date: '2000-01-01' } });
  await makeDue();
  shop.sent.length = 0;
  const ordersBefore = await countOrders();
  assert.equal(await subscriptions.runDueSubscriptions(shop.bot), 1);
  assert.equal(await subscriptions.runDueSubscriptions(shop.bot), 0); // повторный запуск — без дубля
  assert.equal(await countOrders(), ordersBefore + 1);
  assert.ok(shop.sent.some((message) => message.chat === SUBSCRIBER_ID && message.extra?.reply_markup));
  // нехватка: переносы, затем пауза
  await setProductStock(product.id, 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    await makeDue();
    await subscriptions.runDueSubscriptions(shop.bot);
  }
  assert.equal((await shop.database.subscription.findUnique({ where: { id: subscriptionId } })).active, 0);
  await setProductStock(product.id, product.stock);
  assert.equal(await countOrders(), ordersBefore + 1);
  assert.equal((await changeSubscription(SUBSCRIBER_ID, 'resume')).status, 200);
  assert.equal((await changeSubscription(SUBSCRIBER_ID, 'delete')).status, 200);
});

test('админ: настройки доставки сохраняются, ступени разбираются', async () => {
  assert.deepEqual(delivery.parseDistanceTiers('5 : 200\n15 : 350'), [{ km: 5, price: 20000 }, { km: 15, price: 35000 }]);
  assert.throws(() => delivery.parseDistanceTiers('мусор'));
  assert.throws(() => delivery.parseDistanceTiers('5:100\n5:200'));
  const response = await shop.call(1001, 'POST', '/shop-api/admin/delivery2', {
    postEnabled: true, carriers: [{ id: 'cdek', name: 'СДЭК', price: 400 }], distanceEnabled: false, tiers: '5 : 200',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await delivery.getDeliveryOptions()).post.carriers[0].price, 40000);
});
