// stock.js — выгрузка и загрузка склада: Excel (.xlsx) и CSV (открывается в Excel/Numbers/Google Таблицах).
// Колонки: id; название; вариант; вариант2; категория; цена_руб; остаток; описание; тип; для_товаров; состав; шаг_г; мин_г
//   тип: товар | на вес | доп | набор. На вес: цена — за 100 г (целые рубли), остаток и шаги — в граммах.
//   доп: в «для_товаров» через «|» названия товаров, к которым он предлагается (или *); набор: «состав» вида «12×2; 15×1» (id или точные названия).
// Загрузка: строка с id обновляет цену, остаток (и состав/«для_товаров», если колонка есть); строка без id создаёт товар.
const db = require('./db');
const inv = require('./inventory');

const COLS = ['id', 'название', 'вариант', 'вариант2', 'категория', 'цена_руб', 'остаток', 'описание', 'тип', 'для_товаров', 'состав', 'шаг_г', 'мин_г'];

const safeText = (s) => (/^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? "'" + s : s); // защита от формул в Excel
const cell = (v) => {
  const s = safeText(v == null ? '' : String(v));
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const typeOf = (p) => (inv.isBundle(p.id) ? 'набор' : p.is_addon ? 'доп' : p.unit === 'g' ? 'на вес' : 'товар');
// строки таблицы (массив массивов значений)
function tableRows() {
  const rows = db.prepare('SELECT * FROM products ORDER BY is_addon, category, COALESCE(group_key, name), price').all();
  return rows.map((p) => {
    const w = p.unit === 'g';
    return [p.id, p.group_key || p.name, p.option_label || '', p.option2_label || '', p.category || '', w ? p.price : p.price / 100, p.stock, p.description || '',
      typeOf(p), p.addon_for || '', inv.bundleOf(p.id).map((b) => `${b.product_id}×${b.qty}`).join('; '), w ? p.step : '', w ? p.min_qty : ''];
  });
}
function exportCsv() {
  const lines = tableRows().map((r) => r.map(cell).join(';'));
  // «;» и BOM — чтобы Excel сразу открыл кириллицу по столбцам
  return '﻿' + [COLS.join(';'), ...lines].join('\r\n');
}
async function exportXlsx() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Склад');
  ws.addRow(COLS).font = { bold: true };
  for (const r of tableRows()) ws.addRow(r.map((v) => (typeof v === 'string' ? safeText(v) : v)));
  ws.columns.forEach((c, i) => { c.width = [6, 30, 12, 12, 14, 11, 9, 40, 9, 22, 18, 7, 7][i]; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
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
async function parseXlsx(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('В файле нет листов');
  const val = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if (v.result !== undefined) return val(v.result);
      if (v.richText) return v.richText.map((x) => x.text).join('');
      if (v.text !== undefined) return String(v.text);
      if (v instanceof Date) return v.toISOString();
      return '';
    }
    return String(v);
  };
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const arr = [];
    for (let i = 1; i <= Math.min(row.cellCount, 30); i++) arr.push(val(row.getCell(i).value));
    if (arr.some((x) => x.trim())) rows.push(arr);
  });
  return rows;
}

const num = (v) => Number(String(v).replace(/\s/g, '').replace(',', '.'));
const BAD = (m) => Object.assign(new Error(m), { expose: true });

function parseParts(text, line) {
  const out = [];
  for (const raw of String(text || '').split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = raw.match(/^(.+?)\s*[x×*хХ]\s*(\d+)$/i);
    const key = (m ? m[1] : raw).trim(), qty = m ? parseInt(m[2], 10) : 1;
    const p = /^\d+$/.test(key) ? db.prepare('SELECT id FROM products WHERE id = ?').get(parseInt(key, 10)) : db.prepare('SELECT id FROM products WHERE name = ?').get(key);
    if (!p) throw BAD(`строка ${line}: в составе «${key}» — такого товара нет`);
    out.push({ product_id: p.id, qty });
  }
  return out;
}

function importRows(rows) {
  if (rows.length < 2) throw new Error('В файле нет строк с товарами');
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = {
    id: col('id'), name: col('название', 'name'), opt: col('вариант', 'option'), opt2: col('вариант2', 'option2'), cat: col('категория', 'category'),
    price: col('цена_руб', 'цена', 'price', 'price_rub'), stock: col('остаток', 'stock'), desc: col('описание', 'description'),
    type: col('тип', 'type'), addon: col('для_товаров', 'addon_for'), parts: col('состав', 'bundle'), step: col('шаг_г', 'step'), min: col('мин_г', 'min'),
  };
  if (ix.stock < 0 && ix.price < 0) throw new Error('Не нашла колонки «остаток» или «цена_руб» — берите файл из выгрузки');
  const res = { updated: 0, created: 0, unchanged: 0, errors: [] };
  const get = db.prepare('SELECT * FROM products WHERE id = ?');
  const bundles = []; // составы применяем после всех строк — в них могут быть только что созданные товары по названию
  db.transaction(() => {
    rows.slice(1).forEach((r, n) => {
      const line = n + 2, g = (i) => (i >= 0 ? String(r[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '') : '');
      try {
        const id = g(ix.id);
        const stock = g(ix.stock) === '' ? null : num(g(ix.stock));
        if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 1e7)) throw BAD(`строка ${line}: остаток «${g(ix.stock)}» не подходит`);
        const priceRub = g(ix.price) === '' ? null : num(g(ix.price));
        if (priceRub !== null && (!Number.isFinite(priceRub) || priceRub <= 0 || priceRub > 1e7)) throw BAD(`строка ${line}: цена «${g(ix.price)}» не подходит`);
        const type = g(ix.type).toLowerCase();
        if (id) {
          const cur = get.get(parseInt(id, 10));
          if (!cur) throw BAD(`строка ${line}: товара с id ${id} нет`);
          const weight = cur.unit === 'g';
          let np = cur.price;
          if (priceRub !== null) {
            if (weight && !Number.isInteger(priceRub)) throw BAD(`строка ${line}: цена за 100 г — целые рубли`);
            np = weight ? priceRub : Math.round(priceRub * 100);
          }
          const bundle = inv.isBundle(cur.id) || (ix.parts >= 0 && g(ix.parts));
          let changed = false;
          if (np !== cur.price) { db.prepare('UPDATE products SET price = ? WHERE id = ?').run(np, cur.id); changed = true; }
          if (stock !== null && !bundle && stock !== cur.stock) { inv.setStock(cur.id, stock, 'загрузка файла'); changed = true; }
          if (ix.addon >= 0 && cur.is_addon && g(ix.addon) !== (cur.addon_for || '')) { db.prepare('UPDATE products SET addon_for = ? WHERE id = ?').run(g(ix.addon) || null, cur.id); changed = true; }
          if (ix.parts >= 0 && g(ix.parts) !== inv.bundleOf(cur.id).map((b) => `${b.product_id}×${b.qty}`).join('; ')) { bundles.push([cur.id, g(ix.parts), line]); changed = true; }
          return changed ? res.updated++ : res.unchanged++;
        }
        const base = g(ix.name), opt = g(ix.opt), opt2 = g(ix.opt2);
        if (!base || priceRub === null) throw BAD(`строка ${line}: для нового товара нужны название и цена`);
        const weight = type.replace(/\s/g, '') === 'навес';
        if (weight && !Number.isInteger(priceRub)) throw BAD(`строка ${line}: цена за 100 г — целые рубли`);
        const step = weight ? Math.max(1, parseInt(g(ix.step), 10) || 50) : 1, min = weight ? Math.max(1, parseInt(g(ix.min), 10) || 100) : 1;
        const full = [base, opt, opt2].filter(Boolean).join(' · ');
        const r2 = db.prepare(`INSERT INTO products (name, description, price, stock, category, group_key, option_label, option2_label, unit, step, min_qty, is_addon, addon_for)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(full, g(ix.desc) || null, weight ? priceRub : Math.round(priceRub * 100), stock ?? 0, g(ix.cat) || null,
          opt || opt2 ? base : null, opt || null, opt2 || null, weight ? 'g' : null, step, min, type === 'доп' ? 1 : 0, type === 'доп' ? (g(ix.addon) || '*') : null);
        inv.log(Number(r2.lastInsertRowid), stock ?? 0, stock ?? 0, 'добавлен загрузкой файла');
        if (type === 'набор') bundles.push([Number(r2.lastInsertRowid), g(ix.parts), line]);
        res.created++;
      } catch (e) {
        if (!e.expose) throw e;
        res.errors.push(e.message);
      }
    });
    for (const [bid, text, line] of bundles) {
      try { inv.setBundle(bid, parseParts(text, line)); } catch (e) { if (!e.expose) throw e; res.errors.push(`строка ${line}: ${e.message.replace(/^строка \d+: /, '')}`); }
    }
    inv.syncBundles();
  })();
  return res;
}
const importCsv = (text) => importRows(parseCsv(text));
const importXlsx = async (buf) => importRows(await parseXlsx(buf));

const reportText = (r) => `📥 Склад обновлён\nИзменено: ${r.updated} · Добавлено: ${r.created} · Без изменений: ${r.unchanged}` +
  (r.errors.length ? `\n\n⚠️ Пропущено ${r.errors.length}:\n` + r.errors.slice(0, 10).join('\n') + (r.errors.length > 10 ? '\n…' : '') : '');

module.exports = { exportCsv, exportXlsx, importCsv, importXlsx, importRows, parseCsv, parseXlsx, reportText, COLS };
