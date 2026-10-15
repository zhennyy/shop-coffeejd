// Общие форматтеры для текстов бота и уведомлений: деньги и экранирование HTML для Telegram (parse_mode: 'HTML')

// 123456 копеек → «1 235 ₽» (округляем до рубля, тысячи через пробел)
const formatRubles = (kopecks) => Math.round(kopecks / 100).toLocaleString('ru-RU') + ' ₽';

// 123456 копеек → «1235 ₽» — без разделителя тысяч (сводка оформления заказа в чате)
const formatRublesPlain = (kopecks) => (kopecks / 100).toFixed(0) + ' ₽';

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

// Экранирует & < > и кавычку. null/undefined → '', а 0 остаётся «0».
// Для уведомлений о заказах и переписки с покупателями.
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"]/g, (character) => HTML_ENTITIES[character]);

// Экранирует только & < > (кавычки в тексте сообщения Telegram не мешают). Любое «пустое» значение,
// в том числе 0 и false, превращается в ''. Для каталога, корзины и команд владельца в боте.
const escapeHtmlText = (text) => String(text || '').replace(/[&<>]/g, (character) => HTML_ENTITIES[character]);

module.exports = { formatRubles, formatRublesPlain, escapeHtml, escapeHtmlText };
