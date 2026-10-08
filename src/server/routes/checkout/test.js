// Оформление в витрине: способы доставки, контакт и чек, сбой оплаты, нехватка товара, защита промокодов
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const BUYER_ID = 5001;
let shop;
let actions;

const receiptSum = (fiscalReceipt) => fiscalReceipt.items.reduce((sum, position) => sum + Math.round(parseFloat(position.amount.value) * 100) * position.quantity, 0);
const countCartRows = (chatId) => shop.database.cartItem.count({ where: { chat_id: chatId } });
const placeOrder = (orderForm) => shop.call(BUYER_ID, 'POST', '/shop-api/order', orderForm);

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
  const delivery = require('../../../delivery');
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
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 2]]);
  const response = await placeOrder({ delivery: 'pickup', phone: '+7 900 123-45-67' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const order = await actions.findOrder(response.body.id);
  assert.equal(order.total, product.price * 2);
  assert.equal(order.delivery_method, 'pickup');
  assert.equal(await countCartRows(BUYER_ID), 0);
  assert.equal((await placeOrder({ delivery: 'pickup' })).status, 400); // корзина пуста
});

test('СДЭК: фиксированная цена перевозчика; неизвестный перевозчик отклоняется', async () => {
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  assert.equal((await placeOrder({ delivery: 'post', carrier: 'xx', city: 'Казань', address: 'ул. Баумана, 1' })).status, 400);
  const response = await placeOrder({ delivery: 'post', carrier: 'cdek', city: 'Казань', address: 'ул. Баумана, 1', phone: '89001234567' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const order = await actions.findOrder(response.body.id);
  assert.equal(order.carrier, 'cdek');
  assert.ok(order.total >= product.price); // бесплатная доставка от порога допустима
});

test('по расстоянию: ступени, слишком далеко, адрес не найден, котировка совпадает с заказом', async () => {
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  const quote = await shop.call(BUYER_ID, 'POST', '/shop-api/delivery-quote', { delivery: 'distance', city: 'Москва', address: 'Ближняя улица 5' });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.delivery, 20000);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const tooFar = await placeOrder({ delivery: 'distance', city: 'Москва', address: 'Дальняя улица 5', phone: '89001234567' });
  assert.equal(tooFar.status, 400);
  assert.match(tooFar.body.error, /Далеко/);
  assert.equal((await placeOrder({ delivery: 'distance', city: 'Москва', address: 'Неизвестная улица 5', phone: '89001234567' })).status, 400);
  const accepted = await placeOrder({ delivery: 'distance', city: 'Москва', address: 'Средняя улица 5', phone: '89001234567' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await actions.findOrder(accepted.body.id)).total, product.price + 35000);
});

test('валидация контакта и чек 54-ФЗ: сумма позиций равна платежу', async () => {
  process.env.YOOKASSA_RECEIPTS = 'on';
  const [firstProduct, secondProduct] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[firstProduct.id, 3], [secondProduct.id, 2]]);
  assert.equal((await placeOrder({ delivery: 'pickup' })).status, 400);
  assert.equal((await placeOrder({ delivery: 'pickup', phone: '123' })).status, 400);
  assert.equal((await placeOrder({ delivery: 'pickup', email: 'abc' })).status, 400);
  const response = await placeOrder({ delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', email: 'a@b.ru' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const payment = actions.lastPayment();
  assert.ok(payment.body.receipt, 'чек есть');
  assert.equal(receiptSum(payment.body.receipt), Math.round(parseFloat(payment.body.amount.value) * 100));
  assert.equal(payment.body.receipt.customer.email, 'a@b.ru');
  process.env.YOOKASSA_RECEIPTS = 'off';
});

test('сбой создания оплаты: заказ отменён, корзина сохранена', async () => {
  const axios = require('axios');
  const originalPost = axios.post;
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  axios.post = async () => { throw new Error('boom'); };
  const response = await placeOrder({ delivery: 'pickup', phone: '89001234567' });
  axios.post = originalPost;
  assert.equal(response.status, 502);
  assert.equal((await shop.database.order.findFirst({ orderBy: { id: 'desc' } })).status, 'cancelled');
  assert.equal(await countCartRows(BUYER_ID), 1);
  await actions.clearCart(BUYER_ID);
});

test('нехватка товара при оформлении', async () => {
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  await shop.database.product.update({ where: { id: product.id }, data: { stock: 0 } });
  const response = await placeOrder({ delivery: 'pickup', phone: '89001234567' });
  await shop.database.product.update({ where: { id: product.id }, data: { stock: product.stock } });
  assert.equal(response.status, 400);
  await actions.clearCart(BUYER_ID);
});

test('промокоды нельзя подбирать: после 12 попыток — 429', async () => {
  let lastResponse;
  for (let attempt = 0; attempt < 14; attempt++) lastResponse = await shop.call(8001, 'POST', '/shop-api/promo', { code: 'NOPE' + attempt });
  assert.equal(lastResponse.status, 429);
});

test('без подписи Telegram оформить нельзя', async () => {
  assert.equal((await shop.call(null, 'GET', '/shop-api/checkout-info')).status, 401);
  assert.equal((await shop.call(null, 'POST', '/shop-api/order', {})).status, 401);
});
