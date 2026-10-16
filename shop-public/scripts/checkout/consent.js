// Согласие на обработку персональных данных (152-ФЗ): галочка перед оплатой (не отмечена заранее)
// и ссылки на согласие, оферту и политику. Без галочки «Оплатить» показывает подсказку и заказ не создаётся.
import { texts } from '../i18n.js';
import { telegram } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { checkoutForm } from './checkout-state.js';

export const CONSENT_FIELD_ID = 'coConsent';

// Ссылка на страницу из shop-public/legal: 'consent' | 'offer' | 'privacy'
const legalLinkHtml = (pageName, linkText) =>
  `<a href="legal/${pageName}.html" target="_blank" rel="noopener" data-action="open-legal-page">${linkText}</a>`;

export function consentHtml() {
  const errorText = checkoutForm.errors[CONSENT_FIELD_ID];
  return `<div class="box consent${errorText ? ' bad' : ''}">
      <label class="consent-check">
        <input type="checkbox" id="${CONSENT_FIELD_ID}" ${checkoutForm.consent ? 'checked' : ''}>
        <span>${texts().consentCheckbox(legalLinkHtml)}</span>
      </label>
      ${errorText ? `<div class="ferr">${escapeHtml(errorText)}</div>` : ''}
      <div class="consent-terms">${texts().consentTerms(legalLinkHtml)}</div>
    </div>`;
}

/** Галочку отметили или сняли: запоминаем, убираем подсветку ошибки, «Оплатить» в браузере — активна или нет */
export function listenToConsentCheckbox() {
  const checkbox = getElement(CONSENT_FIELD_ID);
  if (!checkbox) return;
  checkbox.addEventListener('change', () => {
    checkoutForm.consent = checkbox.checked;
    delete checkoutForm.errors[CONSENT_FIELD_ID];
    const consentBox = checkbox.closest('.consent');
    consentBox.classList.remove('bad');
    consentBox.querySelector('.ferr')?.remove();
    document.querySelector('[data-action="pay-order"]')?.classList.toggle('blocked', !checkbox.checked);
  });
}

export const consentActions = {
  // внутри Telegram открываем документ во встроенном браузере, вне его — обычная ссылка в новой вкладке
  'open-legal-page': (link, event) => {
    if (!telegram?.openLink) return;
    event.preventDefault();
    telegram.openLink(link.href);
  },
};
