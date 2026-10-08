// Оформление и оплата прямо в витрине. Всё считаем на сервере: цены — из базы, доставка — из тарифов, скидка — из промокода.
const express = require('express');
const { database } = require('../../database');
const { translate } = require('../../i18n');
const cart = require('../../cart');
const pricing = require('../../pricing');
const delivery = require('../../delivery');
const orders = require('../../orders');
const customers = require('../../customers');
const receipt = require('../../payments/receipt');
const { startPayment } = require('../../payments/start');
const { resolveDelivery } = require('../../checkout');
const { getDeliverySettings } = require('../../settings');
const { asyncHandler } = require('../async-handler');

const PROMO_ATTEMPTS_PER_MINUTE = 12;
const ONE_MINUTE_MS = 60000;
const QUOTE_INTERVAL_MS = 1000;
const MAX_TRACKED_USERS = 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function createCheckoutRouter({ bot, shopAuth, isRequestAllowed }) {
  const router = express.Router();
  const sendError = (response, routeError, fallbackMessage) =>
    response.status(routeError.expose ? 400 : 500).json({ error: routeError.expose ? routeError.message : fallbackMessage });
  const isPromoAttemptAllowed = (chatId) => isRequestAllowed('promo:' + chatId, PROMO_ATTEMPTS_PER_MINUTE, ONE_MINUTE_MS);

  router.get('/checkout-info', shopAuth, asyncHandler(async (request, response) => {
    const cities = await database.deliveryRate.findMany({ where: { active: 1 }, select: { city: true, city_en: true, price: true }, orderBy: { city: 'asc' } });
    const deliverySettings = await getDeliverySettings();
    const deliveryOptions = await delivery.getDeliveryOptions();
    const distanceOptions = deliveryOptions.distance;
    response.json({
      cities,
      otherPrice: deliverySettings.otherPrice, freeFrom: deliverySettings.freeFrom, pickup: deliverySettings.pickup, pickupAddress: deliverySettings.pickupAddress,
      payOnline: Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY),
      post: deliveryOptions.post.enabled ? { carriers: deliveryOptions.post.carriers.map(({ id, name, price }) => ({ id, name, price })) } : null,
      distance: distanceOptions.enabled && distanceOptions.origin.lat != null
        ? { maxKm: Math.max(...distanceOptions.tiers.map((tier) => tier.km)), tiers: distanceOptions.tiers }
        : null,
      receipts: receipt.isEnabled(),
      contact: (await customers.getContact(request.chatId)) || '',
    });
  }));

  // Живой расчёт доставки для витрины (нужен для «по расстоянию»; остальное считается на месте)
  const lastQuoteAt = new Map();
  router.post('/delivery-quote', shopAuth, asyncHandler(async (request, response) => {
    if (Date.now() - (lastQuoteAt.get(request.chatId) || 0) < QUOTE_INTERVAL_MS) return response.status(429).json({ error: 'Секунду…' });
    lastQuoteAt.set(request.chatId, Date.now());
    if (lastQuoteAt.size > MAX_TRACKED_USERS) lastQuoteAt.clear();
    try {
      const requestBody = request.body || {};
      const { total } = await cart.getCart(request.chatId);
      let discountPercent = 0;
      try { discountPercent = (await pricing.findPromo(requestBody.promo)).percent; } catch { /* неверный промокод на цену доставки не влияет */ }
      const resolvedDelivery = await resolveDelivery(
        { method: requestBody.delivery, city: requestBody.city, carrier: requestBody.carrier, addr: requestBody.address },
        total, discountPercent, await customers.getLanguage(request.chatId),
      );
      return response.json({ ok: true, delivery: resolvedDelivery.delivery, km: resolvedDelivery.km || null, total: resolvedDelivery.total });
    } catch (quoteError) {
      return sendError(response, quoteError, 'Не получилось рассчитать доставку');
    }
  }));

  router.post('/promo', shopAuth, asyncHandler(async (request, response) => {
    if (!isPromoAttemptAllowed(request.chatId)) return response.status(429).json({ error: 'Слишком много попыток, подождите минуту' }); // защита от подбора кодов
    try {
      return response.json({ ok: true, ...(await pricing.findPromo(request.body.code)) });
    } catch (promoError) {
      return response.status(400).json({ error: promoError.message });
    }
  }));

  // Контакт для чека 54-ФЗ: телефон и/или e-mail. Возвращает строку контакта или бросает ошибку.
  function validateContact({ phone, email }) {
    if (phone && phone.replace(/\D/g, '').length < 10) throw Object.assign(new Error('Проверьте номер телефона'), { expose: true });
    if (email && !EMAIL_PATTERN.test(email)) throw Object.assign(new Error('Проверьте e-mail'), { expose: true });
    const contact = [phone, email].filter(Boolean).join(' ') || null;
    if (receipt.isEnabled() && !receipt.contactFrom(contact)) throw Object.assign(new Error('Для чека укажите телефон или e-mail'), { expose: true });
    return contact;
  }

  const chatsPlacingOrder = new Set(); // защита от двойного нажатия «Оплатить»
  router.post('/order', shopAuth, asyncHandler(async (request, response) => {
    const chatId = request.chatId;
    if (chatsPlacingOrder.has(chatId)) return response.status(429).json({ error: 'Секунду, оформляем…' });
    chatsPlacingOrder.add(chatId);
    let orderId = null;
    try {
      const language = await customers.getLanguage(chatId);
      const requestBody = request.body || {};
      const { items, total } = await cart.getCart(chatId);
      if (!items.length) return response.status(400).json({ error: 'Корзина пуста' });
      const unavailableItem = items.find((cartItem) => cartItem.stock < cartItem.quantity);
      if (unavailableItem) {
        return response.status(400).json({ error: translate(language, 'insufficientStock', (language === 'en' && unavailableItem.name_en) || unavailableItem.name, unavailableItem.stock) });
      }
      const phone = String(requestBody.phone || '').trim().slice(0, 30);
      const email = String(requestBody.email || '').trim().slice(0, 80);
      const contact = validateContact({ phone, email });
      let promo;
      try {
        promo = await pricing.findPromo(requestBody.promo);
      } catch (promoError) {
        isPromoAttemptAllowed(chatId); // неверный промокод тоже считается попыткой подбора
        return response.status(400).json({ error: promoError.message });
      }
      const resolvedDelivery = await resolveDelivery(
        { method: requestBody.delivery, city: requestBody.city, carrier: requestBody.carrier, addr: requestBody.address },
        total, promo.percent, language,
      );
      orderId = await orders.createPendingOrder({
        chatId, address: phone ? `${resolvedDelivery.address} · тел. ${phone}` : resolvedDelivery.address, total: resolvedDelivery.total, items,
        promoCode: promo.code, discountPercent: promo.percent, deliveryCity: resolvedDelivery.deliveryCity, deliveryCost: resolvedDelivery.delivery,
        deliveryMethod: resolvedDelivery.method, contact, carrier: resolvedDelivery.carrier, addrRaw: resolvedDelivery.addrRaw,
      });
      const createdOrder = await database.order.findUnique({ where: { id: orderId }, select: { order_code: true } });
      const orderCode = createdOrder.order_code || String(orderId);
      const payment = await startPayment(orderId);
      await cart.clearCart(chatId); // корзина превратилась в заказ
      if (contact) await customers.setContact(chatId, contact);
      const paymentUrl = payment.confirmation.confirmation_url;
      // ссылка на оплату — ещё и в чат, чтобы не потерялась
      bot.telegram.sendMessage(chatId, translate(language, 'payLinkText', orderCode), {
        reply_markup: { inline_keyboard: [[{ text: translate(language, 'payUrlButton'), url: paymentUrl }]] },
      }).catch(() => {});
      return response.json({ ok: true, id: orderId, code: orderCode, total: resolvedDelivery.total, pay_url: paymentUrl });
    } catch (orderError) {
      if (orderId) await orders.cancelIfNotPaid(orderId); // оплата не создалась — заказ не висит
      if (orderError.expose) return response.status(400).json({ error: orderError.message });
      console.error('Витрина: не удалось оформить заказ', orderError.response?.data || orderError.message);
      return response.status(502).json({ error: 'Не получилось создать оплату. Попробуйте ещё раз через минуту' });
    } finally {
      chatsPlacingOrder.delete(chatId);
    }
  }));

  return router;
}

module.exports = { createCheckoutRouter };
