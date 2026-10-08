const test = require('node:test');
const assert = require('node:assert');
const { buildReceipt, contactFrom, normalizePhone } = require('../src/payments/receipt');
const sum = (rc) => rc.items.reduce((a, x) => a + Math.round(parseFloat(x.amount.value) * 100) * Math.round(parseFloat(x.quantity)), 0);

test('чек сходится с суммой при любых скидках и количествах', () => {
  const contact = { phone: '79001112233' };
  let n = 0;
  for (let price = 1; price < 400; price += 37) for (let q = 1; q <= 7; q++) for (const pct of [0, 5, 10, 33, 50, 99]) for (const delivery of [0, 25000, 33333]) {
    const items = [{ name: 'A', quantity: q, price: price * 97 }, { name: 'B', quantity: 3, price: 12345 }];
    const sum0 = items.reduce((a, i) => a + i.price * i.quantity, 0);
    const goods = Math.round(sum0 * (100 - pct) / 100);
    const rc = buildReceipt({ items, goodsTotal: goods, delivery, contact });
    assert.equal(sum(rc), goods + delivery, `price=${price} q=${q} pct=${pct} d=${delivery}`);
    assert.ok(rc.items.every((x) => parseFloat(x.amount.value) > 0));
    n++;
  }
  assert.ok(n > 500);
});
test('доставка отдельной позицией-услугой, товары — commodity', () => {
  const rc = buildReceipt({ items: [{ name: 'Кофе', quantity: 2, price: 100000 }], goodsTotal: 200000, delivery: 30000, contact: { email: 'a@b.ru' } });
  assert.equal(rc.items.at(-1).payment_subject, 'service'); assert.equal(rc.items[0].payment_subject, 'commodity');
  assert.deepEqual(rc.customer, { email: 'a@b.ru' }); assert.equal(rc.items[0].vat_code, 1);
});
test('без контакта чек не строится', () => {
  assert.throws(() => buildReceipt({ items: [{ name: 'A', quantity: 1, price: 100 }], goodsTotal: 100, contact: null }), /телефон/);
});
test('телефон и e-mail распознаются', () => {
  assert.equal(normalizePhone('+7 (900) 111-22-33'), '79001112233'); assert.equal(normalizePhone('8 900 111 22 33'), '79001112233');
  assert.equal(normalizePhone('9001112233'), '79001112233'); assert.equal(normalizePhone('12345'), null);
  assert.deepEqual(contactFrom('+7 900 111-22-33 anna@mail.ru'), { phone: '79001112233' });
  assert.deepEqual(contactFrom('anna@mail.ru'), { email: 'anna@mail.ru' }); assert.equal(contactFrom('нет'), null);
});
test('длинное название обрезается до 128 символов', () => {
  const rc = buildReceipt({ items: [{ name: 'я'.repeat(300), quantity: 1, price: 5000 }], goodsTotal: 5000, contact: { phone: '79001112233' } });
  assert.equal(rc.items[0].description.length, 128);
});
