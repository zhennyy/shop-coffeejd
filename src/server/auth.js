// Кто делает запрос к витрине: покупатель (подпись Telegram), владелица или CRM (общий секрет)
const crypto = require('node:crypto');

const INIT_DATA_MAX_AGE_SECONDS = 86400; // подпись старше суток не принимаем
const REQUESTS_PER_MINUTE = 240;
const ONE_MINUTE_MS = 60000;
const MAX_TRACKED_KEYS = 5000;

const isOwnerChat = (chatId) => Boolean(process.env.OWNER_CHAT_ID) && String(chatId) === String(process.env.OWNER_CHAT_ID);

// Пользователь Telegram из заголовка X-Init-Data, если подпись верна (проверяем токеном бота)
function verifyTelegramUser(request) {
  const initData = new URLSearchParams(request.get('X-Init-Data') || '');
  const receivedHash = initData.get('hash');
  if (!receivedHash) return null;
  initData.delete('hash');
  const dataCheckString = [...initData.entries()].map(([fieldName, fieldValue]) => `${fieldName}=${fieldValue}`).sort().join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (expectedHash.length !== receivedHash.length || !crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(receivedHash))) return null;
  if (Date.now() / 1000 - Number(initData.get('auth_date') || 0) > INIT_DATA_MAX_AGE_SECONDS) return null;
  try {
    return JSON.parse(initData.get('user'));
  } catch {
    return null;
  }
}

// Простой ограничитель частоты: не больше maxRequests за окно windowMs на ключ
function createRateLimiter() {
  const requestTimesByKey = new Map();
  return function isAllowed(key, maxRequests, windowMs) {
    const now = Date.now();
    const recentRequests = (requestTimesByKey.get(key) || []).filter((requestTime) => now - requestTime < windowMs);
    recentRequests.push(now);
    requestTimesByKey.set(key, recentRequests);
    if (requestTimesByKey.size > MAX_TRACKED_KEYS) {
      for (const [trackedKey, requestTimes] of requestTimesByKey) {
        if (!requestTimes.length || now - requestTimes[requestTimes.length - 1] > windowMs) requestTimesByKey.delete(trackedKey);
      }
    }
    return recentRequests.length <= maxRequests;
  };
}

function createAuthMiddlewares(isRequestAllowed) {
  // Покупатель из Telegram: req.chatId = id пользователя (личный чат с ботом)
  const shopAuth = (request, response, next) => {
    const telegramUser = verifyTelegramUser(request);
    if (!telegramUser || !telegramUser.id) return response.status(401).json({ error: 'Откройте магазин из Telegram' });
    request.chatId = telegramUser.id;
    if (!isRequestAllowed('all:' + telegramUser.id, REQUESTS_PER_MINUTE, ONE_MINUTE_MS)) return response.status(429).json({ error: 'Слишком часто, подождите минуту' });
    return next();
  };
  const ownerOnly = (request, response, next) => (isOwnerChat(request.chatId) ? next() : response.status(403).json({ error: 'Только для владелицы' }));
  // CRM управляет каталогом по общему секрету (тот же CRM_SECRET, что и для заказов). Только маршруты товаров.
  const crmOrTelegram = (request, response, next) => {
    const givenSecret = request.get('x-webhook-secret');
    if (!givenSecret) return shopAuth(request, response, next);
    const expectedSecret = process.env.CRM_SECRET || '';
    const givenBuffer = Buffer.from(givenSecret);
    const expectedBuffer = Buffer.from(expectedSecret);
    if (!expectedSecret || givenBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(givenBuffer, expectedBuffer)) {
      return response.status(401).json({ error: 'Неверный секрет' });
    }
    request.chatId = process.env.OWNER_CHAT_ID;
    return next();
  };
  return {
    shopAuth,
    ownerOnly,
    ownerAuth: [shopAuth, ownerOnly],               // админка: только владелица из Telegram
    catalogAdminAuth: [crmOrTelegram, ownerOnly],   // товары: владелица или CRM
  };
}

module.exports = { isOwnerChat, verifyTelegramUser, createRateLimiter, createAuthMiddlewares };
