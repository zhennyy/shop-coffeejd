// Справочные функции о товаре: названия на нужном языке, варианты, продажа на вес, наборы, допы.
import { state } from '../state.js';
import { isEnglish } from '../i18n.js';
import { formatAmount, formatRubles, unitShortName } from '../utils/format.js';

export const findProduct = (productId) => state.products.find((product) => product.id == productId);

export const productName = (product) => (isEnglish() && product.name_en) || product.name;
export const productDescription = (product) => (isEnglish() && product.description_en) || product.description || '';
export const productCategory = (product) => (isEnglish() && product.category_en) || product.category || '';
export const optionLabel = (product) => (isEnglish() && product.option_label_en) || product.option_label || '';
export const secondOptionLabel = (product) => (isEnglish() && product.option2_label_en) || product.option2_label || '';

/** Название без варианта: «Эфиопия Иргачефф» вместо «Эфиопия Иргачефф · 250 г» */
export function productBaseName(product) {
  if (!product.group_key) return productName(product);
  return isEnglish() && product.name_en ? product.name_en.split(' · ')[0] : product.group_key;
}

/** Все варианты одного товара (фасовки, упаковки); у товара без вариантов — он сам */
export const variantsOf = (product) => (product.group_key
  ? state.products.filter((candidate) => candidate.group_key === product.group_key && !candidate.is_addon)
  : [product]);

// ---- продажа на вес / объём: количество в граммах (мл), цена — за 1 г ----
export const isSoldByAmount = (product) => Boolean(product && product.unit);
export const quantityStep = (product) => (isSoldByAmount(product) ? Math.max(1, product.step || 1) : 1);
export const minimumQuantity = (product) => (isSoldByAmount(product) ? Math.max(1, product.min_qty || 1) : 1);
export const quantityText = (product, quantity) => (isSoldByAmount(product) ? formatAmount(quantity, product.unit) : String(quantity));
export const priceText = (product) => (isSoldByAmount(product)
  ? `${formatRubles(product.price * 100)} / 100 ${unitShortName(product.unit)}`
  : formatRubles(product.price));
/** Цена для сравнения при сортировке: у весовых — за 100 г */
export const comparablePrice = (product) => product.price * (isSoldByAmount(product) ? 100 : 1);

// ---- наборы ----
export const isBundle = (product) => Boolean(product.bundle && product.bundle.length);
export const bundleSeparatePrice = (product) => (product.bundle || []).reduce((sum, item) => sum + (item.price || 0) * item.qty, 0);
export const bundleSaving = (product) => Math.max(0, bundleSeparatePrice(product) - product.price);
export const bundleItemName = (item) => (isEnglish() && item.name_en) || item.name;

/** Допы (помол, упаковка), которые предлагаем к товару: addon_for — «*» или названия через | */
export const addonsFor = (product) => state.products.filter((addon) => addon.is_addon && addon.stock > 0 && addon.id !== product.id
  && String(addon.addon_for || '*').split('|').map((target) => target.trim())
    .some((target) => target === '*' || target === product.group_key || target === product.name));
