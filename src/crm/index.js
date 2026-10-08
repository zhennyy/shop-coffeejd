// crm.js — отправка заказов в CRM по webhook. Включается переменными CRM_URL и CRM_SECRET;
// без них ничего не делает. Сбой CRM никогда не мешает магазину: ошибки только в лог.
const axios = require('axios');
const db = require('../database');

async function push(orderId) {
  const url = process.env.CRM_URL, secret = process.env.CRM_SECRET;
  if (!url || !secret) return;
  try {
    const { getOrder } = require('../orders');
    const o = getOrder(orderId);
    if (!o) return;
    const name = db.prepare('SELECT name FROM user_settings WHERE chat_id = ?').get(o.chat_id)?.name || '';
    const body = {
      source: process.env.CRM_SOURCE || 'coffeejd',
      customer: { external_id: String(o.chat_id), name },
      order: {
        id: String(o.id), code: o.code, status: o.base, total: o.total, delivery_cost: o.delivery_cost || 0,
        address: o.address || '', track: o.track || '',
        items: o.items.map((i) => { const u = require('../inventory/quantity').asUnit({ name: i.name, unit: i.unit }, i.quantity, i.price); return { name: u.name, qty: u.quantity, price: u.price }; }),
      },
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await axios.post(url, body, { headers: { 'X-Webhook-Secret': secret }, timeout: 8000 });
        return;
      } catch (e) {
        if (e.response && e.response.status < 500) { console.warn('CRM отклонила заказ', o.code, e.response.status, e.response.data?.error || ''); return; }
        if (attempt === 3) console.warn('CRM недоступна, заказ', o.code, 'не отправлен:', e.message);
        else await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  } catch (e) { console.warn('CRM:', e.message); }
}

module.exports = { push: (id) => { push(id); } }; // не ждём ответа CRM
