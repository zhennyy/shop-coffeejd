// Шторка товара снизу экрана: фото, варианты, описание, наличие, цена и кнопка «В корзину».
// Та же шторка (#sheet) используется админкой для редактора товара и ввода трек-номера.
import { state } from '../state.js';
import { texts, inLanguage } from '../i18n.js';
import { telegram } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatAmount, formatRubles } from '../utils/format.js';
import { productPhotoHtml } from './product-photo.js';
import { quantityStepperHtml } from './product-card.js';
import { findProduct, isSoldByAmount, minimumQuantity, productCategory, productBaseName, productDescription, priceText } from './product-helpers.js';
import { variantOptionsHtml, addonsHtml, bundleContentsHtml, weightPickerHtml } from './product-sheet-sections.js';
import { cartTotals } from '../cart/cart-model.js';

function stockLineHtml(product) {
  if (product.stock <= 0) return `<div class="stock" style="color:var(--bad)">${texts().outOfStock}</div>`;
  const inStock = isSoldByAmount(product) ? inLanguage('В наличии: ', 'In stock: ') + formatAmount(product.stock, product.unit) : texts().inStock(product.stock);
  return `<div class="stock" style="color:var(--ok)">✓ ${inStock}</div>`;
}

function buyButtonHtml(product, quantity) {
  if (product.stock < minimumQuantity(product)) return '';
  if (quantity) return quantityStepperHtml(product, quantity);
  return `<button class="add" data-action="cart-add" data-product-id="${product.id}">${texts().addToCart}</button>`;
}

export function renderProductSheet() {
  const product = findProduct(state.openProductId);
  if (!product) return;
  const quantity = state.cart[product.id] || 0;
  const goToCart = quantity
    ? `<button class="btn ghost" data-action="go-to-cart" style="margin-top:10px">${inLanguage('Перейти в корзину', 'Go to cart')} · ${formatRubles(cartTotals().sum)}</button>`
    : '';
  getElement('sheet').innerHTML = `<button class="x" data-action="close-sheet">✕</button>
    <div class="big">${productPhotoHtml(product)}</div>
    <div class="body">
      ${productCategory(product) ? `<div class="cat">${escapeHtml(productCategory(product))}</div>` : ''}
      <h2>${escapeHtml(productBaseName(product))}</h2>
      ${variantOptionsHtml(product)}
      ${productDescription(product) ? `<p>${escapeHtml(productDescription(product))}</p>` : ''}
      ${bundleContentsHtml(product)}
      ${stockLineHtml(product)}
      ${weightPickerHtml(product)}
      <div class="act"><div class="price">${priceText(product)}</div>${buyButtonHtml(product, quantity)}</div>
      ${goToCart}
      ${addonsHtml(product)}
    </div>`;
}

/** Показать шторку (её содержимое уже отрисовано) */
export function showSheet() {
  document.body.classList.add('open');
  telegram?.BackButton?.show();
}

export function openProductSheet(productId) {
  state.openProductId = productId;
  renderProductSheet();
  showSheet();
}

export function closeSheet() {
  state.openProductId = null;
  document.body.classList.remove('open');
  if (state.activeTab === 'catalog') telegram?.BackButton?.hide();
}

export const isSheetOpen = () => document.body.classList.contains('open');

export const productSheetActions = {
  'open-product': (element) => openProductSheet(Number(element.dataset.productId)),
  'select-variant': (element) => { state.openProductId = Number(element.dataset.productId); renderProductSheet(); },
  'close-sheet': () => closeSheet(),
};
