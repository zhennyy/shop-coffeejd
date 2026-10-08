// Запросы к API ЮKassa: создать платёж и узнать его статус
const axios = require('axios');
const { v4: createUuid } = require('uuid');

const YOOKASSA_API = 'https://api.yookassa.ru/v3/payments';
const credentials = () => ({ username: process.env.YOOKASSA_SHOP_ID, password: process.env.YOOKASSA_SECRET_KEY });

async function createPayment(orderId, amountRubles, description, fiscalReceipt) {
  const response = await axios.post(
    YOOKASSA_API,
    {
      amount: { value: amountRubles.toFixed(2), currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: `https://t.me/${process.env.BOT_USERNAME}` },
      capture: true,
      description,
      metadata: { order_id: orderId, app: 'coffeejdbot' },
      ...(fiscalReceipt ? { receipt: fiscalReceipt } : {}),
    },
    { auth: credentials(), headers: { 'Idempotence-Key': createUuid() } },
  );
  return response.data; // содержит .confirmation.confirmation_url и .id
}

async function getPayment(paymentId) {
  const response = await axios.get(`${YOOKASSA_API}/${paymentId}`, { auth: credentials() });
  return response.data;
}

module.exports = { createPayment, getPayment };
