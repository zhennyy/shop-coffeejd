// Проверка запросов админки товаров: форма товара, загрузка склада, правка остатков, отчёт, фото
const { ValidationError, createValidator, parsePositiveId, toKopecks, cleanText } = require('../../validation');

const MAX_PRODUCT_NAME = 120;
const MAX_FULL_NAME = 160;
const MAX_DESCRIPTION = 1000;
const MAX_CATEGORY = 60;
const MAX_OPTION_LABEL = 40;
const MAX_IMPORT_FILE_BYTES = 5e6;
const MAX_STOCK_CHANGES = 100;
const MAX_REPORT_DAYS = 366;
const MIN_PHOTO_BYTES = 100;
const MAX_PHOTO_URL_LENGTH = 1000;

// Форма товара из админки → поля для базы
function productFromForm(form) {
  const unit = form.unit === 'ml' ? 'ml' : (form.unit === 'g' || form.sold_by_weight === true) ? 'g' : null;
  const isSoldByWeight = Boolean(unit);
  const product = {
    name: cleanText(form.name, MAX_PRODUCT_NAME),
    description: cleanText(form.description, MAX_DESCRIPTION),
    stock: Math.max(0, parseInt(form.stock, 10) || 0),
    category: cleanText(form.category, MAX_CATEGORY) || null,
    name_en: cleanText(form.name_en, MAX_PRODUCT_NAME) || null,
    description_en: cleanText(form.description_en, MAX_DESCRIPTION) || null,
    category_en: cleanText(form.category_en, MAX_CATEGORY) || null,
    unit, step: 1, min_qty: 1,
    is_addon: form.is_addon ? 1 : 0,
    addon_for: form.is_addon ? (cleanText(form.addon_for || '*', 300) || '*') : null,
  };
  if (isSoldByWeight) {
    // цена вводится за 100 г в целых рублях: тогда цена за грамм — целое число копеек и копейки в заказе не теряются
    const pricePer100 = parseFloat(String(form.price).replace(',', '.'));
    if (!(pricePer100 > 0) || !Number.isInteger(pricePer100)) throw new ValidationError('Цена за 100 г (или 100 мл) — целое число рублей');
    product.price = pricePer100;
    product.step = Math.max(1, Math.min(1000, parseInt(form.step, 10) || 50));
    product.min_qty = Math.max(1, Math.min(100000, parseInt(form.min_qty, 10) || 100));
    if (product.min_qty % product.step) throw new ValidationError('Минимум должен делиться на шаг (например, шаг 50 г, минимум 100 г)');
  } else {
    product.price = toKopecks(form.price);
  }
  // варианты: в базе название хранится целиком «База · вариант · вариант2», чтобы корзина и заказы показывали его как есть
  const optionLabel = cleanText(form.option_label, MAX_OPTION_LABEL);
  const optionLabelEn = cleanText(form.option_label_en, MAX_OPTION_LABEL);
  const option2Label = cleanText(form.option2_label, MAX_OPTION_LABEL);
  const option2LabelEn = cleanText(form.option2_label_en, MAX_OPTION_LABEL);
  if (option2Label && !optionLabel) throw new ValidationError('Сначала заполните первый вариант (например, вес), потом второй (например, упаковку)');
  if (optionLabel) {
    const nameTail = [optionLabel, option2Label].filter(Boolean).join(' · ');
    const nameTailEn = [optionLabelEn || optionLabel, option2Label ? (option2LabelEn || option2Label) : ''].filter(Boolean).join(' · ');
    Object.assign(product, {
      group_key: product.name,
      option_label: optionLabel, option_label_en: optionLabelEn || null,
      option2_label: option2Label || null, option2_label_en: option2LabelEn || null,
      name: `${product.name} · ${nameTail}`.slice(0, MAX_FULL_NAME),
      name_en: product.name_en ? `${product.name_en} · ${nameTailEn}`.slice(0, MAX_FULL_NAME) : null,
    });
  } else {
    Object.assign(product, { group_key: null, option_label: null, option_label_en: null, option2_label: null, option2_label_en: null });
  }
  if (!product.name) throw new ValidationError('Укажите название');
  if (!(product.price > 0)) throw new ValidationError('Укажите цену');
  if (product.is_addon && Array.isArray(form.bundle) && form.bundle.length) throw new ValidationError('Доп не может быть набором');
  return product;
}

// Товар: поля для базы, начальный остаток и состав набора (null — состав не трогаем)
const productFormValidator = createValidator((request) => {
  const { stock, ...productFields } = productFromForm(request.body || {});
  return { productId: parsePositiveId(request.params.id), productFields, stock, bundleParts: Array.isArray(request.body.bundle) ? request.body.bundle : null };
});

// Файл склада: готовый пример чая или свой .xlsx/.csv в base64
const stockImportValidator = createValidator((request) => {
  const requestBody = request.body || {};
  if (requestBody.sample === 'tea') return { sample: 'tea' };
  const fileName = String(requestBody.name || '');
  const fileBase64 = String(requestBody.data || '');
  if (!fileBase64) throw new ValidationError('Файл не получен');
  const fileBuffer = Buffer.from(fileBase64, 'base64');
  if (fileBuffer.length > MAX_IMPORT_FILE_BYTES) throw new ValidationError('Файл слишком большой (до 5 МБ)');
  const fileType = /\.xlsx$/i.test(fileName) ? 'xlsx' : /\.csv$/i.test(fileName) ? 'csv' : null;
  if (!fileType) throw new ValidationError('Нужен файл .xlsx или .csv');
  return { fileType, fileBuffer };
});

// Правка остатков по названию: [{name, delta}], нулевые изменения пропускаем
const stockDeltaValidator = createValidator((request) => {
  const requestedChanges = Array.isArray(request.body.changes) ? request.body.changes.slice(0, MAX_STOCK_CHANGES) : [];
  return {
    stockChanges: requestedChanges
      .map((requestedChange) => ({ productName: String(requestedChange.name || ''), delta: parseInt(requestedChange.delta, 10) }))
      .filter((stockChange) => stockChange.delta),
  };
});

const reportValidator = createValidator((request) => ({
  days: Math.min(MAX_REPORT_DAYS, Math.max(1, parseInt(request.body.days, 10) || 30)),
  withExcelFile: Boolean(request.body.file),
}));

const photoUploadValidator = createValidator((request) => {
  if (!Buffer.isBuffer(request.body) || request.body.length < MIN_PHOTO_BYTES) throw new ValidationError('Файл не получен');
  return { productId: parsePositiveId(request.params.id), photoBuffer: request.body, contentType: request.get('content-type') || '' };
});

const photoUrlValidator = createValidator((request) => {
  const photoUrl = String(request.body.url || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(photoUrl) || photoUrl.length > MAX_PHOTO_URL_LENGTH) throw new ValidationError('Нужна ссылка, начинающаяся с https://');
  return { productId: parsePositiveId(request.params.id), photoUrl };
});

module.exports = { productFormValidator, stockImportValidator, stockDeltaValidator, reportValidator, photoUploadValidator, photoUrlValidator };
