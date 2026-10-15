// Жизнь заказа: создание, статусы, уведомления покупателю и владельцу, склад, оценки.
// Используется и сервером витрины, и ботом (кнопки под уведомлением владельцу).
// Тексты и кнопки — в messages.js, списание со склада — в stock.js, статусы — в status.js.
const { EventEmitter } = require('node:events');
const { database, runInTransaction, toSqliteTimestamp } = require('../database');
const customers = require('../customers');
const { getOwnerId } = require('../owner');
const { escapeHtml } = require('../utils/format');
const { logError, ignoreExpectedError } = require('../utils/log');
const {
  ORDER_FLOW,
  PAID_STATUSES,
  MANUAL_STATUSES,
  STATUS_LABELS,
  baseStatus,
  isPickup,
  statusLabel,
} = require('./status');
const { shopUrl, buyerText, buyerKeyboard, phoneOf, ownerText, ownerKeyboard } = require('./messages');
const { takeStockForOrder, returnStockForOrder } = require('./stock');

// Короткий код заказа для покупателя: 4 символа без похожих друг на друга (0/O, 1/I исключены)
const ORDER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER_CODE_LENGTH = 4;

// Событие 'changed' (id заказа) — заказ создан или сменил статус. На него подписывается CRM (src/crm),
// поэтому заказам не нужно знать про CRM, а CRM спокойно читает заказы — без кольцевых require.
const orderEvents = new EventEmitter();
const announceOrderChange = (orderId) => orderEvents.emit('changed', orderId);

async function generateOrderCode() {
  for (;;) {
    const candidateCode = Array.from(
      { length: ORDER_CODE_LENGTH },
      () => ORDER_CODE_ALPHABET[Math.floor(Math.random() * ORDER_CODE_ALPHABET.length)],
    ).join('');
    if (!(await database.order.findFirst({ where: { order_code: candidateCode }, select: { id: true } })))
      return candidateCode;
  }
}

// Позиции заказов с названием и единицей товара (товар мог быть удалён — тогда name = null)
async function getOrderItems(orderIds) {
  const orderItems = await database.orderItem.findMany({
    where: { order_id: { in: orderIds } },
    orderBy: { id: 'asc' },
  });
  const products = await database.product.findMany({
    where: { id: { in: [...new Set(orderItems.map((orderItem) => orderItem.product_id))] } },
    select: { id: true, name: true, name_en: true, unit: true, stock: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));
  return orderItems.map((orderItem) => {
    const product = productById.get(orderItem.product_id);
    return {
      ...orderItem,
      name: product?.name ?? null,
      name_en: product?.name_en ?? null,
      unit: product?.unit ?? null,
      stock: product?.stock ?? null,
    };
  });
}

// Позиции, сгруппированные по заказу: Map(id заказа → позиции)
async function getItemsByOrderId(orderIds) {
  const itemsByOrderId = new Map(orderIds.map((orderId) => [orderId, []]));
  for (const orderItem of await getOrderItems(orderIds)) itemsByOrderId.get(orderItem.order_id).push(orderItem);
  return itemsByOrderId;
}

async function getOrder(orderId) {
  const order = await database.order.findUnique({ where: { id: orderId } });
  if (!order) return null;
  order.base = baseStatus(order.status);
  order.code = order.order_code || String(order.id);
  order.items = await getOrderItems([orderId]);
  return order;
}

// Заказ со статусом pending; total уже с учётом скидки и доставки. items — [{product_id, quantity, price}]
async function createPendingOrder({
  chatId,
  address,
  total,
  items,
  promoCode = null,
  discountPercent = 0,
  deliveryCity = null,
  deliveryCost = 0,
  deliveryMethod = null,
  contact = null,
  carrier = null,
  addrRaw = null,
}) {
  const orderId = await runInTransaction(async () => {
    const createdOrder = await database.order.create({
      data: {
        chat_id: Number(chatId),
        status: 'pending',
        total,
        address,
        payment_provider: 'yookassa',
        promo_code: promoCode,
        discount_percent: discountPercent,
        delivery_city: deliveryCity,
        delivery_cost: deliveryCost,
        order_code: await generateOrderCode(),
        delivery_method: deliveryMethod || (deliveryCity ? 'city' : 'pickup'),
        contact,
        carrier,
        addr_raw: addrRaw,
      },
    });
    await database.orderItem.createMany({
      data: items.map((orderLine) => ({
        order_id: createdOrder.id,
        product_id: orderLine.product_id,
        quantity: orderLine.quantity,
        price: orderLine.price,
      })),
    });
    return createdOrder.id;
  });
  announceOrderChange(orderId);
  return orderId;
}

// Оплата не создалась — заказ не должен висеть в «ждёт оплату»
async function cancelIfNotPaid(orderId) {
  await database.order.updateMany({ where: { id: orderId, payment_id: null }, data: { status: 'cancelled' } });
}

// Сообщение покупателю о статусе. Прошлое такое сообщение удаляем — в чате остаётся только актуальное.
async function notifyBuyer(bot, order) {
  const language = await customers.getLanguage(order.chat_id);
  // Старое сообщение покупатель мог уже удалить сам, а Telegram не даёт удалять сообщения старше 48 часов —
  // это нормально, новое сообщение всё равно отправляем.
  if (order.status_msg_id)
    await bot.telegram.deleteMessage(order.chat_id, order.status_msg_id).catch(ignoreExpectedError);
  const sentMessage = await bot.telegram
    .sendMessage(order.chat_id, await buyerText(order, language), {
      parse_mode: 'HTML',
      reply_markup: buyerKeyboard(order, language),
    })
    .catch(logError(`Не получилось написать покупателю (заказ ${order.code})`));
  if (sentMessage)
    await database.order.update({ where: { id: order.id }, data: { status_msg_id: sentMessage.message_id } });
}

async function notifyOwnerAboutNewOrder(bot, order) {
  if (!getOwnerId()) return;
  await bot.telegram
    .sendMessage(getOwnerId(), await ownerText(order), {
      parse_mode: 'HTML',
      reply_markup: ownerKeyboard(order),
      disable_web_page_preview: true,
    })
    .catch(logError('Не получилось уведомить владельца о заказе'));
}

// Короткое сообщение владельцу (если он настроен); сбой отправки — только в лог
async function messageOwner(bot, text, extra) {
  if (!getOwnerId()) return;
  await bot.telegram.sendMessage(getOwnerId(), text, extra).catch(logError('Не получилось написать владельцу'));
}

async function warnOwnerAboutShortage(bot, order, shortages) {
  if (!shortages.length) return;
  await messageOwner(
    bot,
    `⚠️ Заказ № ${order.code} оплачен, но на складе не хватило:\n${shortages.join('\n')}\n\nСвяжитесь с покупателем: дозаказать товар или вернуть часть денег.`,
  );
}

// Сменить статус заказа (из админки или кнопкой в Telegram)
async function changeStatus(bot, orderId, newStatus, { track } = {}) {
  if (!MANUAL_STATUSES.has(newStatus)) throw new Error('Неизвестный статус');
  const order = await getOrder(orderId);
  if (!order) throw new Error('Заказ не найден');
  const wasPaid = PAID_STATUSES.has(order.base);
  const becomesPaid = PAID_STATUSES.has(newStatus);
  const newTrack =
    track === undefined
      ? order.track
      : String(track || '')
          .trim()
          .slice(0, 60) || null;
  if (order.base === newStatus && newTrack === order.track) return order;

  let shortages = [];
  await runInTransaction(async () => {
    if (wasPaid && newStatus === 'cancelled') await returnStockForOrder(order); // товар вернулся на склад
    if (!wasPaid && becomesPaid) shortages = await takeStockForOrder(order); // вернули в работу / оплачен вручную
    const now = toSqliteTimestamp();
    await database.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        track: newTrack,
        status_at: now,
        ...(becomesPaid && !order.paid_at ? { paid_at: now } : {}),
      },
    });
  });
  const updatedOrder = await getOrder(orderId);
  announceOrderChange(orderId);
  await notifyBuyer(bot, updatedOrder);
  await warnOwnerAboutShortage(bot, updatedOrder, shortages);
  return updatedOrder;
}

// Id платежа, которым должен оплачиваться заказ (у старых заказов он лежит в статусе)
function expectedPaymentId(order) {
  if (order.payment_id) return order.payment_id;
  return String(order.status).startsWith('awaiting_payment:')
    ? String(order.status).slice('awaiting_payment:'.length)
    : null;
}

// Оплата пришла (вебхук ЮKassa). Засчитываем платёж только один раз и только «свой»:
// повтор уведомления после возврата денег или чужой платёж заказ не «оживят».
async function markPaid(bot, orderId, paymentId) {
  const order = await getOrder(orderId);
  if (!order || order.paid_at || PAID_STATUSES.has(order.base)) return false; // деньги по заказу уже засчитаны
  if (!paymentId || expectedPaymentId(order) !== paymentId) return false; // это не платёж этого заказа
  const wasCancelled = order.base === 'cancelled';
  let shortages = [];
  let exceededPromoCode = null;

  const isMarked = await runInTransaction(async () => {
    const freshOrder = await getOrder(orderId); // перечитали внутри транзакции
    if (freshOrder.paid_at) return false;
    shortages = await takeStockForOrder(freshOrder);
    const now = toSqliteTimestamp();
    await database.order.update({ where: { id: orderId }, data: { status: 'paid', status_at: now, paid_at: now } });
    if (freshOrder.promo_code) {
      // промокод могли удалить, пока заказ ждал оплату, — тогда считать нечего (update падает «запись не найдена»)
      const promoCode = await database.promoCode
        .update({ where: { code: freshOrder.promo_code }, data: { used_count: { increment: 1 } } })
        .catch(ignoreExpectedError);
      if (promoCode && promoCode.max_uses !== null && promoCode.used_count > promoCode.max_uses) {
        exceededPromoCode = `${promoCode.code} (${promoCode.used_count}/${promoCode.max_uses})`;
      }
    }
    return true;
  });
  if (!isMarked) return false;

  const paidOrder = await getOrder(orderId);
  announceOrderChange(orderId);
  await notifyBuyer(bot, paidOrder);
  await notifyOwnerAboutNewOrder(bot, paidOrder);
  await warnOwnerAboutShortage(bot, paidOrder, shortages);
  if (exceededPromoCode) {
    await messageOwner(
      bot,
      `⚠️ Промокод ${exceededPromoCode} превысил лимит использований — заказ № ${paidOrder.code} оплачен со скидкой.`,
    );
  }
  if (wasCancelled) {
    await messageOwner(
      bot,
      `⚠️ Заказ № ${paidOrder.code} был отменён, но покупатель всё-таки оплатил — вернула его в работу.`,
    );
  }
  return true;
}

// Оценка после доставки
async function rateOrder(bot, chatId, orderId, stars) {
  const order = await getOrder(orderId);
  if (!order || String(order.chat_id) !== String(chatId) || order.base !== 'delivered') return null;
  if (order.rating) return order;
  await database.order.update({ where: { id: orderId }, data: { rating: stars } });
  if (getOwnerId()) {
    const buyerName = (await customers.getName(chatId)) || 'Покупатель';
    await messageOwner(
      bot,
      `${'⭐'.repeat(stars)} ${escapeHtml(buyerName)} оценил(а) заказ № ${order.code} на ${stars}/5`,
      { parse_mode: 'HTML' },
    );
  }
  return getOrder(orderId);
}

module.exports = {
  ORDER_FLOW,
  PAID_STATUSES,
  MANUAL_STATUSES,
  STATUS_LABELS,
  baseStatus,
  generateOrderCode,
  getOrder,
  getOrderItems,
  getItemsByOrderId,
  createPendingOrder,
  cancelIfNotPaid,
  statusLabel,
  buyerText,
  buyerKeyboard,
  notifyBuyer,
  ownerText,
  ownerKeyboard,
  notifyOwnerAboutNewOrder,
  changeStatus,
  markPaid,
  rateOrder,
  shopUrl,
  phoneOf,
  isPickup,
  orderEvents,
};
