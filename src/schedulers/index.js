// Фоновые задачи по расписанию
const { checkLowStock } = require('../notifications');
const { runDueSubscriptions } = require('../subscriptions');

const ONE_HOUR_MS = 60 * 60 * 1000;
const MOSCOW_OFFSET_MS = 3 * ONE_HOUR_MS;
const QUIET_HOURS_END = 9; // до 9:00 по Москве покупателям не пишем

const moscowHourNow = () => new Date(Date.now() + MOSCOW_OFFSET_MS).getUTCHours();

function startSchedulers(bot) {
  const timers = [
    setInterval(() => checkLowStock(bot).catch((stockError) => console.error('Склад:', stockError.message)), ONE_HOUR_MS),
    setInterval(() => {
      if (moscowHourNow() < QUIET_HOURS_END) return;
      runDueSubscriptions(bot).catch((subscriptionError) => console.error('Подписки:', subscriptionError.message));
    }, ONE_HOUR_MS),
  ];
  return () => timers.forEach(clearInterval);
}

module.exports = { startSchedulers };
