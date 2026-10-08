// Склад — единственное место, где меняются остатки. Каждое изменение попадает в журнал (для отчётов),
// а остаток наборов считается по составу.
const { database, runInTransaction } = require('../database');

const MAX_BUNDLE_PARTS = 20;
const userError = (message) => Object.assign(new Error(message), { expose: true });

async function isBundle(productId) {
  return (await database.bundleItem.count({ where: { bundle_id: productId } })) > 0;
}

async function getStock(productId) {
  const product = await database.product.findUnique({ where: { id: productId }, select: { stock: true } });
  return product ? product.stock : null;
}

async function writeStockLog(productId, delta, stockAfter, reason, orderId = null) {
  if (!delta) return;
  await database.stockLogEntry.create({ data: { product_id: productId, delta, after: stockAfter, reason, order_id: orderId } });
}

// Пересчитать остаток всех наборов: сколько наборов можно собрать из того, что есть
async function syncBundles() {
  const bundleParts = await database.bundleItem.findMany();
  const componentStocks = await database.product.findMany({
    where: { id: { in: [...new Set(bundleParts.map((part) => part.product_id))] } },
    select: { id: true, stock: true },
  });
  const stockByProductId = new Map(componentStocks.map((product) => [product.id, product.stock]));
  const partsByBundleId = new Map();
  for (const part of bundleParts) {
    if (!partsByBundleId.has(part.bundle_id)) partsByBundleId.set(part.bundle_id, []);
    partsByBundleId.get(part.bundle_id).push(part);
  }
  for (const [bundleId, parts] of partsByBundleId) {
    const existingParts = parts.filter((part) => stockByProductId.has(part.product_id));
    const assemblableCount = existingParts.length
      ? Math.min(...existingParts.map((part) => Math.floor(stockByProductId.get(part.product_id) / part.qty)))
      : 0;
    await database.product.updateMany({ where: { id: bundleId }, data: { stock: assemblableCount } });
  }
}

// Новый остаток товара (для наборов не применяется — они считаются сами)
async function setStock(productId, newStock, reason) {
  return runInTransaction(async () => {
    if (await isBundle(productId)) return false;
    const currentStock = await getStock(productId);
    if (currentStock === null) return false;
    await database.product.update({ where: { id: productId }, data: { stock: newStock } });
    await writeStockLog(productId, newStock - currentStock, newStock, reason);
    await syncBundles();
    return true;
  });
}

// Списать quantity штук (товар или набор целиком). Возвращает, сколько реально списано (не больше, чем есть).
async function takeFromStock(productId, quantity, reason, orderId) {
  return runInTransaction(async () => {
    const product = await database.product.findUnique({ where: { id: productId }, select: { name: true, stock: true } });
    if (!product) return 0;
    const takenQuantity = Math.max(0, Math.min(product.stock, quantity));
    if (!takenQuantity) return 0;
    const bundleParts = await database.bundleItem.findMany({ where: { bundle_id: productId } });
    if (bundleParts.length) {
      for (const part of bundleParts) {
        const componentStockLeft = (await getStock(part.product_id)) - part.qty * takenQuantity;
        await database.product.update({ where: { id: part.product_id }, data: { stock: componentStockLeft } });
        await writeStockLog(part.product_id, -part.qty * takenQuantity, componentStockLeft, `набор «${product.name}»`, orderId);
      }
    } else {
      await database.product.update({ where: { id: productId }, data: { stock: { decrement: takenQuantity } } });
      await writeStockLog(productId, -takenQuantity, product.stock - takenQuantity, reason, orderId);
    }
    await syncBundles();
    return takenQuantity;
  });
}

// Вернуть quantity штук (отмена заказа)
async function returnToStock(productId, quantity, reason, orderId) {
  if (!quantity) return;
  await runInTransaction(async () => {
    const bundleParts = await database.bundleItem.findMany({ where: { bundle_id: productId } });
    const returns = bundleParts.length
      ? bundleParts.map((part) => ({ productId: part.product_id, quantity: part.qty * quantity }))
      : [{ productId, quantity }];
    for (const stockReturn of returns) {
      const updatedProducts = await database.product.updateMany({ where: { id: stockReturn.productId }, data: { stock: { increment: stockReturn.quantity } } });
      const stockAfter = updatedProducts.count ? await getStock(stockReturn.productId) : 0;
      await writeStockLog(stockReturn.productId, stockReturn.quantity, stockAfter, reason, orderId);
    }
    await syncBundles();
  });
}

// Состав набора: [{product_id, qty}]; пустой список — снять набор. Вложенные наборы и сам в себя запрещены.
async function setBundle(bundleId, requestedParts) {
  const quantityByProductId = new Map();
  for (const requestedPart of requestedParts || []) {
    const partProductId = parseInt(requestedPart.product_id, 10);
    const partQuantity = parseInt(requestedPart.qty, 10);
    if (!partProductId || !(partQuantity >= 1 && partQuantity <= 1000)) throw userError('В составе набора количество — целое число от 1');
    if (partProductId === bundleId) throw userError('Набор не может входить сам в себя');
    if (!(await database.product.findUnique({ where: { id: partProductId }, select: { id: true } }))) throw userError(`Товара #${partProductId} нет`);
    if (await isBundle(partProductId)) throw userError('В набор нельзя класть другой набор');
    quantityByProductId.set(partProductId, (quantityByProductId.get(partProductId) || 0) + partQuantity);
  }
  if (quantityByProductId.size > MAX_BUNDLE_PARTS) throw userError(`В наборе не больше ${MAX_BUNDLE_PARTS} позиций`);
  await runInTransaction(async () => {
    await database.bundleItem.deleteMany({ where: { bundle_id: bundleId } });
    if (quantityByProductId.size) {
      await database.bundleItem.createMany({
        data: [...quantityByProductId].map(([partProductId, partQuantity]) => ({ bundle_id: bundleId, product_id: partProductId, qty: partQuantity })),
      });
    }
    await syncBundles();
  });
}

// Состав набора с названиями: [{product_id, qty, name}], по алфавиту
async function getBundleParts(bundleId) {
  const bundleParts = await database.bundleItem.findMany({ where: { bundle_id: bundleId } });
  const products = await database.product.findMany({ where: { id: { in: bundleParts.map((part) => part.product_id) } }, select: { id: true, name: true } });
  const nameByProductId = new Map(products.map((product) => [product.id, product.name]));
  return bundleParts
    .filter((part) => nameByProductId.has(part.product_id))
    .map((part) => ({ product_id: part.product_id, qty: part.qty, name: nameByProductId.get(part.product_id) }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

// id всех наборов — чтобы не спрашивать базу по каждому товару в списках
async function getBundleIds() {
  const bundleParts = await database.bundleItem.findMany({ select: { bundle_id: true } });
  return new Set(bundleParts.map((part) => part.bundle_id));
}

module.exports = { setStock, takeFromStock, returnToStock, syncBundles, setBundle, getBundleParts, getBundleIds, isBundle, writeStockLog };
