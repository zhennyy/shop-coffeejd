// Единые правила цены для витрины и для оформления в чате:
// доставка по городу, «другие города», бесплатно от суммы, промокоды.
// Названия сравниваем в JS: SQLite COLLATE NOCASE не понимает русские буквы («москва» ≠ «Москва»).
const { database } = require('../database');
const { getDeliverySettings } = require('../settings');

const normalizeName = (text) => String(text || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
const normalizePromoCode = (code) => normalizeName(code).toUpperCase().replace(/\s+/g, '');

// Тариф города из списка (или null, если такого города нет / он выключен)
async function findCity(cityName) {
  const normalizedCity = normalizeName(cityName);
  if (!normalizedCity) return null;
  const activeRates = await database.deliveryRate.findMany({ where: { active: 1 }, select: { city: true, city_en: true, price: true } });
  return activeRates.find((rate) => normalizeName(rate.city) === normalizedCity || (rate.city_en && normalizeName(rate.city_en) === normalizedCity)) || null;
}

async function getDeliveryPrice(cityName) {
  const cityRate = await findCity(cityName);
  return cityRate ? cityRate.price : (await getDeliverySettings()).otherPrice;
}

const promoError = (message, kind) => Object.assign(new Error(message), { kind });

// Промокод: возвращает { code, percent } или бросает понятную ошибку
async function findPromo(code) {
  const normalizedCode = normalizePromoCode(code);
  if (!normalizedCode) return { code: null, percent: 0 };
  const activePromoCodes = await database.promoCode.findMany({ where: { active: 1 } });
  const promoCode = activePromoCodes.find((candidate) => normalizePromoCode(candidate.code) === normalizedCode);
  if (!promoCode) throw promoError('Такого промокода нет', 'notFound');
  if (promoCode.max_uses !== null && promoCode.used_count >= promoCode.max_uses) throw promoError('Промокод уже закончился', 'exhausted');
  return { code: promoCode.code, percent: promoCode.discount_percent };
}

// Итог: товары со скидкой + доставка (с учётом «бесплатно от»).
// deliveryCity = null — самовывоз; fixedDeliveryPrice — цена СДЭК/по расстоянию вместо городского тарифа (коп.)
async function quote(goodsTotal, discountPercent, deliveryCity, fixedDeliveryPrice) {
  const goods = discountPercent > 0 ? Math.round((goodsTotal * (100 - discountPercent)) / 100) : goodsTotal;
  const deliverySettings = await getDeliverySettings();
  let delivery = 0;
  if (deliveryCity != null) delivery = fixedDeliveryPrice != null ? fixedDeliveryPrice : await getDeliveryPrice(deliveryCity);
  if (deliveryCity != null && deliverySettings.freeFrom > 0 && goods >= deliverySettings.freeFrom) delivery = 0;
  return { goods, delivery, total: goods + delivery };
}

// Английское название города для истории заказов (orders.delivery_city хранит русский текст на момент заказа)
async function translateCity(cityName, language) {
  if (!cityName || language !== 'en') return cityName;
  const cityRate = await database.deliveryRate.findFirst({ where: { city: cityName }, select: { city_en: true } });
  return (cityRate && cityRate.city_en) || cityName;
}

module.exports = { normalizeName, findCity, getDeliveryPrice, findPromo, quote, translateCity };
