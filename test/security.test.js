const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let shop;
before(async () => { shop = await helpers.start(); });

test('SSRF: ссылки во внутреннюю сеть отклоняются', async () => {
  const { assertPublicUrl } = require('../src/server');
  const internalUrls = ['https://127.0.0.1/a.jpg', 'https://localhost/a.jpg', 'https://169.254.169.254/latest', 'https://10.0.0.5/x',
    'https://192.168.1.1/x', 'https://[::1]/x', 'https://172.16.0.1/x'];
  for (const internalUrl of internalUrls) await assert.rejects(() => assertPublicUrl(internalUrl), undefined, internalUrl);
});

test('CSV: формулы экранируются при выгрузке и не портят названия при загрузке', async () => {
  const stockFiles = require('../src/inventory/import-export');
  await shop.database.product.create({ data: { name: '=HYPERLINK("x")', price: 100, stock: 1 } });
  const exportedCsv = await stockFiles.exportCsv();
  assert.match(exportedCsv, /'=HYPERLINK/);
  assert.doesNotMatch(exportedCsv, /(^|;)=HYPERLINK/m);
  const productsBefore = await shop.database.product.count();
  await stockFiles.importCsv(exportedCsv);
  assert.equal(await shop.database.product.count(), productsBefore); // повторная загрузка ничего не дублирует
  assert.equal(await shop.database.product.count({ where: { name: { startsWith: "'=" } } }), 0);
});

test('промокоды нельзя подбирать: после 12 попыток — 429', async () => {
  let lastResponse;
  for (let attempt = 0; attempt < 14; attempt++) lastResponse = await shop.call(8001, 'POST', '/shop-api/promo', { code: 'NOPE' + attempt });
  assert.equal(lastResponse.status, 429);
});

test('чужие данные недоступны: заказ другого покупателя, админ-маршруты, CRM-секрет', async () => {
  assert.equal((await shop.call(8002, 'GET', '/shop-api/admin/products')).status, 403);
  assert.equal((await shop.call(null, 'GET', '/shop-api/admin/products', undefined, { 'X-Webhook-Secret': 'wrong' })).status, 401);
  assert.equal((await shop.call(null, 'GET', '/shop-api/admin/products', undefined, { 'X-Webhook-Secret': 'crm-secret-test' })).status, 200);
  assert.equal((await shop.call(8002, 'POST', '/shop-api/orders/1/pay', {})).status, 404);
  assert.equal((await shop.call(null, 'GET', '/admin')).status, 404);
});

test('поддельная подпись и просроченная подпись отклоняются', async () => {
  const forgedInitData = helpers.initData(8003).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  const response = await fetch(shop.base + '/shop-api/orders', { headers: { 'X-Init-Data': forgedInitData } });
  assert.equal(response.status, 401);
});
