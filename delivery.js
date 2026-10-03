// delivery.js — способы доставки кроме базовых «по городу» и «самовывоз»:
//  • post — СДЭК / Почта России: фиксированная цена перевозчика, задаёт владелица (точный тариф перевозчика бот не знает);
//  • distance — цена по расстоянию от точки отправки до адреса покупателя (по прямой), ступенями «до N км — X ₽».
// Адрес превращаем в координаты через OpenStreetMap Nominatim (бесплатно, нужен только интернет). Если сервис не ответил —
// покупателю честно предлагаем другой способ, а не придумываем цену.
const axios = require('axios');
const db = require('./db');

const DEFAULTS = {
  post: { enabled: false, carriers: [{ id: 'cdek', name: 'СДЭК', price: 35000 }, { id: 'russianpost', name: 'Почта России', price: 30000 }] },
  distance: { enabled: false, origin: { address: '', lat: null, lon: null }, tiers: [{ km: 5, price: 20000 }, { km: 15, price: 35000 }, { km: 30, price: 60000 }] },
};
const get = () => {
  const s = db.getSetting('delivery2', {});
  return {
    post: { ...DEFAULTS.post, ...(s.post || {}) },
    distance: { ...DEFAULTS.distance, ...(s.distance || {}), origin: { ...DEFAULTS.distance.origin, ...((s.distance || {}).origin || {}) } },
  };
};
const save = (v) => db.setSetting('delivery2', v);

// ── геокодер (можно подменить в тестах) ──
let geocoder = null;
const cache = new Map();
let chain = Promise.resolve();
async function nominatim(q) {
  const r = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { format: 'jsonv2', limit: 1, q, 'accept-language': 'ru' },
    headers: { 'User-Agent': 'ZernoShopBot/1.0 (delivery distance)' }, timeout: 7000,
  });
  const x = r.data && r.data[0];
  return x ? { lat: parseFloat(x.lat), lon: parseFloat(x.lon) } : null;
}
function geocode(q) {
  const key = String(q).trim().toLowerCase();
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const run = chain.then(async () => {
    const pt = await (geocoder || nominatim)(q);
    if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)) {
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      cache.set(key, pt);
      return pt;
    }
    return null;
  });
  // не больше одного запроса в секунду (правила Nominatim); ошибка не ломает очередь
  chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, geocoder ? 0 : 1100)));
  return run;
}
const setGeocoder = (fn) => { geocoder = fn; cache.clear(); };

const rad = (d) => (d * Math.PI) / 180;
function km(a, b) { // расстояние по прямой, формула гаверсинусов
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const err = (m) => Object.assign(new Error(m), { expose: true });

function tierPrice(tiers, distanceKm) {
  const sorted = [...tiers].sort((a, b) => a.km - b.km);
  const t = sorted.find((x) => distanceKm <= x.km);
  return t ? t.price : null; // дальше последней ступени не возим
}

// Цена доставки по расстоянию для адреса покупателя
async function distanceQuote(address) {
  const d = get().distance;
  if (!d.enabled) throw err('Доставка по расстоянию сейчас недоступна');
  if (d.origin.lat == null) throw err('Точка отправки не настроена');
  const a = String(address || '').trim();
  if (a.length < 8) throw err('Укажите полный адрес: город, улица, дом');
  let pt;
  try { pt = await geocode(a); } catch { throw err('Не получилось определить расстояние. Выберите другой способ доставки или попробуйте позже'); }
  if (!pt) throw err('Адрес не найден на карте. Проверьте город, улицу и дом');
  const dist = km(d.origin, pt);
  const price = tierPrice(d.tiers, dist);
  if (price == null) throw err(`Далеко: по расстоянию возим до ${Math.max(...d.tiers.map((t) => t.km))} км. Выберите СДЭК или Почту`);
  return { price, km: Math.round(dist * 10) / 10 };
}

function carrier(id) {
  const p = get().post;
  if (!p.enabled) throw err('Доставка СДЭК/Почтой сейчас недоступна');
  const c = p.carriers.find((x) => x.id === id);
  if (!c) throw err('Выберите перевозчика');
  return c;
}

// Разбор настроек из админки (ступени «до км : цена ₽»)
function parseTiers(text) {
  const out = String(text || '').split(/[\n;,]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:км)?\s*[:=\-–]\s*(\d+(?:[.,]\d+)?)/i);
    if (!m) throw err(`Не понимаю строку «${s}». Пишите так: 5 : 200 (до 5 км — 200 ₽)`);
    return { km: parseFloat(m[1].replace(',', '.')), price: Math.round(parseFloat(m[2].replace(',', '.')) * 100) };
  });
  if (out.length > 12) throw err('Не больше 12 ступеней');
  if (new Set(out.map((t) => t.km)).size !== out.length) throw err('Расстояния в ступенях не должны повторяться');
  return out.sort((a, b) => a.km - b.km);
}

module.exports = { get, save, geocode, setGeocoder, km, tierPrice, distanceQuote, carrier, parseTiers, DEFAULTS };
