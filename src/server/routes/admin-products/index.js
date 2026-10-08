// Админка: товары, фото, склад (Excel/CSV), отчёты, резервная копия
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { database, runInTransaction } = require('../../../database');
const inventory = require('../../../inventory');
const stockFiles = require('../../../inventory/import-export');
const reports = require('../../../reports');
const { makeBackup } = require('../../../backup');
const { checkLowStock } = require('../../../notifications');
const photos = require('../../photos');
const { asyncHandler, userError } = require('../../async-handler');
const { idParamValidator } = require('../../validation');
const {
  productFormValidator, stockImportValidator, stockDeltaValidator, reportValidator, photoUploadValidator, photoUrlValidator,
} = require('./validation');

const TEA_SAMPLE_FILE = path.join(__dirname, '..', '..', '..', '..', 'примеры', 'чай-10-сортов.xlsx');

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

  router.post('/products', ...catalogAdminAuth, productFormValidator, asyncHandler(async (request, response) => {
    const { productFields, stock, bundleParts } = request.validated;
    try {
      const productId = await runInTransaction(async () => {
        const createdProduct = await database.product.create({ data: { ...productFields, stock: 0 } });
        if (bundleParts && bundleParts.length) await inventory.setBundle(createdProduct.id, bundleParts);
        else await inventory.setStock(createdProduct.id, stock, 'добавлен в админке');
        return createdProduct.id;
      });
      response.json({ ok: true, id: productId });
    } catch (productError) { sendAdminError(response, productError); }
  }));

  router.post('/products/:id', ...catalogAdminAuth, productFormValidator, asyncHandler(async (request, response) => {
    const { productId, productFields, stock, bundleParts } = request.validated;
    try {
      await runInTransaction(async () => {
        const updated = await database.product.updateMany({ where: { id: productId }, data: productFields });
        if (!updated.count) throw userError('Товар не найден', 404);
        if (bundleParts) await inventory.setBundle(productId, bundleParts);                                    // пустой список снимает «набор»
        if (!(await inventory.isBundle(productId))) await inventory.setStock(productId, stock, 'правка в админке'); // остаток набора считается по составу
      });
      warnAboutLowStock();
      response.json({ ok: true });
    } catch (productError) { sendAdminError(response, productError); }
  }));

  // Загрузка склада/каталога из Excel или CSV прямо из админки (или готовый пример чая)
  router.post('/stock-import', ...catalogAdminAuth, express.json({ limit: '8mb' }), stockImportValidator, asyncHandler(async (request, response) => {
    const { sample, fileType, fileBuffer } = request.validated;
    try {
      let importResult;
      if (sample === 'tea') importResult = await stockFiles.importXlsx(fs.readFileSync(TEA_SAMPLE_FILE));
      else if (fileType === 'xlsx') importResult = await stockFiles.importXlsx(fileBuffer);
      else importResult = await stockFiles.importCsv(fileBuffer.toString('utf8'));
      response.json({ ok: true, text: stockFiles.importReportText(importResult) });
    } catch (importError) { sendAdminError(response, importError); }
  }));

  // Изменение остатков по названию товара: delta<0 — списать, >0 — вернуть.
  // Всё или ничего: если хоть одной позиции не хватает, ничего не меняем. Наборы меняются через состав.
  router.post('/stock-delta', ...catalogAdminAuth, stockDeltaValidator, asyncHandler(async (request, response) => {
    try {
      const changeResult = await runInTransaction(async () => {
        const appliedChanges = [];
        const unknownNames = [];
        for (const { productName, delta } of request.validated.stockChanges) {
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

  // Отчёт: присылаем владелице в чат (текст + по желанию подробный Excel)
  router.post('/report', ...ownerAuth, reportValidator, asyncHandler(async (request, response) => {
    const { days, withExcelFile } = request.validated;
    try {
      await bot.telegram.sendMessage(process.env.OWNER_CHAT_ID, await reports.reportText(days));
      if (withExcelFile) await bot.telegram.sendDocument(process.env.OWNER_CHAT_ID, { source: await reports.reportXlsx(days), filename: `otchet-${days}d.xlsx` });
      response.json({ ok: true });
    } catch (reportError) {
      console.error('Отчёт:', reportError.message);
      response.status(500).json({ error: 'Не получилось отправить отчёт' });
    }
  }));

  router.post('/products/:id/delete', ...catalogAdminAuth, idParamValidator('productId'), asyncHandler(async (request, response) => {
    const { productId } = request.validated;
    await runInTransaction(async () => {
      await database.cartItem.deleteMany({ where: { product_id: productId } });
      await database.bundleItem.deleteMany({ where: { OR: [{ bundle_id: productId }, { product_id: productId }] } });
      await database.product.deleteMany({ where: { id: productId } });
      await inventory.syncBundles();
    });
    response.json({ ok: true });
  }));

  // Фото с телефона: приходит готовый JPEG (витрина сама уменьшает его до 1600 px)
  router.post('/products/:id/photo', ...ownerAuth, express.raw({ type: 'image/*', limit: '10mb' }), photoUploadValidator, asyncHandler(async (request, response) => {
    const { productId, photoBuffer, contentType } = request.validated;
    if (!(await database.product.findUnique({ where: { id: productId }, select: { id: true } }))) return response.status(404).json({ error: 'Товар не найден' });
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${photos.extensionFor(contentType)}`;
    fs.writeFileSync(path.join(photos.uploadsDir, fileName), photoBuffer);
    await database.product.update({ where: { id: productId }, data: { photo_url: `${request.protocol}://${request.get('host')}/uploads/${fileName}` } });
    forgetShowcasePhoto(productId);
    return response.json({ ok: true });
  }));

  // Фото по ссылке (https), например из генератора картинок — сервер сам скачает и покажет
  router.post('/products/:id/photo-url', ...catalogAdminAuth, photoUrlValidator, asyncHandler(async (request, response) => {
    const { productId, photoUrl } = request.validated;
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
