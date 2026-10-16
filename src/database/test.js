// Миграции на старой базе: база, созданная до 152-ФЗ (миграции 001–002, заказы и подписки с данными),
// после запуска нового кода получает колонку consent_at, а все данные остаются на месте.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const { PrismaClient } = require('./generated');
const { runMigrations } = require('./migrations');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const OLD_MIGRATIONS = ['001_baseline.sql', '002_order_items_id.sql'];

// Так выглядит база на проде до этого изменения: схема из 001–002 и учёт применённых миграций
function createOldDatabase(databasePath) {
  const connection = new Database(databasePath);
  connection.exec(
    "CREATE TABLE _app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  for (const fileName of OLD_MIGRATIONS) {
    connection.exec(fs.readFileSync(path.join(MIGRATIONS_DIRECTORY, fileName), 'utf8'));
    connection.prepare('INSERT INTO _app_migrations (name) VALUES (?)').run(fileName);
  }
  connection
    .prepare(
      "INSERT INTO orders (id, chat_id, status, total, address, order_code, delivery_method, delivery_city) VALUES (7, 42, 'paid', 150000, 'Москва, ул. Ленина, 1 · тел. +7 900 123-45-67', 'AB12', 'city', 'Москва')",
    )
    .run();
  connection.prepare('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (7, 1, 2, 75000)').run();
  connection
    .prepare(
      "INSERT INTO subscriptions (chat_id, items, interval_days, next_date, address) VALUES (42, '[]', 14, '2026-11-01', 'ул. Ленина, 1')",
    )
    .run();
  connection.close();
}

const columnNames = (connection, tableName) =>
  connection
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => column.name);

test('миграция 003 на старой базе: consent_at добавлена, данные на месте, повторный запуск ничего не ломает', async () => {
  const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coffeejd-old-')), 'old.db');
  createOldDatabase(databasePath);

  runMigrations(databasePath);
  runMigrations(databasePath); // при каждом старте — миграция применяется только один раз

  const connection = new Database(databasePath, { readonly: true });
  assert.ok(columnNames(connection, 'orders').includes('consent_at'));
  assert.ok(columnNames(connection, 'subscriptions').includes('consent_at'));
  const appliedMigrations = connection
    .prepare('SELECT name FROM _app_migrations ORDER BY name')
    .all()
    .map((migration) => migration.name);
  assert.deepEqual(appliedMigrations, [...OLD_MIGRATIONS, '003_consent_at.sql']);
  connection.close();

  // Prisma читает старые строки по новой схеме
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) });
  try {
    const oldOrder = await prisma.order.findUnique({ where: { id: 7 } });
    assert.equal(oldOrder.order_code, 'AB12');
    assert.equal(oldOrder.total, 150000);
    assert.match(oldOrder.address, /Ленина/);
    assert.equal(oldOrder.consent_at, null, 'у старых заказов согласия нет — не придумываем его задним числом');
    assert.equal(await prisma.orderItem.count({ where: { order_id: 7 } }), 1);
    const oldSubscription = await prisma.subscription.findFirst({ where: { chat_id: 42 } });
    assert.equal(oldSubscription.interval_days, 14);
    assert.equal(oldSubscription.consent_at, null);
  } finally {
    await prisma.$disconnect();
  }
});
