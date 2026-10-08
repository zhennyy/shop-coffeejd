// Чек 54-ФЗ для ЮKassa («Чеки от ЮKassa» или подключённая онлайн-касса).
// Включается переменной YOOKASSA_RECEIPTS=on. НДС: RECEIPT_VAT_CODE (1 — без НДС, по умолчанию),
// система налогообложения: RECEIPT_TAX_SYSTEM (1–6, если у магазина их несколько).
// Важно: сумма позиций чека обязана совпасть с суммой платежа до копейки — скидку промокода делим по позициям.
const isEnabled = () => /^(on|1|true|yes)$/i.test(String(process.env.YOOKASSA_RECEIPTS || ''));

const formatAmount = (kopecks) => (kopecks / 100).toFixed(2);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizePhone(phoneText) {
  let digits = String(phoneText || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '7' + digits;
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  return /^7\d{10}$/.test(digits) ? digits : null;
}

// Контакт покупателя для чека: {phone} или {email}; строка может содержать то и другое
function contactFrom(contactText) {
  const text = String(contactText || '');
  const email = (text.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}/) || [])[0];
  const phone = normalizePhone(text.replace(email || '', ''));
  if (phone) return { phone };
  if (email && EMAIL_PATTERN.test(email)) return { email };
  return null;
}

// items: [{name, quantity, price (коп. за штуку)}], goodsTotal — товары после скидки (коп.), delivery — коп.
function buildReceipt({ items, goodsTotal, delivery = 0, contact }) {
  if (!contact || (!contact.phone && !contact.email)) throw new Error('Для чека нужен телефон или e-mail');
  const vatCode = parseInt(process.env.RECEIPT_VAT_CODE || '1', 10);
  const totalBeforeDiscount = items.reduce((sum, receiptItem) => sum + receiptItem.price * receiptItem.quantity, 0);
  if (!(totalBeforeDiscount > 0)) throw new Error('Пустой заказ');

  // доли строк после скидки: округляем, остаток копеек уходит в последнюю строку — сумма точная
  let kopecksLeft = goodsTotal;
  const discountedLines = items.map((receiptItem, itemIndex) => {
    const lineTotalBeforeDiscount = receiptItem.price * receiptItem.quantity;
    const lineTotal = itemIndex === items.length - 1 ? kopecksLeft : Math.round((lineTotalBeforeDiscount * goodsTotal) / totalBeforeDiscount);
    kopecksLeft -= lineTotal;
    return { receiptItem, lineTotal };
  });

  const receiptPositions = [];
  const addPosition = (description, quantity, unitPriceKopecks, paymentSubject) => {
    if (quantity <= 0 || unitPriceKopecks <= 0) return;
    receiptPositions.push({
      description: String(description).slice(0, 128), quantity: quantity.toFixed(3), amount: { value: formatAmount(unitPriceKopecks), currency: 'RUB' },
      vat_code: vatCode, payment_mode: 'full_payment', payment_subject: paymentSubject,
    });
  };
  for (const { receiptItem, lineTotal } of discountedLines) {
    if (lineTotal <= 0) continue;
    // копейки не делятся поровну: часть штук идёт по цене +1 копейка
    const unitPrice = Math.floor(lineTotal / receiptItem.quantity);
    const unitsWithExtraKopeck = lineTotal - unitPrice * receiptItem.quantity;
    addPosition(receiptItem.name, receiptItem.quantity - unitsWithExtraKopeck, unitPrice, 'commodity');
    addPosition(receiptItem.name, unitsWithExtraKopeck, unitPrice + 1, 'commodity');
  }
  addPosition('Доставка', 1, delivery, 'service');

  const fiscalReceipt = { customer: contact.phone ? { phone: contact.phone } : { email: contact.email }, items: receiptPositions };
  if (process.env.RECEIPT_TAX_SYSTEM) fiscalReceipt.tax_system_code = parseInt(process.env.RECEIPT_TAX_SYSTEM, 10);
  const receiptTotal = receiptPositions.reduce((sum, position) => sum + Math.round(parseFloat(position.amount.value) * 100) * Math.round(parseFloat(position.quantity)), 0);
  if (receiptTotal !== goodsTotal + delivery) throw new Error(`Чек не сошёлся с суммой платежа (${receiptTotal} ≠ ${goodsTotal + delivery})`);
  return fiscalReceipt;
}

module.exports = { isEnabled, buildReceipt, contactFrom, normalizePhone };
