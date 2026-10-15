// CRM: после startCrmSync() новый заказ и смена статуса уходят на CRM_URL с секретом в заголовке
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../server/test-helpers');
const axios = require('axios');
const { startCrmSync } = require('.');

const CRM_URL = 'https://crm.test/webhook';
const BUYER_ID = 7401;
const crmRequests = [];
let stopCrmSync;
let shop;
let actions;

const waitForBackgroundSends = () => new Promise((resolve) => setTimeout(resolve, 50));

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
  process.env.CRM_URL = CRM_URL;
  const fakeYookassaPost = axios.post;
  axios.post = async (url, body, options) => {
    if (url === CRM_URL) { crmRequests.push({ body, headers: options.headers }); return { data: {} }; }
    return fakeYookassaPost(url, body, options);
  };
  stopCrmSync = startCrmSync();
});

after(() => {
  stopCrmSync();
  delete process.env.CRM_URL;
});

test('оплаченный заказ уходит в CRM с составом и секретом', async () => {
  const [product] = await actions.productsInStock();
  const response = await actions.buy(BUYER_ID, [[product.id, 1]]);
  await actions.payLastOrder();
  await waitForBackgroundSends();

  const sentOrders = crmRequests.filter((request) => request.body.order.id === String(response.body.id));
  assert.ok(sentOrders.length >= 1, 'заказ отправлен в CRM');
  const lastSent = sentOrders.at(-1);
  assert.equal(lastSent.headers['X-Webhook-Secret'], process.env.CRM_SECRET);
  assert.equal(lastSent.body.order.status, 'paid');
  assert.equal(lastSent.body.customer.external_id, String(BUYER_ID));
  assert.equal(lastSent.body.order.items.length, 1);
});

test('после остановки подписки заказы в CRM не уходят', async () => {
  stopCrmSync();
  const requestsBefore = crmRequests.length;
  const [product] = await actions.productsInStock();
  await actions.buy(BUYER_ID, [[product.id, 1]]);
  await waitForBackgroundSends();
  assert.equal(crmRequests.length, requestsBefore);
  stopCrmSync = startCrmSync();
});
