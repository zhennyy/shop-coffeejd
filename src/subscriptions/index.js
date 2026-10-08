// Повторные заказы по расписанию («кофе каждые 2 недели»).
// Деньги автоматически НЕ списываются: в нужный день бот собирает новый заказ по текущим ценам и присылает ссылку на оплату —
// покупатель платит одним нажатием (или пропускает). Так нет ни скрытых списаний, ни юридических рисков с сохранёнными картами.
const { database } = require('../database');
const { resolveDelivery, userError } = require('../checkout');
const orders = require('../orders');
const { startPayment } = require('../payments/start');
const receipt = require('../payments/receipt');
const customers = require('../customers');
const { formatOrderLine } = require('../inventory/quantity');

const INTERVALS = [7, 14, 21, 30, 60];
const MAX_ACTIVE_SUBSCRIPTIONS = 5;
const MAX_POSTPONEMENTS = 3;
const DAY_MS = 864e5;
const MOSCOW_OFFSET_MS = 3 * 3600e3;

const moscowDate = (timestamp = Date.now()) => new Date(timestamp + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (isoDate, days) => new Date(new Date(isoDate + 'T00:00:00Z').getTime() + days * DAY_MS).toISOString().slice(0, 10);

// Подписка из прошлого заказа того же покупателя
async function createSubscription(chatId, orderId, intervalDays) {
  if (!INTERVALS.includes(intervalDays)) throw userError('Выберите период: 1, 2, 3 или 4 недели, либо раз в 2 месяца');
  const order = await database.order.findFirst({ where: { id: orderId, chat_id: Number(chatId) } });
  if (!order) throw userError('Заказ не найден');
  if (!orders.PAID_STATUSES.has(orders.baseStatus(order.status))) throw userError('Подписку можно оформить на оплаченный заказ');
  if (!order.delivery_method) throw userError('Этот заказ оформлен давно — повторите его вручную, и подписка станет доступна на новом');
  const orderItems = await database.orderItem.findMany({ where: { order_id: orderId }, select: { product_id: true, quantity: true }, orderBy: { id: 'asc' } });
  if (!orderItems.length) throw userError('В заказе нет товаров');
  const activeCount = await database.subscription.count({ where: { chat_id: Number(chatId), active: 1 } });
  if (activeCount >= MAX_ACTIVE_SUBSCRIPTIONS) throw userError(`Можно держать не больше ${MAX_ACTIVE_SUBSCRIPTIONS} активных подписок`);
  const subscription = await database.subscription.create({
    data: {
      chat_id: Number(chatId), items: JSON.stringify(orderItems), interval_days: intervalDays, next_date: addDays(moscowDate(), intervalDays),
      delivery_method: order.delivery_method, delivery_city: order.delivery_city, carrier: order.carrier, address: order.addr_raw, contact: order.contact,
    },
  });
  return subscription.id;
}

async function listSubscriptions(chatId, language = 'ru') {
  const subscriptions = await database.subscription.findMany({ where: { chat_id: Number(chatId) }, orderBy: [{ active: 'desc' }, { id: 'desc' }] });
  const productIds = subscriptions.flatMap((subscription) => JSON.parse(subscription.items).map((subscriptionItem) => subscriptionItem.product_id));
  const products = await database.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, name_en: true, price: true, unit: true } });
  const productById = new Map(products.map((product) => [product.id, product]));
  return subscriptions.map((subscription) => ({
    id: subscription.id, interval_days: subscription.interval_days, next_date: subscription.next_date,
    active: Boolean(subscription.active), method: subscription.delivery_method,
    items: JSON.parse(subscription.items).map((subscriptionItem) => {
      const product = productById.get(subscriptionItem.product_id);
      return {
        name: product ? ((language === 'en' && product.name_en) || product.name) : '—',
        qty: subscriptionItem.quantity, price: product ? product.price : 0, unit: product ? product.unit : null,
      };
    }),
  }));
}

async function findOwnSubscription(chatId, subscriptionId) {
  const subscription = await database.subscription.findFirst({ where: { id: subscriptionId, chat_id: Number(chatId) } });
  if (!subscription) throw userError('Подписка не найдена');
  return subscription;
}

const updateSubscriptionFields = (subscriptionId, fields) => database.subscription.update({ where: { id: subscriptionId }, data: fields });

async function updateSubscription(chatId, subscriptionId, { action, days }) {
  const subscription = await findOwnSubscription(chatId, subscriptionId);
  if (action === 'pause') return updateSubscriptionFields(subscription.id, { active: 0 });
  if (action === 'resume') {
    // счёт за пропущенные дни не присылаем: если дата прошла — ближайший раз завтра
    const nextDate = subscription.next_date < moscowDate() ? addDays(moscowDate(), 1) : subscription.next_date;
    return updateSubscriptionFields(subscription.id, { active: 1, postponed: 0, next_date: nextDate });
  }
  if (action === 'skip') return updateSubscriptionFields(subscription.id, { next_date: addDays(subscription.next_date, subscription.interval_days) });
  if (action === 'delete') return database.subscription.delete({ where: { id: subscription.id } });
  if (action === 'interval') {
    if (!INTERVALS.includes(days)) throw userError('Неверный период');
    return updateSubscriptionFields(subscription.id, { interval_days: days });
  }
  throw userError('Неизвестное действие');
}

const TEXTS = {
  ru: {
    due: (orderCode, total, itemLines) => `🔁 Ваш регулярный заказ № ${orderCode} готов:\n${itemLines}\n\nИтого ${Math.round(total / 100).toLocaleString('ru-RU')} ₽. Нажмите «Оплатить», и мы начнём собирать. Если сейчас не нужно — просто не оплачивайте, ничего не спишется.`,
    payButton: '💳 Оплатить',
    outOfStock: (productName) => `Регулярный заказ: «${productName}» сейчас нет в нужном количестве. Попробуем снова завтра.`,
    paused: 'Регулярный заказ поставлен на паузу: товар долго недоступен или изменились условия доставки. Включить снова можно в разделе «Заказы» магазина.',
  },
  en: {
    due: (orderCode, total, itemLines) => `🔁 Your recurring order № ${orderCode} is ready:\n${itemLines}\n\nTotal ${Math.round(total / 100)} RUB. Tap Pay and we will start packing. If you do not need it now, just do not pay: nothing is charged.`,
    payButton: '💳 Pay',
    outOfStock: (productName) => `Recurring order: "${productName}" is not available in the needed quantity right now. We will try again tomorrow.`,
    paused: 'Your recurring order has been paused: an item has been unavailable for a while or delivery options changed. You can resume it in the shop under Orders.',
  },
};

async function pauseAndNotify(bot, subscription, texts) {
  await updateSubscriptionFields(subscription.id, { active: 0, postponed: 0 });
  await bot.telegram.sendMessage(subscription.chat_id, texts.paused).catch(() => {});
}

// Одна подписка, срок которой наступил. Возвращает true, если заказ создан и ссылка на оплату отправлена.
async function processDueSubscription(bot, subscription, today) {
  const language = await customers.getLanguage(subscription.chat_id);
  const texts = TEXTS[language] || TEXTS.ru;
  const subscriptionItems = JSON.parse(subscription.items);
  const products = await database.product.findMany({
    where: { id: { in: subscriptionItems.map((subscriptionItem) => subscriptionItem.product_id) } },
    select: { id: true, name: true, name_en: true, price: true, stock: true, unit: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));
  const itemsWithProducts = subscriptionItems.map((subscriptionItem) => ({ ...subscriptionItem, product: productById.get(subscriptionItem.product_id) }));

  // нет товара: переносим на завтра, после нескольких переносов ставим на паузу
  const unavailableItem = itemsWithProducts.find((subscriptionItem) => !subscriptionItem.product || subscriptionItem.product.stock < subscriptionItem.quantity);
  if (unavailableItem) {
    const postponements = subscription.postponed + 1;
    if (postponements >= MAX_POSTPONEMENTS) {
      await pauseAndNotify(bot, subscription, texts);
    } else {
      await updateSubscriptionFields(subscription.id, { next_date: addDays(today, 1), postponed: postponements });
      const productName = unavailableItem.product ? ((language === 'en' && unavailableItem.product.name_en) || unavailableItem.product.name) : '—';
      await bot.telegram.sendMessage(subscription.chat_id, texts.outOfStock(productName)).catch(() => {});
    }
    return false;
  }

  const orderLines = itemsWithProducts.map((subscriptionItem) => ({
    product_id: subscriptionItem.product.id, quantity: subscriptionItem.quantity, price: subscriptionItem.product.price,
  }));
  const goodsTotal = orderLines.reduce((sum, orderLine) => sum + orderLine.price * orderLine.quantity, 0);
  let resolvedDelivery;
  try {
    resolvedDelivery = await resolveDelivery(
      { method: subscription.delivery_method, city: subscription.delivery_city, carrier: subscription.carrier, addr: subscription.address },
      goodsTotal, 0, language,
    );
  } catch {
    // способ доставки больше недоступен (выключили, изменился адрес и т.п.)
    await pauseAndNotify(bot, subscription, texts);
    return false;
  }
  if (receipt.isEnabled() && !receipt.contactFrom(subscription.contact)) {
    await pauseAndNotify(bot, subscription, texts);
    return false;
  }

  // дата сдвигается ДО создания оплаты: даже если дальше что-то упадёт, дубль заказа не появится
  await updateSubscriptionFields(subscription.id, { next_date: addDays(today, subscription.interval_days), postponed: 0 });
  const orderId = await orders.createPendingOrder({
    chatId: subscription.chat_id, address: resolvedDelivery.address, total: resolvedDelivery.total, items: orderLines,
    deliveryCity: resolvedDelivery.deliveryCity, deliveryCost: resolvedDelivery.delivery, deliveryMethod: resolvedDelivery.method,
    contact: subscription.contact, carrier: resolvedDelivery.carrier, addrRaw: resolvedDelivery.addrRaw,
  });
  let payment;
  try {
    payment = await startPayment(orderId);
  } catch (paymentError) {
    await orders.cancelIfNotPaid(orderId);
    await updateSubscriptionFields(subscription.id, { next_date: addDays(today, 1) }); // повторим завтра
    console.error('Подписка: платёж не создался', subscription.id, paymentError.response?.data || paymentError.message);
    return false;
  }
  await updateSubscriptionFields(subscription.id, { last_order_id: orderId });
  const createdOrder = await database.order.findUnique({ where: { id: orderId }, select: { order_code: true } });
  const itemLines = itemsWithProducts.map((subscriptionItem) => `• ${formatOrderLine(subscriptionItem.product, subscriptionItem.quantity, language)}`).join('\n');
  await bot.telegram.sendMessage(subscription.chat_id, texts.due(createdOrder.order_code || orderId, resolvedDelivery.total, itemLines), {
    reply_markup: { inline_keyboard: [[{ text: texts.payButton, url: payment.confirmation.confirmation_url }]] },
  }).catch(() => {});
  return true;
}

// Обработать подписки, срок которых наступил. Безопасно вызывать часто: следующая дата сдвигается до создания оплаты.
async function runDueSubscriptions(bot, now = Date.now()) {
  const today = moscowDate(now);
  const dueSubscriptions = await database.subscription.findMany({ where: { active: 1, next_date: { lte: today } }, orderBy: { id: 'asc' } });
  let createdOrdersCount = 0;
  for (const subscription of dueSubscriptions) {
    try {
      if (await processDueSubscription(bot, subscription, today)) createdOrdersCount++;
    } catch (subscriptionError) {
      console.error('Подписка', subscription.id, subscriptionError.message);
    }
  }
  return createdOrdersCount;
}

module.exports = { INTERVALS, createSubscription, listSubscriptions, updateSubscription, runDueSubscriptions, moscowDate, addDays };
