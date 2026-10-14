// Фото товара или эмодзи-заглушка, если фото нет или оно не загрузилось.
import { escapeHtml } from '../utils/dom.js';
import { isBundle } from './product-helpers.js';

const BROKEN_PHOTO_HTML = '<div class="noimg">♨️</div>';
const EMOJI_BY_KIND = [
  [/чай|tea|матча|пуэр/i, '🍵'],
  [/кофе|coffee|эспрессо/i, '☕'],
  [/набор|подар|set|gift/i, '🎁'],
  [/сироп|концентрат|лимонад/i, '🧃'],
];

function emojiFor(product) {
  if (isBundle(product)) return '🎁';
  const searchableText = [product.category, product.group_key, product.name].join(' ');
  const match = EMOJI_BY_KIND.find(([pattern]) => pattern.test(searchableText));
  return match ? match[1] : '♨️';
}

export function productPhotoHtml(product) {
  if (product && product.photo) return `<img src="${escapeHtml(product.photo)}" alt="" loading="lazy" data-photo-fallback>`;
  return `<div class="noimg">${emojiFor(product || {})}</div>`;
}

/** Битое фото товара заменяем заглушкой. Событие error не всплывает — ловим на этапе погружения. */
export function replaceBrokenPhotos() {
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.hasAttribute('data-photo-fallback')) image.outerHTML = BROKEN_PHOTO_HTML;
  }, true);
}
