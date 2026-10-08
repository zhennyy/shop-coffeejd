-- Базовая схема: таблицы в том виде, в каком они были до перехода на Prisma.
-- На уже работающей базе ничего не меняет (CREATE ... IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  photo_url TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  name_en TEXT,
  description_en TEXT,
  category_en TEXT,
  group_key TEXT,
  option_label TEXT,
  option_label_en TEXT,
  option2_label TEXT,
  option2_label_en TEXT,
  is_addon INTEGER NOT NULL DEFAULT 0,
  addon_for TEXT,
  unit TEXT,
  step INTEGER NOT NULL DEFAULT 1,
  min_qty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cart_items (
  chat_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (chat_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total INTEGER NOT NULL,
  address TEXT,
  payment_provider TEXT,
  order_code TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  promo_code TEXT,
  discount_percent INTEGER NOT NULL DEFAULT 0,
  delivery_city TEXT,
  delivery_cost INTEGER NOT NULL DEFAULT 0,
  delivery_method TEXT,
  contact TEXT,
  carrier TEXT,
  addr_raw TEXT,
  track TEXT,
  rating INTEGER,
  status_at TEXT,
  status_msg_id INTEGER,
  payment_id TEXT,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL,
  stock_taken INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  discount_percent INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL UNIQUE COLLATE NOCASE,
  city_en TEXT,
  price INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
  chat_id INTEGER PRIMARY KEY,
  lang TEXT NOT NULL DEFAULT 'ru',
  name TEXT,
  contact TEXT
);

CREATE TABLE IF NOT EXISTS bundle_items (
  bundle_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bundle_id, product_id)
);

CREATE TABLE IF NOT EXISTS stock_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  product_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  order_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stock_log_ts ON stock_log (ts);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  items TEXT NOT NULL,
  interval_days INTEGER NOT NULL,
  next_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  delivery_method TEXT,
  delivery_city TEXT,
  carrier TEXT,
  address TEXT,
  contact TEXT,
  last_order_id INTEGER,
  postponed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions (active, next_date);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  from_owner INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  photo TEXT,
  owner_msg_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, id);
