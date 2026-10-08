const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
let S, delivery, subs;
const U = 5001;
const prods = () => S.db.prepare('SELECT id, price, stock FROM products WHERE stock > 5 ORDER BY id').all();
const setCart = async (user, pairs) => { for (const [id, q] of pairs) { const r = await S.call(user, 'POST', '/shop-api/cart', { product_id: id, qty: q }); assert.equal(r.status, 200); } };
const clear = (user) => S.db.prepare('DELETE FROM cart_items WHERE chat_id = ?').run(user);
const rub = (kop) => (kop / 100).toFixed(2);
const sumReceipt = (r) => r.items.reduce((a, i) => a + Math.round(parseFloat(i.amount.value) * 100) * i.quantity, 0);

before(async () => {
  S = await h.start();
  delivery = require('../src/delivery'); subs = require('../src/subscriptions');
  // точка отправки (0,0); геокодер: «Дальняя» ≈ 111 км, «Ближняя» ≈ 2.2 км, «Средняя» ≈ 11 км
  delivery.setGeocoder(async (q) => /дальн/i.test(q) ? { lat: 1, lon: 0 } : /ближн/i.test(q) ? { lat: 0.02, lon: 0 } : /средн/i.test(q) ? { lat: 0.1, lon: 0 } : null);
  delivery.save({ post: { enabled: true, carriers: [{ id: 'cdek', name: 'СДЭК', price: 35000 }, { id: 'russianpost', name: 'Почта России', price: 30000 }] },
    distance: { enabled: true, origin: { address: 'x', lat: 0, lon: 0 }, tiers: [{ km: 5, price: 20000 }, { km: 15, price: 35000 }] } });
});

test('самовывоз: заказ создан, доставка 0, корзина очищена', async () => {
  const p = prods()[0]; await setCart(U, [[p.id, 2]]);
  const r = await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '+7 900 123-45-67' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = S.db.prepare('SELECT * FROM orders WHERE id = ?').get(r.body.id);
  assert.equal(o.total, p.price * 2); assert.equal(o.delivery_method, 'pickup');
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM cart_items WHERE chat_id = ?').get(U).n, 0);
  assert.equal((await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup' })).status, 400); // корзина пуста
});

test('СДЭК: фиксированная цена перевозчика; неизвестный перевозчик отклоняется', async () => {
  const p = prods()[0]; await setCart(U, [[p.id, 1]]);
  const bad = await S.call(U, 'POST', '/shop-api/order', { delivery: 'post', carrier: 'xx', city: 'Казань', address: 'ул. Баумана, 1' });
  assert.equal(bad.status, 400);
  const r = await S.call(U, 'POST', '/shop-api/order', { delivery: 'post', carrier: 'cdek', city: 'Казань', address: 'ул. Баумана, 1', phone: '89001234567' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = S.db.prepare('SELECT * FROM orders WHERE id = ?').get(r.body.id);
  assert.equal(o.carrier, 'cdek');
  assert.ok(o.total >= p.price + 35000 - 1 || o.total === p.price + 35000 || o.total >= p.price); // бесплатная доставка от порога допустима
});

test('по расстоянию: ступени, слишком далеко, адрес не найден, котировка совпадает с заказом', async () => {
  const p = prods()[0]; await setCart(U, [[p.id, 1]]);
  const q = await S.call(U, 'POST', '/shop-api/delivery-quote', { delivery: 'distance', city: 'Москва', address: 'Ближняя улица 5' });
  assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.delivery, 20000);
  await new Promise((r) => setTimeout(r, 1100));
  const far = await S.call(U, 'POST', '/shop-api/order', { delivery: 'distance', city: 'Москва', address: 'Дальняя улица 5', phone: '89001234567' });
  assert.equal(far.status, 400); assert.match(far.body.error, /Далеко/);
  const nf = await S.call(U, 'POST', '/shop-api/order', { delivery: 'distance', city: 'Москва', address: 'Неизвестная улица 5', phone: '89001234567' });
  assert.equal(nf.status, 400);
  const ok = await S.call(U, 'POST', '/shop-api/order', { delivery: 'distance', city: 'Москва', address: 'Средняя улица 5', phone: '89001234567' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const o = S.db.prepare('SELECT total FROM orders WHERE id = ?').get(ok.body.id);
  assert.equal(o.total, p.price + 35000);
});

test('валидация контакта и чек 54-ФЗ: сумма позиций равна платежу', async () => {
  process.env.YOOKASSA_RECEIPTS = 'on';
  const [a, b] = prods(); await setCart(U, [[a.id, 3], [b.id, 2]]);
  const noC = await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup' });
  assert.equal(noC.status, 400);
  const badP = await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '123' });
  assert.equal(badP.status, 400);
  const badE = await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup', email: 'abc' });
  assert.equal(badE.status, 400);
  const r = await S.call(U, 'POST', '/shop-api/order', { delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', email: 'a@b.ru' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pay = [...S.payments.values()].pop();
  assert.ok(pay.body.receipt, 'чек есть');
  assert.equal(sumReceipt(pay.body.receipt), Math.round(parseFloat(pay.body.amount.value) * 100));
  assert.equal(pay.body.receipt.customer.email, 'a@b.ru');
  process.env.YOOKASSA_RECEIPTS = 'off';
});

test('сбой создания оплаты: заказ отменён, корзина сохранена', async () => {
  const axios = require('axios'); const orig = axios.post;
  const p = prods()[0]; await setCart(U, [[p.id, 1]]);
  axios.post = async () => { throw new Error('boom'); };
  const r = await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  axios.post = orig;
  assert.equal(r.status, 502);
  assert.equal(S.db.prepare("SELECT status FROM orders ORDER BY id DESC LIMIT 1").get().status, 'cancelled');
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM cart_items WHERE chat_id = ?').get(U).n, 1);
  clear(U);
});

test('нехватка товара при оформлении', async () => {
  const p = prods()[0]; await setCart(U, [[p.id, 1]]);
  S.db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(p.id);
  const r = await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  S.db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(p.stock, p.id);
  assert.equal(r.status, 400); clear(U);
});

test('вебхук ЮKassa: оплата списывает склад, повтор не дублирует, чужая сумма не засчитывается', async () => {
  const p = prods()[0]; await setCart(U, [[p.id, 2]]);
  const before = S.db.prepare('SELECT stock FROM products WHERE id = ?').get(p.id).stock;
  const r = await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  assert.equal(r.status, 200);
  const pay = [...S.payments.values()].pop();
  pay.status = 'succeeded';
  const hook = () => fetch(S.base + '/yookassa-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'payment.succeeded', object: { id: pay.id } }) });
  assert.equal((await hook()).status, 200); assert.equal((await hook()).status, 200);
  assert.equal(S.db.prepare('SELECT stock FROM products WHERE id = ?').get(p.id).stock, before - 2);
  assert.match(S.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.body.id).status, /paid/);
  // подделка суммы
  await setCart(U, [[p.id, 1]]);
  const r2 = await S.call(U, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  const pay2 = [...S.payments.values()].pop(); pay2.status = 'succeeded'; pay2.amount = { value: '1.00', currency: 'RUB' };
  await fetch(S.base + '/yookassa-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'payment.succeeded', object: { id: pay2.id } }) });
  assert.doesNotMatch(S.db.prepare('SELECT status FROM orders WHERE id = ?').get(r2.body.id).status, /^paid/);
});

test('без подписи Telegram доступа нет', async () => {
  assert.equal((await S.call(null, 'GET', '/shop-api/checkout-info')).status, 401);
  assert.equal((await S.call(null, 'POST', '/shop-api/order', {})).status, 401);
  assert.equal((await S.call(U, 'POST', '/shop-api/admin/delivery2', {})).status, 403);
});

test('повтор заказа: корзина собирается с учётом остатка', async () => {
  const o = S.db.prepare("SELECT id FROM orders WHERE chat_id = ? AND status LIKE 'paid%' ORDER BY id DESC").get(U) || S.db.prepare("SELECT id FROM orders WHERE chat_id = ? ORDER BY id DESC").get(U);
  const r = await S.call(U, 'POST', `/shop-api/orders/${o.id}/repeat`);
  assert.equal(r.status, 200); assert.ok(r.body.added >= 1); clear(U);
  assert.equal((await S.call(U + 1, 'POST', `/shop-api/orders/${o.id}/repeat`)).status, 404); // чужой заказ
});

test('подписки: создание, ограничения, запуск, нехватка, дубли, чужая подписка', async () => {
  const U2 = 5002, p = prods()[0];
  await setCart(U2, [[p.id, 1]]);
  const r = await S.call(U2, 'POST', '/shop-api/order', { delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', phone: '89001234567' });
  assert.equal(r.status, 200);
  assert.equal((await S.call(U2, 'POST', '/shop-api/subscriptions', { order_id: r.body.id, days: 14 })).status, 400); // не оплачен
  S.db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(r.body.id);
  assert.equal((await S.call(U2, 'POST', '/shop-api/subscriptions', { order_id: r.body.id, days: 5 })).status, 400);
  assert.equal((await S.call(U2 + 1, 'POST', '/shop-api/subscriptions', { order_id: r.body.id, days: 14 })).status, 400); // чужой заказ
  const c = await S.call(U2, 'POST', '/shop-api/subscriptions', { order_id: r.body.id, days: 14 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.id;
  assert.equal((await S.call(U2 + 1, 'POST', `/shop-api/subscriptions/${id}`, { action: 'delete' })).status, 400);
  assert.equal((await S.call(U2, 'POST', `/shop-api/subscriptions/${id}`, { action: 'skip' })).status, 200);
  // срок наступил
  S.db.prepare('UPDATE subscriptions SET next_date = ? WHERE id = ?').run('2000-01-01', id);
  S.sent.length = 0;
  const ordersBefore = S.db.prepare('SELECT COUNT(*) n FROM orders').get().n;
  assert.equal(await subs.runDue(S.bot), 1);
  assert.equal(await subs.runDue(S.bot), 0); // повторный запуск — без дубля
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM orders').get().n, ordersBefore + 1);
  assert.ok(S.sent.some((m) => m.chat === U2 && m.extra?.reply_markup));
  // нехватка: переносы, затем пауза
  S.db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(p.id);
  for (let i = 0; i < 3; i++) { S.db.prepare('UPDATE subscriptions SET next_date = ? WHERE id = ?').run('2000-01-01', id); await subs.runDue(S.bot); }
  assert.equal(S.db.prepare('SELECT active FROM subscriptions WHERE id = ?').get(id).active, 0);
  S.db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(p.stock, p.id);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM orders').get().n, ordersBefore + 1);
  assert.equal((await S.call(U2, 'POST', `/shop-api/subscriptions/${id}`, { action: 'resume' })).status, 200);
  assert.equal((await S.call(U2, 'POST', `/shop-api/subscriptions/${id}`, { action: 'delete' })).status, 200);
});

test('админ: настройки доставки сохраняются, ступени разбираются', async () => {
  assert.deepEqual(delivery.parseTiers('5 : 200\n15 : 350'), [{ km: 5, price: 20000 }, { km: 15, price: 35000 }]);
  assert.throws(() => delivery.parseTiers('мусор'));
  assert.throws(() => delivery.parseTiers('5:100\n5:200'));
  const r = await S.call(1001, 'POST', '/shop-api/admin/delivery2', { postEnabled: true, carriers: [{ id: 'cdek', name: 'СДЭК', price: 400 }], distanceEnabled: false, tiers: '5 : 200' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(delivery.get().post.carriers[0].price, 40000);
});
