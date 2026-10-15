// Вкладка «Каталог»: полоса условий доставки, категории, сортировка, фильтр «в наличии», поиск и сетка карточек.
import { state } from '../state.js';
import { texts, inLanguage } from '../i18n.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatRubles } from '../utils/format.js';
import { productCardHtml } from './product-card.js';
import { productCategory, variantsOf, comparablePrice } from './product-helpers.js';

export const LOADING_GRID_HTML =
  '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';

export function renderSortTools() {
  const option = (value, russianText, englishText) =>
    `<option value="${value}" ${state.sortOrder === value ? 'selected' : ''}>${inLanguage(russianText, englishText)}</option>`;
  getElement('tools').innerHTML = `<select id="sortSel" aria-label="${inLanguage('Сортировка', 'Sort')}">
      ${option('', 'Сначала популярные', 'Popular first')}
      ${option('asc', 'Сначала дешевле', 'Cheapest first')}
      ${option('desc', 'Сначала дороже', 'Most expensive first')}</select>
    <button class="chip ${state.onlyInStock ? 'on' : ''}" data-action="toggle-in-stock">${inLanguage('Только в наличии', 'In stock only')}</button>`;
}

export function renderInfoStrip() {
  const shopInfo = state.shopInfo;
  const notes = [];
  if (shopInfo && shopInfo.freeFrom > 0)
    notes.push(
      inLanguage(
        `🚚 Бесплатная доставка от ${formatRubles(shopInfo.freeFrom)}`,
        `🚚 Free delivery from ${formatRubles(shopInfo.freeFrom)}`,
      ),
    );
  if (shopInfo && shopInfo.pickup) notes.push(inLanguage('🏠 Есть самовывоз', '🏠 Pickup available'));
  notes.push(inLanguage('💳 Оплата картой или СБП', '💳 Card or SBP payment'));
  getElement('infostrip').innerHTML =
    `<div class="info-strip">${notes.map((note) => `<span>${note}</span>`).join('')}</div>`;
}

export function renderCategoryChips() {
  // категория в базе (по-русски) → подпись на текущем языке
  const categories = [
    ...new Map(
      state.products
        .filter((product) => product.category && !product.is_addon)
        .map((product) => [product.category, productCategory(product)]),
    ).entries(),
  ];
  const allChip = `<button class="chip ${state.selectedCategory === null ? 'on' : ''}" data-action="select-category" data-category="">${texts().all}</button>`;
  getElement('chips').innerHTML = [allChip]
    .concat(
      categories.map(
        ([category, label]) =>
          `<button class="chip ${state.selectedCategory === category ? 'on' : ''}" data-action="select-category" data-category="${escapeHtml(category)}">${escapeHtml(label)}</button>`,
      ),
    )
    .join('');
}

function matchesFilters(product, searchText) {
  if (product.is_addon) return false;
  if (state.onlyInStock && product.stock <= 0) return false;
  if (state.selectedCategory && product.category !== state.selectedCategory) return false;
  if (!searchText) return true;
  return [product.name, product.name_en, product.description, product.category, product.category_en]
    .join(' ')
    .toLowerCase()
    .includes(searchText);
}

export function renderProductGrid() {
  const searchText = state.searchQuery.trim().toLowerCase();
  const visible = state.products.filter((product) => matchesFilters(product, searchText));
  // у товара с вариантами сортируем по самому дешёвому варианту
  const sortPrice = (product) =>
    product.group_key ? Math.min(...variantsOf(product).map(comparablePrice)) : comparablePrice(product);
  if (state.sortOrder === 'asc') visible.sort((first, second) => sortPrice(first) - sortPrice(second));
  else if (state.sortOrder === 'desc') visible.sort((first, second) => sortPrice(second) - sortPrice(first));
  // варианты одного товара — одна карточка (первый попавшийся вариант)
  const shownGroups = new Set();
  const cards = visible.filter((product) => {
    if (!product.group_key) return true;
    if (shownGroups.has(product.group_key)) return false;
    shownGroups.add(product.group_key);
    return true;
  });
  getElement('grid').innerHTML = cards.length
    ? cards.map(productCardHtml).join('')
    : `<div class="empty"><b>🔍</b>${texts().nothingFound}</div>`;
}

/** Каталог целиком — после загрузки или смены языка */
export function renderCatalog() {
  renderCategoryChips();
  renderSortTools();
  renderInfoStrip();
  renderProductGrid();
}

export function listenToCatalogInputs() {
  getElement('q').addEventListener('input', (event) => {
    state.searchQuery = event.target.value;
    renderProductGrid();
  });
  getElement('tools').addEventListener('change', (event) => {
    if (event.target.id !== 'sortSel') return;
    state.sortOrder = event.target.value;
    renderProductGrid();
  });
}

export const catalogActions = {
  'toggle-in-stock': () => {
    state.onlyInStock = !state.onlyInStock;
    renderSortTools();
    renderProductGrid();
  },
  'select-category': (element) => {
    state.selectedCategory = element.dataset.category || null;
    renderCategoryChips();
    renderProductGrid();
  },
};
