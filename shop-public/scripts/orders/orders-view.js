// Вкладка «Мои заказы»: регулярные заказы сверху, затем карточки заказов со статусом и этапами.
import { state } from '../state.js';
import { texts, isEnglish, inLanguage } from '../i18n.js';
import { callApi } from '../api.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatAmount, formatRubles, formatDateTime, formatStars } from '../utils/format.js';
import { subscriptionsHtml } from './subscriptions.js';

/** Пояснение к статусу: что сейчас происходит с заказом */
function statusExplanation(order) {
  const isPickup = order.pickup;
  const explanations = {
    awaiting_payment: inLanguage(
      'Ждём оплату. Нажмите «Оплатить» ниже — ссылка действует недолго.',
      'Waiting for payment. Tap Pay below.',
    ),
    paid: inLanguage('Оплата получена. Скоро начнём собирать заказ.', 'Payment received. We will start packing soon.'),
    assembling: inLanguage('Собираем ваш заказ.', 'We are packing your order.'),
    shipped: isPickup
      ? inLanguage('Заказ готов к выдаче — приходите, мы ждём.', 'Ready for pickup.')
      : inLanguage('Заказ отправлен. Трек-номер появится ниже, если он есть.', 'Your order is on its way.'),
    delivered: isPickup
      ? inLanguage('Заказ выдан. Спасибо, что выбрали нас!', 'Picked up. Thank you!')
      : inLanguage('Заказ доставлен. Приятного!', 'Delivered. Enjoy!'),
    cancelled: inLanguage(
      'Заказ отменён. Если оплата была — деньги вернутся.',
      'Order cancelled. If paid, you will be refunded.',
    ),
  };
  return explanations[order.status] || '';
}

/** Этапы «Оплачен → Собираем → Отправлен → Доставлен»; order.step — текущий этап (−1 — не показывать) */
function progressStepsHtml(order) {
  if (order.step < 0) return '';
  const names = isEnglish()
    ? ['Paid', 'Packing', order.pickup ? 'Ready' : 'Shipped', order.pickup ? 'Picked up' : 'Delivered']
    : ['Оплачен', 'Собираем', order.pickup ? 'Готов' : 'Отправлен', order.pickup ? 'Получен' : 'Доставлен'];
  const LAST_STEP = 3;
  return `<div class="steps">${names
    .map((name, index) => {
      const stepClass = index < order.step || order.step === LAST_STEP ? 'done' : index === order.step ? 'now' : '';
      return `<div class="${stepClass}">${name}</div>`;
    })
    .join('')}</div>`;
}

/** «Название, 250 г» или «Название × 2» */
export const orderItemLabel = (item) =>
  escapeHtml(item.name) + (item.unit ? ', ' + formatAmount(item.qty, item.unit) : ' × ' + item.qty);

function orderHtml(order) {
  const canRepeat = order.status !== 'awaiting_payment' && order.status !== 'cancelled';
  return `
    <div class="order">
      <div class="top"><span class="code">№ ${escapeHtml(order.code)}</span><span class="pill ${escapeHtml(order.status)}">${escapeHtml(order.statusLabel)}</span></div>
      <div class="stnote">${escapeHtml(statusExplanation(order))}</div>
      ${progressStepsHtml(order)}
      <ul>${order.items.map((item) => `<li><span>${orderItemLabel(item)}</span><span>${formatRubles(item.price * item.qty)}</span></li>`).join('')}
        ${order.delivery_cost ? `<li><span>${texts().delivery}</span><span>${formatRubles(order.delivery_cost)}</span></li>` : ''}</ul>
      <div class="sum"><span>${texts().total}</span><span>${formatRubles(order.total)}</span></div>
      <div class="meta">${escapeHtml(formatDateTime(order.created_at))}${order.address ? ' · ' + escapeHtml(order.address) : ''}</div>
      ${order.track ? `<div class="track">🚚 ${inLanguage('Трек-номер', 'Tracking')}: <b>${escapeHtml(order.track)}</b></div>` : ''}
      ${order.rating ? `<div class="stars">${formatStars(order.rating)}</div>` : ''}
      ${order.can_pay ? `<button class="btn pay" data-action="pay-existing-order" data-order-id="${order.id}">💳 Оплатить ${formatRubles(order.total)}</button>` : ''}
      ${canRepeat ? `<div class="seg" style="margin-top:8px;flex-wrap:wrap"><button data-action="repeat-order" data-order-id="${order.id}">Повторить заказ</button>${order.can_subscribe ? `<button data-action="subscribe-to-order" data-order-id="${order.id}">Повторять регулярно</button>` : ''}</div>` : ''}
    </div>`;
}

export async function loadOrders() {
  const view = getElement('v-orders');
  view.innerHTML = `<h1>${texts().ordersTitle}</h1><div class="skel" style="aspect-ratio:3/1"></div>`;
  let subscriptionData = { subscriptions: [], intervals: [] };
  try {
    state.orders = (await callApi('/orders')).orders;
  } catch (error) {
    view.innerHTML = `<h1>${texts().ordersTitle}</h1><div class="empty">${escapeHtml(error.message)}</div>`;
    return;
  }
  try {
    subscriptionData = await callApi('/subscriptions');
  } catch {
    /* подписки не обязательны для показа заказов */
  }
  state.subscriptionIntervals = subscriptionData.intervals;
  const ordersHtml = state.orders.length
    ? state.orders.map(orderHtml).join('')
    : `<div class="empty"><b>📦</b>${texts().ordersEmpty}</div>`;
  view.innerHTML = `<h1>${texts().ordersTitle}</h1>` + subscriptionsHtml(subscriptionData.subscriptions) + ordersHtml;
}
