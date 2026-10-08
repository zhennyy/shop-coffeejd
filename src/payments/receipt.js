// payments/receipt.js — чек 54-ФЗ для ЮKassa («Чеки от ЮKassa» или подключённая онлайн-касса).
// Включается переменной YOOKASSA_RECEIPTS=on. НДС: RECEIPT_VAT_CODE (1 — без НДС, по умолчанию),
// система налогообложения: RECEIPT_TAX_SYSTEM (1–6, если у магазина их несколько).
// Важно: сумма позиций чека обязана совпасть с суммой платежа до копейки — скидку промокода делим по позициям.
const enabled = () => /^(on|1|true|yes)$/i.test(String(process.env.YOOKASSA_RECEIPTS || ''));

const rub = (kop) => (kop / 100).toFixed(2);

function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return /^7\d{10}$/.test(d) ? d : null;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Контакт покупателя для чека: {phone} или {email}; строка может содержать то и другое
function contactFrom(text) {
  const s = String(text || '');
  const email = (s.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}/) || [])[0];
  const phone = normalizePhone(s.replace(email || '', ''));
  if (phone) return { phone };
  if (email && EMAIL.test(email)) return { email };
  return null;
}

// items: [{name, quantity, price (коп. за штуку)}], goodsTotal — товары после скидки (коп.), delivery — коп.
function buildReceipt({ items, goodsTotal, delivery = 0, contact }) {
  if (!contact || (!contact.phone && !contact.email)) throw new Error('Для чека нужен телефон или e-mail');
  const vat = parseInt(process.env.RECEIPT_VAT_CODE || '1', 10);
  const sum0 = items.reduce((a, i) => a + i.price * i.quantity, 0);
  if (!(sum0 > 0)) throw new Error('Пустой заказ');
  // доли строк после скидки: округляем, остаток копеек уходит в последнюю строку — сумма точная
  let left = goodsTotal;
  const lines = items.map((it, idx) => {
    const t0 = it.price * it.quantity;
    const t = idx === items.length - 1 ? left : Math.round((t0 * goodsTotal) / sum0);
    left -= t;
    return { it, t };
  });
  const out = [];
  const push = (description, qty, unitKop, subject) => {
    if (qty <= 0 || unitKop <= 0) return;
    out.push({
      description: String(description).slice(0, 128), quantity: qty.toFixed(3), amount: { value: rub(unitKop), currency: 'RUB' },
      vat_code: vat, payment_mode: 'full_payment', payment_subject: subject,
    });
  };
  for (const { it, t } of lines) {
    if (t <= 0) continue;
    const unit = Math.floor(t / it.quantity), rem = t - unit * it.quantity; // rem штук по unit+1, остальные по unit
    push(it.name, it.quantity - rem, unit, 'commodity');
    push(it.name, rem, unit + 1, 'commodity');
  }
  push('Доставка', 1, delivery, 'service');
  const receipt = { customer: contact.phone ? { phone: contact.phone } : { email: contact.email }, items: out };
  if (process.env.RECEIPT_TAX_SYSTEM) receipt.tax_system_code = parseInt(process.env.RECEIPT_TAX_SYSTEM, 10);
  const total = out.reduce((a, x) => a + Math.round(parseFloat(x.amount.value) * 100) * Math.round(parseFloat(x.quantity)), 0);
  if (total !== goodsTotal + delivery) throw new Error(`Чек не сошёлся с суммой платежа (${total} ≠ ${goodsTotal + delivery})`);
  return receipt;
}

module.exports = { enabled, buildReceipt, contactFrom, normalizePhone };
