const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
let S;
before(async () => { S = await h.start(); });

test('SSRF: ссылки во внутреннюю сеть отклоняются', async () => {
  const { assertPublicUrl } = require('../webhook');
  for (const u of ['https://127.0.0.1/a.jpg', 'https://localhost/a.jpg', 'https://169.254.169.254/latest', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://[::1]/x', 'https://172.16.0.1/x'])
    await assert.rejects(() => assertPublicUrl(u), undefined, u);
});

test('CSV: формулы экранируются при выгрузке и не портят названия при загрузке', () => {
  const stock = require('../stock');
  S.db.prepare("INSERT INTO products (name, price, stock) VALUES ('=HYPERLINK(\"x\")', 100, 1)").run();
  const csv = stock.exportCsv();
  assert.match(csv, /'=HYPERLINK/);
  assert.doesNotMatch(csv, /(^|;)=HYPERLINK/m);
  const before = S.db.prepare('SELECT COUNT(*) n FROM products').get().n;
  stock.importCsv(csv);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM products').get().n, before); // повторная загрузка ничего не дублирует
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM products WHERE name LIKE '''=%'").get().n, 0);
});

test('промокоды нельзя подбирать: после 12 попыток — 429', async () => {
  let last;
  for (let i = 0; i < 14; i++) last = await S.call(8001, 'POST', '/shop-api/promo', { code: 'NOPE' + i });
  assert.equal(last.status, 429);
});

test('чужие данные недоступны: заказ другого покупателя, админ-маршруты, CRM-секрет', async () => {
  assert.equal((await S.call(8002, 'GET', '/shop-api/admin/products')).status, 403);
  assert.equal((await S.call(null, 'GET', '/shop-api/admin/products', undefined, { 'X-Webhook-Secret': 'wrong' })).status, 401);
  assert.equal((await S.call(null, 'GET', '/shop-api/admin/products', undefined, { 'X-Webhook-Secret': 'crm-secret-test' })).status, 200);
  assert.equal((await S.call(8002, 'POST', '/shop-api/orders/1/pay', {})).status, 404);
  assert.equal((await S.call(null, 'GET', '/admin')).status, 404);
});

test('поддельная подпись и просроченная подпись отклоняются', async () => {
  const bad = h.initData(8003).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  const r = await fetch(S.base + '/shop-api/orders', { headers: { 'X-Init-Data': bad } });
  assert.equal(r.status, 401);
});
