// Витрина для покупателя: каталог, корзина, язык, мои заказы, AI-подбор, повтор заказа, подписки
const express = require('express');
const { database } = require('../../../database');
const { translate } = require('../../../i18n');
const cart = require('../../../cart');
const orders = require('../../../orders');
const customers = require('../../../customers');
const subscriptions = require('../../../subscriptions');
const quantityRules = require('../../../inventory/quantity');
const { getPayment } = require('../../../payments/yookassa');
const { countUnread } = require('../../../chat/messages');
const { isOwnerChat } = require('../../auth');
const { showcasePhotoUrl } = require('../../photos');
const { asyncHandler } = require('../../async-handler');
const { idParamValidator } = require('../../validation');
const { cartPostValidator, languagePostValidator, aiPostValidator, subscriptionPostValidator, subscriptionUpdateValidator } = require('./validation');

const MY_ORDERS_LIMIT = 20;
const AI_REQUEST_INTERVAL_MS = 5000;
const MAX_TRACKED_USERS = 5000;

const CATALOG_FIELDS = {
  id: true, name: true, name_en: true, description: true, description_en: true, category: true, category_en: true, price: true, stock: true,
  photo_url: true, group_key: true, option_label: true, option_label_en: true, option2_label: true, option2_label_en: true,
  is_addon: true, addon_for: true, unit: true, step: true, min_qty: true,
};

// Сортировка как раньше в SQL: сначала в наличии, затем по категории (пустые первыми) и id
const compareCatalogProducts = (first, second) => (Number(first.stock === 0) - Number(second.stock === 0))
  || ((first.category ?? '') < (second.category ?? '') ? -1 : (first.category ?? '') > (second.category ?? '') ? 1 : 0)
  || first.id - second.id;

async function buildCatalog() {
  const products = (await database.product.findMany({ select: CATALOG_FIELDS })).sort(compareCatalogProducts);
  const bundleParts = await database.bundleItem.findMany();
  const partProducts = await database.product.findMany({
    where: { id: { in: [...new Set(bundleParts.map((part) => part.product_id))] } },
    select: { id: true, name: true, name_en: true, unit: true, price: true },
  });
  const partProductById = new Map(partProducts.map((product) => [product.id, product]));
  const partsWithProducts = bundleParts
    .filter((part) => partProductById.has(part.product_id))
    .map((part) => ({ bundleId: part.bundle_id, qty: part.qty, ...partProductById.get(part.product_id) }))
    .sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0));
  // ссылку на фото не отдаём как есть: картинки идут через наш сервер (/shop-photo)
  return products.map(({ photo_url: photoUrl, ...product }) => ({
    ...product,
    bundle: partsWithProducts.filter((part) => part.bundleId === product.id)
      .map((part) => ({ name: part.name, name_en: part.name_en, qty: part.qty, unit: part.unit, price: part.price })),
    photo: showcasePhotoUrl(product.id, photoUrl),
  }));
}

async function buildMyOrders(chatId, language) {
  const fallbackLabels = translate(language, 'orderStatus') || {};
  const recentOrders = await database.order.findMany({ where: { chat_id: chatId }, orderBy: { created_at: 'desc' }, take: MY_ORDERS_LIMIT });
  const itemsByOrderId = await orders.getItemsByOrderId(recentOrders.map((order) => order.id));
  return recentOrders.map((order) => {
    const status = orders.baseStatus(order.status);
    return {
      id: order.id,
      code: order.order_code || String(order.id),
      status,
      statusLabel: orders.statusLabel({ base: status, delivery_city: order.delivery_city }, language) || fallbackLabels[status] || status,
      step: orders.ORDER_FLOW.indexOf(status),
      pickup: !order.delivery_city,
      track: order.track || '',
      rating: order.rating || 0,
      can_pay: status === 'awaiting_payment',
      can_subscribe: orders.PAID_STATUSES.has(status) && Boolean(order.delivery_method),
      total: order.total,
      delivery_cost: order.delivery_cost || 0,
      address: order.address || '',
      created_at: order.created_at,
      items: itemsByOrderId.get(order.id).map((orderItem) => ({
        id: orderItem.name === null ? null : orderItem.product_id, qty: orderItem.quantity, price: orderItem.price, unit: orderItem.unit,
        name: (language === 'en' && orderItem.name_en) || orderItem.name || '—',
      })),
    };
  });
}

function createShopRouter({ shopAuth, aiPick, showCartFor }) {
  const router = express.Router();
  const sendUserError = (response, routeError) => response.status(routeError.expose ? 400 : 500).json({ error: routeError.expose ? routeError.message : 'Что-то пошло не так, попробуйте ещё раз' });

  router.get('/catalog', shopAuth, asyncHandler(async (request, response) => {
    const isOwner = isOwnerChat(request.chatId);
    response.json({
      lang: await customers.getLanguage(request.chatId),
      products: await buildCatalog(),
      cart: await cart.getCartQuantities(request.chatId),
      isOwner,
      unread: isOwner ? await countUnread() : 0,
    });
  }));

  router.post('/cart', shopAuth, cartPostValidator, asyncHandler(async (request, response) => {
    const { productId, quantity } = request.validated;
    const product = await database.product.findUnique({ where: { id: productId }, select: { stock: true, unit: true, step: true, min_qty: true } });
    if (!product) return response.status(404).json({ error: 'Товар не найден' });
    if (quantity > product.stock) return response.status(400).json({ error: 'Больше нет в наличии' });
    if (!quantityRules.isValidQuantity(product, quantity)) {
      return response.status(400).json({ error: quantityRules.explainQuantityRules(product, await customers.getLanguage(request.chatId)) });
    }
    await cart.setCartQuantity(request.chatId, productId, quantity);
    return response.json({ ok: true, cart: await cart.getCartQuantities(request.chatId) });
  }));

  // Язык интерфейса (переключатель RU/EN в шапке витрины)
  router.post('/lang', shopAuth, languagePostValidator, asyncHandler(async (request, response) => {
    const { language } = request.validated;
    await customers.setLanguage(request.chatId, language);
    response.json({ ok: true, lang: language });
  }));

  // Мои заказы — последние 20 с составом
  router.get('/orders', shopAuth, asyncHandler(async (request, response) => {
    response.json({ orders: await buildMyOrders(request.chatId, await customers.getLanguage(request.chatId)) });
  }));

  // AI-подбор: совет + id подходящих товаров (не чаще раза в 5 секунд на человека)
  const lastAiRequestAt = new Map();
  router.post('/ai', shopAuth, aiPostValidator, asyncHandler(async (request, response) => {
    const { query } = request.validated;
    if (!aiPick) return response.status(503).json({ error: 'AI-подбор сейчас недоступен' });
    if (Date.now() - (lastAiRequestAt.get(request.chatId) || 0) < AI_REQUEST_INTERVAL_MS) return response.status(429).json({ error: 'Секунду, ещё думаю над прошлым запросом' });
    if (lastAiRequestAt.size > MAX_TRACKED_USERS) lastAiRequestAt.clear();
    lastAiRequestAt.set(request.chatId, Date.now());
    const language = await customers.getLanguage(request.chatId);
    try {
      const { adviceText, productIds } = await aiPick(query, language, request.chatId);
      return response.json({ advice: adviceText, ids: productIds });
    } catch (aiError) {
      if (aiError.code === 'AI_LIMIT') return response.status(429).json({ error: language === 'en' ? 'AI pick limit reached — try again later' : 'ИИ-подбор на сегодня устал 🙂 Попробуйте позже' });
      console.error('Витрина: AI-подбор не ответил', aiError.response?.status || aiError.message);
      return response.status(502).json({ error: translate(language, 'aiError') });
    }
  }));

  // Повторить заказ: собрать корзину из прошлого заказа с учётом остатков
  router.post('/orders/:id/repeat', shopAuth, idParamValidator('orderId'), asyncHandler(async (request, response) => {
    const order = await database.order.findFirst({ where: { id: request.validated.orderId, chat_id: request.chatId }, select: { id: true } });
    if (!order) return response.status(404).json({ error: 'Заказ не найден' });
    const orderItems = (await orders.getOrderItems([order.id])).filter((orderItem) => orderItem.stock !== null); // удалённые товары пропускаем
    let addedCount = 0;
    let missingCount = 0;
    for (const orderItem of orderItems) {
      const availableQuantity = Math.min(orderItem.quantity, orderItem.stock);
      if (availableQuantity <= 0) { missingCount++; continue; }
      if (availableQuantity < orderItem.quantity) missingCount++;
      await cart.setCartQuantity(request.chatId, orderItem.product_id, availableQuantity);
      addedCount++;
    }
    return response.json({ ok: true, added: addedCount, missing: missingCount, cart: await cart.getCartQuantities(request.chatId) });
  }));

  router.get('/subscriptions', shopAuth, asyncHandler(async (request, response) => {
    const language = await customers.getLanguage(request.chatId);
    response.json({ subscriptions: await subscriptions.listSubscriptions(request.chatId, language), intervals: subscriptions.INTERVALS });
  }));
  router.post('/subscriptions', shopAuth, subscriptionPostValidator, asyncHandler(async (request, response) => {
    try {
      const subscriptionId = await subscriptions.createSubscription(request.chatId, request.validated.orderId, request.validated.intervalDays);
      response.json({ ok: true, id: subscriptionId });
    } catch (subscriptionError) { sendUserError(response, subscriptionError); }
  }));
  router.post('/subscriptions/:id', shopAuth, subscriptionUpdateValidator, asyncHandler(async (request, response) => {
    const { subscriptionId, action, days } = request.validated;
    try {
      await subscriptions.updateSubscription(request.chatId, subscriptionId, { action, days });
      response.json({ ok: true });
    } catch (subscriptionError) { sendUserError(response, subscriptionError); }
  }));

  // Ссылка «Оплатить» для заказа, который ещё ждёт оплату
  router.post('/orders/:id/pay', shopAuth, idParamValidator('orderId'), asyncHandler(async (request, response) => {
    const order = await database.order.findFirst({ where: { id: request.validated.orderId, chat_id: request.chatId } });
    const paymentId = order && String(order.status || '').startsWith('awaiting_payment:') ? order.status.split(':')[1] : null;
    if (!paymentId) return response.status(404).json({ error: 'Этот заказ уже не ждёт оплату' });
    try {
      const payment = await getPayment(paymentId);
      if (payment.status !== 'pending' || !payment.confirmation?.confirmation_url) return response.status(410).json({ error: 'Ссылка на оплату устарела — оформите заказ заново' });
      return response.json({ pay_url: payment.confirmation.confirmation_url });
    } catch {
      return response.status(502).json({ error: 'ЮKassa не ответила, попробуйте ещё раз' });
    }
  }));

  // «Оформить» в витрине → бот присылает корзину с кнопкой оформления в чат
  router.post('/checkout', shopAuth, asyncHandler(async (request, response) => {
    try {
      if (showCartFor) await showCartFor(request.chatId);
      response.json({ ok: true });
    } catch (cartError) {
      console.error('Витрина: не удалось отправить корзину', cartError.message);
      response.status(500).json({ error: 'Не получилось, попробуйте ещё раз' });
    }
  }));

  return router;
}

module.exports = { createShopRouter };
