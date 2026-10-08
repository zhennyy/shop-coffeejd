// Админка товаров: варианты, вес, допы, наборы, импорт склада, отчёты, доступ
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const OWNER_ID = testHelpers.OWNER_ID;
const BUYER_ID = 6001;
let shop;
let actions;
let inventory;

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
  inventory = require('../../../inventory');
});

test('два параметра выбора: вес и упаковка; второй без первого запрещён', async () => {
  const productId = await actions.createProduct({ name: 'Колумбия', price: 900, stock: 10, option_label: '250 г', option2_label: 'Пакет' });
  const product = await actions.findProduct(productId);
  assert.equal(product.name, 'Колумбия · 250 г · Пакет');
  assert.equal(product.group_key, 'Колумбия');
  assert.equal(product.option2_label, 'Пакет');
  const rejected = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products', { name: 'X', price: 100, stock: 1, option2_label: 'Пакет' });
  assert.equal(rejected.status, 400);
  const catalog = await shop.call(BUYER_ID, 'GET', '/shop-api/catalog');
  assert.equal(catalog.body.products.find((catalogProduct) => catalogProduct.id === productId).option2_label, 'Пакет');
});

test('продажа на вес: цена за 100 г, чек одной строкой, склад в граммах', async () => {
  const productId = await actions.createProduct({ name: 'Кофе на развес', unit: 'g', price: 480, stock: 5000, step: 50, min_qty: 100 });
  assert.equal((await actions.findProduct(productId)).price, 480);
  assert.equal((await actions.findProduct(productId)).unit, 'g');
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products', { name: 'Дробная', unit: 'g', price: 480.5, stock: 10 })).status, 400);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: productId, qty: 6000 })).status, 400);
  process.env.YOOKASSA_RECEIPTS = 'on';
  const response = await actions.buy(BUYER_ID, [[productId, 300]]);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await actions.findOrder(response.body.id)).total, 300 * 480);
  const payment = actions.lastPayment();
  assert.equal(payment.body.receipt.items.length, 1);
  assert.match(payment.body.receipt.items[0].description, /300 г/);
  assert.equal(payment.body.amount.value, '1440.00');
  process.env.YOOKASSA_RECEIPTS = 'off';
  await actions.payLastOrder();
  assert.equal((await actions.findProduct(productId)).stock, 4700);
  const lastLogEntry = await shop.database.stockLogEntry.findFirst({ where: { product_id: productId }, orderBy: { id: 'desc' } });
  assert.equal(lastLogEntry.delta, -300);
});

test('допы: хранятся как товар с флагом и отдаются в каталоге', async () => {
  const baseProductId = await actions.createProduct({ name: 'Кофе для допов', price: 500, stock: 5 });
  const addonId = await actions.createProduct({ name: 'Подарочная упаковка', price: 150, stock: 100, is_addon: true, addon_for: 'Кофе для допов' });
  const catalogProducts = (await shop.call(BUYER_ID, 'GET', '/shop-api/catalog')).body.products;
  const addon = catalogProducts.find((catalogProduct) => catalogProduct.id === addonId);
  assert.equal(addon.is_addon, 1);
  assert.equal(addon.addon_for, 'Кофе для допов');
  const response = await actions.buy(BUYER_ID, [[baseProductId, 1], [addonId, 1]]);
  assert.equal(response.status, 200);
  assert.equal((await actions.findOrder(response.body.id)).total, 65000);
  await actions.payLastOrder();
  assert.equal((await actions.findProduct(addonId)).stock, 99);
});

test('отчёты: продажи, остатки, движение; отправка владелице', async () => {
  const reports = require('../../../reports');
  const report = await reports.buildReport(30);
  assert.ok(report.orders.n >= 2, JSON.stringify(report.orders));
  assert.ok(report.byProduct.length);
  assert.ok(report.moves.length);
  assert.match(await reports.reportText(30), /Выручка/);
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await reports.reportXlsx(30));
  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), ['Итоги', 'Продажи по товарам', 'Способы получения', 'Остатки', 'Движение товара']);
  shop.sent.length = 0;
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/report', { days: 7 })).status, 200);
  assert.ok(shop.sent.some((message) => /Отчёт за 7/.test(message.text)));
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/admin/report', { days: 7 })).status, 403);
});

test('наборы: остаток по составу, оплата списывает компоненты, отмена возвращает', async () => {
  const firstComponentId = await actions.createProduct({ name: 'Набор-А', price: 100, stock: 7 });
  const secondComponentId = await actions.createProduct({ name: 'Набор-Б', price: 100, stock: 3 });
  const bundleParts = [{ product_id: firstComponentId, qty: 2 }, { product_id: secondComponentId, qty: 1 }];
  const bundleId = await actions.createProduct({ name: 'Дегустация 2', price: 1500, stock: 99, bundle: bundleParts });
  assert.equal((await actions.findProduct(bundleId)).stock, 3); // min(7/2=3, 3/1=3)
  const edited = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${bundleId}`, { name: 'Дегустация 2', price: 1500, stock: 50, bundle: bundleParts });
  assert.equal(edited.status, 200);
  assert.equal((await actions.findProduct(bundleId)).stock, 3); // ручной остаток набора игнорируется
  const response = await actions.buy(BUYER_ID, [[bundleId, 2]]);
  assert.equal(response.status, 200);
  await actions.payLastOrder();
  assert.equal((await actions.findProduct(firstComponentId)).stock, 3);
  assert.equal((await actions.findProduct(secondComponentId)).stock, 1);
  assert.equal((await actions.findProduct(bundleId)).stock, 1);
  const cancelled = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/orders/${response.body.id}/status`, { status: 'cancelled' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal((await actions.findProduct(firstComponentId)).stock, 7);
  assert.equal((await actions.findProduct(secondComponentId)).stock, 3);
  assert.equal((await actions.findProduct(bundleId)).stock, 3);
  // запреты
  await assert.rejects(() => inventory.setBundle(bundleId, [{ product_id: bundleId, qty: 1 }]), /сам в себя/);
  const otherBundleId = await actions.createProduct({ name: 'Набор-В', price: 10, stock: 1, bundle: [{ product_id: firstComponentId, qty: 1 }] });
  await assert.rejects(() => inventory.setBundle(bundleId, [{ product_id: otherBundleId, qty: 1 }]), /другой набор/);
  const stockChange = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-delta', { changes: [{ name: 'Дегустация 2', delta: -1 }] });
  assert.equal(stockChange.status, 409);
  // удаление компонента не ломает набор
  await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${secondComponentId}/delete`, {});
  assert.equal(await shop.database.bundleItem.count({ where: { product_id: secondComponentId } }), 0);
});

test('импорт из админки: пример чая и свой файл; покупатель не может', async () => {
  const productsBefore = await shop.database.product.count();
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/admin/stock-import', { sample: 'tea' })).status, 403);
  const sampleImport = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-import', { sample: 'tea' });
  assert.equal(sampleImport.status, 200, JSON.stringify(sampleImport.body));
  assert.match(sampleImport.body.text, /Добавлено: 19/);
  assert.equal(await shop.database.product.count(), productsBefore + 19);
  const csvBase64 = Buffer.from('название;вариант;категория;цена_руб;остаток\nИмпорт-тест;;Тест;100;5\n', 'utf8').toString('base64');
  const csvImport = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-import', { name: 'x.csv', data: csvBase64 });
  assert.equal(csvImport.status, 200, JSON.stringify(csvImport.body));
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-import', { name: 'x.exe', data: csvBase64 })).status, 400);
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-import', { name: 'x.csv' })).status, 400);
});

test('доступ к товарам: покупатель — нет, CRM — только с верным секретом; фото — только https', async () => {
  assert.equal((await shop.call(8002, 'GET', '/shop-api/admin/products')).status, 403);
  assert.equal((await shop.call(null, 'GET', '/shop-api/admin/products', undefined, { 'X-Webhook-Secret': 'wrong' })).status, 401);
  assert.equal((await shop.call(null, 'GET', '/shop-api/admin/products', undefined, { 'X-Webhook-Secret': 'crm-secret-test' })).status, 200);
  const [product] = await actions.productsInStock();
  assert.equal((await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${product.id}/photo-url`, { url: 'http://example.com/a.jpg' })).status, 400);
});
