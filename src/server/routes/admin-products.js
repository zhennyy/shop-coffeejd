// Админка: товары, фото, склад (Excel/CSV), отчёты, резервная копия
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { database, runInTransaction } = require('../../database');
const inventory = require('../../inventory');
const stockFiles = require('../../inventory/import-export');
const reports = require('../../reports');
const { makeBackup } = require('../../backup');
const { checkLowStock } = require('../../notifications');
const photos = require('../photos');
const { asyncHandler, userError } = require('../async-handler');

const MAX_PRODUCT_NAME = 120;
const MAX_FULL_NAME = 160;
const MAX_DESCRIPTION = 1000;
const MAX_CATEGORY = 60;
const MAX_OPTION_LABEL = 40;
const MAX_IMPORT_FILE_BYTES = 5e6;
const MAX_STOCK_CHANGES = 100;
const MAX_REPORT_DAYS = 366;
const TEA_SAMPLE_FILE = path.join(__dirname, '..', '..', '..', 'примеры', 'чай-10-сортов.xlsx');

const toKopecks = (value) => Math.round(parseFloat(String(value).replace(',', '.').replace(/\s/g, '')) * 100);
const cleanText = (value, maxLength) => String(value || '').trim().slice(0, maxLength);

// Товар из формы админки → поля для базы (с проверками)
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
    if (!(pricePer100 > 0) || !Number.isInteger(pricePer100)) throw userError('Цена за 100 г (или 100 мл) — целое число рублей');
    product.price = pricePer100;
    product.step = Math.max(1, Math.min(1000, parseInt(form.step, 10) || 50));
    product.min_qty = Math.max(1, Math.min(100000, parseInt(form.min_qty, 10) || 100));
    if (product.min_qty % product.step) throw userError('Минимум должен делиться на шаг (например, шаг 50 г, минимум 100 г)');
  } else {
    product.price = toKopecks(form.price);
  }
  // варианты: в базе название хранится целиком «База · вариант · вариант2», чтобы корзина и заказы показывали его как есть
  const optionLabel = cleanText(form.option_label, MAX_OPTION_LABEL);
  const optionLabelEn = cleanText(form.option_label_en, MAX_OPTION_LABEL);
  const option2Label = cleanText(form.option2_label, MAX_OPTION_LABEL);
  const option2LabelEn = cleanText(form.option2_label_en, MAX_OPTION_LABEL);
  if (option2Label && !optionLabel) throw userError('Сначала заполните первый вариант (например, вес), потом второй (например, упаковку)');
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
  if (!product.name) throw userError('Укажите название');
  if (!(product.price > 0)) throw userError('Укажите цену');
  if (product.is_addon && Array.isArray(form.bundle) && form.bundle.length) throw userError('Доп не может быть набором');
  return product;
}

function createAdminProductsRouter({ bot, ownerAuth, catalogAdminAuth, forgetShowcasePhoto }) {
  const router = express.Router();
  const sendAdminError = (response, adminError) => response.status(adminError.statusCode && adminError.statusCode !== 500 ? adminError.statusCode : 400).json({ error: adminError.message });
  const warnAboutLowStock = () => checkLowStock(bot).catch((stockError) => console.error('Склад:', stockError.message));

  router.get('/products', ...catalogAdminAuth, asyncHandler(async (request, response) => {
    const products = await database.product.findMany({ orderBy: [{ is_addon: 'asc' }, { category: 'asc' }, { id: 'asc' }] });
    const bundleIds = await inventory.getBundleIds();
    const productsForAdmin = [];
    for (const { photo_url: photoUrl, ...product } of products) {
      productsForAdmin.push({
        ...product, has_photo: Boolean(photoUrl), bundle: await inventory.getBundleParts(product.id), is_bundle: bundleIds.has(product.id),
        photo: photos.showcasePhotoUrl(product.id, photoUrl),
      });
    }
    response.json({ products: productsForAdmin });
  }));

  router.post('/products', ...catalogAdminAuth, asyncHandler(async (request, response) => {
    try {
      const { stock, ...productFields } = productFromForm(request.body);
      const productId = await runInTransaction(async () => {
        const createdProduct = await database.product.create({ data: { ...productFields, stock: 0 } });
        if (Array.isArray(request.body.bundle) && request.body.bundle.length) await inventory.setBundle(createdProduct.id, request.body.bundle);
        else await inventory.setStock(createdProduct.id, stock, 'добавлен в админке');
        return createdProduct.id;
      });
      response.json({ ok: true, id: productId });
    } catch (productError) { sendAdminError(response, productError); }
  }));

  router.post('/products/:id', ...catalogAdminAuth, asyncHandler(async (request, response) => {
    try {
      const { stock, ...productFields } = productFromForm(request.body);
      const productId = parseInt(request.params.id, 10) || 0;
      await runInTransaction(async () => {
        const updated = await database.product.updateMany({ where: { id: productId }, data: productFields });
        if (!updated.count) throw userError('Товар не найден', 404);
        if (Array.isArray(request.body.bundle)) await inventory.setBundle(productId, request.body.bundle);     // пустой список снимает «набор»
        if (!(await inventory.isBundle(productId))) await inventory.setStock(productId, stock, 'правка в админке'); // остаток набора считается по составу
      });
      warnAboutLowStock();
      response.json({ ok: true });
    } catch (productError) { sendAdminError(response, productError); }
  }));

  // Загрузка склада/каталога из Excel или CSV прямо из админки (или готовый пример чая)
  router.post('/stock-import', ...catalogAdminAuth, express.json({ limit: '8mb' }), asyncHandler(async (request, response) => {
    try {
      const requestBody = request.body || {};
      let importResult;
      if (requestBody.sample === 'tea') {
        importResult = await stockFiles.importXlsx(fs.readFileSync(TEA_SAMPLE_FILE));
      } else {
        const fileName = String(requestBody.name || '');
        const fileBase64 = String(requestBody.data || '');
        if (!fileBase64) return response.status(400).json({ error: 'Файл не получен' });
        const fileBuffer = Buffer.from(fileBase64, 'base64');
        if (fileBuffer.length > MAX_IMPORT_FILE_BYTES) return response.status(400).json({ error: 'Файл слишком большой (до 5 МБ)' });
        if (/\.xlsx$/i.test(fileName)) importResult = await stockFiles.importXlsx(fileBuffer);
        else if (/\.csv$/i.test(fileName)) importResult = await stockFiles.importCsv(fileBuffer.toString('utf8'));
        else return response.status(400).json({ error: 'Нужен файл .xlsx или .csv' });
      }
      return response.json({ ok: true, text: stockFiles.importReportText(importResult) });
    } catch (importError) { return sendAdminError(response, importError); }
  }));

  // Изменение остатков по названию товара: {changes:[{name, delta}]}, delta<0 — списать, >0 — вернуть.
  // Всё или ничего: если хоть одной позиции не хватает, ничего не меняем. Наборы меняются через состав.
  router.post('/stock-delta', ...catalogAdminAuth, asyncHandler(async (request, response) => {
    const requestedChanges = Array.isArray(request.body.changes) ? request.body.changes.slice(0, MAX_STOCK_CHANGES) : [];
    try {
      const changeResult = await runInTransaction(async () => {
        const appliedChanges = [];
        const unknownNames = [];
        for (const requestedChange of requestedChanges) {
          const delta = parseInt(requestedChange.delta, 10);
          const productName = String(requestedChange.name || '');
          if (!delta) continue;
          const product = await database.product.findFirst({ where: { name: productName }, select: { id: true, name: true, stock: true } });
          if (!product) { unknownNames.push(productName); continue; }
          if (await inventory.isBundle(product.id)) throw new Error(`«${product.name}» — набор: его остаток считается по составу`);
          const newStock = product.stock + delta;
          if (newStock < 0) throw new Error(`Недостаточно на складе: ${product.name} (есть ${product.stock}, нужно ${-delta})`);
          await inventory.setStock(product.id, newStock, 'CRM / ручная правка');
          appliedChanges.push({ name: product.name, from: product.stock, to: newStock });
        }
        return { applied: appliedChanges, unknown: unknownNames };
      });
      if (changeResult.applied.length) warnAboutLowStock();
      response.json({ ok: true, ...changeResult });
    } catch (stockError) {
      response.status(409).json({ error: stockError.message });
    }
  }));

  // Отчёт: присылаем владелице в чат (текст + при file=true подробный Excel)
  router.post('/report', ...ownerAuth, asyncHandler(async (request, response) => {
    try {
      const days = Math.min(MAX_REPORT_DAYS, Math.max(1, parseInt(request.body.days, 10) || 30));
      await bot.telegram.sendMessage(process.env.OWNER_CHAT_ID, await reports.reportText(days));
      if (request.body.file) await bot.telegram.sendDocument(process.env.OWNER_CHAT_ID, { source: await reports.reportXlsx(days), filename: `otchet-${days}d.xlsx` });
      response.json({ ok: true });
    } catch (reportError) {
      console.error('Отчёт:', reportError.message);
      response.status(500).json({ error: 'Не получилось отправить отчёт' });
    }
  }));

  router.post('/products/:id/delete', ...catalogAdminAuth, asyncHandler(async (request, response) => {
    const productId = parseInt(request.params.id, 10) || 0;
    await runInTransaction(async () => {
      await database.cartItem.deleteMany({ where: { product_id: productId } });
      await database.bundleItem.deleteMany({ where: { OR: [{ bundle_id: productId }, { product_id: productId }] } });
      await database.product.deleteMany({ where: { id: productId } });
      await inventory.syncBundles();
    });
    response.json({ ok: true });
  }));

  // Фото с телефона: приходит готовый JPEG (витрина сама уменьшает его до 1600 px)
  router.post('/products/:id/photo', ...ownerAuth, express.raw({ type: 'image/*', limit: '10mb' }), asyncHandler(async (request, response) => {
    const productId = parseInt(request.params.id, 10) || 0;
    if (!(await database.product.findUnique({ where: { id: productId }, select: { id: true } }))) return response.status(404).json({ error: 'Товар не найден' });
    if (!Buffer.isBuffer(request.body) || request.body.length < 100) return response.status(400).json({ error: 'Файл не получен' });
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${photos.extensionFor(request.get('content-type') || '')}`;
    fs.writeFileSync(path.join(photos.uploadsDir, fileName), request.body);
    await database.product.update({ where: { id: productId }, data: { photo_url: `${request.protocol}://${request.get('host')}/uploads/${fileName}` } });
    forgetShowcasePhoto(productId);
    return response.json({ ok: true });
  }));

  // Фото по ссылке (https), например из генератора картинок — сервер сам скачает и покажет
  router.post('/products/:id/photo-url', ...catalogAdminAuth, asyncHandler(async (request, response) => {
    const productId = parseInt(request.params.id, 10) || 0;
    const photoUrl = String(request.body.url || '').trim();
    if (!/^https:\/\/[^\s]+$/i.test(photoUrl) || photoUrl.length > 1000) return response.status(400).json({ error: 'Нужна ссылка, начинающаяся с https://' });
    const updated = await database.product.updateMany({ where: { id: productId }, data: { photo_url: photoUrl } });
    if (!updated.count) return response.status(404).json({ error: 'Товар не найден' });
    forgetShowcasePhoto(productId);
    try {
      await photos.localizeAllPhotos();
      const product = await database.product.findUnique({ where: { id: productId }, select: { photo_url: true } });
      return response.json({ ok: true, local: photos.isLocalPhoto(product?.photo_url) });
    } catch {
      return response.json({ ok: true, local: false });
    }
  }));

  // Резервная копия: бот присылает владелице ZIP в чат (каталог, заказы, промокоды, доставка, фото)
  router.post('/backup', ...ownerAuth, asyncHandler(async (request, response) => {
    try {
      const backup = await makeBackup({ uploadsDir: photos.uploadsDir, photosDir: photos.photosDir });
      await bot.telegram.sendDocument(request.chatId, { source: backup.buffer, filename: backup.filename },
        { caption: `📦 Резервная копия магазина\nФото: ${backup.photos} · заказы и каталог — в Excel-файлах внутри.\nХраните у себя: там адреса покупателей.` });
      response.json({ ok: true, size: backup.buffer.length });
    } catch (backupError) {
      console.error('Резервная копия:', backupError.message);
      response.status(500).json({ error: 'Не получилось собрать копию' });
    }
  }));

  return router;
}

module.exports = { createAdminProductsRouter };
