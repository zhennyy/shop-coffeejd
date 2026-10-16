-- 152-ФЗ: когда покупатель дал согласие на обработку персональных данных.
-- Формат как у остальных дат в базе: «YYYY-MM-DD HH:MM:SS» (UTC). У старых заказов и подписок — NULL.
ALTER TABLE orders ADD COLUMN consent_at TEXT;
ALTER TABLE subscriptions ADD COLUMN consent_at TEXT;
