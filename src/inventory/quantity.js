// Количество товара: штуки или граммы/миллилитры (продажа на вес и на объём).
// Единые правила проверки и текст для чата, заказов и чеков.
// На вес/объём: количество — целое число единиц, price — копеек за 1 единицу.
const UNITS = { g: { ru: 'г', en: 'g' }, ml: { ru: 'мл', en: 'ml' } };

const isWeight = (product) => Boolean(product) && Object.hasOwn(UNITS, product.unit);
const unitLabel = (product, language = 'ru') => (isWeight(product) ? UNITS[product.unit][language === 'en' ? 'en' : 'ru'] : '');
const stepOf = (product) => Math.max(1, product.step || 1);
const minimumOf = (product) => Math.max(1, product.min_qty || 1);

// Подходит ли количество для товара (0 допустимо — убрать из корзины)
function isValidQuantity(product, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) return false;
  if (quantity === 0 || !isWeight(product)) return true;
  return quantity >= minimumOf(product) && quantity % stepOf(product) === 0;
}

function explainQuantityRules(product, language = 'ru') {
  const unit = unitLabel(product, language);
  return language === 'en'
    ? `Amount: from ${minimumOf(product)} ${unit} in steps of ${stepOf(product)} ${unit}`
    : `Количество: от ${minimumOf(product)} ${unit} с шагом ${stepOf(product)} ${unit}`;
}

// «300 г» или «2»
const formatQuantity = (product, quantity, language = 'ru') => (isWeight(product) ? `${quantity} ${unitLabel(product, language)}` : String(quantity));

// Строка заказа: «Эфиопия × 2» или «Эфиопия, 300 г»
const formatOrderLine = (product, quantity, language = 'ru') =>
  `${(language === 'en' && product.name_en) || product.name}${isWeight(product) ? ', ' + formatQuantity(product, quantity, language) : ' × ' + quantity}`;

// Для чека и CRM: весовой товар — одна позиция с итоговой суммой (иначе пришлось бы дробить копейки за грамм)
const asReceiptLine = (product, quantity, price) =>
  isWeight(product)
    ? { name: `${product.name}, ${quantity} ${unitLabel(product)}`, quantity: 1, price: price * quantity }
    : { name: product.name, quantity, price };

module.exports = { UNITS, unitLabel, isWeight, isValidQuantity, explainQuantityRules, formatQuantity, formatOrderLine, asReceiptLine };
