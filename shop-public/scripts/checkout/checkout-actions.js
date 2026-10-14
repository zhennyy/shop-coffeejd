// Оформление заказа: открыть форму с подставленными данными, проверить поля, рассчитать доставку,
// применить промокод и создать заказ — после этого открывается ссылка на оплату ЮKassa.
import { state } from '../state.js';
import { texts } from '../i18n.js';
import { callApi } from '../api.js';
import { telegram, vibrate, openPaymentLink } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { showToast } from '../utils/toast.js';
import { cartTotals } from '../cart/cart-model.js';
import { renderCart } from '../cart/cart-view.js';
import { renderProductGrid } from '../catalog/catalog-view.js';
import { switchTab } from '../navigation.js';
import { checkoutForm, checkout, OTHER_CITY, deliveryCost, addressKey } from './checkout-state.js';
import { renderCheckout } from './checkout-view.js';

const MIN_CITY_LENGTH = 2;
const MIN_ADDRESS_LENGTH = 5;
const MIN_PHONE_DIGITS = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Значения по умолчанию: Петербург (или первый город), первый перевозчик, контакты из прошлого заказа */
function prefillForm(info) {
  if (!checkoutForm.city && info.cities.length) checkoutForm.city = (info.cities.find((city) => /петербург/i.test(city.city)) || info.cities[0]).city;
  if (!checkoutForm.city) checkoutForm.city = OTHER_CITY;
  if (!info.pickup && checkoutForm.delivery === 'pickup') checkoutForm.delivery = 'city';
  if (info.post && !checkoutForm.carrier) checkoutForm.carrier = info.post.carriers[0]?.id || '';
  const savedContacts = String(info.contact || '').split(/\s+/);
  if (!checkoutForm.phone) checkoutForm.phone = savedContacts.find((contact) => !contact.includes('@') && contact.replace(/\D/g, '').length >= MIN_PHONE_DIGITS) || '';
  if (!checkoutForm.email) checkoutForm.email = savedContacts.find((contact) => contact.includes('@')) || '';
}

export async function openCheckout() {
  if (!cartTotals().itemCount) { showToast(texts().cartEmpty); return; }
  switchTab('checkout');
  if (!checkout.isPrepared) {
    if (!state.shopInfo) {
      const view = getElement('v-checkout');
      view.innerHTML = '<h1>Оформление</h1><div class="skel" style="aspect-ratio:3/1"></div>';
      try {
        state.shopInfo = await callApi('/checkout-info');
      } catch (error) {
        view.innerHTML = `<h1>Оформление</h1><div class="empty">${escapeHtml(error.message)}<br><br><button class="btn ghost" data-action="open-checkout">Повторить</button></div>`;
        return;
      }
    }
    checkout.info = state.shopInfo;
    prefillForm(checkout.info);
    checkout.isPrepared = true;
  }
  checkoutForm.errors = {};
  renderCheckout();
}

/** Подсветить поле с ошибкой, прокрутить к нему и показать подсказку */
function showFieldError(fieldId, message) {
  checkoutForm.errors = { [fieldId]: message };
  renderCheckout();
  const field = getElement(fieldId);
  if (field) {
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  vibrate('heavy');
  showToast(message);
}

async function quoteDistanceDelivery() {
  if (checkoutForm.other.trim().length < MIN_CITY_LENGTH || checkoutForm.address.trim().length < MIN_ADDRESS_LENGTH) { showToast('Укажите город и адрес'); return false; }
  try {
    const quote = await callApi('/delivery-quote', { delivery: 'distance', city: checkoutForm.other.trim(), address: checkoutForm.address, promo: checkoutForm.promoPercent ? checkoutForm.promo : '' }, 1);
    checkoutForm.quote = { key: addressKey(), delivery: quote.delivery, km: quote.km };
    renderCheckout();
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

async function applyPromo() {
  checkoutForm.promo = (getElement('coPromo')?.value || '').trim();
  if (!checkoutForm.promo) {
    checkoutForm.promoPercent = 0;
    checkoutForm.promoMessage = '';
    renderCheckout();
    return;
  }
  try {
    const promo = await callApi('/promo', { code: checkoutForm.promo }, 1);
    checkoutForm.promoPercent = promo.percent;
    checkoutForm.promoMessage = `Скидка ${promo.percent}%`;
    vibrate('medium');
  } catch (error) {
    checkoutForm.promoPercent = 0;
    checkoutForm.promoMessage = '';
    showToast(error.message);
  }
  renderCheckout();
}

/** Первая ошибка в форме: [id поля, текст] или null */
function findFormError() {
  const method = checkoutForm.delivery;
  const hasCity = checkoutForm.other.trim().length >= MIN_CITY_LENGTH;
  if (method === 'city' && checkoutForm.city === OTHER_CITY && !hasCity) return ['coOther', 'Укажите город'];
  if ((method === 'post' || method === 'distance') && !hasCity) return ['coOther', 'Укажите город'];
  if (method !== 'pickup' && checkoutForm.address.trim().length < MIN_ADDRESS_LENGTH) return ['coAddr', 'Укажите адрес: улица, дом, квартира'];
  // без телефона можно, если включены чеки и указан e-mail
  if (checkoutForm.phone.replace(/\D/g, '').length < MIN_PHONE_DIGITS && !(checkoutForm.email && checkout.info.receipts)) return ['coPhone', 'Введите телефон полностью, например +7 900 123-45-67'];
  if (checkoutForm.email && !EMAIL_PATTERN.test(checkoutForm.email.trim())) return ['coEmail', 'Проверьте e-mail — например, name@mail.ru'];
  return null;
}

function deliveryCityForOrder() {
  const method = checkoutForm.delivery;
  if (method === 'city') return checkoutForm.city === OTHER_CITY ? checkoutForm.other.trim() : checkoutForm.city;
  return method === 'pickup' ? '' : checkoutForm.other.trim();
}

/** Кнопка «Оплатить»: проверить форму, создать заказ и открыть оплату */
export async function payForOrder() {
  if (checkout.isPaying) return;
  const formError = findFormError();
  if (formError) { showFieldError(...formError); return; }
  if (checkoutForm.delivery === 'distance' && deliveryCost() == null) { await quoteDistanceDelivery(); return; } // сначала покажем цену, потом оплата
  if (checkoutForm.promo && !checkoutForm.promoPercent) {
    await applyPromo();
    if (!checkoutForm.promoPercent) return;
  }
  checkout.isPaying = true;
  telegram?.MainButton?.showProgress?.();
  try {
    const method = checkoutForm.delivery;
    const order = await callApi('/order', {
      delivery: method, city: deliveryCityForOrder(), carrier: method === 'post' ? checkoutForm.carrier : '', address: checkoutForm.address,
      phone: checkoutForm.phone, email: checkoutForm.email.trim(), promo: checkoutForm.promoPercent ? checkoutForm.promo : '',
    }, 1);
    vibrate('heavy');
    state.cart = {};
    renderCart();
    renderProductGrid();
    Object.assign(checkoutForm, { promo: '', promoPercent: 0, promoMessage: '', quote: null });
    openPaymentLink(order.pay_url);
    switchTab('orders');
    showToast(`Заказ ${order.code} создан — осталось оплатить`);
  } catch (error) {
    showToast(error.message);
  } finally {
    checkout.isPaying = false;
    telegram?.MainButton?.hideProgress?.();
  }
}

export const checkoutActions = {
  'open-checkout': () => openCheckout(),
  'choose-delivery': (element) => { checkoutForm.delivery = element.dataset.delivery; renderCheckout(); },
  'apply-promo': () => applyPromo(),
  'quote-distance': () => quoteDistanceDelivery(),
  'pay-order': () => payForOrder(),
};
