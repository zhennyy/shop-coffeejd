// Регулярные заказы покупателя: блок со списком и окно выбора «как часто повторять».
// Деньги сами не списываются — в нужный день бот присылает ссылку на оплату.
import { escapeHtml } from '../utils/dom.js';
import { formatAmount } from '../utils/format.js';

const INTERVAL_NAMES = {
  7: 'раз в неделю',
  14: 'раз в 2 недели',
  21: 'раз в 3 недели',
  30: 'раз в месяц',
  60: 'раз в 2 месяца',
};

const intervalName = (days) => INTERVAL_NAMES[days] || `раз в ${days} дн.`;
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);

function subscriptionHtml(subscription) {
  const nextDate = escapeHtml(subscription.next_date.split('-').reverse().join('.'));
  const items = subscription.items
    .map((item) => escapeHtml(item.name) + (item.unit ? ', ' + formatAmount(item.qty, item.unit) : ' × ' + item.qty))
    .join(', ');
  const button = (action, label) =>
    `<button data-action="change-subscription" data-change="${action}" data-subscription-id="${subscription.id}">${label}</button>`;
  return `
      <div class="sub" style="padding:8px 0;border-top:1px solid var(--line,#eee)">
        <div><b>${intervalName(subscription.interval_days)}</b>${subscription.active ? ` · следующий ${nextDate}` : ' · на паузе'}</div>
        <div class="note" style="text-align:left">${items}</div>
        <div class="seg" style="margin-top:6px;flex-wrap:wrap">
          ${subscription.active ? button('skip', 'Пропустить раз') + button('pause', 'Пауза') : button('resume', 'Возобновить')}
          ${button('delete', 'Отменить')}
        </div>
      </div>`;
}

export function subscriptionsHtml(subscriptions) {
  if (!subscriptions.length) return '';
  return `<div class="box"><h3>Регулярные заказы</h3>${subscriptions.map(subscriptionHtml).join('')}
      <div class="note" style="text-align:left">Деньги не списываются сами: в нужный день пришлём ссылку на оплату.</div></div>`;
}

/** Окно выбора интервала снизу экрана. Возвращает число дней или 0, если закрыли. */
export function pickInterval(intervals) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99;display:flex;align-items:flex-end';
    overlay.innerHTML = `<div style="background:var(--bg,#fff);width:100%;padding:16px;border-radius:16px 16px 0 0"><h3 style="margin:0 0 10px">Как часто повторять?</h3>
      ${intervals.map((days) => `<button class="btn ghost" data-interval-days="${days}" style="width:100%;margin-bottom:8px">${capitalize(intervalName(days))}</button>`).join('')}
      <button class="btn ghost" data-interval-days="0" style="width:100%">Закрыть</button></div>`;
    overlay.addEventListener('click', (event) => {
      const button = event.target.closest('[data-interval-days]');
      if (!button && event.target !== overlay) return; // клик по самому окну — не закрываем
      overlay.remove();
      resolve(button ? Number(button.dataset.intervalDays) : 0);
    });
    document.body.appendChild(overlay);
  });
}
