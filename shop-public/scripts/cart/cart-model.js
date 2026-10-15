// Корзина: подсчёт итогов и изменение количества. Меняем сразу на экране, затем сохраняем на сервере;
// если сервер отказал (например, товар закончился) — возвращаем как было и показываем причину.
import { state } from '../state.js';
import { texts } from '../i18n.js';
import { callApi } from '../api.js';
import { vibrate } from '../telegram.js';
import { showToast } from '../utils/toast.js';
import { findProduct, isSoldByAmount, quantityStep, minimumQuantity } from '../catalog/product-helpers.js';
import { quantityControlHtml } from '../catalog/product-card.js';
import { renderProductSheet } from '../catalog/product-sheet.js';
import { renderCart } from './cart-view.js';

/** itemCount — число позиций для значка (весовой товар считается одной позицией), sum — сумма в копейках */
export function cartTotals() {
  let itemCount = 0;
  let sum = 0;
  for (const [productId, quantity] of Object.entries(state.cart)) {
    const product = findProduct(productId);
    if (!product) continue;
    itemCount += isSoldByAmount(product) ? 1 : quantity;
    sum += quantity * product.price;
  }
  return { itemCount, sum };
}

/** Строки корзины: [{ product, quantity }] — только товары, которые есть в каталоге */
export const cartLines = () =>
  Object.entries(state.cart)
    .map(([productId, quantity]) => ({ product: findProduct(productId), quantity }))
    .filter((line) => line.product);

/** Перерисовать всё, что показывает количество этого товара */
function refreshProductEverywhere(productId) {
  document.querySelectorAll(`[data-quantity-control-for="${productId}"]`).forEach((container) => {
    container.innerHTML = quantityControlHtml(findProduct(productId));
  });
  if (Number(state.openProductId) === Number(productId)) renderProductSheet();
  renderCart();
}

async function saveQuantity(productId, quantity, strength) {
  const previous = state.cart[productId] || 0;
  if (quantity) state.cart[productId] = quantity;
  else delete state.cart[productId];
  vibrate(strength);
  refreshProductEverywhere(productId);
  try {
    await callApi('/cart', { product_id: productId, qty: quantity });
  } catch (error) {
    if (previous) state.cart[productId] = previous;
    else delete state.cart[productId];
    refreshProductEverywhere(productId);
    showToast(error.message);
  }
}

/** «+» (direction 1) или «−» (direction -1). У весовых — шаг в граммах и минимум */
export async function changeQuantity(productId, direction) {
  const product = findProduct(productId);
  if (!product) return;
  const current = state.cart[productId] || 0;
  let next;
  if (isSoldByAmount(product)) {
    const step = quantityStep(product);
    if (direction > 0) next = current ? current + step : minimumQuantity(product);
    else next = current - step < minimumQuantity(product) ? 0 : current - step;
  } else {
    next = Math.max(0, current + direction);
  }
  if (next > product.stock) {
    showToast(texts().noMoreInStock);
    return;
  }
  await saveQuantity(productId, next, direction > 0 ? 'medium' : 'light');
}

/** Задать количество сразу (быстрый выбор веса, «Убрать», «Очистить») */
export async function setQuantity(productId, quantity) {
  const product = findProduct(productId);
  if (!product) return;
  if (quantity > product.stock) {
    showToast(texts().noMoreInStock);
    return;
  }
  await saveQuantity(productId, quantity, 'medium');
}
