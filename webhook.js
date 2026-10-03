// webhook.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { checkLowStock } = require('./notify');
const { t } = require('./i18n');
const crypto = require('crypto');
const axios = require('axios');
const inv = require('./inventory');
const qty_ = require('./qty');
const { getPayment } = require('./payments/yookassa');
const orders = require('./orders');
const { sendToBuyer } = require('./chat');

// фото товаров храним рядом с базой — на Railway это подключённый Volume,
// так что файлы переживают редеплой (в отличие от остальной файловой системы)
const dbDir = path.dirname(path.resolve(process.env.DB_PATH || 'shop.db'));
const uploadsDir = path.join(dbDir, 'uploads');
// Фото товаров, которые лежат в самом проекте (видно в VS Code и на GitHub)
const photosDir = path.join(__dirname, 'photos');
fs.mkdirSync(uploadsDir, { recursive: true });

// ===== Все фото товаров храним у себя: папка uploads на постоянном диске Railway =====
// Если у товара ссылка на чужой сайт — скачиваем картинку один раз и дальше показываем свою копию.
const PUBLIC_BASE = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const isLocalPhoto = (url) => {
  const m = String(url || '').match(/\/(uploads|photos)\/([^/?#]+)$/);
  return Boolean(m) && fs.existsSync(path.join(m[1] === 'photos' ? photosDir : uploadsDir, m[2]));
};

// Защита от SSRF: не ходим по ссылкам во внутреннюю сеть (localhost, 10.x, 192.168.x, 169.254.x — метаданные облака и т.п.)
const isPrivateIp = (ip) => {
  if (ip.includes(':')) return /^(::1?|fe80|fc|fd|::ffff:(127|10|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};
async function assertPublicUrl(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = require('net').isIP(host) ? [{ address: host }] : await require('dns').promises.lookup(host, { all: true });
  if (!addrs.length || addrs.some((x) => isPrivateIp(x.address))) throw new Error('ссылка ведёт во внутреннюю сеть');
}
async function localizePhoto(id, url) {
  if (!url || isLocalPhoto(url) || !/^https?:\/\//i.test(url) || !PUBLIC_BASE) return false;
  await assertPublicUrl(url);
  const r = await require('axios').get(url, {
    responseType: 'arraybuffer', timeout: 20000, maxContentLength: 15 * 1024 * 1024, maxRedirects: 0,
    headers: { 'User-Agent': 'Mozilla/5.0 (Zerno shop)', Accept: 'image/*' },
  });
  const type = String(r.headers['content-type'] || '');
  if (!type.startsWith('image/')) throw new Error('по ссылке не картинка (' + type + ')');
  const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
  const name = `p${id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, name), Buffer.from(r.data));
  db.prepare('UPDATE products SET photo_url = ? WHERE id = ? AND photo_url = ?').run(`${PUBLIC_BASE}/uploads/${name}`, id, url);
  return true;
}

let localizing = null;
function localizeAllPhotos() {
  if (localizing) return localizing;
  localizing = (async () => {
    const rows = db.prepare('SELECT id, name, photo_url FROM products WHERE photo_url IS NOT NULL').all();
    for (const p of rows) {
      try {
        if (await localizePhoto(p.id, p.photo_url)) console.log(`Фото «${p.name}» сохранено на сервере`);
      } catch (e) {
        console.warn(`Фото «${p.name}» не скачалось: ${e.message}`);
      }
    }
  })().finally(() => { localizing = null; });
  return localizing;
}

// Разовые правки каталога (выполняются один раз — отметка лежит рядом с фото)
function runOnce(key, fn) {
  const mark = path.join(uploadsDir, `.done-${key}`);
  if (fs.existsSync(mark)) return;
  try { fn(); fs.writeFileSync(mark, new Date().toISOString()); } catch (e) { console.error('Разовая правка не прошла:', key, e.message); }
}
// Фото из папки проекта photos/: файл «<id товара>-название.jpg» один раз ставится товару.
// Если потом заменить фото в админке — новое фото не перезапишется при следующем запуске.
if (fs.existsSync(photosDir) && PUBLIC_BASE) {
  for (const file of fs.readdirSync(photosDir)) {
    const m = file.match(/^(\d+)-[\w.-]+\.(jpe?g|png|webp)$/i);
    if (!m) continue;
    runOnce(`photo-${file}`, () => {
      const r = db.prepare('UPDATE products SET photo_url = ? WHERE id = ?').run(`${PUBLIC_BASE}/photos/${file}`, parseInt(m[1], 10));
      if (r.changes) console.log(`Фото из проекта: ${file}`);
    });
  }
}

function startWebhookServer(bot, { showCartFor, aiPick } = {}) {
  const app = express();
  app.set('trust proxy', true); // за прокси Railway — иначе req.protocol всегда 'http'
  app.use(express.json());
  app.use('/uploads', express.static(uploadsDir)); // без авторизации — Telegram должен уметь их скачать
  app.use('/photos', express.static(photosDir, { maxAge: '7d' })); // фото из папки проекта

  // === Витрина (мини-приложение Telegram): /shop + /shop-api ===
  // Покупатель открывает /shop внутри Telegram. Каждый запрос подписан Telegram (initData) —
  // проверяем подпись токеном бота, так что чужую корзину изменить нельзя.
  app.use('/shop', express.static(path.join(__dirname, 'shop-public'), {
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'), // Telegram не держит старую версию витрины
  }));

  function tgUser(req) {
    const raw = req.get('X-Init-Data') || '';
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const data = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const check = crypto.createHmac('sha256', secret).update(data).digest('hex');
    if (check.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 86400) return null; // подпись старше суток
    try { return JSON.parse(params.get('user')); } catch { return null; }
  }
  // простой ограничитель частоты: не больше max запросов за окно на ключ
  const hits = new Map();
  const rateOk = (key, max, windowMs) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((x) => now - x < windowMs);
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return arr.length <= max;
  };
  const shopAuth = (req, res, next) => {
    const user = tgUser(req);
    if (!user || !user.id) return res.status(401).json({ error: 'Откройте магазин из Telegram' });
    req.chatId = user.id; // личный чат с ботом = id пользователя
    if (!rateOk('all:' + user.id, 240, 60000)) return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
    next();
  };
  const cartMap = (chatId) =>
    Object.fromEntries(db.prepare('SELECT product_id, quantity FROM cart_items WHERE chat_id = ?').all(chatId)
      .map((r) => [r.product_id, r.quantity]));

  app.get('/shop-api/catalog', shopAuth, (req, res) => {
    const products = db
      .prepare(`SELECT id, name, name_en, description, description_en, category, category_en, price, stock, photo_url,
                       group_key, option_label, option_label_en, option2_label, option2_label_en, is_addon, addon_for, unit, step, min_qty
                FROM products ORDER BY stock = 0, category, id`)
      .all();
    const parts = db.prepare('SELECT b.bundle_id, p.name, p.name_en, b.qty, p.unit, p.price FROM bundle_items b JOIN products p ON p.id = b.product_id ORDER BY p.name').all();
    // ссылку на фото не отдаём как есть: картинки идут через наш сервер (/shop-photo),
    // иначе часть сайтов-источников не показывает их внутри Telegram
    const list = products.map(({ photo_url, ...p }) => ({
      ...p,
      bundle: parts.filter((x) => x.bundle_id === p.id).map((x) => ({ name: x.name, name_en: x.name_en, qty: x.qty, unit: x.unit, price: x.price })),
      photo: photo_url ? `/shop-photo/${p.id}?v=${crypto.createHash('md5').update(photo_url).digest('hex').slice(0, 8)}` : null,
    }));
    const owner = isOwnerId(req.chatId);
    res.json({ lang: db.getLang(req.chatId), products: list, cart: cartMap(req.chatId), isOwner: owner, unread: owner ? db.unreadTotal() : 0 });
  });

  // Фото товара через наш сервер: скачиваем по ссылке из админки (или с нашего /uploads) и кэшируем в памяти
  const photoCache = new Map(); // id → { url, type, buf }
  app.get('/shop-photo/:id', async (req, res) => {
    const p = db.prepare('SELECT photo_url FROM products WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!p || !p.photo_url) return res.sendStatus(404);
    try {
      let hit = photoCache.get(req.params.id);
      if (!hit || hit.url !== p.photo_url) {
        const local = p.photo_url.match(/\/(uploads|photos)\/([^/?#]+)$/);
        const localPath = local && path.join(local[1] === 'photos' ? photosDir : uploadsDir, local[2]);
        if (localPath && fs.existsSync(localPath)) {
          return res.set('Cache-Control', 'public, max-age=86400').sendFile(localPath);
        }
        let url = p.photo_url;
        if (!/^https?:\/\//i.test(url)) url = await bot.telegram.getFileLink(url).then(String); // file_id из Telegram
        const r = await axios.get(url, {
          responseType: 'arraybuffer', timeout: 10000, maxContentLength: 10 * 1024 * 1024,
          headers: { 'User-Agent': 'Mozilla/5.0 (Zerno shop)', Accept: 'image/*' },
        });
        const type = String(r.headers['content-type'] || '');
        if (!type.startsWith('image/')) throw new Error('не картинка: ' + type);
        hit = { url: p.photo_url, type, buf: Buffer.from(r.data) };
        if (photoCache.size > 200) photoCache.delete(photoCache.keys().next().value);
        photoCache.set(req.params.id, hit);
      }
      res.set({ 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400' }).send(hit.buf);
    } catch (e) {
      console.warn(`Витрина: фото товара #${req.params.id} не загрузилось —`, e.message);
      res.sendStatus(404);
    }
  });

  app.post('/shop-api/cart', shopAuth, (req, res) => {
    const productId = parseInt(req.body.product_id, 10);
    const qty = Math.max(0, parseInt(req.body.qty, 10) || 0);
    const p = db.prepare('SELECT stock, unit, step, min_qty FROM products WHERE id = ?').get(productId);
    if (!p) return res.status(404).json({ error: 'Товар не найден' });
    if (qty > p.stock) return res.status(400).json({ error: 'Больше нет в наличии' });
    if (!qty_.valid(p, qty)) return res.status(400).json({ error: qty_.explain(p, db.getLang(req.chatId)) });
    if (qty === 0) {
      db.prepare('DELETE FROM cart_items WHERE chat_id = ? AND product_id = ?').run(req.chatId, productId);
    } else {
      db.prepare(`INSERT INTO cart_items (chat_id, product_id, quantity) VALUES (?,?,?)
                  ON CONFLICT(chat_id, product_id) DO UPDATE SET quantity = excluded.quantity`).run(req.chatId, productId, qty);
    }
    res.json({ ok: true, cart: cartMap(req.chatId) });
  });

  // Язык интерфейса (переключатель RU/EN в шапке витрины)
  app.post('/shop-api/lang', shopAuth, (req, res) => {
    const lang = req.body.lang === 'en' ? 'en' : 'ru';
    db.setLang(req.chatId, lang);
    res.json({ ok: true, lang });
  });

  // Мои заказы — последние 20 с составом
  app.get('/shop-api/orders', shopAuth, (req, res) => {
    const lang = db.getLang(req.chatId);
    const labels = t(lang, 'orderStatus') || {};
    const itemsStmt = db.prepare(
      `SELECT oi.quantity, oi.price, p.id, p.name, p.name_en, p.unit FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`);
    const list = db
      .prepare('SELECT * FROM orders WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(req.chatId)
      .map((o) => {
        const status = String(o.status || '').split(':')[0];
        return {
          id: o.id,
          code: o.order_code || String(o.id),
          status,
          statusLabel: orders.statusLabel({ base: status, delivery_city: o.delivery_city }, lang) || labels[status] || status,
          step: orders.FLOW.indexOf(status),
          pickup: !o.delivery_city,
          track: o.track || '',
          rating: o.rating || 0,
          can_pay: status === 'awaiting_payment',
          can_subscribe: orders.PAID.has(status) && Boolean(o.delivery_method),
          total: o.total,
          delivery_cost: o.delivery_cost || 0,
          address: o.address || '',
          created_at: o.created_at,
          items: itemsStmt.all(o.id).map((i) => ({
            id: i.id, qty: i.quantity, price: i.price, unit: i.unit,
            name: (lang === 'en' && i.name_en) || i.name || '—',
          })),
        };
      });
    res.json({ orders: list });
  });

  // AI-подбор: совет + id подходящих товаров (не чаще раза в 5 секунд на человека)
  const aiLast = new Map();
  app.post('/shop-api/ai', shopAuth, async (req, res) => {
    const query = String(req.body.query || '').trim().slice(0, 500);
    if (!query) return res.status(400).json({ error: 'Опишите, что нужно подобрать' });
    if (!aiPick) return res.status(503).json({ error: 'AI-подбор сейчас недоступен' });
    if (Date.now() - (aiLast.get(req.chatId) || 0) < 5000) return res.status(429).json({ error: 'Секунду, ещё думаю над прошлым запросом' });
    aiLast.set(req.chatId, Date.now());
    try {
      const lang = db.getLang(req.chatId);
      const { adviceText, productIds } = await aiPick(query, lang);
      res.json({ advice: adviceText, ids: productIds });
    } catch (e) {
      console.error('Витрина: AI-подбор не ответил', e.response?.data || e.message);
      res.status(502).json({ error: t(db.getLang(req.chatId), 'aiError') });
    }
  });

  // ===== Админка внутри витрины — только для владелицы (OWNER_CHAT_ID), без пароля:
  // Telegram сам подписывает, кто открыл приложение =====
  const isOwnerId = (id) => Boolean(process.env.OWNER_CHAT_ID) && String(id) === String(process.env.OWNER_CHAT_ID);
  const ownerOnly = (req, res, next) => (isOwnerId(req.chatId) ? next() : res.status(403).json({ error: 'Только для владелицы' }));
  const adm = [shopAuth, ownerOnly];
  // CRM управляет каталогом по общему секрету (тот же CRM_SECRET, что и для заказов). Только маршруты товаров.
  const crmOrTg = (req, res, next) => {
    const given = req.get('x-webhook-secret');
    if (!given) return shopAuth(req, res, next);
    const want = process.env.CRM_SECRET || '';
    const a = Buffer.from(given), b = Buffer.from(want);
    if (!want || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Неверный секрет' });
    req.chatId = process.env.OWNER_CHAT_ID;
    next();
  };
  const admP = [crmOrTg, ownerOnly];
  const toKop = (v) => Math.round(parseFloat(String(v).replace(',', '.').replace(/\s/g, '')) * 100);
  const BADREQ = (m) => Object.assign(new Error(m), { expose: true });
  const cleanProduct = (b) => {
    const unit = b.unit === 'ml' ? 'ml' : (b.unit === 'g' || b.sold_by_weight === true) ? 'g' : null, weight = Boolean(unit);
    const p = {
      name: String(b.name || '').trim().slice(0, 120),
      description: String(b.description || '').trim().slice(0, 1000),
      stock: Math.max(0, parseInt(b.stock, 10) || 0),
      category: String(b.category || '').trim().slice(0, 60) || null,
      name_en: String(b.name_en || '').trim().slice(0, 120) || null,
      description_en: String(b.description_en || '').trim().slice(0, 1000) || null,
      category_en: String(b.category_en || '').trim().slice(0, 60) || null,
      unit, step: 1, min_qty: 1,
      is_addon: b.is_addon ? 1 : 0,
      addon_for: b.is_addon ? (String(b.addon_for || '*').trim().slice(0, 300) || '*') : null,
    };
    if (weight) {
      // цена вводится за 100 г в целых рублях: тогда цена за грамм — целое число копеек и копейки в заказе не теряются
      const per100 = parseFloat(String(b.price).replace(',', '.'));
      if (!(per100 > 0) || !Number.isInteger(per100)) throw BADREQ('Цена за 100 г (или 100 мл) — целое число рублей');
      p.price = per100;
      p.step = Math.max(1, Math.min(1000, parseInt(b.step, 10) || 50));
      p.min_qty = Math.max(1, Math.min(100000, parseInt(b.min_qty, 10) || 100));
      if (p.min_qty % p.step) throw BADREQ('Минимум должен делиться на шаг (например, шаг 50 г, минимум 100 г)');
    } else p.price = toKop(b.price);
    // варианты: в базе название хранится целиком «База · вариант · вариант2», чтобы корзина и заказы показывали его как есть
    const opt = String(b.option_label || '').trim().slice(0, 40), optEn = String(b.option_label_en || '').trim().slice(0, 40);
    const opt2 = String(b.option2_label || '').trim().slice(0, 40), opt2En = String(b.option2_label_en || '').trim().slice(0, 40);
    if (opt2 && !opt) throw BADREQ('Сначала заполните первый вариант (например, вес), потом второй (например, упаковку)');
    if (opt) {
      const tail = [opt, opt2].filter(Boolean).join(' · '), tailEn = [optEn || opt, opt2 ? (opt2En || opt2) : ''].filter(Boolean).join(' · ');
      p.group_key = p.name;
      p.option_label = opt; p.option_label_en = optEn || null;
      p.option2_label = opt2 || null; p.option2_label_en = opt2En || null;
      p.name = `${p.name} · ${tail}`.slice(0, 160);
      p.name_en = p.name_en ? `${p.name_en} · ${tailEn}`.slice(0, 160) : null;
    } else { p.group_key = null; p.option_label = null; p.option_label_en = null; p.option2_label = null; p.option2_label_en = null; }
    if (!p.name) throw new Error('Укажите название');
    if (!(p.price > 0)) throw new Error('Укажите цену');
    if (p.is_addon && Array.isArray(b.bundle) && b.bundle.length) throw BADREQ('Доп не может быть набором');
    return p;
  };
  const COLS_SQL = `name=@name, description=@description, price=@price, category=@category, name_en=@name_en, description_en=@description_en, category_en=@category_en,
                    group_key=@group_key, option_label=@option_label, option_label_en=@option_label_en, option2_label=@option2_label, option2_label_en=@option2_label_en,
                    unit=@unit, step=@step, min_qty=@min_qty, is_addon=@is_addon, addon_for=@addon_for`;
  const sendAdmErr = (res, e) => res.status(400).json({ error: e.message });

  app.get('/shop-api/admin/products', ...admP, (req, res) => {
    const rows = db.prepare('SELECT * FROM products ORDER BY is_addon, category, id').all();
    res.json({ products: rows.map(({ photo_url, ...p }) => ({ ...p, has_photo: Boolean(photo_url), bundle: inv.bundleOf(p.id), is_bundle: inv.isBundle(p.id),
      photo: photo_url ? `/shop-photo/${p.id}?v=${crypto.createHash('md5').update(photo_url).digest('hex').slice(0, 8)}` : null })) });
  });

  app.post('/shop-api/admin/products', ...admP, (req, res) => {
    try {
      const p = cleanProduct(req.body);
      const id = db.transaction(() => {
        const r = db.prepare(`INSERT INTO products (name, description, price, stock, category, name_en, description_en, category_en, group_key, option_label, option_label_en,
                              option2_label, option2_label_en, unit, step, min_qty, is_addon, addon_for)
                              VALUES (@name, @description, @price, 0, @category, @name_en, @description_en, @category_en, @group_key, @option_label, @option_label_en,
                              @option2_label, @option2_label_en, @unit, @step, @min_qty, @is_addon, @addon_for)`).run(p);
        const nid = Number(r.lastInsertRowid);
        if (Array.isArray(req.body.bundle) && req.body.bundle.length) inv.setBundle(nid, req.body.bundle);
        else inv.setStock(nid, p.stock, 'добавлен в админке');
        return nid;
      })();
      res.json({ ok: true, id });
    } catch (e) { sendAdmErr(res, e); }
  });

  app.post('/shop-api/admin/products/:id', ...admP, (req, res) => {
    try {
      const p = cleanProduct(req.body), id = parseInt(req.params.id, 10);
      db.transaction(() => {
        const r = db.prepare(`UPDATE products SET ${COLS_SQL} WHERE id=@id`).run({ ...p, id });
        if (!r.changes) throw Object.assign(new Error('Товар не найден'), { notFound: true });
        if (Array.isArray(req.body.bundle)) inv.setBundle(id, req.body.bundle);       // пустой список снимает «набор»
        if (!inv.isBundle(id)) inv.setStock(id, p.stock, 'правка в админке');          // остаток набора считается по составу
      })();
      checkLowStock(bot);
      res.json({ ok: true });
    } catch (e) { res.status(e.notFound ? 404 : 400).json({ error: e.message }); }
  });

  // Изменение остатков по названию товара: {changes:[{name, delta}]}, delta<0 — списать, >0 — вернуть.
  // Всё или ничего: если хоть одной позиции не хватает, ничего не меняем. Наборы меняются через состав.
  app.post('/shop-api/admin/stock-delta', ...admP, (req, res) => {
    const list = Array.isArray(req.body.changes) ? req.body.changes.slice(0, 100) : [];
    const find = db.prepare('SELECT id, name, stock FROM products WHERE name = ?');
    try {
      const out = db.transaction(() => {
        const applied = [], unknown = [];
        for (const c of list) {
          const delta = parseInt(c.delta, 10), name = String(c.name || '');
          if (!delta) continue;
          const p = find.get(name);
          if (!p) { unknown.push(name); continue; }
          if (inv.isBundle(p.id)) throw new Error(`«${p.name}» — набор: его остаток считается по составу`);
          const next = p.stock + delta;
          if (next < 0) throw new Error(`Недостаточно на складе: ${p.name} (есть ${p.stock}, нужно ${-delta})`);
          inv.setStock(p.id, next, 'CRM / ручная правка');
          applied.push({ name: p.name, from: p.stock, to: next });
        }
        return { applied, unknown };
      })();
      if (out.applied.length) checkLowStock(bot);
      res.json({ ok: true, ...out });
    } catch (e) { res.status(409).json({ error: e.message }); }
  });

  // Отчёт: присылаем владелице в чат (текст + при file=true подробный Excel)
  app.post('/shop-api/admin/report', ...adm, async (req, res) => {
    try {
      const days = Math.min(366, Math.max(1, parseInt(req.body.days, 10) || 30));
      const rep = require('./reports');
      await bot.telegram.sendMessage(process.env.OWNER_CHAT_ID, rep.text(days));
      if (req.body.file) await bot.telegram.sendDocument(process.env.OWNER_CHAT_ID, { source: await rep.xlsx(days), filename: `otchet-${days}d.xlsx` });
      res.json({ ok: true });
    } catch (e) { console.error('Отчёт:', e.message); res.status(500).json({ error: 'Не получилось отправить отчёт' }); }
  });

  app.post('/shop-api/admin/products/:id/delete', ...admP, (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.transaction(() => {
      db.prepare('DELETE FROM cart_items WHERE product_id = ?').run(id);
      db.prepare('DELETE FROM bundle_items WHERE bundle_id = ? OR product_id = ?').run(id, id);
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
      inv.syncBundles();
    })();
    res.json({ ok: true });
  });

  // Фото с телефона: приходит готовый JPEG (витрина сама уменьшает его до 1600 px)
  app.post('/shop-api/admin/products/:id/photo', express.raw({ type: 'image/*', limit: '10mb' }), ...adm, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: 'Товар не найден' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'Файл не получен' });
    const ext = /png/.test(req.get('content-type')) ? '.png' : /webp/.test(req.get('content-type')) ? '.webp' : '.jpg';
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    fs.writeFileSync(path.join(uploadsDir, name), req.body);
    const url = `${req.protocol}://${req.get('host')}/uploads/${name}`;
    db.prepare('UPDATE products SET photo_url = ? WHERE id = ?').run(url, id);
    photoCache.delete(String(id));
    res.json({ ok: true });
  });

  // Фото по ссылке (https), например из генератора картинок — сервер сам скачает и покажет
  app.post('/shop-api/admin/products/:id/photo-url', ...admP, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const url = String(req.body.url || '').trim();
    if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 1000) return res.status(400).json({ error: 'Нужна ссылка, начинающаяся с https://' });
    const r = db.prepare('UPDATE products SET photo_url = ? WHERE id = ?').run(url, id);
    if (!r.changes) return res.status(404).json({ error: 'Товар не найден' });
    photoCache.delete(String(id));
    localizeAllPhotos()
      .then(() => res.json({ ok: true, local: isLocalPhoto(db.prepare('SELECT photo_url FROM products WHERE id = ?').get(id).photo_url) }))
      .catch(() => res.json({ ok: true, local: false }));
  });

  // Резервная копия: бот присылает владелице ZIP в чат (каталог, заказы, промокоды, доставка, фото)
  app.post('/shop-api/admin/backup', ...adm, async (req, res) => {
    try {
      const { makeBackup } = require('./backup');
      const b = makeBackup({ uploadsDir, photosDir });
      await bot.telegram.sendDocument(req.chatId, { source: b.buffer, filename: b.filename },
        { caption: `📦 Резервная копия магазина\nФото: ${b.photos} · заказы и каталог — в Excel-файлах внутри.\nХраните у себя: там адреса покупателей.` });
      res.json({ ok: true, size: b.buffer.length });
    } catch (e) {
      console.error('Резервная копия:', e.message);
      res.status(500).json({ error: 'Не получилось собрать копию' });
    }
  });

  app.get('/shop-api/admin/orders', ...adm, (req, res) => {
    const itemsStmt = db.prepare(`SELECT oi.quantity, oi.price, p.name, p.unit FROM order_items oi
                                  LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`);
    const list = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 150').all().map((o) => ({
      id: o.id, code: o.order_code || String(o.id), status: String(o.status || '').split(':')[0],
      total: o.total, delivery_cost: o.delivery_cost || 0, created_at: o.created_at,
      address: String(o.address || '').replace(/ · тел\..*$/, ''), phone: orders.phoneOf(o),
      pickup: !o.delivery_city, track: o.track || '', rating: o.rating || 0, was_paid: Boolean(o.paid_at),
      promo: o.promo_code || '', discount: o.discount_percent || 0,
      buyer: db.getName(o.chat_id) || '', chat_id: o.chat_id,
      items: itemsStmt.all(o.id).map((i) => ({ name: i.name || '—', qty: i.quantity, price: i.price, unit: i.unit })),
    }));
    res.json({ orders: list });
  });

  app.post('/shop-api/admin/orders/:id/status', ...adm, async (req, res) => {
    const status = String(req.body.status || '');
    if (!orders.PAID.has(status) && status !== 'cancelled') return res.status(400).json({ error: 'Неизвестный статус' });
    try {
      const o = await orders.changeStatus(bot, parseInt(req.params.id, 10), status,
        req.body.track !== undefined ? { track: req.body.track } : {});
      res.json({ ok: true, status: o.base, track: o.track || '' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // статистика, чаты, доставка, промокоды
  require('./admin-api')(app, { bot, adm });

  // ===== Оформление и оплата прямо в витрине =====
  // Всё считаем на сервере: цены — из базы, доставка — из тарифов, скидка — из промокода.
  const { createPendingOrder } = require('./scenes/checkout');
  const pricing = require('./pricing');
  const { getCart } = require('./cart');

  const delivery = require('./delivery');
  const core = require('./checkout-core');
  const receipt = require('./payments/receipt');
  const subs = require('./subscriptions');
  const { startPayment } = require('./payments/start');
  const sendErr = (res, e, fallback = 'Что-то пошло не так, попробуйте ещё раз') => res.status(e.expose ? 400 : 500).json({ error: e.expose ? e.message : fallback });

  app.get('/shop-api/checkout-info', shopAuth, (req, res) => {
    const cities = db.prepare('SELECT city, city_en, price FROM delivery_rates WHERE active = 1 ORDER BY city').all();
    const ds = db.getDeliverySettings(), d2 = delivery.get();
    res.json({ cities, otherPrice: ds.otherPrice, freeFrom: ds.freeFrom, pickup: ds.pickup, pickupAddress: ds.pickupAddress,
      payOnline: Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY),
      post: d2.post.enabled ? { carriers: d2.post.carriers.map(({ id, name, price }) => ({ id, name, price })) } : null,
      distance: d2.distance.enabled && d2.distance.origin.lat != null ? { maxKm: Math.max(...d2.distance.tiers.map((t) => t.km)), tiers: d2.distance.tiers } : null,
      receipts: receipt.enabled(),
      contact: db.prepare('SELECT contact FROM user_settings WHERE chat_id = ?').get(req.chatId)?.contact || '' });
  });

  // Живой расчёт доставки для витрины (нужен для «по расстоянию»; остальное считается на месте)
  const quoteBusy = new Map();
  app.post('/shop-api/delivery-quote', shopAuth, async (req, res) => {
    const last = quoteBusy.get(req.chatId) || 0;
    if (Date.now() - last < 1000) return res.status(429).json({ error: 'Секунду…' });
    quoteBusy.set(req.chatId, Date.now());
    if (quoteBusy.size > 1000) quoteBusy.clear();
    try {
      const b = req.body || {};
      const { total } = getCart(req.chatId);
      let promo = { percent: 0 };
      try { promo = findPromo(b.promo); } catch { /* неверный промокод на цену доставки не влияет */ }
      const r = await core.resolve({ method: b.delivery, city: b.city, carrier: b.carrier, addr: b.address }, total, promo.percent, db.getLang(req.chatId));
      res.json({ ok: true, delivery: r.delivery, km: r.km || null, total: r.total });
    } catch (e) { sendErr(res, e, 'Не получилось рассчитать доставку'); }
  });

  const findPromo = pricing.findPromo;
  app.post('/shop-api/promo', shopAuth, (req, res) => {
    if (!rateOk('promo:' + req.chatId, 12, 60000)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' }); // защита от подбора кодов
    try { res.json({ ok: true, ...findPromo(req.body.code) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  const orderBusy = new Set(); // защита от двойного нажатия «Оплатить»
  app.post('/shop-api/order', shopAuth, async (req, res) => {
    const chatId = req.chatId;
    if (orderBusy.has(chatId)) return res.status(429).json({ error: 'Секунду, оформляем…' });
    orderBusy.add(chatId);
    let orderId = null;
    try {
      const lang = db.getLang(chatId);
      const b = req.body || {};
      const { items, total } = getCart(chatId);
      if (!items.length) return res.status(400).json({ error: 'Корзина пуста' });
      for (const i of items) {
        if (i.stock < i.quantity) return res.status(400).json({ error: t(lang, 'insufficientStock', (lang === 'en' && i.name_en) || i.name, i.stock) });
      }
      // контакт: телефон и/или e-mail; для чека 54-ФЗ нужен хотя бы один корректный
      const phone = String(b.phone || '').trim().slice(0, 30), email = String(b.email || '').trim().slice(0, 80);
      if (phone && phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Проверьте номер телефона' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Проверьте e-mail' });
      const contact = [phone, email].filter(Boolean).join(' ') || null;
      if (receipt.enabled() && !receipt.contactFrom(contact)) return res.status(400).json({ error: 'Для чека укажите телефон или e-mail' });
      let promo;
      try { promo = findPromo(b.promo); } catch (e) { rateOk('promo:' + chatId, 12, 60000); return res.status(400).json({ error: e.message }); }
      const rs = await core.resolve({ method: b.delivery, city: b.city, carrier: b.carrier, addr: b.address }, total, promo.percent, lang);
      const address = phone ? `${rs.address} · тел. ${phone}` : rs.address;

      orderId = createPendingOrder(chatId, address, 'yookassa', rs.total, promo.code, promo.percent, rs.deliveryCity, rs.delivery, rs.method, contact,
        { carrier: rs.carrier, addrRaw: rs.addrRaw });
      const code = db.prepare('SELECT order_code FROM orders WHERE id = ?').get(orderId).order_code || String(orderId);
      const payment = await startPayment(orderId);
      db.prepare('DELETE FROM cart_items WHERE chat_id = ?').run(chatId); // корзина превратилась в заказ
      if (contact) db.prepare(`INSERT INTO user_settings (chat_id, lang, contact) VALUES (?, ?, ?)
                               ON CONFLICT(chat_id) DO UPDATE SET contact = excluded.contact`).run(chatId, lang, contact);
      const url = payment.confirmation.confirmation_url;
      // ссылка на оплату — ещё и в чат, чтобы не потерялась
      bot.telegram.sendMessage(chatId, t(lang, 'payLinkText', code), {
        reply_markup: { inline_keyboard: [[{ text: t(lang, 'payUrlButton'), url }]] },
      }).catch(() => {});
      res.json({ ok: true, id: orderId, code, total: rs.total, pay_url: url });
    } catch (e) {
      if (orderId) db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND payment_id IS NULL").run(orderId); // оплата не создалась — заказ не висит
      if (e.expose) return res.status(400).json({ error: e.message });
      console.error('Витрина: не удалось оформить заказ', e.response?.data || e.message);
      res.status(502).json({ error: 'Не получилось создать оплату. Попробуйте ещё раз через минуту' });
    } finally {
      orderBusy.delete(chatId);
    }
  });

  // ===== Повторить заказ и подписки =====
  app.post('/shop-api/orders/:id/repeat', shopAuth, (req, res) => { // собрать корзину из прошлого заказа
    const o = db.prepare('SELECT id FROM orders WHERE id = ? AND chat_id = ?').get(parseInt(req.params.id, 10), req.chatId);
    if (!o) return res.status(404).json({ error: 'Заказ не найден' });
    const its = db.prepare(`SELECT oi.product_id, oi.quantity, p.stock FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(o.id);
    let added = 0, missing = 0;
    for (const i of its) {
      const q = Math.min(i.quantity, i.stock);
      if (q <= 0) { missing++; continue; }
      if (q < i.quantity) missing++;
      db.prepare(`INSERT INTO cart_items (chat_id, product_id, quantity) VALUES (?,?,?)
                  ON CONFLICT(chat_id, product_id) DO UPDATE SET quantity = excluded.quantity`).run(req.chatId, i.product_id, q);
      added++;
    }
    res.json({ ok: true, added, missing, cart: cartMap(req.chatId) });
  });
  app.get('/shop-api/subscriptions', shopAuth, (req, res) => res.json({ subscriptions: subs.list(req.chatId, db.getLang(req.chatId)), intervals: subs.INTERVALS }));
  app.post('/shop-api/subscriptions', shopAuth, (req, res) => {
    try { res.json({ ok: true, id: subs.create(req.chatId, parseInt(req.body.order_id, 10), parseInt(req.body.days, 10)) }); } catch (e) { sendErr(res, e); }
  });
  app.post('/shop-api/subscriptions/:id', shopAuth, (req, res) => {
    try { subs.update(req.chatId, parseInt(req.params.id, 10), { action: String(req.body.action || ''), days: parseInt(req.body.days, 10) }); res.json({ ok: true }); } catch (e) { sendErr(res, e); }
  });

  // Ссылка «Оплатить» для заказа, который ещё ждёт оплату
  app.post('/shop-api/orders/:id/pay', shopAuth, async (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND chat_id = ?').get(parseInt(req.params.id, 10), req.chatId);
    const payId = o && String(o.status || '').startsWith('awaiting_payment:') ? o.status.split(':')[1] : null;
    if (!payId) return res.status(404).json({ error: 'Этот заказ уже не ждёт оплату' });
    try {
      const p = await getPayment(payId);
      if (p.status !== 'pending' || !p.confirmation?.confirmation_url) return res.status(410).json({ error: 'Ссылка на оплату устарела — оформите заказ заново' });
      res.json({ pay_url: p.confirmation.confirmation_url });
    } catch (e) { res.status(502).json({ error: 'ЮKassa не ответила, попробуйте ещё раз' }); }
  });

  // «Оформить» в витрине → бот присылает корзину с кнопкой оформления в чат
  app.post('/shop-api/checkout', shopAuth, async (req, res) => {
    try {
      if (showCartFor) await showCartFor(req.chatId);
      res.json({ ok: true });
    } catch (e) {
      console.error('Витрина: не удалось отправить корзину', e.message);
      res.status(500).json({ error: 'Не получилось, попробуйте ещё раз' });
    }
  });

  // === Вебхук ЮKassa (без авторизации — вызывается самой ЮKassa) ===
  app.post('/yookassa-webhook', async (req, res) => {
    const event = req.body;

    if (event && event.event === 'payment.succeeded' && event.object && event.object.id) {
      // Не верим уведомлению «на слово»: переспрашиваем платёж у самой ЮKassa.
      // Иначе кто угодно мог бы отправить сюда поддельный «оплачено».
      let payment;
      try {
        payment = await getPayment(event.object.id);
      } catch (e) {
        console.error('ЮKassa: не удалось проверить платёж', e.message);
        return res.sendStatus(500); // ЮKassa повторит уведомление позже
      }
      if (payment.status !== 'succeeded') return res.sendStatus(200);
      // Платёж другого бота (тот же магазин ЮKassa, например «Флёр») — не наш, пропускаем
      const app = payment.metadata && payment.metadata.app;
      if (app && app !== 'zernobot') return res.sendStatus(200);
      // Деньги уже (частично) вернули — повтор уведомления заказ не «оживляет»
      if (parseFloat(payment.refunded_amount?.value || 0) > 0) return res.sendStatus(200);

      const orderId = parseInt(payment.metadata && payment.metadata.order_id, 10);
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order || orders.PAID.has(orders.base(order.status))) return res.sendStatus(200); // защита от дублей
      // Сумма платежа должна совпасть с суммой заказа (в копейках)
      if (Math.round(parseFloat(payment.amount.value) * 100) !== order.total) {
        console.warn(`ЮKassa: сумма платежа ${payment.amount.value} не совпадает с заказом #${orderId}`);
        return res.sendStatus(200);
      }

      try {
        // статус, склад, промокод, сообщения покупателю и владелице; чужой/повторный платёж не засчитается
        if (!(await orders.markPaid(bot, orderId, payment.id))) console.warn(`ЮKassa: платёж ${payment.id} не засчитан заказу #${orderId} (повтор или чужой)`);
        checkLowStock(bot);
      } catch (e) {
        console.error('ЮKassa: оплата получена, но обработка заказа упала', e.message);
        return res.sendStatus(500);
      }
    }

    res.sendStatus(200);
  });

  // Старая веб-админка (/admin, /api) отключена: вся админка теперь внутри магазина в Telegram,
  // где доступ проверяется подписью Telegram, а не паролем.
  app.all(['/admin', '/admin/*', '/api', '/api/*'], (req, res) => res.sendStatus(404));

  // при старте и раз в 6 часов проверяем, что все фото лежат у нас
  setTimeout(localizeAllPhotos, 5000);
  setInterval(localizeAllPhotos, 6 * 3600 * 1000);

  const port = process.env.WEBHOOK_PORT || 3001;
  app.listen(port, () =>
    console.log(`Вебхук ЮKassa и веб-админка слушают порт ${port} (/admin)`)
  );
}

module.exports = { startWebhookServer , assertPublicUrl };
