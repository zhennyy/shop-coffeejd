// Форматирование: цены (сервер присылает копейки), граммы/миллилитры, даты.
import { isEnglish } from '../i18n.js';

const KOPECKS_IN_RUBLE = 100;
const UNITS = {
  g: { ru: 'г', en: 'g', bigRu: 'кг', bigEn: 'kg' },
  ml: { ru: 'мл', en: 'ml', bigRu: 'л', bigEn: 'l' },
};

const numberLocale = () => (isEnglish() ? 'en-GB' : 'ru-RU');

/** 125000 → «1 250 ₽» */
export const formatRubles = (kopecks) => Math.round(kopecks / KOPECKS_IN_RUBLE).toLocaleString('ru-RU') + ' ₽';

/** Количество товара на вес/объём: 250 → «250 г», 1500 → «1,5 кг» */
export function formatAmount(amount, unit = 'g') {
  const names = UNITS[unit] || UNITS.g;
  if (amount >= 1000)
    return (amount / 1000).toLocaleString(numberLocale()) + ' ' + (isEnglish() ? names.bigEn : names.bigRu);
  return amount + ' ' + (isEnglish() ? names.en : names.ru);
}

/** Короткое название единицы: «г» / «мл» */
export const unitShortName = (unit) => (UNITS[unit] || UNITS.g)[isEnglish() ? 'en' : 'ru'];

/** Дата из базы (UTC, «2026-10-01 12:30:00») → «1 окт., 15:30» в часовом поясе покупателя */
export function formatDateTime(databaseDate) {
  if (!databaseDate) return '';
  const date = new Date(String(databaseDate).replace(' ', 'T') + 'Z');
  if (isNaN(date)) return '';
  return date.toLocaleString(numberLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** «★★★★☆» по оценке 1–5 */
export const formatStars = (rating) => '★'.repeat(rating) + '☆'.repeat(5 - rating);
