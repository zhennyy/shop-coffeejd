// Отчёты для владелицы: продажи, остатки, движение товара. Чат (коротко) и Excel (подробно).
const { database, toSqliteTimestamp } = require('../database');
const inventory = require('../inventory');
const orders = require('../orders');

const DAY_MS = 864e5;
const MAX_REPORT_DAYS = 366;
const MAX_STOCK_MOVES = 2000;
const UNIT_LABELS = { g: 'г', ml: 'мл' };
const DELIVERY_METHOD_NAMES = { pickup: 'Самовывоз', city: 'Курьер по городу', post: 'СДЭК / Почта', distance: 'По расстоянию' };

const formatRubles = (kopecks) => Math.round(kopecks / 100).toLocaleString('ru-RU') + ' ₽';
const clampDays = (days) => Math.min(MAX_REPORT_DAYS, Math.max(1, parseInt(days, 10) || 30));
const quantityText = (unit, quantity) => `${quantity} ${UNIT_LABELS[unit] || 'шт.'}`;
const isLowStock = (product) => product.stock <= (product.unit ? 1000 : 3);

// Сумма значений по ключу: Map(ключ → накопитель)
function groupInto(rows, keyOf, createAccumulator, addRow) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, createAccumulator(row));
    addRow(groups.get(key), row);
  }
  return [...groups.values()];
}

async function buildReport(requestedDays = 30) {
  const days = clampDays(requestedDays);
  const periodStart = toSqliteTimestamp(Date.now() - days * DAY_MS);

  const paidOrders = (await database.order.findMany({ where: { paid_at: { gte: periodStart } } }))
    .filter((order) => orders.PAID_STATUSES.has(orders.baseStatus(order.status)));
  const ordersSummary = {
    n: paidOrders.length,
    revenue: paidOrders.reduce((sum, order) => sum + order.total, 0),
    delivery: paidOrders.reduce((sum, order) => sum + (order.delivery_cost || 0), 0),
    promo: paidOrders.filter((order) => order.discount_percent > 0).length,
  };

  const soldItems = await orders.getOrderItems(paidOrders.map((order) => order.id));
  const byProduct = groupInto(
    soldItems,
    (orderItem) => orderItem.product_id,
    (orderItem) => ({ name: orderItem.name || 'удалённый товар', unit: orderItem.unit, qty: 0, revenue: 0 }),
    (productTotals, orderItem) => { productTotals.qty += orderItem.quantity; productTotals.revenue += orderItem.quantity * orderItem.price; },
  ).sort((first, second) => second.revenue - first.revenue);

  const byMethod = groupInto(
    paidOrders,
    (order) => order.delivery_method || 'старые заказы',
    (order) => ({ method: order.delivery_method || 'старые заказы', n: 0, revenue: 0 }),
    (methodTotals, order) => { methodTotals.n += 1; methodTotals.revenue += order.total; },
  ).sort((first, second) => second.n - first.n);

  const bundleIds = await inventory.getBundleIds();
  const stock = (await database.product.findMany({
    select: { id: true, name: true, unit: true, stock: true, is_addon: true },
    orderBy: [{ is_addon: 'asc' }, { stock: 'asc' }, { name: 'asc' }],
  })).map((product) => ({ ...product, bundle: bundleIds.has(product.id), low: isLowStock(product) }));

  const stockLogEntries = await database.stockLogEntry.findMany({ where: { ts: { gte: periodStart } }, orderBy: { id: 'desc' }, take: MAX_STOCK_MOVES });
  const loggedProducts = await database.product.findMany({
    where: { id: { in: [...new Set(stockLogEntries.map((logEntry) => logEntry.product_id))] } },
    select: { id: true, name: true, unit: true },
  });
  const loggedProductById = new Map(loggedProducts.map((product) => [product.id, product]));
  const moves = stockLogEntries.map((logEntry) => ({
    ts: logEntry.ts, name: loggedProductById.get(logEntry.product_id)?.name ?? null, unit: loggedProductById.get(logEntry.product_id)?.unit ?? null,
    delta: logEntry.delta, after: logEntry.after, reason: logEntry.reason, order_id: logEntry.order_id,
  }));

  return {
    days, orders: ordersSummary, avg: ordersSummary.n ? Math.round(ordersSummary.revenue / ordersSummary.n) : 0,
    byProduct, byMethod, stock, moves,
  };
}

async function reportText(requestedDays = 30) {
  const report = await buildReport(requestedDays);
  const lines = [`📊 Отчёт за ${report.days} дн.`, '',
    `Оплачено заказов: ${report.orders.n}`,
    `Выручка: ${formatRubles(report.orders.revenue)} (из них доставка ${formatRubles(report.orders.delivery)})`,
    `Средний чек: ${formatRubles(report.avg)}`];
  if (report.orders.promo) lines.push(`С промокодом: ${report.orders.promo}`);
  if (report.byProduct.length) {
    lines.push('', 'Лучшие товары:');
    report.byProduct.slice(0, 5).forEach((product, position) =>
      lines.push(`${position + 1}. ${product.name} — ${quantityText(product.unit, product.qty)}, ${formatRubles(product.revenue)}`));
  }
  if (report.byMethod.length) {
    lines.push('', 'Способы получения: ' + report.byMethod.map((methodTotals) => `${DELIVERY_METHOD_NAMES[methodTotals.method] || methodTotals.method} — ${methodTotals.n}`).join(', '));
  }
  const runningLow = report.stock.filter((product) => product.low && !product.is_addon && !product.bundle);
  if (runningLow.length) {
    lines.push('', 'Заканчивается: ' + runningLow.slice(0, 8).map((product) => `${product.name} (${product.stock <= 0 ? 'нет' : quantityText(product.unit, product.stock)})`).join(', '));
  }
  lines.push('', 'Подробный отчёт в Excel — командой /report ' + report.days + ' file или кнопкой в админке.');
  return lines.join('\n');
}

// Excel не должен исполнять текст как формулу
const protectFromFormula = (value) => (typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value);

async function reportXlsx(requestedDays = 30) {
  const ExcelJS = require('exceljs');
  const report = await buildReport(requestedDays);
  const workbook = new ExcelJS.Workbook();
  const addSheet = (sheetName, headerRow, rows, columnWidths) => {
    const worksheet = workbook.addWorksheet(sheetName);
    worksheet.addRow(headerRow).font = { bold: true };
    rows.forEach((row) => worksheet.addRow(row.map(protectFromFormula)));
    worksheet.columns.forEach((column, columnIndex) => { column.width = columnWidths[columnIndex] || 14; });
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  };
  addSheet('Итоги', ['Показатель', 'Значение'], [
    ['Период, дней', report.days], ['Оплачено заказов', report.orders.n], ['Выручка, ₽', report.orders.revenue / 100],
    ['в том числе доставка, ₽', report.orders.delivery / 100], ['Средний чек, ₽', report.avg / 100], ['Заказов с промокодом', report.orders.promo],
  ], [30, 16]);
  addSheet('Продажи по товарам', ['Товар', 'Продано', 'Ед.', 'Сумма до скидок, ₽'],
    report.byProduct.map((product) => [product.name, product.qty, UNIT_LABELS[product.unit] || 'шт.', product.revenue / 100]), [42, 10, 6, 18]);
  addSheet('Способы получения', ['Способ', 'Заказов', 'Выручка, ₽'],
    report.byMethod.map((methodTotals) => [DELIVERY_METHOD_NAMES[methodTotals.method] || methodTotals.method, methodTotals.n, methodTotals.revenue / 100]), [24, 10, 14]);
  addSheet('Остатки', ['id', 'Товар', 'Остаток', 'Ед.', 'Тип', 'Мало'],
    report.stock.map((product) => [product.id, product.name, product.stock, UNIT_LABELS[product.unit] || 'шт.',
      product.bundle ? 'набор' : product.is_addon ? 'доп' : 'товар', product.low && !product.is_addon && !product.bundle ? 'да' : '']), [6, 42, 10, 6, 8, 7]);
  addSheet('Движение товара', ['Дата (UTC)', 'Товар', 'Изменение', 'Остаток после', 'Причина', 'Заказ'],
    report.moves.map((move) => [move.ts, move.name || '—', move.delta, move.after, move.reason, move.order_id || '']), [20, 42, 11, 14, 28, 8]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildReport, reportText, reportXlsx };
