// Владелец магазина: OWNER_CHAT_ID из .env — ему приходят заказы и сообщения покупателей, ему открыта админка
const getOwnerId = () => process.env.OWNER_CHAT_ID || null;
const isOwner = (chatId) => Boolean(getOwnerId()) && String(chatId) === String(getOwnerId());

module.exports = { getOwnerId, isOwner };
