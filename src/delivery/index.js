// Способы доставки кроме базовых «по городу» и «самовывоз»:
//  • post — СДЭК / Почта России: фиксированная цена перевозчика, задаёт владелица (точный тариф перевозчика бот не знает);
//  • distance — цена по расстоянию от точки отправки до адреса покупателя (по прямой), ступенями «до N км — X ₽».
// Адрес превращаем в координаты через OpenStreetMap Nominatim (бесплатно, нужен только интернет). Если сервис не ответил —
// покупателю честно предлагаем другой способ, а не придумываем цену.
const axios = require('axios');
const { getSetting, setSetting } = require('../settings');

const SETTINGS_KEY = 'delivery2';
const DEFAULT_OPTIONS = {
  post: { enabled: false, carriers: [{ id: 'cdek', name: 'СДЭК', price: 35000 }, { id: 'russianpost', name: 'Почта России', price: 30000 }] },
  distance: { enabled: false, origin: { address: '', lat: null, lon: null }, tiers: [{ km: 5, price: 20000 }, { km: 15, price: 35000 }, { km: 30, price: 60000 }] },
};
const MAX_GEOCODE_QUEUE = 15;
const MAX_GEOCODE_CACHE = 500;
const NOMINATIM_PAUSE_MS = 1100; // правила Nominatim: не больше одного запроса в секунду
const EARTH_RADIUS_KM = 6371;
const MAX_DISTANCE_TIERS = 12;

const userError = (message) => Object.assign(new Error(message), { expose: true });

async function getDeliveryOptions() {
  const savedOptions = await getSetting(SETTINGS_KEY, {});
  const savedDistance = savedOptions.distance || {};
  return {
    post: { ...DEFAULT_OPTIONS.post, ...(savedOptions.post || {}) },
    distance: { ...DEFAULT_OPTIONS.distance, ...savedDistance, origin: { ...DEFAULT_OPTIONS.distance.origin, ...(savedDistance.origin || {}) } },
  };
}
const saveDeliveryOptions = (options) => setSetting(SETTINGS_KEY, options);

// ── Геокодер (в тестах подменяется через setGeocoder) ──
let customGeocoder = null;
const geocodeCache = new Map();
let geocodeQueue = Promise.resolve();
let pendingGeocodeCount = 0;

async function geocodeWithNominatim(address) {
  const response = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { format: 'jsonv2', limit: 1, q: address, 'accept-language': 'ru' },
    headers: { 'User-Agent': 'CoFFeeJDShopBot/1.0 (delivery distance)' },
    timeout: 7000,
  });
  const foundPlace = response.data && response.data[0];
  return foundPlace ? { lat: parseFloat(foundPlace.lat), lon: parseFloat(foundPlace.lon) } : null;
}

function geocode(address) {
  const cacheKey = String(address).trim().toLowerCase();
  if (geocodeCache.has(cacheKey)) return Promise.resolve(geocodeCache.get(cacheKey));
  if (pendingGeocodeCount >= MAX_GEOCODE_QUEUE) return Promise.reject(new Error('Сервис адресов перегружен — попробуйте через минуту'));
  pendingGeocodeCount++;
  const geocodeRequest = geocodeQueue.then(async () => {
    const point = await (customGeocoder || geocodeWithNominatim)(address);
    if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
      if (geocodeCache.size > MAX_GEOCODE_CACHE) geocodeCache.delete(geocodeCache.keys().next().value);
      geocodeCache.set(cacheKey, point);
      return point;
    }
    return null;
  });
  geocodeRequest.finally(() => { pendingGeocodeCount--; }).catch(() => {});
  // запросы идут по одному с паузой; ошибка одного не ломает очередь
  geocodeQueue = geocodeRequest.catch(() => {}).then(() => new Promise((resolve) => setTimeout(resolve, customGeocoder ? 0 : NOMINATIM_PAUSE_MS)));
  return geocodeRequest;
}
const setGeocoder = (geocoderFunction) => { customGeocoder = geocoderFunction; geocodeCache.clear(); };

const toRadians = (degrees) => (degrees * Math.PI) / 180;
// Расстояние по прямой между двумя точками, км (формула гаверсинусов)
function distanceBetween(fromPoint, toPoint) {
  const latitudeDelta = toRadians(toPoint.lat - fromPoint.lat);
  const longitudeDelta = toRadians(toPoint.lon - fromPoint.lon);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(fromPoint.lat)) * Math.cos(toRadians(toPoint.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(haversine));
}

function priceForDistance(tiers, distanceKm) {
  const matchingTier = [...tiers].sort((first, second) => first.km - second.km).find((tier) => distanceKm <= tier.km);
  return matchingTier ? matchingTier.price : null; // дальше последней ступени не возим
}

// Цена доставки по расстоянию до адреса покупателя
async function quoteByDistance(address) {
  const distanceOptions = (await getDeliveryOptions()).distance;
  if (!distanceOptions.enabled) throw userError('Доставка по расстоянию сейчас недоступна');
  if (distanceOptions.origin.lat == null) throw userError('Точка отправки не настроена');
  const cleanAddress = String(address || '').trim();
  if (cleanAddress.length < 8) throw userError('Укажите полный адрес: город, улица, дом');
  let customerPoint;
  try {
    customerPoint = await geocode(cleanAddress);
  } catch {
    throw userError('Не получилось определить расстояние. Выберите другой способ доставки или попробуйте позже');
  }
  if (!customerPoint) throw userError('Адрес не найден на карте. Проверьте город, улицу и дом');
  const distanceKm = distanceBetween(distanceOptions.origin, customerPoint);
  const price = priceForDistance(distanceOptions.tiers, distanceKm);
  if (price == null) {
    throw userError(`Далеко: по расстоянию возим до ${Math.max(...distanceOptions.tiers.map((tier) => tier.km))} км. Выберите СДЭК или Почту`);
  }
  return { price, km: Math.round(distanceKm * 10) / 10 };
}

async function getCarrier(carrierId) {
  const postOptions = (await getDeliveryOptions()).post;
  if (!postOptions.enabled) throw userError('Доставка СДЭК/Почтой сейчас недоступна');
  const carrier = postOptions.carriers.find((candidate) => candidate.id === carrierId);
  if (!carrier) throw userError('Выберите перевозчика');
  return carrier;
}

// Разбор ступеней из админки: строки «до км : цена ₽»
function parseDistanceTiers(text) {
  const tiers = String(text || '').split(/[\n;,]+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const tierMatch = line.match(/^(\d+(?:[.,]\d+)?)\s*(?:км)?\s*[:=\-–]\s*(\d+(?:[.,]\d+)?)/i);
    if (!tierMatch) throw userError(`Не понимаю строку «${line}». Пишите так: 5 : 200 (до 5 км — 200 ₽)`);
    return { km: parseFloat(tierMatch[1].replace(',', '.')), price: Math.round(parseFloat(tierMatch[2].replace(',', '.')) * 100) };
  });
  if (tiers.length > MAX_DISTANCE_TIERS) throw userError(`Не больше ${MAX_DISTANCE_TIERS} ступеней`);
  if (new Set(tiers.map((tier) => tier.km)).size !== tiers.length) throw userError('Расстояния в ступенях не должны повторяться');
  return tiers.sort((first, second) => first.km - second.km);
}

module.exports = {
  getDeliveryOptions, saveDeliveryOptions, geocode, setGeocoder, distanceBetween, priceForDistance,
  quoteByDistance, getCarrier, parseDistanceTiers, DEFAULT_OPTIONS,
};
