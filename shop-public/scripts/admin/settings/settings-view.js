// Админка → «Настройки»: доставка по городам, СДЭК/Почта и по расстоянию, чеки, промокоды, резервная копия.
import { callApi } from '../../api.js';
import { getElement, escapeHtml } from '../../utils/dom.js';
import { showToast } from '../../utils/toast.js';
import { adminState } from '../admin-state.js';

/** Копейки → целые рубли для полей ввода */
const toRubles = (kopecks) => (kopecks ? Math.round(kopecks / 100) : 0);

const switchHtml = (attributes, isOn) =>
  `<span class="sw"><input type="checkbox" ${attributes} ${isOn ? 'checked' : ''}><i></i></span>`;

function cityDeliveryHtml(settings) {
  const delivery = settings.delivery;
  const cityRows = settings.cities
    .map(
      (city) => `
        <div class="crow ${city.active ? '' : 'off'}" data-city-id="${city.id}">
          <input class="cn" value="${escapeHtml(city.city)}"><input class="cp" type="number" inputmode="numeric" value="${toRubles(city.price)}"><span class="rub">₽</span>
          <label class="sw"><input type="checkbox" class="ca" ${city.active ? 'checked' : ''}><i></i></label>
          <button class="mini" data-action="delete-city" data-city-id="${city.id}" aria-label="Удалить">🗑</button>
        </div>`,
    )
    .join('');
  return `<div class="box form"><h3>🚚 Доставка по городам</h3>
      ${cityRows}
      <div class="crow new"><input id="ncity" placeholder="Новый город"><input id="nprice" type="number" inputmode="numeric" placeholder="Цена"><span class="rub">₽</span><button class="btn small" data-action="add-city">＋</button></div>
      <div class="two">
        <div><label>Другие города, ₽</label><input id="dOther" type="number" inputmode="numeric" value="${toRubles(delivery.otherPrice)}"></div>
        <div><label>Бесплатно от суммы, ₽</label><input id="dFree" type="number" inputmode="numeric" value="${delivery.freeFrom ? toRubles(delivery.freeFrom) : ''}" placeholder="выкл."></div>
      </div>
      <label class="line2"><span>🏠 Самовывоз</span>${switchHtml('id="dPickup"', delivery.pickup)}</label>
      <input id="dPickupAddr" placeholder="Адрес и часы самовывоза — покупатель увидит после оплаты" value="${escapeHtml(delivery.pickupAddress || '')}">
      <div class="actions"><button class="btn" data-action="save-delivery">Сохранить доставку</button></div>
    </div>`;
}

function otherDeliveryHtml(settings) {
  const { post, distance } = settings.delivery2;
  return `<div class="box form"><h3>📦 СДЭК / Почта и доставка по расстоянию</h3>
      <label class="line2"><span>СДЭК / Почта России</span>${switchHtml('id="d2Post"', post.enabled)}</label>
      <div class="note" style="text-align:left">Цена — фиксированная, вы задаёте её сами (точный тариф перевозчика бот не считает).</div>
      ${post.carriers.map((carrier) => `<div class="crow" data-carrier-id="${escapeHtml(carrier.id)}"><input class="cn" value="${escapeHtml(carrier.name)}"><input class="cp" type="number" inputmode="numeric" value="${toRubles(carrier.price)}"><span class="rub">₽</span></div>`).join('')}
      <label class="line2"><span>По расстоянию</span>${switchHtml('id="d2Dist"', distance.enabled)}</label>
      <input id="d2Origin" placeholder="Откуда отправляете: город, улица, дом" value="${escapeHtml(distance.originAddress || '')}">
      <textarea id="d2Tiers" placeholder="5 : 200">${escapeHtml(distance.tiers)}</textarea>
      <div class="note" style="text-align:left">Каждая строка: «до скольки км : цена в ₽». Расстояние считается по прямой. Дальше последней ступени бот не возит.</div>
      <div class="actions"><button class="btn" data-action="save-delivery2">Сохранить</button></div>
    </div>`;
}

const receiptsHtml = (settings) => `<div class="box"><h3>🧾 Чеки (54-ФЗ)</h3>
      <div class="note" style="text-align:left">${settings.receipts ? 'Включены: чек формируется вместе с платежом ЮKassa, покупатель указывает телефон или e-mail.' : 'Выключены. Включаются настройкой YOOKASSA_RECEIPTS=on на сервере после согласования с ЮKassa и вашей онлайн-кассой.'}</div>
    </div>`;

function promosHtml(settings) {
  const promoRows = settings.promos.length
    ? settings.promos
        .map(
          (promo) => `
        <div class="prow ${promo.active ? '' : 'off'}">
          <div class="mid"><b>${escapeHtml(promo.code)}</b> <span class="pill">−${promo.discount_percent}%</span>
            <div class="s">использован ${promo.used_count}${promo.max_uses ? ' из ' + promo.max_uses : ''} раз</div></div>
          <label class="sw"><input type="checkbox" data-action="toggle-promo" data-promo-id="${promo.id}" ${promo.active ? 'checked' : ''}><i></i></label>
          <button class="mini" data-action="delete-promo" data-promo-id="${promo.id}" aria-label="Удалить">🗑</button>
        </div>`,
        )
        .join('')
    : '<div class="note" style="text-align:left">Промокодов пока нет</div>';
  return `<div class="box form"><h3>🎟 Промокоды</h3>
      ${promoRows}
      <div class="two3"><input id="pcode" placeholder="КОД" autocapitalize="characters"><input id="ppct" type="number" inputmode="numeric" placeholder="%"><input id="pmax" type="number" inputmode="numeric" placeholder="лимит"></div>
      <div class="actions"><button class="btn" data-action="add-promo">Создать промокод</button></div>
    </div>`;
}

const BACKUP_HTML = `<div class="box"><h3>📦 Резервная копия</h3>
      <div class="note" style="text-align:left;margin:0 0 10px">Бот пришлёт в чат ZIP: фото, каталог, заказы и промокоды (таблицы открываются в Excel).</div>
      <button class="btn ghost" data-action="request-backup">Получить копию</button>
    </div>`;

export function renderSettings() {
  const settings = adminState.settings;
  getElement('admBody').innerHTML = `
    ${cityDeliveryHtml(settings)}
    ${otherDeliveryHtml(settings)}
    ${receiptsHtml(settings)}
    ${promosHtml(settings)}
    ${BACKUP_HTML}`;
  listenToCityRows();
}

/** Город сохраняется сразу при изменении названия, цены или переключателя */
function listenToCityRows() {
  document.querySelectorAll('.crow[data-city-id]').forEach((row) => {
    const saveCity = async () => {
      const isActive = row.querySelector('.ca').checked;
      try {
        adminState.settings = await callApi(
          '/admin/cities',
          {
            id: Number(row.dataset.cityId),
            city: row.querySelector('.cn').value,
            price: row.querySelector('.cp').value,
            active: isActive,
          },
          1,
        );
        row.classList.toggle('off', !isActive);
        showToast('Сохранено ✓');
      } catch (error) {
        showToast(error.message);
      }
    };
    row.querySelectorAll('input').forEach((input) => input.addEventListener('change', saveCity));
  });
}
