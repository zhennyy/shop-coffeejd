// Редактор товара в шторке: название, цена, остаток, варианты, продажа на вес, допы, наборы, перевод.
import { callApi } from '../../api.js';
import { confirmAction, vibrate } from '../../telegram.js';
import { getElement, escapeHtml } from '../../utils/dom.js';
import { showToast } from '../../utils/toast.js';
import { unitShortName } from '../../utils/format.js';
import { productPhotoHtml } from '../../catalog/product-photo.js';
import { closeSheet, showSheet } from '../../catalog/product-sheet.js';
import { adminState } from '../admin-state.js';
import { reloadProducts } from './product-list.js';
import { renderBundleEditor, bundleEditorHtml } from './bundle-editor.js';

const NEW_PRODUCT = { name: '', price: '', stock: 1, category: '', description: '' };

/** Значение поля формы: цена штучного товара хранится в копейках, весового — в рублях за 100 г */
function formValue(product, fieldName) {
  if (fieldName === 'price' && product.price) return product.unit ? product.price : product.price / 100;
  return product[fieldName] ?? '';
}

function editorFormHtml(product, isNew) {
  const input = (fieldName, label, type = 'text', attributes = '') => `<label>${label}</label><input name="${fieldName}" type="${type}" value="${escapeHtml(formValue(product, fieldName))}" ${attributes}>`;
  const unitOption = (value, label) => `<option value="${value}" ${(product.unit || '') === value ? 'selected' : ''}>${label}</option>`;
  const categories = [...new Set(adminState.products.map((item) => item.category).filter(Boolean))];
  return `<form class="body form" id="pform">
      <h2>${isNew ? 'Новый товар' : 'Редактирование'}</h2>
      ${isNew ? '' : `<details><summary>Фото по ссылке</summary><div style="display:flex;gap:8px;margin-top:8px"><input id="photoUrl" placeholder="https://…" inputmode="url"><button class="btn" style="width:auto;padding:0 16px" data-action="set-photo-url" data-product-id="${product.id}">OK</button></div></details>`}
      ${input('name', 'Название')}
      <div class="two"><div>${input('price', product.unit ? 'Цена за 100 ' + unitShortName(product.unit) + ', ₽ (целая)' : 'Цена, ₽ (для весового — за 100 г)', 'number', 'inputmode="decimal" min="1" step="any"')}</div><div>${input('stock', product.unit ? 'Остаток, ' + unitShortName(product.unit) : 'Остаток, шт. (для весового — граммы)', 'number', 'inputmode="numeric" min="0"' + (product.is_bundle ? ' disabled title="Считается по составу набора"' : ''))}</div></div>
      ${product.is_bundle ? '<div class="note" style="text-align:left">Остаток набора считается сам по составу.</div>' : ''}
      ${input('option_label', 'Параметр 1 (например вес «250 г»; пусто — без вариантов)')}
      ${input('option2_label', 'Параметр 2 (необязательно: «Пакет», «Коробка», цвет)')}
      <details ${product.unit ? 'open' : ''}><summary>Продажа на вес или объём</summary>
        <label>Как продаётся</label><select id="f_unit" style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--text)">
          ${unitOption('', 'Штуками')}${unitOption('g', 'На вес — граммы')}${unitOption('ml', 'На объём — миллилитры')}</select>
        <div class="two"><div>${input('step', 'Шаг (г / мл)', 'number', 'inputmode="numeric" min="1"')}</div><div>${input('min_qty', 'Минимум (г / мл)', 'number', 'inputmode="numeric" min="1"')}</div></div>
        <div class="note" style="text-align:left">Цена задаётся за 100 г (или 100 мл) целыми рублями, остаток считается в граммах или миллилитрах. Пример: шаг 50, минимум 100.</div>
      </details>
      <details ${product.is_addon ? 'open' : ''}><summary>Доп к другим товарам</summary>
        <label class="line2"><span>Это доп (упаковка, помол)</span><span class="sw"><input type="checkbox" id="f_addon" ${product.is_addon ? 'checked' : ''}><i></i></span></label>
        <label>К каким товарам предлагать (названия через | ; * — ко всем)</label><input name="addon_for" value="${escapeHtml(product.addon_for || '*')}">
        <div class="note" style="text-align:left">Доп не показывается в каталоге: покупатель видит его в карточке подходящего товара.</div>
      </details>
      ${bundleEditorHtml(product)}
      ${input('category', 'Категория', 'text', 'list="cats"')}
      <datalist id="cats">${categories.map((category) => `<option value="${escapeHtml(category)}">`).join('')}</datalist>
      <label>Описание</label><textarea name="description">${escapeHtml(product.description || '')}</textarea>
      <details><summary>English (необязательно)</summary>
        ${input('name_en', 'Name')}${input('option_label_en', 'Option (e.g. 250 g)')}${input('category_en', 'Category')}<label>Description</label><textarea name="description_en">${escapeHtml(product.description_en || '')}</textarea>
      </details>
      <div class="actions">${isNew ? '' : `<button class="btn danger" data-action="delete-product" data-product-id="${product.id}" style="flex:1">Удалить</button>`}<button class="btn" data-action="save-product" style="flex:2">${isNew ? 'Создать' : 'Сохранить'}</button></div>
      ${isNew ? '<div class="note">Фото можно добавить сразу после создания</div>' : ''}
    </form>`;
}

export function openProductEditor(productId) {
  adminState.editingProductId = productId;
  const isNew = productId === 'new';
  let product = isNew ? NEW_PRODUCT : adminState.products.find((item) => item.id == productId);
  if (!product) return;
  // у варианта редактируем общее название группы, вариант — в полях «Параметр»
  if (product.group_key) product = { ...product, name: product.group_key, name_en: (product.name_en || '').split(' · ')[0] };
  adminState.bundleDraft = (product.bundle || []).map((item) => ({ product_id: item.product_id, qty: item.qty }));
  const photoHtml = isNew ? '' : `<div class="big photoEdit">${productPhotoHtml(product)}<button class="up" data-action="upload-photo" data-product-id="${product.id}">📷 ${product.has_photo ? 'Заменить фото' : 'Добавить фото'}</button></div>`;
  getElement('sheet').innerHTML = `<button class="x" data-action="close-sheet">✕</button>
    ${photoHtml}
    ${editorFormHtml(product, isNew)}`;
  // форма отправляется только кнопками (Enter в поле ничего не отправляет на сервер сам по себе)
  getElement('pform').addEventListener('submit', (event) => event.preventDefault());
  showSheet();
  renderBundleEditor();
}

async function saveProduct() {
  const productData = Object.fromEntries(new FormData(getElement('pform')).entries());
  productData.unit = getElement('f_unit')?.value || '';
  productData.is_addon = Boolean(getElement('f_addon')?.checked);
  productData.bundle = adminState.bundleDraft.filter((item) => item.product_id);
  try {
    if (adminState.editingProductId === 'new') {
      const created = await callApi('/admin/products', productData, 1);
      showToast('Товар создан ✓');
      await reloadProducts();
      openProductEditor(created.id);
    } else {
      await callApi('/admin/products/' + adminState.editingProductId, productData, 1);
      showToast('Сохранено ✓');
      closeSheet();
      await reloadProducts();
    }
    vibrate('medium');
  } catch (error) { showToast(error.message); }
}

async function deleteProduct(productId) {
  if (!(await confirmAction('Удалить товар? Его уберут из каталога и корзин покупателей.'))) return;
  try {
    await callApi(`/admin/products/${productId}/delete`, {}, 1);
    showToast('Удалено');
    closeSheet();
    await reloadProducts();
  } catch (error) { showToast(error.message); }
}

function setPhotoFromUrl(productId) {
  const url = getElement('photoUrl').value.trim();
  callApi(`/admin/products/${productId}/photo-url`, { url }, 1)
    .then(async () => { showToast('Фото обновлено ✓'); await reloadProducts(); openProductEditor(productId); })
    .catch((error) => showToast(error.message));
}

export const productEditorActions = {
  'edit-product': (element) => openProductEditor(element.dataset.productId === 'new' ? 'new' : Number(element.dataset.productId)),
  'save-product': () => saveProduct(),
  'delete-product': (element) => deleteProduct(Number(element.dataset.productId)),
  'set-photo-url': (element) => setPhotoFromUrl(Number(element.dataset.productId)),
};
