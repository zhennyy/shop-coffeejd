// reports.js — отчёты для владелицы: продажи, остатки, движение товара. Чат (коротко) и Excel (подробно).
const db = require('./db');
const inv = require('./inventory');

const PAID_SQL = "('paid','assembling','shipped','delivered')";
const rub = (kop) => Math.round(kop / 100).toLocaleString('ru-RU') + ' ₽';
const clampDays = (d) => Math.min(366, Math.max(1, parseInt(d, 10) || 30));
const qtyTxt = (unit, q) => (unit === 'g' ? `${q} г` : `${q} шт.`);

function build(daysIn = 30) {
  const days = clampDays(daysIn);
  const since = `-${days} days`;
  const orders = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) revenue, COALESCE(SUM(delivery_cost),0) delivery, COALESCE(SUM(CASE WHEN discount_percent > 0 THEN 1 ELSE 0 END),0) promo
                             FROM orders WHERE substr(status, 1, instr(status || ':', ':') - 1) IN ${PAID_SQL} AND paid_at >= datetime('now', ?)`).get(since);
  const byProduct = db.prepare(`SELECT COALESCE(p.name, 'удалённый товар') name, p.unit, SUM(oi.quantity) qty, SUM(oi.quantity * oi.price) revenue
                                FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id
                                WHERE substr(o.status, 1, instr(o.status || ':', ':') - 1) IN ${PAID_SQL} AND o.paid_at >= datetime('now', ?)
                                GROUP BY oi.product_id ORDER BY revenue DESC`).all(since);
  const byMethod = db.prepare(`SELECT COALESCE(delivery_method, 'старые заказы') method, COUNT(*) n, SUM(total) revenue FROM orders
                               WHERE substr(status, 1, instr(status || ':', ':') - 1) IN ${PAID_SQL} AND paid_at >= datetime('now', ?) GROUP BY delivery_method ORDER BY n DESC`).all(since);
  const stock = db.prepare(`SELECT id, name, unit, stock, is_addon FROM products ORDER BY is_addon, stock, name`).all()
    .map((p) => ({ ...p, bundle: inv.isBundle(p.id), low: p.stock <= (p.unit === 'g' ? 1000 : 3) }));
  const moves = db.prepare(`SELECT l.ts, p.name, p.unit, l.delta, l.after, l.reason, l.order_id FROM stock_log l LEFT JOIN products p ON p.id = l.product_id
                            WHERE l.ts >= datetime('now', ?) ORDER BY l.id DESC LIMIT 2000`).all(since);
  return { days, orders, avg: orders.n ? Math.round(orders.revenue / orders.n) : 0, byProduct, byMethod, stock, moves };
}

const METHOD = { pickup: 'Самовывоз', city: 'Курьер по городу', post: 'СДЭК / Почта', distance: 'По расстоянию' };

function text(daysIn = 30) {
  const r = build(daysIn);
  const lines = [`📊 Отчёт за ${r.days} дн.`, '',
    `Оплачено заказов: ${r.orders.n}`, `Выручка: ${rub(r.orders.revenue)} (из них доставка ${rub(r.orders.delivery)})`, `Средний чек: ${rub(r.avg)}`];
  if (r.orders.promo) lines.push(`С промокодом: ${r.orders.promo}`);
  if (r.byProduct.length) {
    lines.push('', 'Лучшие товары:');
    r.byProduct.slice(0, 5).forEach((p, i) => lines.push(`${i + 1}. ${p.name} — ${qtyTxt(p.unit, p.qty)}, ${rub(p.revenue)}`));
  }
  if (r.byMethod.length) lines.push('', 'Способы получения: ' + r.byMethod.map((m) => `${METHOD[m.method] || m.method} — ${m.n}`).join(', '));
  const low = r.stock.filter((p) => p.low && !p.is_addon && !p.bundle);
  if (low.length) lines.push('', 'Заканчивается: ' + low.slice(0, 8).map((p) => `${p.name} (${p.stock <= 0 ? 'нет' : qtyTxt(p.unit, p.stock)})`).join(', '));
  lines.push('', 'Подробный отчёт в Excel — командой /report ' + r.days + ' file или кнопкой в админке.');
  return lines.join('\n');
}

async function xlsx(daysIn = 30) {
  const ExcelJS = require('exceljs');
  const r = build(daysIn);
  const wb = new ExcelJS.Workbook();
  const sheet = (name, head, rows, widths) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(head).font = { bold: true };
    rows.forEach((x) => ws.addRow(x.map((v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v))));
    ws.columns.forEach((c, i) => { c.width = widths[i] || 14; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  sheet('Итоги', ['Показатель', 'Значение'], [
    ['Период, дней', r.days], ['Оплачено заказов', r.orders.n], ['Выручка, ₽', r.orders.revenue / 100], ['в том числе доставка, ₽', r.orders.delivery / 100],
    ['Средний чек, ₽', r.avg / 100], ['Заказов с промокодом', r.orders.promo]], [30, 16]);
  sheet('Продажи по товарам', ['Товар', 'Продано', 'Ед.', 'Сумма до скидок, ₽'], r.byProduct.map((p) => [p.name, p.qty, p.unit === 'g' ? 'г' : 'шт.', p.revenue / 100]), [42, 10, 6, 18]);
  sheet('Способы получения', ['Способ', 'Заказов', 'Выручка, ₽'], r.byMethod.map((m) => [METHOD[m.method] || m.method, m.n, m.revenue / 100]), [24, 10, 14]);
  sheet('Остатки', ['id', 'Товар', 'Остаток', 'Ед.', 'Тип', 'Мало'], r.stock.map((p) => [p.id, p.name, p.stock, p.unit === 'g' ? 'г' : 'шт.', p.bundle ? 'набор' : p.is_addon ? 'доп' : 'товар', p.low && !p.is_addon && !p.bundle ? 'да' : '']), [6, 42, 10, 6, 8, 7]);
  sheet('Движение товара', ['Дата (UTC)', 'Товар', 'Изменение', 'Остаток после', 'Причина', 'Заказ'], r.moves.map((m) => [m.ts, m.name || '—', m.delta, m.after, m.reason, m.order_id || '']), [20, 42, 11, 14, 28, 8]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { build, text, xlsx };
