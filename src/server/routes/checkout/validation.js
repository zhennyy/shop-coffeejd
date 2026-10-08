// Проверка запросов оформления: способ доставки, адрес, промокод, контакт для чека
const receipt = require('../../../payments/receipt');
const { ValidationError, createValidator, cleanText } = require('../../validation');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PHONE_DIGITS = 10;

// Поля доставки из формы витрины — так их ждёт resolveDelivery
const readDeliveryForm = (requestBody) => ({ method: requestBody.delivery, city: requestBody.city, carrier: requestBody.carrier, addr: requestBody.address });

const deliveryQuoteValidator = createValidator((request) => {
  const requestBody = request.body || {};
  return { deliveryForm: readDeliveryForm(requestBody), promoCode: requestBody.promo };
});

const promoPostValidator = createValidator((request) => ({ promoCode: request.body.code }));

// Заказ: телефон и/или e-mail; для чека 54-ФЗ нужен хотя бы один корректный
const orderPostValidator = createValidator((request) => {
  const requestBody = request.body || {};
  const phone = cleanText(requestBody.phone, 30);
  const email = cleanText(requestBody.email, 80);
  if (phone && phone.replace(/\D/g, '').length < MIN_PHONE_DIGITS) throw new ValidationError('Проверьте номер телефона');
  if (email && !EMAIL_PATTERN.test(email)) throw new ValidationError('Проверьте e-mail');
  const contact = [phone, email].filter(Boolean).join(' ') || null;
  if (receipt.isEnabled() && !receipt.contactFrom(contact)) throw new ValidationError('Для чека укажите телефон или e-mail');
  return { deliveryForm: readDeliveryForm(requestBody), promoCode: requestBody.promo, phone, contact };
});

module.exports = { deliveryQuoteValidator, promoPostValidator, orderPostValidator };
