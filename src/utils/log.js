// Журнал ошибок для промисов, которые не должны ронять обработчик:
//   bot.telegram.sendMessage(...).catch(logError('Не получилось предупредить владельца'))
// Ошибка пишется в лог с пояснением, а промис завершается значением undefined.
const logError = (description) => (error) => {
  console.error(`${description}:`, error?.message || error);
};

// Сбой, который ожидаем и сознательно пропускаем (например, сообщение в Telegram уже удалено).
// Отдельная функция, чтобы в коде было видно: ошибку не «проглотили», а решили не замечать.
const ignoreExpectedError = () => undefined;

module.exports = { logError, ignoreExpectedError };
