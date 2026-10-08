const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let shop;
let inventory;
let stockFiles;
const OWNER_ID = 1001;
const BUYER_ID = 6001;

const createProduct = async (productForm) => {
  const response = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products', productForm);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.id;
};
const findProduct = (productId) => shop.database.product.findUnique({ where: { id: productId } });
const findProductByName = (name) => shop.database.product.findFirst({ where: { name } });
const findOrder = (orderId) => shop.database.order.findUnique({ where: { id: orderId } });
const countProducts = () => shop.database.product.count();
const lastPayment = () => [...shop.payments.values()].pop();
const payLastOrder = async () => {
  const payment = lastPayment();
  payment.status = 'succeeded';
  await fetch(shop.base + '/yookassa-webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'payment.succeeded', object: { id: payment.id } }),
  });
  return payment;
};
const buy = async (chatId, productQuantities) => {
  await shop.database.cartItem.deleteMany({ where: { chat_id: chatId } });
  for (const [productId, quantity] of productQuantities) {
    const response = await shop.call(chatId, 'POST', '/shop-api/cart', { product_id: productId, qty: quantity });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  return shop.call(chatId, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
};

before(async () => {
  shop = await helpers.start();
  inventory = require('../src/inventory');
  stockFiles = require('../src/inventory/import-export');
});

test('два параметра выбора: вес и упаковка; второй без первого запрещён', async () => {
  const productId = await createProduct({ name: 'Колумбия', price: 900, stock: 10, option_label: '250 г', option2_label: 'Пакет' });
  const product = await findProduct(productId);
  assert.equal(product.name, 'Колумбия · 250 г · Пакет');
  assert.equal(product.group_key, 'Колумбия');
  assert.equal(product.option2_label, 'Пакет');
  const rejected = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products', { name: 'X', price: 100, stock: 1, option2_label: 'Пакет' });
  assert.equal(rejected.status, 400);
  const catalog = await shop.call(BUYER_ID, 'GET', '/shop-api/catalog');
  assert.equal(catalog.body.products.find((catalogProduct) => catalogProduct.id === productId).option2_label, 'Пакет');
});

test('продажа на вес: шаг и минимум, цена за 100 г, чек одной строкой, склад в граммах', async () => {
  const productId = await createProduct({ name: 'Кофе на развес', unit: 'g', price: 480, stock: 5000, step: 50, min_qty: 100 });
  assert.equal((await findProduct(productId)).price, 480);
  assert.equal((await findProduct(productId)).unit, 'g');
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products', { name: 'Дробная', unit: 'g', price: 480.5, stock: 10 })).status, 400);
  for (const wrongQuantity of [50, 130, 75]) {
    assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: productId, qty: wrongQuantity })).status, 400, 'qty ' + wrongQuantity);
  }
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: productId, qty: 6000 })).status, 400);
  process.env.YOOKASSA_RECEIPTS = 'on';
  const response = await buy(BUYER_ID, [[productId, 300]]);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await findOrder(response.body.id)).total, 300 * 480);
  const payment = lastPayment();
  assert.equal(payment.body.receipt.items.length, 1);
  assert.match(payment.body.receipt.items[0].description, /300 г/);
  assert.equal(payment.body.amount.value, '1440.00');
  process.env.YOOKASSA_RECEIPTS = 'off';
  await payLastOrder();
  assert.equal((await findProduct(productId)).stock, 4700);
  const lastLogEntry = await shop.database.stockLogEntry.findFirst({ where: { product_id: productId }, orderBy: { id: 'desc' } });
  assert.equal(lastLogEntry.delta, -300);
});

test('допы: хранятся как товар с флагом, отдаются в каталоге, не попадают в чат-каталог бота', async () => {
  const baseProductId = await createProduct({ name: 'Кофе для допов', price: 500, stock: 5 });
  const addonId = await createProduct({ name: 'Подарочная упаковка', price: 150, stock: 100, is_addon: true, addon_for: 'Кофе для допов' });
  const catalogProducts = (await shop.call(BUYER_ID, 'GET', '/shop-api/catalog')).body.products;
  const addon = catalogProducts.find((catalogProduct) => catalogProduct.id === addonId);
  assert.equal(addon.is_addon, 1);
  assert.equal(addon.addon_for, 'Кофе для допов');
  const response = await buy(BUYER_ID, [[baseProductId, 1], [addonId, 1]]);
  assert.equal(response.status, 200);
  assert.equal((await findOrder(response.body.id)).total, 65000);
  await payLastOrder();
  assert.equal((await findProduct(addonId)).stock, 99);
});

test('наборы: остаток по составу, оплата списывает компоненты, отмена возвращает', async () => {
  const firstComponentId = await createProduct({ name: 'Набор-А', price: 100, stock: 7 });
  const secondComponentId = await createProduct({ name: 'Набор-Б', price: 100, stock: 3 });
  const bundleParts = [{ product_id: firstComponentId, qty: 2 }, { product_id: secondComponentId, qty: 1 }];
  const bundleId = await createProduct({ name: 'Дегустация 2', price: 1500, stock: 99, bundle: bundleParts });
  assert.equal((await findProduct(bundleId)).stock, 3); // min(7/2=3, 3/1=3)
  const edited = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${bundleId}`, { name: 'Дегустация 2', price: 1500, stock: 50, bundle: bundleParts });
  assert.equal(edited.status, 200);
  assert.equal((await findProduct(bundleId)).stock, 3); // ручной остаток набора игнорируется
  const response = await buy(BUYER_ID, [[bundleId, 2]]);
  assert.equal(response.status, 200);
  await payLastOrder();
  assert.equal((await findProduct(firstComponentId)).stock, 3);
  assert.equal((await findProduct(secondComponentId)).stock, 1);
  assert.equal((await findProduct(bundleId)).stock, 1);
  const cancelled = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/orders/${response.body.id}/status`, { status: 'cancelled' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal((await findProduct(firstComponentId)).stock, 7);
  assert.equal((await findProduct(secondComponentId)).stock, 3);
  assert.equal((await findProduct(bundleId)).stock, 3);
  // запреты
  await assert.rejects(() => inventory.setBundle(bundleId, [{ product_id: bundleId, qty: 1 }]), /сам в себя/);
  const otherBundleId = await createProduct({ name: 'Набор-В', price: 10, stock: 1, bundle: [{ product_id: firstComponentId, qty: 1 }] });
  await assert.rejects(() => inventory.setBundle(bundleId, [{ product_id: otherBundleId, qty: 1 }]), /другой набор/);
  const stockChange = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-delta', { changes: [{ name: 'Дегустация 2', delta: -1 }] }, {});
  assert.equal(stockChange.status, 409);
  // удаление компонента не ломает набор
  await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${secondComponentId}/delete`, {});
  assert.equal(await shop.database.bundleItem.count({ where: { product_id: secondComponentId } }), 0);
});

test('Excel (.xlsx): выгрузка → правка → загрузка; новые строки; ошибки не ломают остальное', async () => {
  const ExcelJS = require('exceljs');
  const exportedFile = await stockFiles.exportXlsx();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exportedFile);
  const worksheet = workbook.worksheets[0];
  assert.deepEqual(worksheet.getRow(1).values.slice(1, 5), ['id', 'название', 'вариант', 'вариант2']);
  const unchangedImport = await stockFiles.importXlsx(exportedFile);
  assert.equal(unchangedImport.updated + unchangedImport.created, 0, JSON.stringify(unchangedImport)); // выгрузка без правок ничего не меняет
  assert.deepEqual(unchangedImport.errors, []);
  let editedRow = worksheet.getRow(2);
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    if (worksheet.getRow(rowNumber).getCell(9).value === 'товар') { editedRow = worksheet.getRow(rowNumber); break; }
  }
  const editedProductId = editedRow.getCell(1).value;
  const oldStock = (await findProduct(editedProductId)).stock;
  editedRow.getCell(7).value = oldStock + 11;
  worksheet.addRow(['', 'Новый на вес', '', '', 'Кофе', 600, 2000, '', 'на вес', '', '', 50, 100]);
  worksheet.addRow(['', 'Новый доп', '', '', '', 99, 40, '', 'доп', '*', '', '', '']);
  worksheet.addRow(['', 'Плохая цена', '', '', '', 'abc', 5, '', '', '', '', '', '']);
  const importResult = await stockFiles.importXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(importResult.updated, 1);
  assert.equal(importResult.created, 2);
  assert.equal(importResult.errors.length, 1, JSON.stringify(importResult));
  assert.equal((await findProduct(editedProductId)).stock, oldStock + 11);
  const weightProduct = await findProductByName('Новый на вес');
  assert.equal(weightProduct.unit, 'g');
  assert.equal(weightProduct.price, 600);
  assert.equal(weightProduct.step, 50);
  assert.equal((await findProductByName('Новый доп')).is_addon, 1);
});

test('CSV: набор по составу', async () => {
  const component = await shop.database.product.findFirst({ where: { stock: { gt: 5 } }, select: { id: true } });
  const importResult = await stockFiles.importCsv(`название;цена_руб;остаток;тип;состав\nНабор из CSV;1000;0;набор;${component.id}×2`);
  assert.equal(importResult.created, 1, JSON.stringify(importResult));
  const bundle = await findProductByName('Набор из CSV');
  assert.equal((await inventory.getBundleParts(bundle.id))[0].qty, 2);
  assert.equal(bundle.stock, Math.floor((await findProduct(component.id)).stock / 2));
  const brokenImport = await stockFiles.importCsv('название;цена_руб;остаток;тип;состав\nКривой;100;0;набор;Нет такого×2');
  assert.match(brokenImport.errors[0], /такого товара нет/);
});

test('отчёты: продажи, остатки, движение; отправка владелице', async () => {
  const reports = require('../src/reports');
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

test('подписка и повтор заказа с весовым товаром и набором', async () => {
  const subscriptions = require('../src/subscriptions');
  const weightProductId = await createProduct({ name: 'Весовой для подписки', unit: 'g', price: 500, stock: 3000, step: 50, min_qty: 100 });
  const componentId = await createProduct({ name: 'Компонент П', price: 100, stock: 10 });
  const bundleId = await createProduct({ name: 'Набор для подписки', price: 700, stock: 0, bundle: [{ product_id: componentId, qty: 2 }] });
  const SUBSCRIBER_ID = 6100;
  const response = await buy(SUBSCRIBER_ID, [[weightProductId, 250], [bundleId, 1]]);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await payLastOrder();
  assert.equal((await findProduct(weightProductId)).stock, 2750);
  assert.equal((await findProduct(componentId)).stock, 8);
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

test('на объём (мл) и пример «чай — 10 сортов» загружается целиком', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const volumeProductId = await createProduct({ name: 'Сироп на розлив', unit: 'ml', price: 180, stock: 5000, step: 50, min_qty: 100 });
  assert.equal((await findProduct(volumeProductId)).unit, 'ml');
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: volumeProductId, qty: 125 })).status, 400);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: volumeProductId, qty: 250 })).status, 200);
  const importResult = await stockFiles.importXlsx(fs.readFileSync(path.join(__dirname, '..', 'примеры', 'чай-10-сортов.xlsx')));
  assert.deepEqual(importResult.errors, []);
  assert.equal(importResult.created, 19);
  const icedTea = await shop.database.product.findFirst({ where: { category: 'Чай', name: { contains: 'Холодный чай' } } });
  assert.equal(icedTea.unit, 'ml');
  // 17 строк = 10 карточек чая (+2 набора лежат в категории «Наборы»)
  const importedProducts = await shop.database.product.findMany({ orderBy: { id: 'desc' }, take: 19 });
  const teaCards = new Set(importedProducts.filter((product) => product.category === 'Чай').map((product) => product.group_key ?? product.name));
  assert.equal(teaCards.size, 10);
  const bundle = await findProductByName('Набор «Утёсный вечер»');
  const bundleParts = await inventory.getBundleParts(bundle.id);
  assert.equal(bundleParts.length, 3);
  assert.ok(bundle.stock > 0);
  assert.equal(bundleParts.find((part) => part.name === 'Те Гуань Инь').qty, 100);
});

test('импорт из админки: пример чая и свой файл; покупатель не может', async () => {
  const productsBefore = await countProducts();
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/admin/stock-import', { sample: 'tea' })).status, 403);
  const sampleImport = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-import', { sample: 'tea' });
  assert.equal(sampleImport.status, 200, JSON.stringify(sampleImport.body));
  assert.match(sampleImport.body.text, /Добавлено: 19/);
  assert.equal(await countProducts(), productsBefore + 19);
  const csvBase64 = Buffer.from('название;вариант;категория;цена_руб;остаток\nИмпорт-тест;;Тест;100;5\n', 'utf8').toString('base64');
  const csvImport = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-import', { name: 'x.csv', data: csvBase64 });
  assert.equal(csvImport.status, 200, JSON.stringify(csvImport.body));
  const wrongExtension = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/stock-import', { name: 'x.exe', data: csvBase64 });
  assert.equal(wrongExtension.status, 400);
});
