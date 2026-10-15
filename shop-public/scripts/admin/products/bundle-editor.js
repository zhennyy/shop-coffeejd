// Состав набора в редакторе товара: строки «товар × количество», добавить/убрать строку.
import { getElement, escapeHtml } from '../../utils/dom.js';
import { adminState } from '../admin-state.js';

export const bundleEditorHtml = (
  product,
) => `<details ${(product.bundle || []).length ? 'open' : ''}><summary>Набор из других товаров</summary>
        <div id="bundleBox"></div>
        <button class="btn ghost small" data-action="add-bundle-item" type="button" style="margin-top:6px">＋ Добавить товар в набор</button>
        <div class="note" style="text-align:left">При оплате набора списываются товары из состава; остаток набора считается по ним. Чтобы убрать набор — удалите все строки.</div>
      </details>`;

/** В набор можно положить обычные товары (не наборы, не допы и не сам редактируемый товар) */
const bundleCandidates = () =>
  adminState.products.filter(
    (product) => !product.is_bundle && !product.is_addon && product.id !== Number(adminState.editingProductId),
  );

export function renderBundleEditor() {
  const container = getElement('bundleBox');
  if (!container) return;
  const candidates = bundleCandidates();
  container.innerHTML = adminState.bundleDraft
    .map(
      (
        item,
        index,
      ) => `<div class="crow"><select data-bundle-row="${index}" style="flex:1">${candidates.map((candidate) => `<option value="${candidate.id}" ${candidate.id === Number(item.product_id) ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`).join('')}</select>
      <input type="number" min="1" value="${item.qty}" data-bundle-row="${index}" style="width:70px" inputmode="numeric"><button class="mini" type="button" data-action="remove-bundle-item" data-bundle-row="${index}" aria-label="Убрать">🗑</button></div>`,
    )
    .join('');
  container.querySelectorAll('select[data-bundle-row]').forEach((select) =>
    select.addEventListener('change', () => {
      adminState.bundleDraft[Number(select.dataset.bundleRow)].product_id = Number(select.value);
    }),
  );
  container.querySelectorAll('input[data-bundle-row]').forEach((input) =>
    input.addEventListener('input', () => {
      adminState.bundleDraft[Number(input.dataset.bundleRow)].qty = Number(input.value) || 1;
    }),
  );
}

export const bundleEditorActions = {
  'add-bundle-item': () => {
    const firstCandidate = bundleCandidates()[0];
    if (!firstCandidate) return;
    adminState.bundleDraft.push({ product_id: firstCandidate.id, qty: 1 });
    renderBundleEditor();
  },
  'remove-bundle-item': (element) => {
    adminState.bundleDraft.splice(Number(element.dataset.bundleRow), 1);
    renderBundleEditor();
  },
};
