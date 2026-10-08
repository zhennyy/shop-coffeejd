// Точка входа CoFFeeJD: проверяем настройки, запускаем бота, сервер витрины и фоновые задачи.
const { validateConfig } = require('./src/config');

validateConfig();

const { bot, launchBot, showcaseHelpers } = require('./src/bot');
const { startWebhookServer } = require('./src/server');
const { startSchedulers } = require('./src/schedulers');

process.on('unhandledRejection', (rejectionReason) => console.error('Необработанная ошибка:', rejectionReason?.message || rejectionReason));

launchBot();
startWebhookServer(bot, showcaseHelpers);
const stopSchedulers = startSchedulers(bot);

const shutdown = (signal) => {
  stopSchedulers();
  bot.stop(signal);
  process.exit(0);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
