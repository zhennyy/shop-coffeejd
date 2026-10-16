// Резервная копия уходит владелице через Telegram — в ней не должно быть адресов и телефонов покупателей (152-ФЗ)
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../server/test-helpers');

const BUYER_ID = 5401;
let shop;

before(async () => {
  shop = await testHelpers.start();
});

test('в архиве есть заказы, но нет адреса, телефона и e-mail покупателя', async () => {
  const actions = testHelpers.createShopActions(shop);
  const [product] = await actions.productsInStock();
  await actions.clearCart(BUYER_ID);
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', {
    delivery: 'city',
    city: 'Москва',
    address: 'Тверская улица, 7, кв. 3',
    phone: '+7 912 345-67-89',
    email: 'buyer@mail.test',
    consent: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { makeBackup } = require('./index');
  const directory = require('node:os').tmpdir();
  const backup = await makeBackup({ uploadsDir: directory, photosDir: directory });
  const archiveText = backup.buffer.toString('utf8'); // архив без сжатия — содержимое файлов видно как есть
  assert.match(archiveText, new RegExp(`"order_code": "${response.body.code}"`), 'заказ в архиве');
  assert.doesNotMatch(archiveText, /Тверская/);
  assert.doesNotMatch(archiveText, /912 345-67-89|79123456789/);
  assert.doesNotMatch(archiveText, /buyer@mail\.test/);
});
