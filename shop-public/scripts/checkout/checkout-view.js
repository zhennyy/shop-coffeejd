// Экран оформления: состав заказа, способ получения, контакты, промокод, итог.
import { texts, isEnglish } from '../i18n.js';
import { isInsideTelegram } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatAmount, formatRubles } from '../utils/format.js';
import { cartTotals, cartLines } from '../cart/cart-model.js';
import { productName, isSoldByAmount } from '../catalog/product-helpers.js';
import { updateMainButton } from '../navigation.js';
import { checkoutForm, checkout, OTHER_CITY, deliveryCost, isDeliveryFree, goodsTotal, discountAmount, addressKey } from './checkout-state.js';

// поле с подписью и сообщением об ошибке под ним
const fieldHtml = (id, label, inputHtml, hint = '') => `<div class="fld"><label class="flbl" for="${id}">${label}${hint ? ` <small>${hint}</small>` : ''}</label>${inputHtml}${checkoutForm.errors[id] ? `<div class="ferr">${escapeHtml(checkoutForm.errors[id])}</div>` : ''}</div>`;
const errorClass = (id) => (checkoutForm.errors[id] ? ' bad' : '');

function deliveryTilesHtml() {
  const info = checkout.info;
  const cheapestCity = info.cities.length ? Math.min(...info.cities.map((city) => city.price)) : info.otherPrice;
  const tiles = [
    ['city', '🚚', 'Курьер по городу', `от ${formatRubles(cheapestCity)} · привезём домой`],
    ...(info.pickup ? [['pickup', '🏠', 'Самовывоз', 'бесплатно · заберёте сами']] : []),
    ...(info.post ? [['post', '📦', 'СДЭК / Почта России', `от ${formatRubles(Math.min(...info.post.carriers.map((carrier) => carrier.price)))} · в другой город`]] : []),
    ...(info.distance ? [['distance', '📍', 'Доставка по расстоянию', `до ${info.distance.maxKm} км · цена по адресу`]] : []),
  ];
  return tiles.map(([method, icon, title, subtitle]) => `<button class="tile ${checkoutForm.delivery === method ? 'on' : ''}" data-action="choose-delivery" data-delivery="${method}"><i>${icon}</i><span><div class="tt">${title}</div><div class="ts">${subtitle}</div></span><span class="dot"></span></button>`).join('');
}

const addressFieldHtml = (placeholder = 'Улица, дом, квартира, подъезд') => fieldHtml('coAddr', 'Адрес', `<textarea id="coAddr" class="${errorClass('coAddr')}" placeholder="${placeholder}">${escapeHtml(checkoutForm.address)}</textarea>`);
const cityInputHtml = (label, placeholder) => fieldHtml('coOther', label, `<input id="coOther" class="${errorClass('coOther')}" placeholder="${placeholder}" value="${escapeHtml(checkoutForm.other)}">`);

/** Поля для выбранного способа получения */
function deliveryFieldsHtml() {
  const info = checkout.info;
  const cityName = (city) => (isEnglish() && city.city_en) || city.city;
  switch (checkoutForm.delivery) {
    case 'pickup':
      return `<div class="note" style="text-align:left;margin:4px 0 0">${info.pickupAddress ? '📍 ' + escapeHtml(info.pickupAddress) + '<br>' : ''}Напишем в чат, когда заказ будет готов к выдаче.</div>`;
    case 'city':
      return fieldHtml('coCity', 'Город', `<select id="coCity">${info.cities.map((city) => `<option value="${escapeHtml(city.city)}" ${checkoutForm.city === city.city ? 'selected' : ''}>${escapeHtml(cityName(city))} — ${formatRubles(city.price)}</option>`).join('')}
          <option value="${OTHER_CITY}" ${checkoutForm.city === OTHER_CITY ? 'selected' : ''}>Другой город — ${formatRubles(info.otherPrice)}</option></select>`)
        + (checkoutForm.city === OTHER_CITY ? cityInputHtml('Название города', 'Например, Тверь') : '') + addressFieldHtml();
    case 'post':
      return fieldHtml('coCarrier', 'Перевозчик', `<select id="coCarrier">${info.post.carriers.map((carrier) => `<option value="${escapeHtml(carrier.id)}" ${checkoutForm.carrier === carrier.id ? 'selected' : ''}>${escapeHtml(carrier.name)} — ${formatRubles(carrier.price)}</option>`).join('')}</select>`)
        + cityInputHtml('Город', 'Город получателя') + addressFieldHtml('Улица, дом, квартира — или пункт выдачи и индекс')
        + '<div class="note" style="text-align:left">Отправим выбранным перевозчиком и пришлём трек-номер в этот чат.</div>';
    default: { // по расстоянию
      const quote = checkoutForm.quote;
      const quoteNote = quote && quote.key === addressKey()
        ? `✓ Расстояние ≈ ${quote.km} км — доставка ${formatRubles(quote.delivery)}`
        : `Возим до ${info.distance.maxKm} км. Стоимость зависит от расстояния до вашего адреса.`;
      return cityInputHtml('Город', 'Ваш город') + addressFieldHtml()
        + `<button class="btn ghost" data-action="quote-distance" style="margin-top:8px">Рассчитать стоимость</button>
       <div class="note" style="text-align:left">${quoteNote}</div>`;
    }
  }
}

function freeDeliveryNoteHtml() {
  const info = checkout.info;
  if (checkoutForm.delivery === 'pickup' || !(info.freeFrom > 0)) return '';
  const text = isDeliveryFree() ? '✓ Доставка для вас бесплатная' : `Бесплатная доставка от ${formatRubles(info.freeFrom)} — осталось ${formatRubles(info.freeFrom - goodsTotal())}`;
  return `<div class="note" style="text-align:left;margin:0 0 4px">${text}</div>`;
}

function contactsHtml() {
  const phone = fieldHtml('coPhone', 'Телефон', `<input id="coPhone" class="${errorClass('coPhone')}" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" value="${escapeHtml(checkoutForm.phone)}">`, 'чтобы связаться по заказу');
  if (!checkout.info.receipts) return phone;
  return phone + fieldHtml('coEmail', 'E-mail', `<input id="coEmail" class="${errorClass('coEmail')}" type="email" inputmode="email" autocomplete="email" placeholder="name@mail.ru" value="${escapeHtml(checkoutForm.email)}">`, 'необязательно — для чека')
    + '<div class="note" style="text-align:left">Чек придёт после оплаты на телефон или e-mail.</div>';
}

function summaryHtml() {
  const { sum } = cartTotals();
  const discount = discountAmount();
  const cost = deliveryCost();
  const deliveryText = checkoutForm.delivery === 'pickup' || isDeliveryFree() ? 'бесплатно' : cost == null ? 'посчитаем по адресу' : formatRubles(cost);
  return `<div class="box">
      <div class="sumrow"><span>Товары</span><span>${formatRubles(sum)}</span></div>
      ${discount ? `<div class="sumrow"><span>Скидка ${checkoutForm.promoPercent}%</span><span>−${formatRubles(discount)}</span></div>` : ''}
      <div class="sumrow"><span>Доставка</span><span>${deliveryText}</span></div>
      <div class="sumrow big"><span>К оплате</span><span>${cost == null ? '—' : formatRubles(sum - discount + cost)}</span></div>
    </div>`;
}

const orderLinesHtml = () => cartLines().map(({ product, quantity }) => {
  const amount = isSoldByAmount(product) ? ', ' + formatAmount(quantity, product.unit) : quantity > 1 ? ' × ' + quantity : '';
  return `<li><span>${escapeHtml(productName(product))}${amount}</span><span>${formatRubles(product.price * quantity)}</span></li>`;
}).join('');

export function renderCheckout() {
  const { sum } = cartTotals();
  const cost = deliveryCost();
  const total = sum - discountAmount() + (cost || 0);
  getElement('v-checkout').innerHTML = `<h1>Оформление</h1>
    <div class="steps2"><b>① Получение</b><span>② Оплата</span><span>③ Статус в чате</span></div>
    <div class="box"><h3>Ваш заказ</h3>
      <ul class="osum">${orderLinesHtml()}</ul></div>
    <div class="box"><h3>Как получить</h3>
      ${deliveryTilesHtml()}
      ${freeDeliveryNoteHtml()}
      ${deliveryFieldsHtml()}</div>
    <div class="box"><h3>Контакты</h3>
      ${contactsHtml()}
    </div>
    <div class="box"><h3>Промокод</h3>
      <div class="promo"><input id="coPromo" placeholder="Если есть" value="${escapeHtml(checkoutForm.promo)}" autocapitalize="characters"><button class="btn ghost" data-action="apply-promo">Применить</button></div>
      ${checkoutForm.promoMessage ? `<div class="fld ok">✓ ${escapeHtml(checkoutForm.promoMessage)}</div>` : ''}
    </div>
    ${summaryHtml()}
    ${isInsideTelegram ? '' : `<button class="btn" data-action="pay-order">${cost == null ? 'Рассчитать и оформить' : 'Оплатить · ' + formatRubles(total)}</button>`}
    <div class="note">${texts().checkoutNote} Деньги списываются только после вашего подтверждения оплаты.</div>`;
  listenToCheckoutFields();
  updateMainButton();
}

// поле исправили — убираем подсветку ошибки
function clearFieldError(field) {
  field.classList.remove('bad');
  field.closest('.fld')?.querySelector('.ferr')?.remove();
  delete checkoutForm.errors[field.id];
}

/** Связать поле с checkoutForm[formKey]; rerender — перерисовать экран (меняется цена) */
function bindField(id, formKey, rerender = false) {
  const field = getElement(id);
  if (!field) return;
  field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', (event) => {
    checkoutForm[formKey] = event.target.value;
    clearFieldError(field);
    if (rerender) renderCheckout(); else updateMainButton();
  });
}

function listenToCheckoutFields() {
  bindField('coCity', 'city', true);
  bindField('coCarrier', 'carrier', true);
  bindField('coOther', 'other');
  bindField('coAddr', 'address');
  bindField('coPhone', 'phone');
  bindField('coEmail', 'email');
  bindField('coPromo', 'promo');
  // цена зависит от города/адреса — пересчитываем, когда покупатель закончил ввод
  if (getElement('coOther') && checkoutForm.delivery === 'city') getElement('coOther').addEventListener('change', () => renderCheckout());
  if (getElement('coAddr') && checkoutForm.delivery === 'distance') getElement('coAddr').addEventListener('change', () => renderCheckout());
}
