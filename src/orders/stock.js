// Склад по заказу: списать товар при оплате и вернуть при отмене.
// Вызывается внутри runInTransaction — остаток читаем и меняем в той же транзакции.
const { database } = require('../database');
const inventory = require('../inventory');
const quantityRules = require('../inventory/quantity');

// Списываем не больше, чем есть, и запоминаем, сколько взяли. Возвращает список нехватки.
async function takeStockForOrder(order) {
  const shortages = [];
  for (const orderItem of order.items) {
    const neededQuantity = orderItem.quantity - (orderItem.stock_taken || 0);
    if (neededQuantity <= 0) continue;
    const takenQuantity = await inventory.takeFromStock(orderItem.product_id, neededQuantity, 'продажа', order.id);
    await database.orderItem.update({
      where: { id: orderItem.id },
      data: { stock_taken: { increment: takenQuantity } },
    });
    if (takenQuantity < neededQuantity) {
      const unit = orderItem.unit ? quantityRules.unitLabel(orderItem) : 'шт.';
      shortages.push(`${orderItem.name || 'товар'} — не хватило ${neededQuantity - takenQuantity} ${unit}`);
    }
  }
  return shortages;
}

// Возвращаем на склад ровно то, что списали
async function returnStockForOrder(order) {
  for (const orderItem of order.items) {
    if (!orderItem.stock_taken) continue;
    await inventory.returnToStock(orderItem.product_id, orderItem.stock_taken, 'отмена заказа', order.id);
    await database.orderItem.update({ where: { id: orderItem.id }, data: { stock_taken: 0 } });
  }
}

module.exports = { takeStockForOrder, returnStockForOrder };
