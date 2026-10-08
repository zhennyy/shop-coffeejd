// Общая обвязка тестов: временная база, подставные ЮKassa/Telegram/геокодер, подписанные запросы витрины.
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.BOT_TOKEN = '123456:TESTTOKEN';
process.env.OWNER_CHAT_ID = '1001';
process.env.CRM_SECRET = 'crm-secret-test';
process.env.YOOKASSA_SHOP_ID = 'shop'; process.env.YOOKASSA_SECRET_KEY = 'key';
process.env.BOT_USERNAME = 'coffeejd_test_bot';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coffeejd-')), 'test.db');
process.env.WEBHOOK_PORT = String(30000 + Math.floor(Math.random() * 20000));

// ---- подставная ЮKassa: запоминаем платежи, чтобы проверять чеки и суммы ----
const axios = require('axios');
const payments = new Map();
let paymentCounter = 0;
axios.post = async (url, body) => {
  if (url.includes('/v3/payments')) {
    const paymentId = 'pay-' + ++paymentCounter;
    payments.set(paymentId, { id: paymentId, body, status: 'pending', metadata: body.metadata, amount: body.amount });
    return { data: { id: paymentId, confirmation: { confirmation_url: 'https://pay.test/' + paymentId } } };
  }
  throw new Error('unexpected POST ' + url);
};
axios.get = async (url) => {
  const paymentMatch = url.match(/payments\/(pay-\d+)/);
  if (paymentMatch) return { data: payments.get(paymentMatch[1]) };
  throw new Error('unexpected GET ' + url);
};

const sentMessages = []; // сообщения «в Telegram»
const fakeBot = {
  telegram: {
    sendMessage: async (chatId, text, extra) => { sentMessages.push({ chat: chatId, text, extra }); return { message_id: sentMessages.length }; },
    editMessageText: async () => ({}), getFileLink: async () => 'https://x', sendDocument: async () => ({}), deleteMessage: async () => ({}),
  },
};

// Подписанные Telegram данные пользователя — как их присылает мини-приложение
function initData(userId, extraFields = {}) {
  const parameters = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'T' }), ...extraFields });
  const dataCheckString = [...parameters.entries()].map(([fieldName, fieldValue]) => `${fieldName}=${fieldValue}`).sort().join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  parameters.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return parameters.toString();
}

async function start() {
  const { initializeDatabase } = require('../src/database/initialize');
  await initializeDatabase();
  const { startWebhookServer } = require('../src/server');
  startWebhookServer(fakeBot, { aiPick: async () => ({ advice: '', ids: [] }) });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const baseUrl = `http://127.0.0.1:${process.env.WEBHOOK_PORT}`;
  const call = (userId, method, urlPath, body, headers = {}) => fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-Init-Data': initData(userId) } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const { database } = require('../src/database');
  return { base: baseUrl, call, payments, sent: sentMessages, bot: fakeBot, database };
}
module.exports = { start, payments, sent: sentMessages, bot: fakeBot, initData };
