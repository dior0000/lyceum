// Лакальны запуск: звычайны сервер + бот на long-polling.
// (Перад лакальным запускам зніміце webhook: /deleteWebhook у Bot API,
// інакш polling атрымае 409.)
require('dotenv').config();
const app = require('./app');
const { bot } = require('./bot');

const PORT = Number(process.env.PORT || 3000);

if (!process.env.BOT_TOKEN) {
  console.error('Не зададзены BOT_TOKEN — запоўні файл .env (гл. .env.example)');
  process.exit(1);
}

app.listen(PORT, () => console.log(`Сервер запушчаны: http://localhost:${PORT}`));
bot
  .start({ onStart: (info) => console.log(`Бот запушчаны: @${info.username}`) })
  .catch((e) => console.error('Бот не запусціўся:', e.message));
