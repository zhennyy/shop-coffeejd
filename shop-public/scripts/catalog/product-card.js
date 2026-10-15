// Карточка товара в сетке каталога (и в результатах AI-подбора) и кнопки количества «− 2 +».
import { state } from '../state.js';
import { texts, inLanguage } from '../i18n.js';
import { escapeHtml } from '../utils/dom.js';
import { formatAmount, formatRubles } from '../utils/format.js';
import { productPhotoHtml } from './product-photo.js';
import {
  isSoldByAmount,
  minimumQuantity,
  quantityText,
  priceText,
  comparablePrice,
  productCategory,
  productBaseName,
  variantsOf,
  optionLabel,
  secondOptionLabel,
  isBundle,
  bundleSaving,
  bundleSeparatePrice,
  bundleItemName,
} from './product-helpers.js';

const LOW_STOCK_PIECES = 3;
const LOW_STOCK_AMOUNT = 1000; // граммов или миллилитров

function stockTagHtml(product) {
  if (product.stock <= 0) return `<span class="tag out">${texts().outOfStock}</span>`;
  const isLow = isSoldByAmount(product) ? product.stock <= LOW_STOCK_AMOUNT : product.stock <= LOW_STOCK_PIECES;
  if (isLow)
    return `<span class="tag low">${texts().lowStock(isSoldByAmount(product) ? formatAmount(product.stock, product.unit) : product.stock)}</span>`;
  return '';
}

/** Кнопка «+» или счётчик «− количество +» для товара */
export function quantityControlHtml(product) {
  const quantity = state.cart[product.id] || 0;
  if (product.stock < minimumQuantity(product)) return '<button class="add" disabled>+</button>';
  if (!quantity)
    return `<button class="add" data-action="cart-add" data-product-id="${product.id}" aria-label="${texts().addToCart}">+</button>`;
  return quantityStepperHtml(product, quantity);
}

/** Счётчик «− количество +»; withLabels — подписи для экранного диктора (в корзине) */
export function quantityStepperHtml(product, quantity, { withLabels = false } = {}) {
  const label = (sign) => (withLabels ? ` aria-label="${sign}"` : '');
  return (
    `<div class="step"><button data-action="cart-remove-one" data-product-id="${product.id}"${label('−')}>−</button>` +
    `<span>${quantityText(product, quantity)}</span>` +
    `<button data-action="cart-add" data-product-id="${product.id}"${label('+')}>+</button></div>`
  );
}

// у товара с вариантами: «таблетки» вариантов и цена «от» самого дешёвого
function variantsSummaryHtml(product) {
  const variants = variantsOf(product);
  const cheapest = variants.reduce((best, variant) =>
    comparablePrice(variant) < comparablePrice(best) ? variant : best,
  );
  const firstOptions = [...new Set(variants.map(optionLabel).filter(Boolean))];
  const secondOptions = [...new Set(variants.map(secondOptionLabel).filter(Boolean))];
  const pills =
    firstOptions
      .slice(0, 3)
      .map((option) => `<i>${escapeHtml(option)}</i>`)
      .join('') +
    (firstOptions.length > 3 ? `<i>+${firstOptions.length - 3}</i>` : '') +
    secondOptions
      .slice(0, 2)
      .map((option) => `<i class="alt">${escapeHtml(option)}</i>`)
      .join('');
  return `<div class="vpills">${pills}</div>
    <div class="row"><div class="price"><small>${texts().priceFrom}</small> ${priceText(cheapest)}</div><span class="pick">${inLanguage('Выбрать', 'Choose')}</span></div>`;
}

function badgesHtml(product) {
  let badges = '';
  if (isBundle(product)) {
    const saving = bundleSaving(product);
    badges += `<span class="kind gift">${saving ? inLanguage('Выгода ', 'Save ') + formatRubles(saving) : inLanguage('Набор', 'Set')}</span>`;
  }
  if (isSoldByAmount(product)) {
    badges += `<span class="kind">${product.unit === 'ml' ? inLanguage('на розлив', 'by volume') : inLanguage('на развес', 'by weight')}</span>`;
  }
  return badges;
}

function singleProductHtml(product) {
  const bundleContents = isBundle(product)
    ? `<div class="inside">${inLanguage('Внутри', 'Inside')}: ${product.bundle
        .slice(0, 3)
        .map((item) => escapeHtml(bundleItemName(item).split(' · ')[0]))
        .join(', ')}${product.bundle.length > 3 ? ' …' : ''}</div>`
    : '';
  const oldPrice = bundleSaving(product) ? `<div class="was">${formatRubles(bundleSeparatePrice(product))}</div>` : '';
  return `${bundleContents}
        <div class="row"><div class="price">${priceText(product)}${oldPrice}</div><div data-quantity-control-for="${product.id}">${quantityControlHtml(product)}</div></div>`;
}

export const productCardHtml = (product) => `
  <article class="card ${product.stock <= 0 ? 'out' : ''}" data-action="open-product" data-product-id="${product.id}">
    <div class="ph">${productPhotoHtml(product)}${stockTagHtml(product)}${badgesHtml(product)}</div>
    <div class="info">
      ${productCategory(product) ? `<div class="cat">${escapeHtml(productCategory(product))}</div>` : ''}
      <div class="name">${escapeHtml(productBaseName(product))}</div>
      ${product.group_key && variantsOf(product).length > 1 ? variantsSummaryHtml(product) : singleProductHtml(product)}
    </div>
  </article>`;
