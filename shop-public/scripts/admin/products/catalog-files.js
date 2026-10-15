// Файлы каталога: загрузка склада из Excel/CSV, пример «10 сортов чая», резервная копия и отчёт (приходят в чат с ботом).
import { callApi } from '../../api.js';
import { confirmAction } from '../../telegram.js';
import { getElement } from '../../utils/dom.js';
import { showToast } from '../../utils/toast.js';
import { reloadProducts } from './product-list.js';

const MAX_IMPORT_BYTES = 5e6;
const REPORT_DAYS = 30;

/** Итог загрузки — первые две строки отчёта сервера */
const importSummary = (result) => result.text.split('\n').slice(0, 2).join(' · ');

async function sendImport(body) {
  showToast('Загружаю…');
  try {
    const result = await callApi('/admin/stock-import', body, 1);
    showToast(importSummary(result));
    await reloadProducts();
  } catch (error) {
    showToast(error.message);
  }
}

/** Выбранный файл отправляем на сервер в base64 */
export function listenToImportFile(fileInput) {
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showToast('Файл слишком большой (до 5 МБ)');
      fileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] || '';
      sendImport({ name: file.name, data: base64 });
      fileInput.value = '';
    };
    reader.readAsDataURL(file);
  });
}

async function importTeaSample() {
  if (!(await confirmAction('Добавить в каталог 10 сортов чая и 2 набора (пример)?'))) return;
  sendImport({ sample: 'tea' });
}

function requestBackup() {
  showToast('Собираю резервную копию…');
  callApi('/admin/backup', {}, 1)
    .then(() => showToast('Готово — архив в чате с ботом 📦'))
    .catch((error) => showToast(error.message));
}

function sendReport() {
  callApi('/admin/report', { days: REPORT_DAYS, file: true }, 1)
    .then(() => showToast('Отчёт за 30 дней отправлен в чат 📊'))
    .catch((error) => showToast(error.message));
}

export const catalogFileActions = {
  'import-file': () => getElement('impInput')?.click(),
  'import-sample': () => importTeaSample(),
  'request-backup': () => requestBackup(),
  'send-report': () => sendReport(),
};
