// Админка настроек: доставка, города, промокоды, статистика, чаты
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const OWNER_ID = testHelpers.OWNER_ID;
const BUYER_ID = 6401;
let shop;
let delivery;

before(async () => {
  shop = await testHelpers.start();
  delivery = require('../../../delivery');
});

test('СДЭК/Почта и ступени расстояния сохраняются; кривые ступени отклоняются', async () => {
  assert.deepEqual(delivery.parseDistanceTiers('5 : 200\n15 : 350'), [{ km: 5, price: 20000 }, { km: 15, price: 35000 }]);
  assert.throws(() => delivery.parseDistanceTiers('мусор'));
  assert.throws(() => delivery.parseDistanceTiers('5:100\n5:200'));
  const saved = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/delivery2', {
    postEnabled: true, carriers: [{ id: 'cdek', name: 'СДЭК', price: 400 }], distanceEnabled: false, tiers: '5 : 200',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await delivery.getDeliveryOptions()).post.carriers[0].price, 40000);
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/delivery2', { tiers: 'мусор' })).status, 400);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/admin/delivery2', {})).status, 403);
});

test('города: добавить, изменить цену, удалить', async () => {
  const added = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/cities', { city: 'Казань', price: 900 });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const kazan = added.body.cities.find((rate) => rate.city === 'Казань');
  assert.equal(kazan.price, 90000);
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/cities', { city: 'К', price: 100 })).status, 400);
  const updated = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/cities', { id: kazan.id, city: 'Казань', price: 950 });
  assert.equal(updated.body.cities.find((rate) => rate.id === kazan.id).price, 95000);
  const removed = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/cities/${kazan.id}/delete`, {});
  assert.ok(!removed.body.cities.some((rate) => rate.id === kazan.id));
});

test('промокоды: проверка формы, дубль, выключение', async () => {
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'X', percent: 10 })).status, 400);
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'AUTUMN', percent: 95 })).status, 400);
  const created = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'autumn', percent: 15, max_uses: 3 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const promo = created.body.promos.find((promoCode) => promoCode.code === 'AUTUMN');
  assert.equal(promo.discount_percent, 15);
  assert.match((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'AUTUMN', percent: 10 })).body.error, /уже есть/);
  const switchedOff = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/promos/${promo.id}`, { active: false });
  assert.equal(switchedOff.body.promos.find((promoCode) => promoCode.id === promo.id).active, 0);
});

test('статистика и чаты доступны только владелице', async () => {
  const stats = await shop.call(OWNER_ID, 'GET', '/shop-api/admin/stats?days=7');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.days, 7);
  assert.equal(stats.body.byDay.length, 7);
  assert.equal((await shop.call(BUYER_ID, 'GET', '/shop-api/admin/stats')).status, 403);
  assert.equal((await shop.call(OWNER_ID, 'POST', `/shop-api/admin/chats/${BUYER_ID}`, { text: '   ' })).status, 400);
  assert.match((await shop.call(OWNER_ID, 'POST', `/shop-api/admin/chats/${BUYER_ID}`, { text: 'Привет' })).body.error, /ещё не писал/);
});
