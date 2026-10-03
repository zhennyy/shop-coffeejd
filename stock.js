// stock.js — выгрузка и загрузка склада через CSV (открывается в Excel/Numbers/Google Таблицах).
// Колонки: id; название; вариант; категория; цена, ₽; остаток; описание.
// Загрузка: строка с id обновляет цену и остаток; строка без id и с названием+ценой создаёт товар.
const db = require('./db');

const COLS = ['id', 'название', 'вариант', 'категория', 'цена_руб', 'остаток', 'описание'];

const cell = (v) => {
  const s = v == null ? '' : String(v);
  // защита от формул в Excel: =, +, -, @ в начале ячейки
  const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? "'" + s : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function exportCsv() {
  const rows = db.prepare('SELECT * FROM products ORDER BY category, COALESCE(group_key, name), price').all();
  const lines = rows.map((p) => [p.id, p.group_key || p.name, p.option_label || '', p.category || '', p.price / 100, p.stock, p.description || '']
    .map(cell).join(';'));
  // «;» и BOM — чтобы Excel сразу открыл кириллицу по столбцам
  return '﻿' + [COLS.join(';'), ...lines].join('\r\n');
}

function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = ''; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const num = (v) => Number(String(v).replace(/\s/g, '').replace(',', '.'));

function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('В файле нет строк с товарами');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = {
    id: col('id'), name: col('название', 'name'), opt: col('вариант', 'option'), cat: col('категория', 'category'),
    price: col('цена_руб', 'цена', 'price', 'price_rub'), stock: col('остаток', 'stock'), desc: col('описание', 'description'),
  };
  if (ix.stock < 0 && ix.price < 0) throw new Error('Не нашла колонки «остаток» или «цена_руб» — берите файл из выгрузки');
  const res = { updated: 0, created: 0, unchanged: 0, errors: [] };
  const upd = db.prepare('UPDATE products SET price = ?, stock = ? WHERE id = ?');
  const get = db.prepare('SELECT id, price, stock FROM products WHERE id = ?');
  const ins = db.prepare(`INSERT INTO products (name, description, price, stock, category, group_key, option_label)
                          VALUES (?,?,?,?,?,?,?)`);
  db.transaction(() => {
    rows.slice(1).forEach((r, n) => {
      const line = n + 2, g = (i) => (i >= 0 ? String(r[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '') : '');
      const id = g(ix.id);
      const stock = g(ix.stock) === '' ? null : num(g(ix.stock));
      const price = g(ix.price) === '' ? null : Math.round(num(g(ix.price)) * 100);
      if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 1e6)) return res.errors.push(`строка ${line}: остаток «${g(ix.stock)}» не подходит`);
      if (price !== null && (!Number.isFinite(price) || price <= 0 || price > 1e9)) return res.errors.push(`строка ${line}: цена «${g(ix.price)}» не подходит`);
      if (id) {
        const cur = get.get(parseInt(id, 10));
        if (!cur) return res.errors.push(`строка ${line}: товара с id ${id} нет`);
        const np = price ?? cur.price, ns = stock ?? cur.stock;
        if (np === cur.price && ns === cur.stock) return res.unchanged++;
        upd.run(np, ns, cur.id); res.updated++;
      } else {
        const base = g(ix.name), opt = g(ix.opt);
        if (!base || price === null) return res.errors.push(`строка ${line}: для нового товара нужны название и цена`);
        ins.run(opt ? `${base} · ${opt}` : base, g(ix.desc) || null, price, stock ?? 0, g(ix.cat) || null, opt ? base : null, opt || null);
        res.created++;
      }
    });
  })();
  return res;
}

const reportText = (r) => `📥 Склад обновлён\nИзменено: ${r.updated} · Добавлено: ${r.created} · Без изменений: ${r.unchanged}` +
  (r.errors.length ? `\n\n⚠️ Пропущено ${r.errors.length}:\n` + r.errors.slice(0, 10).join('\n') + (r.errors.length > 10 ? '\n…' : '') : '');

module.exports = { exportCsv, importCsv, parseCsv, reportText };
