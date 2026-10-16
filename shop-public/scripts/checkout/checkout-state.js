// Данные формы оформления и расчёт стоимости: товары со скидкой, доставка, итог к оплате.
import { cartTotals } from '../cart/cart-model.js';

// введённое покупателем (сохраняется между открытиями оформления)
export const checkoutForm = {
  delivery: 'city', // city | pickup | post | distance
  city: '', // город из списка или '__other'
  other: '', // свой город (для «другой город», СДЭК/Почты и доставки по расстоянию)
  address: '',
  phone: '',
  email: '',
  carrier: '',
  quote: null, // { key, delivery, km } — рассчитанная доставка по расстоянию для адреса key
  promo: '',
  promoPercent: 0,
  promoMessage: '',
  consent: false, // согласие на обработку персональных данных — отмечает сам покупатель, для каждого заказа заново
  errors: {}, // id поля → текст ошибки
};

export const OTHER_CITY = '__other';

export const checkout = {
  info: null, // условия доставки с сервера (/checkout-info)
  isPrepared: false, // форма заполнена значениями по умолчанию
  isPaying: false,
};

const discountFor = (sum) => (checkoutForm.promoPercent ? Math.round((sum * checkoutForm.promoPercent) / 100) : 0);

/** Сумма товаров со скидкой по промокоду */
export function goodsTotal() {
  const { sum } = cartTotals();
  return sum - discountFor(sum);
}

export const discountAmount = () => discountFor(cartTotals().sum);

export const isDeliveryFree = () =>
  Boolean(
    checkout.info &&
    checkout.info.freeFrom > 0 &&
    checkoutForm.delivery !== 'pickup' &&
    goodsTotal() >= checkout.info.freeFrom,
  );

/** Ключ адреса: расчёт по расстоянию действителен, пока адрес не поменяли */
export const addressKey = () =>
  [checkoutForm.city, checkoutForm.other, checkoutForm.address].join('|').trim().toLowerCase();

const normalizeCity = (city) =>
  String(city || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');

/** Стоимость доставки в копейках; null — пока неизвестна (нужен расчёт по адресу) */
export function deliveryCost() {
  const info = checkout.info;
  if (checkoutForm.delivery === 'pickup' || !info) return 0;
  if (isDeliveryFree()) return 0;
  if (checkoutForm.delivery === 'post') {
    const carrier = (info.post?.carriers || []).find((candidate) => candidate.id === checkoutForm.carrier);
    return carrier ? carrier.price : 0;
  }
  if (checkoutForm.delivery === 'distance') {
    const quote = checkoutForm.quote;
    return quote && quote.key === addressKey() ? quote.delivery : null;
  }
  const wantedCity =
    checkoutForm.city === OTHER_CITY ? normalizeCity(checkoutForm.other) : normalizeCity(checkoutForm.city);
  const knownCity = info.cities.find(
    (city) => normalizeCity(city.city) === wantedCity || (city.city_en && normalizeCity(city.city_en) === wantedCity),
  );
  if (knownCity) return knownCity.price;
  return checkoutForm.city === OTHER_CITY ? info.otherPrice : 0;
}

/** Итого к оплате (если доставка ещё не рассчитана — без неё) */
export const amountToPay = () => goodsTotal() + (deliveryCost() || 0);
