// Части шторки товара: выбор варианта, «Сколько нужно?» для весовых, состав набора, допы к заказу.
import { state } from '../state.js';
import { inLanguage } from '../i18n.js';
import { escapeHtml } from '../utils/dom.js';
import { formatAmount, formatRubles } from '../utils/format.js';
import { quantityControlHtml } from './product-card.js';
import {
  variantsOf, optionLabel, secondOptionLabel, isSoldByAmount, minimumQuantity, quantityStep,
  productName, priceText, addonsFor, isBundle, bundleItemName, bundleSaving, bundleSeparatePrice,
} from './product-helpers.js';

const WEIGHT_PRESETS = [250, 500, 750, 1000, 2000];
const MAX_WEIGHT_PRESETS = 5;

const variantChipHtml = (label, isSelected, targetProduct, isOutOfStock) => (
  `<button class="chip ${isSelected ? 'on' : ''} ${isOutOfStock ? 'off' : ''}" data-action="select-variant" data-product-id="${targetProduct.id}">${escapeHtml(label)}</button>`
);

/**
 * Один или два ряда выбора: первый параметр (вес) и второй (упаковка/цвет).
 * При смене одного параметра подбираем вариант с тем же значением второго, если такой есть.
 */
export function variantOptionsHtml(product) {
  const variants = variantsOf(product);
  if (variants.length <= 1) return '';
  const hasSecondOption = variants.some((variant) => variant.option2_label);
  if (!hasSecondOption) {
    return `<div class="opts">${variants.map((variant) => variantChipHtml(optionLabel(variant), variant.id === product.id, variant, variant.stock <= 0)).join('')}</div>`;
  }
  const findVariant = (firstOption, secondOption) => variants.find((variant) => variant.option_label === firstOption && (variant.option2_label || '') === (secondOption || '')) || null;
  const uniqueFirst = [...new Map(variants.map((variant) => [variant.option_label, variant])).values()];
  const uniqueSecond = [...new Map(variants.filter((variant) => variant.option2_label).map((variant) => [variant.option2_label, variant])).values()];
  const firstRow = uniqueFirst.map((variant) => {
    const target = findVariant(variant.option_label, product.option2_label) || variants.find((candidate) => candidate.option_label === variant.option_label);
    return variantChipHtml(optionLabel(variant), variant.option_label === product.option_label, target, target.stock <= 0);
  }).join('');
  const secondRow = uniqueSecond.map((variant) => {
    const target = findVariant(product.option_label, variant.option2_label) || variants.find((candidate) => candidate.option2_label === variant.option2_label);
    return variantChipHtml(secondOptionLabel(variant), variant.option2_label === product.option2_label, target, target.stock <= 0);
  }).join('');
  return `<div class="opts">${firstRow}</div>
       <div class="opts">${secondRow}</div>`;
}

export function addonsHtml(product) {
  const addons = addonsFor(product);
  if (!addons.length) return '';
  return `<div class="addons"><h3>${inLanguage('Добавить к заказу', 'Add to your order')}</h3>${addons.map((addon) => `
      <div class="arow"><div><div class="an">${escapeHtml(productName(addon))}</div><div class="ap">+ ${priceText(addon)}</div></div><div data-quantity-control-for="${addon.id}">${quantityControlHtml(addon)}</div></div>`).join('')}</div>`;
}

export function bundleContentsHtml(product) {
  if (!isBundle(product)) return '';
  const saving = bundleSaving(product);
  return `<div class="bset"><div class="btitle">${inLanguage('Что в наборе', 'What is inside')}</div>
      ${product.bundle.map((item) => `<div class="bline"><span class="bn">${escapeHtml(bundleItemName(item))}</span><span class="bq">${item.unit ? formatAmount(item.qty, item.unit) : '× ' + item.qty}</span><span class="bp">${formatRubles((item.price || 0) * item.qty)}</span></div>`).join('')}
      ${saving ? `<div class="bsave"><span>${inLanguage('Отдельно', 'Separately')}: <s>${formatRubles(bundleSeparatePrice(product))}</s></span><b>${inLanguage('Выгода', 'You save')} ${formatRubles(saving)}</b></div>` : ''}</div>`;
}

/** Быстрый выбор веса (250 г, 500 г …) и подсказка про шаг */
export function weightPickerHtml(product) {
  if (!isSoldByAmount(product)) return '';
  const quantity = state.cart[product.id] || 0;
  const minimum = minimumQuantity(product);
  const step = quantityStep(product);
  const presets = [...new Set([minimum, ...WEIGHT_PRESETS].filter((amount) => amount >= minimum && amount % step === 0 && amount <= product.stock))]
    .sort((first, second) => first - second).slice(0, MAX_WEIGHT_PRESETS);
  const presetButtons = presets.map((amount) => `<button class="chip ${quantity === amount ? 'on' : ''}" data-action="set-quantity" data-product-id="${product.id}" data-quantity="${amount}">${formatAmount(amount, product.unit)}</button>`).join('');
  const hint = inLanguage(`Или кнопками − / + : от ${formatAmount(minimum, product.unit)}, шаг ${formatAmount(step, product.unit)}`, `Or use − / + : from ${formatAmount(minimum, product.unit)}, step ${formatAmount(step, product.unit)}`);
  const sum = quantity ? ` · ${inLanguage('Сумма', 'Total')}: <b>${formatRubles(product.price * quantity)}</b>` : '';
  return `<div class="wbox"><div class="wlbl">${inLanguage('Сколько нужно?', 'How much do you need?')}</div>
      <div class="opts">${presetButtons}</div>
      <div class="note" style="text-align:left;margin:2px 0 0">${hint}${sum}</div></div>`;
}
