import { splitIntoTelegramMessages } from './utils.js';

export class TelegramBot {
  constructor(token) {
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN belum diisi.');
    }

    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async request(method, payload = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'mlb-alert-telegram-agent/0.1'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      const description = data?.description || response.statusText;
      throw new Error(`Telegram ${method} gagal: ${description}`);
    }

    return data.result;
  }

  getUpdates({ offset, timeout = 30 }) {
    return this.request('getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'callback_query']
    });
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...options
    });
  }

  async sendMessage(chatId, text, options = {}) {
    const chunks = splitIntoTelegramMessages(text);

    for (const chunk of chunks) {
      await this.request('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...options
      });
    }
  }
}
