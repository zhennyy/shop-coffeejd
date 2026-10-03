// qty.js — количество товара: штуки или граммы (продажа на вес). Единые правила проверки и текст для чата, заказов и чеков.
const isWeight = (p) => Boolean(p) && p.unit === 'g';

// Подходит ли количество q для товара p (0 допустимо — убрать из корзины)
function valid(p, q) {
  if (!Number.isInteger(q) || q < 0) return false;
  if (q === 0) return true;
  if (!isWeight(p)) return true;
  const step = Math.max(1, p.step || 1), min = Math.max(1, p.min_qty || 1);
  return q >= min && q % step === 0;
}
const explain = (p, lang = 'ru') => {
  const step = Math.max(1, p.step || 1), min = Math.max(1, p.min_qty || 1);
  return lang === 'en' ? `Weight: from ${min} g in steps of ${step} g` : `Вес: от ${min} г с шагом ${step} г`;
};
// «300 г» или «2»
const fmt = (p, q, lang = 'ru') => (isWeight(p) ? `${q} ${lang === 'en' ? 'g' : 'г'}` : String(q));
// строка заказа: «Эфиопия × 2» или «Эфиопия, 300 г»
const line = (p, q, lang = 'ru') => `${(lang === 'en' && p.name_en) || p.name}${isWeight(p) ? ', ' + fmt(p, q, lang) : ' × ' + q}`;
// для чека и CRM: весовой товар — одна позиция с итоговой суммой (иначе пришлось бы дробить копейки за грамм)
const asUnit = (p, q, price) => (isWeight(p) ? { name: `${p.name}, ${q} г`, quantity: 1, price: price * q } : { name: p.name, quantity: q, price });

module.exports = { isWeight, valid, explain, fmt, line, asUnit };
