// Отправка заказов в CRM по webhook. Включается переменными CRM_URL и CRM_SECRET; без них ничего не делает.
// Сбой CRM никогда не мешает магазину: ошибки только в лог.
const axios = require('axios');
const customers = require('../customers');
const { asReceiptLine } = require('../inventory/quantity');

const MAX_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1500;

async function sendOrderToCrm(orderId) {
  const crmUrl = process.env.CRM_URL;
  const crmSecret = process.env.CRM_SECRET;
  if (!crmUrl || !crmSecret) return;
  try {
    const { getOrder } = require('../orders');
    const order = await getOrder(orderId);
    if (!order) return;
    const requestBody = {
      source: process.env.CRM_SOURCE || 'coffeejd',
      customer: { external_id: String(order.chat_id), name: (await customers.getName(order.chat_id)) || '' },
      order: {
        id: String(order.id), code: order.code, status: order.base, total: order.total, delivery_cost: order.delivery_cost || 0,
        address: order.address || '', track: order.track || '',
        items: order.items.map((orderItem) => {
          const receiptLine = asReceiptLine({ name: orderItem.name, unit: orderItem.unit }, orderItem.quantity, orderItem.price);
          return { name: receiptLine.name, qty: receiptLine.quantity, price: receiptLine.price };
        }),
      },
    };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await axios.post(crmUrl, requestBody, { headers: { 'X-Webhook-Secret': crmSecret }, timeout: 8000 });
        return;
      } catch (requestError) {
        if (requestError.response && requestError.response.status < 500) {
          console.warn('CRM отклонила заказ', order.code, requestError.response.status, requestError.response.data?.error || '');
          return;
        }
        if (attempt === MAX_ATTEMPTS) console.warn('CRM недоступна, заказ', order.code, 'не отправлен:', requestError.message);
        else await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS * attempt));
      }
    }
  } catch (crmError) {
    console.warn('CRM:', crmError.message);
  }
}

// Не ждём ответа CRM: заказ оформляется дальше, отправка идёт в фоне
const pushOrder = (orderId) => { sendOrderToCrm(orderId); };

module.exports = { pushOrder };
