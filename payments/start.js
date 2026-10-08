// payments/start.js — единая точка создания платежа для заказа (витрина, чат, повторные заказы): чек, статус, id платежа.
const db = require('../db');
const { createPayment } = require('./yookassa');
const receipt = require('./receipt');

async function startPayment(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new Error('Заказ не найден');
  const code = o.order_code || String(o.id);
  let rc;
  if (receipt.enabled()) {
    const items = db.prepare(`SELECT p.name, p.unit, oi.quantity, oi.price FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(orderId)
      .map((i) => require('../qty').asUnit({ name: i.name || 'Товар', unit: i.unit }, i.quantity, i.price));
    rc = receipt.buildReceipt({ items, goodsTotal: o.total - (o.delivery_cost || 0), delivery: o.delivery_cost || 0, contact: receipt.contactFrom(o.contact) });
  }
  const payment = await createPayment(orderId, o.total / 100, `Заказ #${code} в CoFFeeJD`, rc);
  db.prepare('UPDATE orders SET status = ?, payment_id = ? WHERE id = ?').run(`awaiting_payment:${payment.id}`, payment.id, orderId);
  return payment;
}
module.exports = { startPayment };
