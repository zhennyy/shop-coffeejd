// Тестовые данные магазина для проверки в браузере: товары, доставка, промокод, фото, заказы, переписка.
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('../../src/server/test-helpers');

const BUYER_ID = 2002;
const SECOND_BUYER_ID = 2003;
const OWNER_ID = helpers.OWNER_ID;
const DAY_MS = 24 * 3600 * 1000;

// Дата заказа/сообщения «N дней назад» в формате базы — одинаковая при повторных прогонах в тот же день
function daysAgo(days, time) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10) + ' ' + time;
}

async function prepareShop(shop, samplePhotoPng) {
  const actions = helpers.createShopActions(shop);
  const ownerCall = (method, urlPath, body) => shop.call(OWNER_ID, method, urlPath, body);
  const expectOk = (response, what) => {
    if (response.status !== 200) throw new Error(`${what}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  };

  expectOk(await ownerCall('POST', '/shop-api/admin/stock-import', { sample: 'tea' }), 'пример чая');
  await actions.createProduct({
    name: 'Помол под турку',
    price: '50',
    stock: '100',
    is_addon: true,
    addon_for: '*',
    category: 'Услуги',
  });
  expectOk(
    await ownerCall('POST', '/shop-api/admin/delivery', {
      otherPrice: '900',
      freeFrom: '5000',
      pickup: true,
      pickupAddress: 'СПб, ул. Рубинштейна, 1 — ежедневно 10:00–20:00',
    }),
    'доставка',
  );
  // геокодер без интернета: точка отправки — (0,0), любой другой адрес ≈ 2 км
  require('../../src/delivery').setGeocoder(async (address) =>
    /Невский проспект, 1$/.test(address) ? { lat: 0, lon: 0 } : { lat: 0.02, lon: 0 },
  );
  const settings = expectOk(await ownerCall('GET', '/shop-api/admin/settings'), 'настройки');
  expectOk(
    await ownerCall('POST', '/shop-api/admin/delivery2', {
      postEnabled: true,
      distanceEnabled: true,
      originAddress: 'Санкт-Петербург, Невский проспект, 1',
      tiers: '5 : 200\n15 : 450',
      carriers: settings.delivery2.post.carriers.map((carrier) => ({
        id: carrier.id,
        name: carrier.name,
        price: String(Math.round(carrier.price / 100) || 350),
      })),
    }),
    'доставка 2',
  );
  expectOk(
    await ownerCall('POST', '/shop-api/admin/promos', { code: 'COFFEE10', percent: '10', max_uses: '50' }),
    'промокод',
  );

  // фото: у первого товара — настоящее, у набора «Дегустация» — битое (проверяем заглушку)
  fs.writeFileSync(path.join(path.dirname(process.env.DB_PATH), 'uploads', 'sample.png'), samplePhotoPng);
  await shop.database.product.update({ where: { id: 1 }, data: { photo_url: '/uploads/sample.png' } });
  await shop.database.product.update({ where: { id: 7 }, data: { photo_url: 'AgACAgIAAxkBAAIBROKEN' } });

  // заказы: у покупателя — доставленный (с оценкой) и неоплаченный; у второго — курьер в сборке и самовывоз оплачен
  expectOk(await actions.buy(BUYER_ID, [[1, 2]]), 'заказ 1');
  await actions.payLastOrder();
  const firstOrder = await shop.database.order.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  await shop.database.order.update({ where: { id: firstOrder.id }, data: { delivery_method: 'pickup', rating: 5 } });
  for (const status of ['assembling', 'shipped', 'delivered'])
    expectOk(await ownerCall('POST', `/shop-api/admin/orders/${firstOrder.id}/status`, { status }), 'статус ' + status);
  expectOk(
    await shop.call(BUYER_ID, 'POST', '/shop-api/subscriptions', { order_id: firstOrder.id, days: 30 }),
    'подписка',
  );
  expectOk(await actions.buy(BUYER_ID, [[8, 1]]), 'заказ 2');

  await actions.clearCart(SECOND_BUYER_ID);
  await actions.setCart(SECOND_BUYER_ID, [
    [3, 1],
    [9, 1],
  ]);
  expectOk(
    await shop.call(SECOND_BUYER_ID, 'POST', '/shop-api/order', {
      delivery: 'city',
      city: 'Санкт-Петербург',
      address: 'Невский проспект, 10, кв. 5',
      phone: '+7 900 111-22-33',
      promo: 'COFFEE10',
    }),
    'заказ 3',
  );
  await actions.payLastOrder();
  const courierOrder = await shop.database.order.findFirst({
    where: { chat_id: SECOND_BUYER_ID },
    orderBy: { id: 'desc' },
  });
  expectOk(
    await ownerCall('POST', `/shop-api/admin/orders/${courierOrder.id}/status`, { status: 'assembling' }),
    'сборка',
  );
  expectOk(await actions.buy(SECOND_BUYER_ID, [[5, 1]]), 'заказ 4');
  await actions.payLastOrder();

  await shop.database.message.createMany({
    data: [
      {
        chat_id: SECOND_BUYER_ID,
        from_owner: 0,
        text: 'Здравствуйте! А Иргачефф бывает в зёрнах по 1 кг?',
        is_read: 1,
        created_at: daysAgo(1, '10:15:00'),
      },
      {
        chat_id: SECOND_BUYER_ID,
        from_owner: 1,
        text: 'Да, есть — уже в каталоге 🙂',
        is_read: 1,
        created_at: daysAgo(1, '10:20:00'),
      },
      {
        chat_id: SECOND_BUYER_ID,
        from_owner: 0,
        photo: 'AgACAgIAAxkBAAIBPHOTO',
        is_read: 0,
        created_at: daysAgo(0, '08:05:00'),
      },
      {
        chat_id: SECOND_BUYER_ID,
        from_owner: 0,
        text: 'Вот так выглядит пачка, которую я брала',
        is_read: 0,
        created_at: daysAgo(0, '08:06:00'),
      },
    ],
  });
  await normalizeOrders(shop);
}

// Коды и даты заказов случайные/текущие — делаем их одинаковыми, чтобы скриншоты сравнивались
async function normalizeOrders(shop) {
  const allOrders = await shop.database.order.findMany({ orderBy: { id: 'asc' } });
  for (const order of allOrders) {
    await shop.database.order.update({
      where: { id: order.id },
      data: { order_code: `CJ-${100 + order.id}`, created_at: daysAgo(6 - order.id, `1${order.id}:30:00`) },
    });
  }
}

module.exports = { prepareShop, normalizeOrders, BUYER_ID, SECOND_BUYER_ID, OWNER_ID };
