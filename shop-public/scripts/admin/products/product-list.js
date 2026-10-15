// Админка → «Товары»: кнопки (новый товар, копия, отчёт, загрузка Excel) и список товаров с остатками.
import { state } from '../../state.js';
import { callApi } from '../../api.js';
import { getElement, escapeHtml } from '../../utils/dom.js';
import { formatAmount, formatRubles, unitShortName } from '../../utils/format.js';
import { productPhotoHtml } from '../../catalog/product-photo.js';
import { renderCategoryChips, renderProductGrid } from '../../catalog/catalog-view.js';
import { renderCart } from '../../cart/cart-view.js';
import { adminState } from '../admin-state.js';
import { listenToImportFile } from './catalog-files.js';

const LOW_STOCK_PIECES = 3;
const LOW_STOCK_AMOUNT = 1000;

const TOOLBAR_HTML = `<div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn" data-action="edit-product" data-product-id="new" style="flex:2">＋ Новый товар</button><button class="btn ghost" data-action="request-backup" style="flex:1">📦 Копия</button><button class="btn ghost" data-action="send-report" style="flex:1">📊 Отчёт</button></div><div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn ghost" data-action="import-file" style="flex:1">📥 Загрузить Excel / CSV</button><button class="btn ghost" data-action="import-sample" style="flex:1">🍵 Пример: 10 сортов чая</button></div><input type="file" id="impInput" accept=".xlsx,.csv" style="display:none">`;

function priceSummary(product) {
  if (!product.unit) return formatRubles(product.price);
  return (
    `<b>${product.unit === 'ml' ? 'на объём' : 'на вес'}</b> · ` +
    formatRubles(product.price * 100) +
    '/100 ' +
    unitShortName(product.unit)
  );
}

function stockSummary(product) {
  if (product.stock <= 0) return '<span class="warn">нет в наличии</span>';
  const stockText = product.unit ? formatAmount(product.stock, product.unit) : product.stock;
  const isLow = product.unit ? product.stock <= LOW_STOCK_AMOUNT : product.stock <= LOW_STOCK_PIECES;
  if (isLow) return `<span class="warn">осталось ${stockText}</span>`;
  return product.unit ? stockText : `${product.stock} шт.`;
}

const productRowHtml = (product) => `
    <div class="aline" data-action="edit-product" data-product-id="${product.id}">
      <div class="thumb">${productPhotoHtml(product)}</div>
      <div class="mid"><div class="t">${escapeHtml(product.name)}</div>
        <div class="s">${product.is_addon ? '<b>доп</b> · ' : ''}${product.is_bundle ? '<b>набор</b> · ' : ''}${priceSummary(product)} · ${stockSummary(product)}${product.category ? ' · ' + escapeHtml(product.category) : ''}${product.has_photo ? '' : ' · <span class="warn">без фото</span>'}</div></div>
      <span style="color:var(--muted)">›</span>
    </div>`;

export function renderAdminProducts() {
  const withoutPhoto = adminState.products.filter((product) => !product.has_photo).length;
  getElement('admBody').innerHTML =
    TOOLBAR_HTML +
    (withoutPhoto
      ? `<div class="note" style="margin:0 0 10px">Без фото: ${withoutPhoto} — нажмите на товар и «📷 Фото»</div>`
      : '') +
    adminState.products.map(productRowHtml).join('');
  listenToImportFile(getElement('impInput'));
}

/** После изменений товаров: обновить список в админке и каталог покупателя (вместе с корзиной) */
export async function reloadProducts() {
  try {
    adminState.products = (await callApi('/admin/products')).products;
  } catch {
    /* покажем старый список */
  }
  try {
    const catalog = await callApi('/catalog');
    state.products = catalog.products;
    state.cart = catalog.cart || {};
    renderCategoryChips();
    renderProductGrid();
    renderCart();
  } catch {
    /* каталог обновится при следующем открытии */
  }
  if (state.activeTab === 'admin' && adminState.section === 'products') renderAdminProducts();
}
