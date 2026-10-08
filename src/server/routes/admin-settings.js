// Админка: статистика, чаты с покупателями, настройки доставки, города, промокоды
const express = require('express');
const axios = require('axios');
const { database, toSqliteTimestamp } = require('../../database');
const orders = require('../../orders');
const customers = require('../../customers');
const delivery = require('../../delivery');
const receipt = require('../../payments/receipt');
const messages = require('../../chat/messages');
const { sendToBuyer } = require('../../chat');
const { getDeliverySettings, setSetting } = require('../../settings');
const { asyncHandler, userError } = require('../async-handler');

const STATS_PERIODS = [7, 30, 90];
const DAY_MS = 864e5;
const MOSCOW_OFFSET_MS = 3 * 3600e3;
const TOP_LIST_SIZE = 6;
const CHAT_ORDERS_LIMIT = 10;
const MAX_CARRIERS = 6;
const LOW_STOCK_PIECES = 3;
const ACTIVE_STATUSES = ['paid', 'assembling', 'shipped'];

const toKopecks = (value) => Math.round(parseFloat(String(value ?? '').replace(',', '.').replace(/\s/g, '')) * 100);
// «2026-10-08 21:30:00» (UTC) → дата по Москве «2026-10-09»
const moscowDay = (sqliteTimestamp) => new Date(new Date(String(sqliteTimestamp).replace(' ', 'T') + 'Z').getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);

async function buildStats(requestedDays) {
  const days = STATS_PERIODS.includes(Number(requestedDays)) ? Number(requestedDays) : 30;
  const todayInMoscow = new Date(Date.now() + MOSCOW_OFFSET_MS);
  const firstDay = new Date(todayInMoscow - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  // created_at — UTC; дни считаем по Москве (+3 ч)
  const periodStartUtc = toSqliteTimestamp(new Date(firstDay + 'T00:00:00Z').getTime() - MOSCOW_OFFSET_MS);
  const periodOrders = (await database.order.findMany({ where: { created_at: { gte: periodStartUtc } } }))
    .filter((order) => order.created_at)
    .map((order) => ({ ...order, day: moscowDay(order.created_at) }))
    .filter((order) => order.day >= firstDay);
  const paidOrders = periodOrders.filter((order) => orders.PAID_STATUSES.has(orders.baseStatus(order.status)));
  const revenue = paidOrders.reduce((sum, order) => sum + order.total, 0);
  const deliveryRevenue = paidOrders.reduce((sum, order) => sum + (order.delivery_cost || 0), 0);

  const byDay = [];
  for (let daysAgo = days - 1; daysAgo >= 0; daysAgo--) {
    const date = new Date(todayInMoscow - daysAgo * DAY_MS).toISOString().slice(0, 10);
    const dayOrders = paidOrders.filter((order) => order.day === date);
    byDay.push({ date, revenue: dayOrders.reduce((sum, order) => sum + order.total, 0), orders: dayOrders.length });
  }

  const topProducts = new Map();
  for (const orderItem of await orders.getOrderItems(paidOrders.map((order) => order.id))) {
    const productTotals = topProducts.get(orderItem.product_id) || { id: orderItem.product_id, name: orderItem.name || '—', qty: 0, revenue: 0 };
    productTotals.qty += orderItem.quantity;
    productTotals.revenue += orderItem.quantity * orderItem.price;
    topProducts.set(orderItem.product_id, productTotals);
  }
  const cities = new Map();
  for (const order of paidOrders) {
    const cityName = order.delivery_city || 'Самовывоз';
    const cityTotals = cities.get(cityName) || { city: cityName, orders: 0, revenue: 0 };
    cityTotals.orders++;
    cityTotals.revenue += order.total;
    cities.set(cityName, cityTotals);
  }
  const ordersPerCustomer = new Map();
  for (const order of paidOrders) ordersPerCustomer.set(order.chat_id, (ordersPerCustomer.get(order.chat_id) || 0) + 1);
  const ratedOrders = paidOrders.filter((order) => order.rating);
  const countByStatus = {};
  for (const order of periodOrders) {
    const status = orders.baseStatus(order.status);
    countByStatus[status] = (countByStatus[status] || 0) + 1;
  }

  return {
    days, revenue, delivery: deliveryRevenue, goods: revenue - deliveryRevenue,
    orders: paidOrders.length,
    avg: paidOrders.length ? Math.round(revenue / paidOrders.length) : 0,
    customers: ordersPerCustomer.size,
    repeat: [...ordersPerCustomer.values()].filter((orderCount) => orderCount > 1).length,
    unpaid: (countByStatus.awaiting_payment || 0) + (countByStatus.pending || 0),
    cancelled: countByStatus.cancelled || 0,
    promoUsed: paidOrders.filter((order) => order.promo_code).length,
    rating: ratedOrders.length ? Math.round((ratedOrders.reduce((sum, order) => sum + order.rating, 0) / ratedOrders.length) * 10) / 10 : null,
    rated: ratedOrders.length,
    active: await database.order.count({ where: { status: { in: ACTIVE_STATUSES } } }),
    byDay,
    top: [...topProducts.values()].sort((first, second) => second.revenue - first.revenue).slice(0, TOP_LIST_SIZE),
    cities: [...cities.values()].sort((first, second) => second.revenue - first.revenue).slice(0, TOP_LIST_SIZE),
    lowStock: await database.product.findMany({ where: { stock: { lte: LOW_STOCK_PIECES } }, select: { id: true, name: true, stock: true }, orderBy: [{ stock: 'asc' }, { name: 'asc' }] }),
  };
}

// Всё, что показывает вкладка «Настройки»
async function buildSettings() {
  const deliveryOptions = await delivery.getDeliveryOptions();
  return {
    delivery: await getDeliverySettings(),
    delivery2: {
      post: deliveryOptions.post,
      distance: {
        enabled: deliveryOptions.distance.enabled,
        originAddress: deliveryOptions.distance.origin.address,
        ready: deliveryOptions.distance.origin.lat != null,
        tiers: deliveryOptions.distance.tiers.map((tier) => `${tier.km} : ${tier.price / 100}`).join('\n'),
      },
    },
    receipts: receipt.isEnabled(),
    cities: await database.deliveryRate.findMany({ select: { id: true, city: true, city_en: true, price: true, active: true }, orderBy: [{ active: 'desc' }, { city: 'asc' }] }),
    promos: await database.promoCode.findMany({
      select: { id: true, code: true, discount_percent: true, max_uses: true, used_count: true, active: true }, orderBy: [{ active: 'desc' }, { id: 'desc' }],
    }),
  };
}

function createAdminSettingsRouter({ bot, ownerAuth }) {
  const router = express.Router();
  // Ответ JSON или {error} со статусом 400
  const jsonRoute = (handler) => asyncHandler(async (request, response) => {
    try {
      response.json(await handler(request));
    } catch (routeError) {
      response.status(400).json({ error: routeError.message });
    }
  });

  // ───────── 📊 Статистика ─────────
  router.get('/stats', ...ownerAuth, jsonRoute((request) => buildStats(request.query.days)));

  // ───────── 💬 Чаты ─────────
  router.get('/chats', ...ownerAuth, jsonRoute(async () => ({ chats: await messages.listChats(), unread: await messages.countUnread() })));
  router.get('/chats/:chatId', ...ownerAuth, jsonRoute(async (request) => {
    const chatId = Number(request.params.chatId);
    await messages.markChatRead(chatId);
    const buyerOrders = await database.order.findMany({
      where: { chat_id: chatId }, orderBy: { id: 'desc' }, take: CHAT_ORDERS_LIMIT, select: { id: true, order_code: true, status: true, total: true },
    });
    return {
      name: (await customers.getName(chatId)) || '',
      messages: await messages.getChatHistory(chatId),
      orders: buyerOrders.map((order) => ({ id: order.id, code: order.order_code || String(order.id), status: orders.baseStatus(order.status), total: order.total })),
      unread: await messages.countUnread(),
    };
  }));
  router.post('/chats/:chatId', ...ownerAuth, jsonRoute(async (request) => {
    const chatId = Number(request.params.chatId);
    const text = String(request.body?.text ?? '').trim().slice(0, 4000);
    if (!text) throw new Error('Пустое сообщение');
    const hasWrittenBefore = (await database.message.count({ where: { chat_id: chatId } })) > 0 || (await database.order.count({ where: { chat_id: chatId } })) > 0;
    if (!hasWrittenBefore) throw new Error('Этот покупатель ещё не писал магазину');
    try {
      await sendToBuyer(bot, chatId, { text });
    } catch (sendError) {
      throw new Error('Telegram не доставил сообщение: ' + sendError.message);
    }
    return { messages: await messages.getChatHistory(chatId) };
  }));
  // Фото из переписки хранит Telegram — отдаём через сервер, только владелице
  router.get('/photo/:fileId', ...ownerAuth, asyncHandler(async (request, response) => {
    try {
      if (!(await messages.isKnownPhoto(request.params.fileId))) return response.sendStatus(404);
      const fileLink = await bot.telegram.getFileLink(request.params.fileId);
      const photoResponse = await axios.get(String(fileLink), { responseType: 'arraybuffer', timeout: 15000 });
      return response.set({ 'Content-Type': photoResponse.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
        .send(Buffer.from(photoResponse.data));
    } catch {
      return response.sendStatus(404);
    }
  }));

  // ───────── ⚙️ Настройки доставки ─────────
  router.get('/settings', ...ownerAuth, jsonRoute(buildSettings));

  router.post('/delivery', ...ownerAuth, jsonRoute(async (request) => {
    const form = request.body || {};
    const otherPrice = toKopecks(form.otherPrice);
    const freeFrom = form.freeFrom === '' || form.freeFrom == null ? 0 : toKopecks(form.freeFrom);
    if (!(otherPrice >= 0)) throw new Error('Цена для других городов — числом');
    if (!(freeFrom >= 0)) throw new Error('«Бесплатно от» — числом (0 — выключено)');
    await setSetting('delivery', { otherPrice, freeFrom, pickup: Boolean(form.pickup), pickupAddress: String(form.pickupAddress || '').trim().slice(0, 200) });
    return buildSettings();
  }));

  // СДЭК / Почта и доставка по расстоянию
  router.post('/delivery2', ...ownerAuth, jsonRoute(async (request) => {
    const form = request.body || {};
    const currentOptions = await delivery.getDeliveryOptions();
    const carriers = (Array.isArray(form.carriers) ? form.carriers : currentOptions.post.carriers).slice(0, MAX_CARRIERS).map((carrierForm) => {
      const price = toKopecks(carrierForm.price);
      if (!(price >= 0)) throw new Error(`Цена «${carrierForm.name}» — числом`);
      const carrierId = String(carrierForm.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'c' + Math.random().toString(36).slice(2, 6);
      return { id: carrierId, name: String(carrierForm.name || '').trim().slice(0, 40), price };
    }).filter((carrier) => carrier.name);
    const distanceOptions = { ...currentOptions.distance, enabled: Boolean(form.distanceEnabled) };
    if (form.tiers !== undefined) {
      distanceOptions.tiers = delivery.parseDistanceTiers(form.tiers);
      if (!distanceOptions.tiers.length) throw new Error('Добавьте хотя бы одну ступень расстояния');
    }
    const originAddress = String(form.originAddress || '').trim().slice(0, 200);
    if (originAddress && originAddress !== currentOptions.distance.origin.address) {
      const originPoint = await delivery.geocode(originAddress).catch(() => null);
      if (!originPoint) throw new Error('Не нашла этот адрес на карте. Напишите город, улицу и дом полностью');
      distanceOptions.origin = { address: originAddress, lat: originPoint.lat, lon: originPoint.lon };
    }
    if (distanceOptions.enabled && distanceOptions.origin.lat == null) throw new Error('Для доставки по расстоянию укажите адрес, откуда вы отправляете');
    await delivery.saveDeliveryOptions({ post: { enabled: Boolean(form.postEnabled), carriers }, distance: distanceOptions });
    return buildSettings();
  }));

  router.post('/cities', ...ownerAuth, jsonRoute(async (request) => {
    const form = request.body || {};
    const city = String(form.city || '').trim().slice(0, 80);
    const price = toKopecks(form.price);
    if (city.length < 2) throw new Error('Укажите город');
    if (!(price >= 0)) throw new Error('Укажите цену доставки');
    const rateId = parseInt(form.id, 10);
    if (rateId) {
      // city в базе с COLLATE NOCASE — «москва» и «Москва» считаются одним городом
      const sameNameRate = await database.deliveryRate.findFirst({ where: { city, id: { not: rateId } }, select: { id: true } });
      if (sameNameRate) throw new Error('Такой город уже есть');
      await database.deliveryRate.update({ where: { id: rateId }, data: { city, price, active: form.active === false ? 0 : 1 } });
    } else {
      await database.deliveryRate.upsert({ where: { city }, create: { city, price }, update: { price, active: 1 } });
    }
    return buildSettings();
  }));
  router.post('/cities/:id/delete', ...ownerAuth, jsonRoute(async (request) => {
    await database.deliveryRate.deleteMany({ where: { id: parseInt(request.params.id, 10) || 0 } });
    return buildSettings();
  }));

  // ───────── 🎟 Промокоды ─────────
  router.post('/promos', ...ownerAuth, jsonRoute(async (request) => {
    const form = request.body || {};
    const code = String(form.code || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 30);
    const percent = parseInt(form.percent, 10);
    const maxUses = form.max_uses === '' || form.max_uses == null ? null : parseInt(form.max_uses, 10);
    if (!/^[A-ZА-ЯЁ0-9_-]{2,30}$/.test(code)) throw new Error('Код — буквы и цифры, от 2 символов');
    if (!(percent >= 1 && percent <= 90)) throw new Error('Скидка — от 1 до 90%');
    if (maxUses !== null && !(maxUses >= 1)) throw new Error('Лимит — число от 1 (или пусто — без лимита)');
    try {
      await database.promoCode.create({ data: { code, discount_percent: percent, max_uses: maxUses } });
    } catch (createError) {
      if (createError.code === 'P2002' || String(createError.message).includes('UNIQUE')) throw userError(`Промокод ${code} уже есть`);
      throw createError;
    }
    return buildSettings();
  }));
  router.post('/promos/:id', ...ownerAuth, jsonRoute(async (request) => {
    await database.promoCode.updateMany({ where: { id: parseInt(request.params.id, 10) || 0 }, data: { active: request.body?.active ? 1 : 0 } });
    return buildSettings();
  }));
  router.post('/promos/:id/delete', ...ownerAuth, jsonRoute(async (request) => {
    await database.promoCode.deleteMany({ where: { id: parseInt(request.params.id, 10) || 0 } });
    return buildSettings();
  }));

  return router;
}

module.exports = { createAdminSettingsRouter };
