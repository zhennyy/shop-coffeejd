// Склад: выгрузка и загрузка Excel/CSV, наборы из файла, пример «чай — 10 сортов», защита от формул
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const testHelpers = require('../server/test-helpers');

let shop;
let actions;
let inventory;
let stockFiles;

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
  inventory = require('./index');
  stockFiles = require('./import-export');
});

const findProductByName = (name) => shop.database.product.findFirst({ where: { name } });

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
  const oldStock = (await actions.findProduct(editedProductId)).stock;
  editedRow.getCell(7).value = oldStock + 11;
  worksheet.addRow(['', 'Новый на вес', '', '', 'Кофе', 600, 2000, '', 'на вес', '', '', 50, 100]);
  worksheet.addRow(['', 'Новый доп', '', '', '', 99, 40, '', 'доп', '*', '', '', '']);
  worksheet.addRow(['', 'Плохая цена', '', '', '', 'abc', 5, '', '', '', '', '', '']);
  const importResult = await stockFiles.importXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(importResult.updated, 1);
  assert.equal(importResult.created, 2);
  assert.equal(importResult.errors.length, 1, JSON.stringify(importResult));
  assert.equal((await actions.findProduct(editedProductId)).stock, oldStock + 11);
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
  assert.equal(bundle.stock, Math.floor((await actions.findProduct(component.id)).stock / 2));
  const brokenImport = await stockFiles.importCsv('название;цена_руб;остаток;тип;состав\nКривой;100;0;набор;Нет такого×2');
  assert.match(brokenImport.errors[0], /такого товара нет/);
});

test('на объём (мл) и пример «чай — 10 сортов» загружается целиком', async () => {
  const volumeProductId = await actions.createProduct({ name: 'Сироп на розлив', unit: 'ml', price: 180, stock: 5000, step: 50, min_qty: 100 });
  assert.equal((await actions.findProduct(volumeProductId)).unit, 'ml');
  assert.equal((await shop.call(6001, 'POST', '/shop-api/cart', { product_id: volumeProductId, qty: 125 })).status, 400);
  assert.equal((await shop.call(6001, 'POST', '/shop-api/cart', { product_id: volumeProductId, qty: 250 })).status, 200);
  const importResult = await stockFiles.importXlsx(fs.readFileSync(path.join(__dirname, '..', '..', 'примеры', 'чай-10-сортов.xlsx')));
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

test('CSV: формулы экранируются при выгрузке и не портят названия при загрузке', async () => {
  await shop.database.product.create({ data: { name: '=HYPERLINK("x")', price: 100, stock: 1 } });
  const exportedCsv = await stockFiles.exportCsv();
  assert.match(exportedCsv, /'=HYPERLINK/);
  assert.doesNotMatch(exportedCsv, /(^|;)=HYPERLINK/m);
  const productsBefore = await shop.database.product.count();
  await stockFiles.importCsv(exportedCsv);
  assert.equal(await shop.database.product.count(), productsBefore); // повторная загрузка ничего не дублирует
  assert.equal(await shop.database.product.count({ where: { name: { startsWith: "'=" } } }), 0);
});
