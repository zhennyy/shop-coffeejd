// Общий расчёт доставки и цены для витрины и повторных заказов (одно правило в двух местах — меньше багов)
const pricing = require('../pricing');
const delivery = require('../delivery');
const { getDeliverySettings } = require('../settings');
const { translate } = require('../i18n');

const userError = (message) => Object.assign(new Error(message), { expose: true });
const DELIVERY_METHODS = ['pickup', 'city', 'post', 'distance'];

// Вход: { method, city, carrier, addr }; goodsTotal — сумма товаров в коп. до скидки; discountPercent — скидка промокода.
// Выход: { method, deliveryCity, address, addrRaw, carrier, delivery, goods, total, km? }
async function resolveDelivery({ method, city, carrier, addr }, goodsTotal, discountPercent, language = 'ru') {
  const deliveryMethod = DELIVERY_METHODS.includes(method) ? method : 'city';
  const deliverySettings = await getDeliverySettings();
  const streetAddress = String(addr || '').trim().slice(0, 300);
  const cityName = String(city || '').trim().slice(0, 80);
  let deliveryCity = null;
  let fullAddress;
  let fixedDeliveryPrice;
  let distanceKm;
  let carrierId = null;

  if (deliveryMethod === 'pickup') {
    if (!deliverySettings.pickup) throw userError('Самовывоза сейчас нет — выберите доставку');
    fullAddress = translate(language, 'pickupSet');
  } else {
    if (!cityName) throw userError('Выберите город');
    if (streetAddress.length < 5) throw userError('Укажите адрес: улица, дом, квартира');
    if (deliveryMethod === 'city') {
      const knownCity = await pricing.findCity(cityName);
      deliveryCity = knownCity ? knownCity.city : cityName;
      fullAddress = `${deliveryCity}, ${streetAddress}`;
    } else if (deliveryMethod === 'post') {
      const chosenCarrier = await delivery.getCarrier(carrier);
      carrierId = chosenCarrier.id;
      deliveryCity = cityName;
      fixedDeliveryPrice = chosenCarrier.price;
      fullAddress = `${chosenCarrier.name} · ${cityName}, ${streetAddress}`;
    } else {
      const distanceQuote = await delivery.quoteByDistance(`${cityName}, ${streetAddress}`);
      deliveryCity = cityName;
      fixedDeliveryPrice = distanceQuote.price;
      distanceKm = distanceQuote.km;
      fullAddress = `${cityName}, ${streetAddress} (≈${distanceQuote.km} км)`;
    }
  }

  const priceQuote = await pricing.quote(goodsTotal, discountPercent, deliveryCity, fixedDeliveryPrice);
  return {
    method: deliveryMethod, deliveryCity, address: fullAddress, addrRaw: streetAddress, carrier: carrierId,
    delivery: priceQuote.delivery, goods: priceQuote.goods, total: priceQuote.total, km: distanceKm,
  };
}

module.exports = { resolveDelivery, DELIVERY_METHODS, userError };
