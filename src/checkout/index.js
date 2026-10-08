// checkout-core.js — общий расчёт доставки и цены для витрины и повторных заказов (одно правило в двух местах — меньше багов).
const db = require('../database');
const pricing = require('../pricing');
const delivery = require('../delivery');
const { t } = require('../i18n');

const err = (m) => Object.assign(new Error(m), { expose: true });
const METHODS = ['pickup', 'city', 'post', 'distance'];

// in: {method, city, carrier, addr}; goodsTotal — сумма товаров в коп. до скидки; percent — скидка промокода
// out: { method, deliveryCity, address, addrRaw, carrier, delivery, goods, total, km? }
async function resolve({ method, city, carrier, addr }, goodsTotal, percent, lang = 'ru') {
  method = METHODS.includes(method) ? method : 'city';
  const ds = db.getDeliverySettings();
  const a = String(addr || '').trim().slice(0, 300);
  const c = String(city || '').trim().slice(0, 80);
  let deliveryCity = null, address, fixed, km, carrierId = null;
  if (method === 'pickup') {
    if (!ds.pickup) throw err('Самовывоза сейчас нет — выберите доставку');
    address = t(lang, 'pickupSet');
  } else {
    if (!c) throw err('Выберите город');
    if (a.length < 5) throw err('Укажите адрес: улица, дом, квартира');
    if (method === 'city') {
      const known = pricing.findCity(c);
      deliveryCity = known ? known.city : c;
      address = `${deliveryCity}, ${a}`;
    } else if (method === 'post') {
      const cr = delivery.carrier(carrier);
      carrierId = cr.id; deliveryCity = c; fixed = cr.price;
      address = `${cr.name} · ${c}, ${a}`;
    } else {
      const q = await delivery.distanceQuote(`${c}, ${a}`);
      deliveryCity = c; fixed = q.price; km = q.km;
      address = `${c}, ${a} (≈${q.km} км)`;
    }
  }
  const q = pricing.quote(goodsTotal, percent, deliveryCity, fixed);
  return { method, deliveryCity, address, addrRaw: a, carrier: carrierId, delivery: q.delivery, goods: q.goods, total: q.total, km };
}
module.exports = { resolve, METHODS, err };
