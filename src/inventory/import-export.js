// Выгрузка и загрузка склада: Excel (.xlsx) и CSV (открывается в Excel/Numbers/Google Таблицах).
// Колонки: id; название; вариант; вариант2; категория; цена_руб; остаток; описание; тип; для_товаров; состав; шаг_г; мин_г
//   тип: товар | на вес | на объём | доп | набор. На вес/объём: цена — за 100 г (мл), целые рубли; остаток, шаг и минимум — в граммах (мл).
//   доп: в «для_товаров» через «|» названия товаров, к которым он предлагается (или *); набор: «состав» вида «12×2; 15×1» (id или точные названия).
// Загрузка: строка с id обновляет цену, остаток (и состав/«для_товаров», если колонка есть); строка без id создаёт товар.
const { database, runInTransaction } = require('../database');
const inventory = require('./index');

const COLUMNS = ['id', 'название', 'вариант', 'вариант2', 'категория', 'цена_руб', 'остаток', 'описание', 'тип', 'для_товаров', 'состав', 'шаг_г', 'мин_г'];
const COLUMN_WIDTHS = [6, 30, 12, 12, 14, 11, 9, 40, 9, 22, 18, 7, 7];
const MAX_FILE_COLUMNS = 30;
const MAX_STOCK = 1e7;
const MAX_PRICE_RUBLES = 1e7;
const DEFAULT_WEIGHT_STEP = 50;
const DEFAULT_WEIGHT_MINIMUM = 100;

// Защита от формул в Excel: «=…», «+…», «-…», «@…» (кроме чисел)
const protectText = (text) => (/^[=+\-@]/.test(text) && Number.isNaN(Number(text)) ? "'" + text : text);
const formatCsvCell = (value) => {
  const cellText = protectText(value == null ? '' : String(value));
  return /[";\n\r]/.test(cellText) ? `"${cellText.replace(/"/g, '""')}"` : cellText;
};
const formatBundleParts = (bundleParts) => bundleParts.map((part) => `${part.product_id}×${part.qty}`).join('; ');

function productType(product, bundleIds) {
  if (bundleIds.has(product.id)) return 'набор';
  if (product.is_addon) return 'доп';
  if (product.unit === 'g') return 'на вес';
  if (product.unit === 'ml') return 'на объём';
  return 'товар';
}

// Строки таблицы склада (массив массивов значений)
async function buildTableRows() {
  const products = await database.product.findMany();
  products.sort((first, second) => (first.is_addon - second.is_addon)
    || compareText(first.category, second.category)
    || compareText(first.group_key ?? first.name, second.group_key ?? second.name)
    || first.price - second.price);
  const bundleIds = await inventory.getBundleIds();
  const tableRows = [];
  for (const product of products) {
    const isSoldByWeight = Boolean(product.unit);
    tableRows.push([
      product.id, product.group_key || product.name, product.option_label || '', product.option2_label || '', product.category || '',
      isSoldByWeight ? product.price : product.price / 100, product.stock, product.description || '',
      productType(product, bundleIds), product.addon_for || '', formatBundleParts(await inventory.getBundleParts(product.id)),
      isSoldByWeight ? product.step : '', isSoldByWeight ? product.min_qty : '',
    ]);
  }
  return tableRows;
}

// Сравнение как в SQLite ORDER BY: пустые значения первыми, затем по кодам символов
function compareText(first, second) {
  if (first == null) return second == null ? 0 : -1;
  if (second == null) return 1;
  return first < second ? -1 : first > second ? 1 : 0;
}

async function exportCsv() {
  const lines = (await buildTableRows()).map((tableRow) => tableRow.map(formatCsvCell).join(';'));
  return '﻿' + [COLUMNS.join(';'), ...lines].join('\r\n'); // «;» и BOM — Excel сразу откроет кириллицу по столбцам
}

async function exportXlsx() {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Склад');
  worksheet.addRow(COLUMNS).font = { bold: true };
  for (const tableRow of await buildTableRows()) worksheet.addRow(tableRow.map((value) => (typeof value === 'string' ? protectText(value) : value)));
  worksheet.columns.forEach((column, columnIndex) => { column.width = COLUMN_WIDTHS[columnIndex]; });
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function parseCsv(csvText) {
  const text = String(csvText).replace(/^﻿/, '');
  const headerLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = [';', '\t', ','].sort((first, second) => headerLine.split(second).length - headerLine.split(first).length)[0];
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let insideQuotes = false;
  for (let position = 0; position < text.length; position++) {
    const character = text[position];
    if (insideQuotes) {
      if (character === '"') {
        if (text[position + 1] === '"') { currentCell += '"'; position++; } else insideQuotes = false;
      } else currentCell += character;
    } else if (character === '"') insideQuotes = true;
    else if (character === delimiter) { currentRow.push(currentCell); currentCell = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[position + 1] === '\n') position++;
      currentRow.push(currentCell); currentCell = '';
      if (currentRow.some((cell) => cell.trim())) rows.push(currentRow);
      currentRow = [];
    } else currentCell += character;
  }
  currentRow.push(currentCell);
  if (currentRow.some((cell) => cell.trim())) rows.push(currentRow);
  return rows;
}

function cellToText(cellValue) {
  if (cellValue == null) return '';
  if (typeof cellValue !== 'object') return String(cellValue);
  if (cellValue.result !== undefined) return cellToText(cellValue.result);
  if (cellValue.richText) return cellValue.richText.map((richTextPart) => richTextPart.text).join('');
  if (cellValue.text !== undefined) return String(cellValue.text);
  if (cellValue instanceof Date) return cellValue.toISOString();
  return '';
}

async function parseXlsx(fileBuffer) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('В файле нет листов');
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (worksheetRow) => {
    const cells = [];
    for (let columnNumber = 1; columnNumber <= Math.min(worksheetRow.cellCount, MAX_FILE_COLUMNS); columnNumber++) {
      cells.push(cellToText(worksheetRow.getCell(columnNumber).value));
    }
    if (cells.some((cell) => cell.trim())) rows.push(cells);
  });
  return rows;
}

const parseNumber = (value) => Number(String(value).replace(/\s/g, '').replace(',', '.'));
const userError = (message) => Object.assign(new Error(message), { expose: true });

// «12×2; Эфиопия×1» → [{product_id, qty}]
async function parseBundleParts(partsText, lineNumber) {
  const bundleParts = [];
  for (const rawPart of String(partsText || '').split(/[;\n]+/).map((part) => part.trim()).filter(Boolean)) {
    const partMatch = rawPart.match(/^(.+?)\s*[x×*хХ]\s*(\d+)$/i);
    const productKey = (partMatch ? partMatch[1] : rawPart).trim();
    const partQuantity = partMatch ? parseInt(partMatch[2], 10) : 1;
    const product = /^\d+$/.test(productKey)
      ? await database.product.findUnique({ where: { id: parseInt(productKey, 10) }, select: { id: true } })
      : await database.product.findFirst({ where: { name: productKey }, select: { id: true } });
    if (!product) throw userError(`строка ${lineNumber}: в составе «${productKey}» — такого товара нет`);
    bundleParts.push({ product_id: product.id, qty: partQuantity });
  }
  return bundleParts;
}

function findColumnIndexes(headerRow) {
  const headers = headerRow.map((header) => String(header).trim().toLowerCase());
  const indexOf = (...possibleNames) => headers.findIndex((header) => possibleNames.includes(header));
  return {
    id: indexOf('id'), name: indexOf('название', 'name'), option: indexOf('вариант', 'option'), option2: indexOf('вариант2', 'option2'),
    category: indexOf('категория', 'category'), price: indexOf('цена_руб', 'цена', 'price', 'price_rub'), stock: indexOf('остаток', 'stock'),
    description: indexOf('описание', 'description'), type: indexOf('тип', 'type'), addonFor: indexOf('для_товаров', 'addon_for'),
    bundleParts: indexOf('состав', 'bundle'), step: indexOf('шаг_г', 'шаг', 'step'), minimum: indexOf('мин_г', 'мин', 'min'),
  };
}

// Обновить существующий товар по строке файла. Возвращает true, если что-то изменилось.
async function updateProductFromRow(existingProduct, rowData, columns, pendingBundles) {
  const { lineNumber, priceRubles, stock, readCell } = rowData;
  const isSoldByWeight = Boolean(existingProduct.unit);
  let newPrice = existingProduct.price;
  if (priceRubles !== null) {
    if (isSoldByWeight && !Number.isInteger(priceRubles)) throw userError(`строка ${lineNumber}: цена за 100 г — целые рубли`);
    newPrice = isSoldByWeight ? priceRubles : Math.round(priceRubles * 100);
  }
  const isBundleRow = (await inventory.isBundle(existingProduct.id)) || (columns.bundleParts >= 0 && readCell(columns.bundleParts));
  let isChanged = false;
  if (newPrice !== existingProduct.price) {
    await database.product.update({ where: { id: existingProduct.id }, data: { price: newPrice } });
    isChanged = true;
  }
  if (stock !== null && !isBundleRow && stock !== existingProduct.stock) {
    await inventory.setStock(existingProduct.id, stock, 'загрузка файла');
    isChanged = true;
  }
  if (columns.addonFor >= 0 && existingProduct.is_addon && readCell(columns.addonFor) !== (existingProduct.addon_for || '')) {
    await database.product.update({ where: { id: existingProduct.id }, data: { addon_for: readCell(columns.addonFor) || null } });
    isChanged = true;
  }
  if (columns.bundleParts >= 0 && readCell(columns.bundleParts) !== formatBundleParts(await inventory.getBundleParts(existingProduct.id))) {
    pendingBundles.push({ bundleId: existingProduct.id, partsText: readCell(columns.bundleParts), lineNumber });
    isChanged = true;
  }
  return isChanged;
}

// Создать товар по строке файла без id
async function createProductFromRow(rowData, columns, pendingBundles) {
  const { lineNumber, priceRubles, stock, readCell, productTypeName } = rowData;
  const baseName = readCell(columns.name);
  const optionLabel = readCell(columns.option);
  const option2Label = readCell(columns.option2);
  if (!baseName || priceRubles === null) throw userError(`строка ${lineNumber}: для нового товара нужны название и цена`);
  const compactType = productTypeName.replace(/\s/g, '');
  const unit = compactType === 'навес' ? 'g' : compactType === 'наобъём' || compactType === 'наобъем' ? 'ml' : null;
  const isSoldByWeight = Boolean(unit);
  if (isSoldByWeight && !Number.isInteger(priceRubles)) throw userError(`строка ${lineNumber}: цена за 100 г — целые рубли`);
  const isAddon = productTypeName === 'доп';
  const createdProduct = await database.product.create({
    data: {
      name: [baseName, optionLabel, option2Label].filter(Boolean).join(' · '),
      description: readCell(columns.description) || null,
      price: isSoldByWeight ? priceRubles : Math.round(priceRubles * 100),
      stock: stock ?? 0,
      category: readCell(columns.category) || null,
      group_key: optionLabel || option2Label ? baseName : null,
      option_label: optionLabel || null,
      option2_label: option2Label || null,
      unit,
      step: isSoldByWeight ? Math.max(1, parseInt(readCell(columns.step), 10) || DEFAULT_WEIGHT_STEP) : 1,
      min_qty: isSoldByWeight ? Math.max(1, parseInt(readCell(columns.minimum), 10) || DEFAULT_WEIGHT_MINIMUM) : 1,
      is_addon: isAddon ? 1 : 0,
      addon_for: isAddon ? (readCell(columns.addonFor) || '*') : null,
    },
  });
  await inventory.writeStockLog(createdProduct.id, stock ?? 0, stock ?? 0, 'добавлен загрузкой файла');
  if (productTypeName === 'набор') pendingBundles.push({ bundleId: createdProduct.id, partsText: readCell(columns.bundleParts), lineNumber });
}

async function importRows(rows) {
  if (rows.length < 2) throw new Error('В файле нет строк с товарами');
  const columns = findColumnIndexes(rows[0]);
  if (columns.stock < 0 && columns.price < 0) throw new Error('Не нашла колонки «остаток» или «цена_руб» — берите файл из выгрузки');
  const importResult = { updated: 0, created: 0, unchanged: 0, errors: [] };
  // составы наборов применяем после всех строк — в них могут быть только что созданные товары по названию
  const pendingBundles = [];

  await runInTransaction(async () => {
    for (const [rowIndex, fileRow] of rows.slice(1).entries()) {
      const lineNumber = rowIndex + 2;
      // «'=…» из нашей же выгрузки — возвращаем как было
      const readCell = (columnIndex) => (columnIndex >= 0 ? String(fileRow[columnIndex] ?? '').trim().replace(/^'(?=[=+\-@])/, '') : '');
      try {
        const stock = readCell(columns.stock) === '' ? null : parseNumber(readCell(columns.stock));
        if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > MAX_STOCK)) throw userError(`строка ${lineNumber}: остаток «${readCell(columns.stock)}» не подходит`);
        const priceRubles = readCell(columns.price) === '' ? null : parseNumber(readCell(columns.price));
        if (priceRubles !== null && (!Number.isFinite(priceRubles) || priceRubles <= 0 || priceRubles > MAX_PRICE_RUBLES)) {
          throw userError(`строка ${lineNumber}: цена «${readCell(columns.price)}» не подходит`);
        }
        const rowData = { lineNumber, priceRubles, stock, readCell, productTypeName: readCell(columns.type).toLowerCase() };
        const productId = readCell(columns.id);
        if (productId) {
          const existingProduct = await database.product.findUnique({ where: { id: parseInt(productId, 10) } });
          if (!existingProduct) throw userError(`строка ${lineNumber}: товара с id ${productId} нет`);
          if (await updateProductFromRow(existingProduct, rowData, columns, pendingBundles)) importResult.updated++;
          else importResult.unchanged++;
        } else {
          await createProductFromRow(rowData, columns, pendingBundles);
          importResult.created++;
        }
      } catch (rowError) {
        if (!rowError.expose) throw rowError;
        importResult.errors.push(rowError.message);
      }
    }
    for (const { bundleId, partsText, lineNumber } of pendingBundles) {
      try {
        await inventory.setBundle(bundleId, await parseBundleParts(partsText, lineNumber));
      } catch (bundleError) {
        if (!bundleError.expose) throw bundleError;
        importResult.errors.push(`строка ${lineNumber}: ${bundleError.message.replace(/^строка \d+: /, '')}`);
      }
    }
    await inventory.syncBundles();
  });
  return importResult;
}

const importCsv = (csvText) => importRows(parseCsv(csvText));
const importXlsx = async (fileBuffer) => importRows(await parseXlsx(fileBuffer));

const importReportText = (importResult) => `📥 Склад обновлён\nИзменено: ${importResult.updated} · Добавлено: ${importResult.created} · Без изменений: ${importResult.unchanged}` +
  (importResult.errors.length
    ? `\n\n⚠️ Пропущено ${importResult.errors.length}:\n` + importResult.errors.slice(0, 10).join('\n') + (importResult.errors.length > 10 ? '\n…' : '')
    : '');

module.exports = { exportCsv, exportXlsx, importCsv, importXlsx, importRows, parseCsv, parseXlsx, importReportText, COLUMNS };
