// Общие форматтеры и журнал ошибок: оба варианта экранирования ведут себя так же, как старые копии в orders и keyboards
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatRubles, formatRublesPlain, escapeHtml, escapeHtmlText } = require('./format');
const { logError, ignoreExpectedError } = require('./log');

test('formatRubles: копейки → рубли с округлением и пробелом между тысячами', () => {
  assert.equal(formatRubles(0), '0 ₽');
  assert.equal(formatRubles(34950), '350 ₽');
  assert.equal(formatRubles(123456), '1 235 ₽');
});

test('formatRublesPlain: без разделителя тысяч', () => {
  assert.equal(formatRublesPlain(123456), '1235 ₽');
  assert.equal(formatRublesPlain(0), '0 ₽');
});

test('escapeHtml: & < > " экранируются, null → пусто, 0 остаётся числом', () => {
  assert.equal(escapeHtml('<b>"Кофе" & чай</b>'), '&lt;b&gt;&quot;Кофе&quot; &amp; чай&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('escapeHtmlText: кавычки не трогает, любое пустое значение (в том числе 0) → пусто', () => {
  assert.equal(escapeHtmlText('<b>"Кофе" & чай</b>'), '&lt;b&gt;"Кофе" &amp; чай&lt;/b&gt;');
  assert.equal(escapeHtmlText(null), '');
  assert.equal(escapeHtmlText(0), '');
  assert.equal(escapeHtmlText(false), '');
  assert.equal(escapeHtmlText(42), '42');
});

test('logError пишет пояснение и текст ошибки, промис не падает', async (context) => {
  const logged = [];
  context.mock.method(console, 'error', (...parts) => logged.push(parts.join(' ')));
  const result = await Promise.reject(new Error('сеть недоступна')).catch(logError('Не получилось написать'));
  assert.equal(result, undefined);
  assert.deepEqual(logged, ['Не получилось написать: сеть недоступна']);
  assert.equal(await Promise.reject(new Error('message to delete not found')).catch(ignoreExpectedError), undefined);
});
