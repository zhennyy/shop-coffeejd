const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
let S, inv, stock;
const OWN = 1001, U = 6001;
const mk = async (b) => { const r = await S.call(OWN, 'POST', '/shop-api/admin/products', b); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.id; };
const row = (id) => S.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const paySucceed = async () => {
  const pay = [...S.payments.values()].pop(); pay.status = 'succeeded';
  await fetch(S.base + '/yookassa-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'payment.succeeded', object: { id: pay.id } }) });
  return pay;
};
const buy = async (user, pairs) => {
  S.db.prepare('DELETE FROM cart_items WHERE chat_id = ?').run(user);
  for (const [id, q] of pairs) { const r = await S.call(user, 'POST', '/shop-api/cart', { product_id: id, qty: q }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  return S.call(user, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
};

before(async () => { S = await h.start(); inv = require('../inventory'); stock = require('../stock'); });

test('два параметра выбора: вес и упаковка; второй без первого запрещён', async () => {
  const id = await mk({ name: 'Колумбия', price: 900, stock: 10, option_label: '250 г', option2_label: 'Пакет' });
  const p = row(id);
  assert.equal(p.name, 'Колумбия · 250 г · Пакет'); assert.equal(p.group_key, 'Колумбия'); assert.equal(p.option2_label, 'Пакет');
  const bad = await S.call(OWN, 'POST', '/shop-api/admin/products', { name: 'X', price: 100, stock: 1, option2_label: 'Пакет' });
  assert.equal(bad.status, 400);
  const cat = await S.call(U, 'GET', '/shop-api/catalog');
  assert.equal(cat.body.products.find((x) => x.id === id).option2_label, 'Пакет');
});

test('продажа на вес: шаг и минимум, цена за 100 г, чек одной строкой, склад в граммах', async () => {
  const id = await mk({ name: 'Кофе на развес', unit: 'g', price: 480, stock: 5000, step: 50, min_qty: 100 });
  assert.equal(row(id).price, 480); assert.equal(row(id).unit, 'g');
  assert.equal((await S.call(OWN, 'POST', '/shop-api/admin/products', { name: 'Дробная', unit: 'g', price: 480.5, stock: 10 })).status, 400);
  for (const q of [50, 130, 75]) assert.equal((await S.call(U, 'POST', '/shop-api/cart', { product_id: id, qty: q })).status, 400, 'qty ' + q);
  assert.equal((await S.call(U, 'POST', '/shop-api/cart', { product_id: id, qty: 6000 })).status, 400);
  process.env.YOOKASSA_RECEIPTS = 'on';
  const r = await buy(U, [[id, 300]]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(S.db.prepare('SELECT total FROM orders WHERE id = ?').get(r.body.id).total, 300 * 480);
  const pay = [...S.payments.values()].pop();
  assert.equal(pay.body.receipt.items.length, 1);
  assert.match(pay.body.receipt.items[0].description, /300 г/);
  assert.equal(pay.body.amount.value, '1440.00');
  process.env.YOOKASSA_RECEIPTS = 'off';
  await paySucceed();
  assert.equal(row(id).stock, 4700);
  const log = S.db.prepare('SELECT delta, reason FROM stock_log WHERE product_id = ? ORDER BY id DESC').get(id);
  assert.equal(log.delta, -300);
});

test('допы: хранятся как товар с флагом, отдаются в каталоге, не попадают в чат-каталог бота', async () => {
  const base = await mk({ name: 'Кофе для допов', price: 500, stock: 5 });
  const add = await mk({ name: 'Подарочная упаковка', price: 150, stock: 100, is_addon: true, addon_for: 'Кофе для допов' });
  const cat = (await S.call(U, 'GET', '/shop-api/catalog')).body.products;
  assert.equal(cat.find((x) => x.id === add).is_addon, 1);
  assert.equal(cat.find((x) => x.id === add).addon_for, 'Кофе для допов');
  const r = await buy(U, [[base, 1], [add, 1]]);
  assert.equal(r.status, 200); assert.equal(S.db.prepare('SELECT total FROM orders WHERE id = ?').get(r.body.id).total, 65000);
  await paySucceed(); assert.equal(row(add).stock, 99);
});

test('наборы: остаток по составу, оплата списывает компоненты, отмена возвращает', async () => {
  const a = await mk({ name: 'Набор-А', price: 100, stock: 7 }), b = await mk({ name: 'Набор-Б', price: 100, stock: 3 });
  const set = await mk({ name: 'Дегустация 2', price: 1500, stock: 99, bundle: [{ product_id: a, qty: 2 }, { product_id: b, qty: 1 }] });
  assert.equal(row(set).stock, 3);                           // min(7/2=3, 3/1=3)
  assert.equal((await S.call(OWN, 'POST', `/shop-api/admin/products/${set}`, { name: 'Дегустация 2', price: 1500, stock: 50, bundle: [{ product_id: a, qty: 2 }, { product_id: b, qty: 1 }] })).status, 200);
  assert.equal(row(set).stock, 3);                           // ручной остаток набора игнорируется
  const r = await buy(U, [[set, 2]]);
  assert.equal(r.status, 200); await paySucceed();
  assert.equal(row(a).stock, 3); assert.equal(row(b).stock, 1); assert.equal(row(set).stock, 1);
  const st = await S.call(OWN, 'POST', `/shop-api/admin/orders/${r.body.id}/status`, { status: 'cancelled' });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(row(a).stock, 7); assert.equal(row(b).stock, 3); assert.equal(row(set).stock, 3);
  // запреты
  assert.throws(() => inv.setBundle(set, [{ product_id: set, qty: 1 }]), /сам в себя/);
  const other = await mk({ name: 'Набор-В', price: 10, stock: 1, bundle: [{ product_id: a, qty: 1 }] });
  assert.throws(() => inv.setBundle(set, [{ product_id: other, qty: 1 }]), /другой набор/);
  const delta = await S.call(OWN, 'POST', '/shop-api/admin/stock-delta', { changes: [{ name: 'Дегустация 2', delta: -1 }] }, {});
  assert.equal(delta.status, 409);
  // удаление компонента не ломает набор
  await S.call(OWN, 'POST', `/shop-api/admin/products/${b}/delete`, {});
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM bundle_items WHERE product_id = ?').get(b).n, 0);
});

test('Excel (.xlsx): выгрузка → правка → загрузка; новые строки; ошибки не ломают остальное', async () => {
  const ExcelJS = require('exceljs');
  const buf = await stock.exportXlsx();
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.deepEqual(ws.getRow(1).values.slice(1, 5), ['id', 'название', 'вариант', 'вариант2']);
  const same = await stock.importXlsx(buf);
  assert.equal(same.updated + same.created, 0, JSON.stringify(same));        // выгрузка без правок ничего не меняет
  assert.deepEqual(same.errors, []);
  let first = ws.getRow(2); for (let i = 2; i <= ws.rowCount; i++) if (ws.getRow(i).getCell(9).value === 'товар') { first = ws.getRow(i); break; }
  const id = first.getCell(1).value; const oldStock = row(id).stock;
  first.getCell(7).value = oldStock + 11;
  ws.addRow(['', 'Новый на вес', '', '', 'Кофе', 600, 2000, '', 'на вес', '', '', 50, 100]);
  ws.addRow(['', 'Новый доп', '', '', '', 99, 40, '', 'доп', '*', '', '', '']);
  ws.addRow(['', 'Плохая цена', '', '', '', 'abc', 5, '', '', '', '', '', '']);
  const r = await stock.importXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(r.updated, 1); assert.equal(r.created, 2); assert.equal(r.errors.length, 1, JSON.stringify(r));
  assert.equal(row(id).stock, oldStock + 11);
  const w = S.db.prepare("SELECT * FROM products WHERE name = 'Новый на вес'").get();
  assert.equal(w.unit, 'g'); assert.equal(w.price, 600); assert.equal(w.step, 50);
  assert.equal(S.db.prepare("SELECT is_addon FROM products WHERE name = 'Новый доп'").get().is_addon, 1);
});

test('CSV: набор по составу', () => {
  const a = S.db.prepare('SELECT id FROM products WHERE stock > 5 LIMIT 1').get().id;
  const csv = `название;цена_руб;остаток;тип;состав\nНабор из CSV;1000;0;набор;${a}×2`;
  const r = stock.importCsv(csv);
  assert.equal(r.created, 1, JSON.stringify(r));
  const set = S.db.prepare("SELECT id, stock FROM products WHERE name = 'Набор из CSV'").get();
  assert.equal(inv.bundleOf(set.id)[0].qty, 2); assert.equal(set.stock, Math.floor(row(a).stock / 2));
  assert.match(stock.importCsv(`название;цена_руб;остаток;тип;состав\nКривой;100;0;набор;Нет такого×2`).errors[0], /такого товара нет/);
});

test('отчёты: продажи, остатки, движение; отправка владелице', async () => {
  const rep = require('../reports');
  const r = rep.build(30);
  assert.ok(r.orders.n >= 2, JSON.stringify(r.orders)); assert.ok(r.byProduct.length); assert.ok(r.moves.length);
  assert.match(rep.text(30), /Выручка/);
  const buf = await rep.xlsx(30);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ['Итоги', 'Продажи по товарам', 'Способы получения', 'Остатки', 'Движение товара']);
  S.sent.length = 0;
  assert.equal((await S.call(OWN, 'POST', '/shop-api/admin/report', { days: 7 })).status, 200);
  assert.ok(S.sent.some((m) => /Отчёт за 7/.test(m.text)));
  assert.equal((await S.call(U, 'POST', '/shop-api/admin/report', { days: 7 })).status, 403);
});

test('подписка и повтор заказа с весовым товаром и набором', async () => {
  const subs = require('../subscriptions');
  const w = await mk({ name: 'Весовой для подписки', unit: 'g', price: 500, stock: 3000, step: 50, min_qty: 100 });
  const a = await mk({ name: 'Компонент П', price: 100, stock: 10 });
  const set = await mk({ name: 'Набор для подписки', price: 700, stock: 0, bundle: [{ product_id: a, qty: 2 }] });
  const U2 = 6100;
  const r = await buy(U2, [[w, 250], [set, 1]]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await paySucceed();
  assert.equal(row(w).stock, 2750); assert.equal(row(a).stock, 8);
  const rep = await S.call(U2, 'POST', `/shop-api/orders/${r.body.id}/repeat`);
  assert.equal(rep.status, 200); assert.equal(rep.body.cart[w], 250);
  const c = await S.call(U2, 'POST', '/shop-api/subscriptions', { order_id: r.body.id, days: 7 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const list = await S.call(U2, 'GET', '/shop-api/subscriptions');
  assert.equal(list.body.subscriptions[0].items.find((i) => i.name.includes('развес') || i.name.includes('Весовой')).unit, 'g');
  S.db.prepare('UPDATE subscriptions SET next_date = ? WHERE id = ?').run('2000-01-01', c.body.id);
  S.sent.length = 0;
  assert.equal(await subs.runDue(S.bot), 1);
  assert.ok(S.sent.some((m) => m.chat === U2 && /250 г/.test(m.text)), 'в сообщении граммы');
  const o = S.db.prepare('SELECT total FROM orders WHERE chat_id = ? ORDER BY id DESC').get(U2);
  assert.equal(o.total, 250 * 500 + 70000);
});

test('на объём (мл) и пример «чай — 10 сортов» загружается целиком', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const ml = await mk({ name: 'Сироп на розлив', unit: 'ml', price: 180, stock: 5000, step: 50, min_qty: 100 });
  assert.equal(row(ml).unit, 'ml');
  assert.equal((await S.call(U, 'POST', '/shop-api/cart', { product_id: ml, qty: 125 })).status, 400);
  assert.equal((await S.call(U, 'POST', '/shop-api/cart', { product_id: ml, qty: 250 })).status, 200);
  const res = await stock.importXlsx(fs.readFileSync(path.join(__dirname, '..', 'примеры', 'чай-10-сортов.xlsx')));
  assert.deepEqual(res.errors, []); assert.equal(res.created, 19);
  const teas = S.db.prepare("SELECT * FROM products WHERE category = 'Чай' AND name LIKE '%Холодный чай%'").get();
  assert.equal(teas.unit, 'ml');
  const cards = S.db.prepare("SELECT COUNT(DISTINCT COALESCE(group_key, name)) n FROM products WHERE category = 'Чай' AND id IN (SELECT id FROM products ORDER BY id DESC LIMIT 19)").get().n;
  assert.equal(cards, 10);   // 17 строк = 10 карточек чая (+2 набора лежат в категории «Наборы»)
  const set = S.db.prepare("SELECT id, stock FROM products WHERE name = 'Набор «Утёсный вечер»'").get();
  assert.equal(inv.bundleOf(set.id).length, 3); assert.ok(set.stock > 0);
  assert.equal(inv.bundleOf(set.id).find((b) => b.name === 'Те Гуань Инь').qty, 100);
});

test('импорт из админки: пример чая и свой файл; покупатель не может', async () => {
  const before = S.db.prepare('SELECT COUNT(*) n FROM products').get().n;
  const bad = await S.call(U, 'POST', '/shop-api/admin/stock-import', { sample: 'tea' });
  assert.equal(bad.status, 403);
  const r = await S.call(OWN, 'POST', '/shop-api/admin/stock-import', { sample: 'tea' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Добавлено: 19/);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM products').get().n, before + 19);
  const csv = Buffer.from('название;вариант;категория;цена_руб;остаток\nИмпорт-тест;;Тест;100;5\n', 'utf8').toString('base64');
  const c = await S.call(OWN, 'POST', '/shop-api/admin/stock-import', { name: 'x.csv', data: csv });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const wrong = await S.call(OWN, 'POST', '/shop-api/admin/stock-import', { name: 'x.exe', data: csv });
  assert.equal(wrong.status, 400);
});
