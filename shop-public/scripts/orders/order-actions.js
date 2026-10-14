// Действия покупателя с заказами: оплатить, повторить, настроить и изменить регулярный заказ.
import { state } from '../state.js';
import { callApi } from '../api.js';
import { confirmAction, openPaymentLink } from '../telegram.js';
import { showToast } from '../utils/toast.js';
import { renderCart } from '../cart/cart-view.js';
import { renderProductGrid } from '../catalog/catalog-view.js';
import { switchTab } from '../navigation.js';
import { loadOrders } from './orders-view.js';
import { pickInterval } from './subscriptions.js';

const DEFAULT_INTERVALS = [14, 30];

async function payExistingOrder(orderId) {
  try {
    const payment = await callApi(`/orders/${orderId}/pay`, {}, 1);
    openPaymentLink(payment.pay_url);
  } catch (error) { showToast(error.message); }
}

async function repeatOrder(orderId) {
  const result = await callApi(`/orders/${orderId}/repeat`, {}, 1);
  state.cart = result.cart || {};
  renderCart();
  renderProductGrid();
  switchTab('cart');
  showToast(result.missing ? 'Часть товаров закончилась — добавили то, что есть' : 'Товары в корзине');
}

async function subscribeToOrder(orderId) {
  const days = await pickInterval(state.subscriptionIntervals || DEFAULT_INTERVALS);
  if (!days) return;
  await callApi('/subscriptions', { order_id: orderId, days }, 1);
  showToast('Регулярный заказ настроен');
  loadOrders();
}

/** change: skip | pause | resume | delete */
async function changeSubscription(subscriptionId, change) {
  if (change === 'delete' && !(await confirmAction('Отменить регулярный заказ?'))) return;
  await callApi(`/subscriptions/${subscriptionId}`, { action: change }, 1);
  loadOrders();
}

/** Ошибку любого действия показываем во всплывающем сообщении */
const showingErrors = (action) => async (element) => {
  try { await action(element); } catch (error) { showToast(error.message); }
};

export const orderActions = {
  'pay-existing-order': (element) => payExistingOrder(Number(element.dataset.orderId)),
  'repeat-order': showingErrors((element) => repeatOrder(element.dataset.orderId)),
  'subscribe-to-order': showingErrors((element) => subscribeToOrder(Number(element.dataset.orderId))),
  'change-subscription': showingErrors((element) => changeSubscription(element.dataset.subscriptionId, element.dataset.change)),
};
