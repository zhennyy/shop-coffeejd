// Вкладка «Корзина», значок количества на вкладке и плавающая кнопка корзины (вне Telegram).
import { state } from '../state.js';
import { texts, inLanguage } from '../i18n.js';
import { isInsideTelegram, confirmAction } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatAmount, formatRubles } from '../utils/format.js';
import { productPhotoHtml } from '../catalog/product-photo.js';
import { quantityStepperHtml } from '../catalog/product-card.js';
import { productName, priceText, isSoldByAmount } from '../catalog/product-helpers.js';
import { closeSheet } from '../catalog/product-sheet.js';
import { switchTab, updateMainButton } from '../navigation.js';
import { cartTotals, cartLines, changeQuantity, setQuantity } from './cart-model.js';

function freeDeliveryProgressHtml(sum) {
  const freeFrom = state.shopInfo && state.shopInfo.freeFrom > 0 ? state.shopInfo.freeFrom : 0;
  if (!freeFrom) return '';
  if (sum >= freeFrom) return `<div class="freebar ok"><b>${inLanguage('🎉', '')}</b> ${inLanguage('Доставка будет бесплатной', 'Delivery will be free')}</div>`;
  const missing = formatRubles(freeFrom - sum);
  const percent = Math.min(100, Math.round(sum / freeFrom * 100));
  return `<div class="freebar"><div>${inLanguage(`Добавьте ещё на <b>${missing}</b> — и доставка бесплатно`, `Add <b>${missing}</b> more for free delivery`)}</div><div class="bar"><i style="width:${percent}%"></i></div></div>`;
}

function cartLineHtml({ product, quantity }) {
  let details = '';
  if (isSoldByAmount(product)) details = formatAmount(quantity, product.unit) + ' · ' + priceText(product);
  else if (quantity > 1) details = quantity + ' × ' + formatRubles(product.price);
  return `
      <div class="line">
        <div class="thumb" data-action="open-product" data-product-id="${product.id}">${productPhotoHtml(product)}</div>
        <div class="mid"><div class="name">${escapeHtml(productName(product))}</div>
          <div class="sub">${details}</div>
          <div class="price">${formatRubles(product.price * quantity)}</div></div>
        <div class="rt">${quantityStepperHtml(product, quantity, { withLabels: true })}
          <button class="linkbtn rm" data-action="remove-from-cart" data-product-id="${product.id}">${inLanguage('Убрать', 'Remove')}</button></div>
      </div>`;
}

const emptyCartHtml = () => `<div class="empty"><b>🛒</b>${texts().cartEmpty}<br><span style="font-size:13px">${inLanguage('Загляните в каталог — мы подскажем, что выбрать', 'Browse the catalog to get started')}</span><br><br><button class="btn" data-action="switch-tab" data-tab="catalog">${texts().toCatalog}</button></div>`;

export function renderCart() {
  const { itemCount, sum } = cartTotals();
  getElement('cartCount').textContent = itemCount || '';
  const lines = cartLines();
  const header = `<div class="carthead"><h1>${texts().cartTitle}</h1>${lines.length ? `<button class="linkbtn" data-action="clear-cart">${inLanguage('Очистить', 'Clear')}</button>` : ''}</div>`;
  const content = lines.length ? freeDeliveryProgressHtml(sum) + lines.map(cartLineHtml).join('') + `
      <div class="total"><span>${texts().total}</span><b>${formatRubles(sum)}</b></div>
      <div class="note" style="text-align:left;margin:-6px 0 12px">${inLanguage('Способ получения и стоимость доставки выберете на следующем шаге.', 'You will choose delivery on the next step.')}</div>
      ${isInsideTelegram ? '' : `<button class="btn" data-action="open-checkout">${texts().checkout(formatRubles(sum))}</button>`}
      <div class="note">${texts().checkoutNote}</div>` : emptyCartHtml();
  getElement('v-cart').innerHTML = header + content;
  // в Telegram вместо плавающей кнопки — системная MainButton
  const showCartBar = !isInsideTelegram && itemCount > 0 && state.activeTab === 'catalog';
  getElement('cartbar').innerHTML = showCartBar
    ? `<button data-action="switch-tab" data-tab="cart"><span>🛒 ${itemCount} · ${formatRubles(sum)}</span><b>${inLanguage('В корзину →', 'Go to cart →')}</b></button>`
    : '';
  updateMainButton();
}

async function clearCart() {
  if (!(await confirmAction(inLanguage('Очистить корзину?', 'Clear the cart?')))) return;
  Object.keys(state.cart).forEach((productId) => setQuantity(Number(productId), 0));
}

const productIdOf = (element) => Number(element.dataset.productId);

export const cartActions = {
  'cart-add': (element) => changeQuantity(productIdOf(element), 1),
  'cart-remove-one': (element) => changeQuantity(productIdOf(element), -1),
  // быстрый выбор веса: повторное нажатие на выбранный вес убирает товар
  'set-quantity': (element) => {
    const productId = productIdOf(element);
    const quantity = Number(element.dataset.quantity);
    setQuantity(productId, state.cart[productId] === quantity ? 0 : quantity);
  },
  'remove-from-cart': (element) => setQuantity(productIdOf(element), 0),
  'clear-cart': () => clearCart(),
  'go-to-cart': () => { closeSheet(); switchTab('cart'); },
};
