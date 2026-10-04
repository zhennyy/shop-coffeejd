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
let payN = 0;
axios.post = async (url, body) => {
  if (url.includes('/v3/payments')) {
    const id = 'pay-' + ++payN;
    payments.set(id, { id, body, status: 'pending', metadata: body.metadata, amount: body.amount });
    return { data: { id, confirmation: { confirmation_url: 'https://pay.test/' + id } } };
  }
  throw new Error('unexpected POST ' + url);
};
axios.get = async (url) => {
  const m = url.match(/payments\/(pay-\d+)/);
  if (m) return { data: payments.get(m[1]) };
  throw new Error('unexpected GET ' + url);
};

const sent = []; // сообщения «в Telegram»
const bot = { telegram: { sendMessage: async (chat, text, extra) => { sent.push({ chat, text, extra }); return { message_id: sent.length }; },
  editMessageText: async () => ({}), getFileLink: async () => 'https://x', sendDocument: async () => ({}), deleteMessage: async () => ({}) } };

function initData(userId, extra = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'T' }), ...extra });
  const data = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return params.toString();
}

async function start() {
  const { startWebhookServer } = require('../webhook');
  startWebhookServer(bot, { aiPick: async () => ({ advice: '', ids: [] }) });
  await new Promise((r) => setTimeout(r, 400));
  const base = `http://127.0.0.1:${process.env.WEBHOOK_PORT}`;
  const call = (user, method, p, body, headers = {}) => fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Init-Data': initData(user) } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { base, call, payments, sent, bot, db: require('../db') };
}
module.exports = { start, payments, sent, bot, initData };
