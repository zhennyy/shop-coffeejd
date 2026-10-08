// Подготовка базы при старте: миграции, стартовые данные, остатки наборов
const { connect } = require('./index');
const { seedDatabase } = require('./seed');
const { syncBundles } = require('../inventory');

async function initializeDatabase() {
  connect(); // применяет миграции и создаёт клиент Prisma
  await seedDatabase();
  await syncBundles();
}

module.exports = { initializeDatabase };
