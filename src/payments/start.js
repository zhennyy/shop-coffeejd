// Единая точка создания платежа для заказа (витрина, чат, повторные заказы): чек, статус, id платежа
const { database } = require('../database');
const { createPayment } = require('./yookassa');
const receipt = require('./receipt');
const { asReceiptLine } = require('../inventory/quantity');
const { getOrderItems } = require('../orders');

async function startPayment(orderId) {
  const order = await database.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('Заказ не найден');
  const orderCode = order.order_code || String(order.id);
  let fiscalReceipt;
  if (receipt.isEnabled()) {
    const receiptLines = (await getOrderItems([orderId]))
      .map((orderItem) => asReceiptLine({ name: orderItem.name || 'Товар', unit: orderItem.unit }, orderItem.quantity, orderItem.price));
    const deliveryCost = order.delivery_cost || 0;
    fiscalReceipt = receipt.buildReceipt({
      items: receiptLines, goodsTotal: order.total - deliveryCost, delivery: deliveryCost, contact: receipt.contactFrom(order.contact),
    });
  }
  const payment = await createPayment(orderId, order.total / 100, `Заказ #${orderCode} в CoFFeeJD`, fiscalReceipt);
  await database.order.update({ where: { id: orderId }, data: { status: `awaiting_payment:${payment.id}`, payment_id: payment.id } });
  return payment;
}

module.exports = { startPayment };
