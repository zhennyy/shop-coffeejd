// inventory.js — единственное место, где меняются остатки: каждое изменение попадает в журнал (для отчётов),
// а остаток наборов считается по составу.
const db = require('./db');

const isBundle = (id) => Boolean(db.prepare('SELECT 1 FROM bundle_items WHERE bundle_id = ?').get(id));

function log(productId, delta, after, reason, orderId = null) {
  if (!delta) return;
  db.prepare('INSERT INTO stock_log (product_id, delta, after, reason, order_id) VALUES (?,?,?,?,?)').run(productId, delta, after, reason, orderId);
}

// Пересчитать остаток всех наборов: сколько наборов можно собрать из того, что есть
function syncBundles() {
  const bundles = db.prepare('SELECT DISTINCT bundle_id FROM bundle_items').all();
  const comp = db.prepare(`SELECT b.qty, p.stock FROM bundle_items b JOIN products p ON p.id = b.product_id WHERE b.bundle_id = ?`);
  const set = db.prepare('UPDATE products SET stock = ? WHERE id = ?');
  for (const { bundle_id } of bundles) {
    const rows = comp.all(bundle_id);
    set.run(rows.length ? Math.min(...rows.map((r) => Math.floor(r.stock / r.qty))) : 0, bundle_id);
  }
}

// Новый остаток товара (для наборов не применяется — они считаются сами)
function setStock(id, value, reason) {
  if (isBundle(id)) return false;
  const cur = db.prepare('SELECT stock FROM products WHERE id = ?').get(id);
  if (!cur) return false;
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(value, id);
  log(id, value - cur.stock, value, reason);
  syncBundles();
  return true;
}

// Списать n штук (товар или набор целиком). Возвращает, сколько реально списано (не больше, чем есть).
function take(id, n, reason, orderId) {
  const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(id);
  if (!p) return 0;
  const k = Math.max(0, Math.min(p.stock, n));
  if (!k) return 0;
  const parts = db.prepare('SELECT product_id, qty FROM bundle_items WHERE bundle_id = ?').all(id);
  if (parts.length) {
    for (const c of parts) {
      const left = db.prepare('SELECT stock FROM products WHERE id = ?').get(c.product_id).stock - c.qty * k;
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(left, c.product_id);
      log(c.product_id, -c.qty * k, left, `набор «${db.prepare('SELECT name FROM products WHERE id = ?').get(id).name}»`, orderId);
    }
  } else {
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(k, id);
    log(id, -k, p.stock - k, reason, orderId);
  }
  syncBundles();
  return k;
}

// Вернуть n штук (отмена заказа)
function give(id, n, reason, orderId) {
  if (!n) return;
  const parts = db.prepare('SELECT product_id, qty FROM bundle_items WHERE bundle_id = ?').all(id);
  if (parts.length) {
    for (const c of parts) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(c.qty * n, c.product_id);
      log(c.product_id, c.qty * n, db.prepare('SELECT stock FROM products WHERE id = ?').get(c.product_id).stock, reason, orderId);
    }
  } else {
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(n, id);
    log(id, n, db.prepare('SELECT stock FROM products WHERE id = ?').get(id)?.stock ?? 0, reason, orderId);
  }
  syncBundles();
}

// Состав набора: [{product_id, qty}]; пустой список — снять набор. Вложенные наборы и сам в себя запрещены.
function setBundle(bundleId, parts) {
  const clean = new Map();
  for (const p of parts || []) {
    const pid = parseInt(p.product_id, 10), qty = parseInt(p.qty, 10);
    if (!pid || !(qty >= 1 && qty <= 1000)) throw Object.assign(new Error('В составе набора количество — целое число от 1'), { expose: true });
    if (pid === bundleId) throw Object.assign(new Error('Набор не может входить сам в себя'), { expose: true });
    const row = db.prepare('SELECT id FROM products WHERE id = ?').get(pid);
    if (!row) throw Object.assign(new Error(`Товара #${pid} нет`), { expose: true });
    if (isBundle(pid)) throw Object.assign(new Error('В набор нельзя класть другой набор'), { expose: true });
    clean.set(pid, (clean.get(pid) || 0) + qty);
  }
  if (clean.size > 20) throw Object.assign(new Error('В наборе не больше 20 позиций'), { expose: true });
  db.transaction(() => {
    db.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').run(bundleId);
    for (const [pid, qty] of clean) db.prepare('INSERT INTO bundle_items (bundle_id, product_id, qty) VALUES (?,?,?)').run(bundleId, pid, qty);
    syncBundles();
  })();
}
const bundleOf = (id) => db.prepare(`SELECT b.product_id, b.qty, p.name FROM bundle_items b JOIN products p ON p.id = b.product_id WHERE b.bundle_id = ? ORDER BY p.name`).all(id);

module.exports = { setStock, take, give, syncBundles, setBundle, bundleOf, isBundle, log };

try { syncBundles(); } catch { /* таблица составов появится при первой миграции */ }
