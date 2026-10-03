// subscriptions.js — повторные заказы по расписанию («кофе каждые 2 недели»).
// Деньги автоматически НЕ списываются: в нужный день бот собирает новый заказ по текущим ценам и присылает ссылку на оплату —
// покупатель платит одним нажатием (или пропускает). Так нет ни скрытых списаний, ни юридических рисков с сохранёнными картами.
const db = require('./db');
const core = require('./checkout-core');
const { createPendingOrder } = require('./scenes/checkout');
const { startPayment } = require('./payments/start');
const receipt = require('./payments/receipt');

const INTERVALS = [7, 14, 21, 30, 60];
const mskDate = (ms = Date.now()) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(new Date(date + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const err = core.err;

// Подписка из прошлого заказа (того же покупателя)
function create(chatId, orderId, intervalDays) {
  if (!INTERVALS.includes(intervalDays)) throw err('Выберите период: 1, 2, 3 или 4 недели, либо раз в 2 месяца');
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND chat_id = ?').get(orderId, chatId);
  if (!o) throw err('Заказ не найден');
  if (!['paid', 'assembling', 'shipped', 'delivered'].includes(String(o.status).split(':')[0])) throw err('Подписку можно оформить на оплаченный заказ');
  if (!o.delivery_method) throw err('Этот заказ оформлен давно — повторите его вручную, и подписка станет доступна на новом');
  const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
  if (!items.length) throw err('В заказе нет товаров');
  const active = db.prepare('SELECT COUNT(*) n FROM subscriptions WHERE chat_id = ? AND active = 1').get(chatId).n;
  if (active >= 5) throw err('Можно держать не больше 5 активных подписок');
  const r = db.prepare(`INSERT INTO subscriptions (chat_id, items, interval_days, next_date, delivery_method, delivery_city, carrier, address, contact)
                        VALUES (?,?,?,?,?,?,?,?,?)`).run(chatId, JSON.stringify(items), intervalDays, addDays(mskDate(), intervalDays),
    o.delivery_method, o.delivery_city, o.carrier, o.addr_raw, o.contact);
  return Number(r.lastInsertRowid);
}

function list(chatId, lang = 'ru') {
  return db.prepare('SELECT * FROM subscriptions WHERE chat_id = ? ORDER BY active DESC, id DESC').all(chatId).map((s) => ({
    id: s.id, interval_days: s.interval_days, next_date: s.next_date, active: Boolean(s.active), method: s.delivery_method,
    items: JSON.parse(s.items).map((i) => {
      const p = db.prepare('SELECT name, name_en, price, unit FROM products WHERE id = ?').get(i.product_id);
      return { name: p ? ((lang === 'en' && p.name_en) || p.name) : '—', qty: i.quantity, price: p ? p.price : 0, unit: p ? p.unit : null };
    }),
  }));
}
const own = (chatId, id) => {
  const s = db.prepare('SELECT * FROM subscriptions WHERE id = ? AND chat_id = ?').get(id, chatId);
  if (!s) throw err('Подписка не найдена');
  return s;
};
function update(chatId, id, patch) {
  const s = own(chatId, id);
  if (patch.action === 'pause') db.prepare('UPDATE subscriptions SET active = 0 WHERE id = ?').run(s.id);
  else if (patch.action === 'resume') {
    const next = s.next_date < mskDate() ? addDays(mskDate(), 1) : s.next_date; // не присылаем счёт за пропущенные дни
    db.prepare('UPDATE subscriptions SET active = 1, postponed = 0, next_date = ? WHERE id = ?').run(next, s.id);
  } else if (patch.action === 'skip') db.prepare('UPDATE subscriptions SET next_date = ? WHERE id = ?').run(addDays(s.next_date, s.interval_days), s.id);
  else if (patch.action === 'delete') db.prepare('DELETE FROM subscriptions WHERE id = ?').run(s.id);
  else if (patch.action === 'interval') {
    if (!INTERVALS.includes(patch.days)) throw err('Неверный период');
    db.prepare('UPDATE subscriptions SET interval_days = ? WHERE id = ?').run(patch.days, s.id);
  } else throw err('Неизвестное действие');
}

const L = {
  ru: {
    due: (code, total, items) => `🔁 Ваш регулярный заказ № ${code} готов:\n${items}\n\nИтого ${Math.round(total / 100).toLocaleString('ru-RU')} ₽. Нажмите «Оплатить», и мы начнём собирать. Если сейчас не нужно — просто не оплачивайте, ничего не спишется.`,
    pay: '💳 Оплатить', manage: '⚙️ Мои подписки',
    short: (name) => `Регулярный заказ: «${name}» сейчас нет в нужном количестве. Попробуем снова завтра.`,
    paused: 'Регулярный заказ поставлен на паузу: товар долго недоступен или изменились условия доставки. Включить снова можно в разделе «Заказы» магазина.',
  },
  en: {
    due: (code, total, items) => `🔁 Your recurring order № ${code} is ready:\n${items}\n\nTotal ${Math.round(total / 100)} RUB. Tap Pay and we will start packing. If you do not need it now, just do not pay: nothing is charged.`,
    pay: '💳 Pay', manage: '⚙️ My subscriptions',
    short: (name) => `Recurring order: "${name}" is not available in the needed quantity right now. We will try again tomorrow.`,
    paused: 'Your recurring order has been paused: an item has been unavailable for a while or delivery options changed. You can resume it in the shop under Orders.',
  },
};

// Обработать подписки, срок которых наступил. Безопасно вызывать часто: следующая дата сдвигается до создания оплаты.
async function runDue(bot, now = Date.now()) {
  const today = mskDate(now);
  const due = db.prepare('SELECT * FROM subscriptions WHERE active = 1 AND next_date <= ? ORDER BY id').all(today);
  let made = 0;
  for (const s of due) {
    const lang = db.getLang(s.chat_id);
    const tx = L[lang] || L.ru;
    try {
      const items = JSON.parse(s.items).map((i) => {
        const p = db.prepare('SELECT id, name, name_en, price, stock, unit FROM products WHERE id = ?').get(i.product_id);
        return { ...i, p };
      });
      const bad = items.find((i) => !i.p || i.p.stock < i.quantity);
      if (bad) { // нет товара: переносим на завтра, после 3 переносов ставим на паузу
        const n = s.postponed + 1;
        if (n >= 3) {
          db.prepare('UPDATE subscriptions SET active = 0, postponed = 0 WHERE id = ?').run(s.id);
          await bot.telegram.sendMessage(s.chat_id, tx.paused).catch(() => {});
        } else {
          db.prepare('UPDATE subscriptions SET next_date = ?, postponed = ? WHERE id = ?').run(addDays(today, 1), n, s.id);
          await bot.telegram.sendMessage(s.chat_id, tx.short(bad.p ? ((lang === 'en' && bad.p.name_en) || bad.p.name) : '—')).catch(() => {});
        }
        continue;
      }
      const lines = items.map((i) => ({ product_id: i.p.id, quantity: i.quantity, price: i.p.price }));
      const goods = lines.reduce((a, l) => a + l.price * l.quantity, 0);
      let rs;
      try {
        rs = await core.resolve({ method: s.delivery_method, city: s.delivery_city, carrier: s.carrier, addr: s.address }, goods, 0, lang);
      } catch (e) { // способ доставки больше недоступен (выключили, изменился адрес и т.п.)
        db.prepare('UPDATE subscriptions SET active = 0 WHERE id = ?').run(s.id);
        await bot.telegram.sendMessage(s.chat_id, tx.paused).catch(() => {});
        continue;
      }
      if (receipt.enabled() && !receipt.contactFrom(s.contact)) {
        db.prepare('UPDATE subscriptions SET active = 0 WHERE id = ?').run(s.id);
        await bot.telegram.sendMessage(s.chat_id, tx.paused).catch(() => {});
        continue;
      }
      // дата сдвигается ДО создания оплаты: даже если дальше что-то упадёт, дубль заказа не появится
      db.prepare('UPDATE subscriptions SET next_date = ?, postponed = 0 WHERE id = ?').run(addDays(today, s.interval_days), s.id);
      const orderId = createPendingOrder(s.chat_id, rs.address, 'yookassa', rs.total, null, 0, rs.deliveryCity, rs.delivery, rs.method, s.contact,
        { items: lines, carrier: rs.carrier, addrRaw: rs.addrRaw });
      let payment;
      try { payment = await startPayment(orderId); } catch (e) {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND payment_id IS NULL").run(orderId);
        db.prepare('UPDATE subscriptions SET next_date = ? WHERE id = ?').run(addDays(today, 1), s.id); // повторим завтра
        console.error('Подписка: платёж не создался', s.id, e.response?.data || e.message);
        continue;
      }
      db.prepare('UPDATE subscriptions SET last_order_id = ? WHERE id = ?').run(orderId, s.id);
      const code = db.prepare('SELECT order_code FROM orders WHERE id = ?').get(orderId).order_code || orderId;
      const text = tx.due(code, rs.total, items.map((i) => `• ${require('./qty').line(i.p, i.quantity, lang)}`).join('\n'));
      await bot.telegram.sendMessage(s.chat_id, text, { reply_markup: { inline_keyboard: [[{ text: tx.pay, url: payment.confirmation.confirmation_url }]] } }).catch(() => {});
      made++;
    } catch (e) { console.error('Подписка', s.id, e.message); }
  }
  return made;
}

module.exports = { INTERVALS, create, list, update, runDue, mskDate, addDays };
