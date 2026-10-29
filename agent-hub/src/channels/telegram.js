// Telegram as a way to talk to the hub from a phone. One bot (token from @BotFather), long polling, and
// only the chat ids listed in TELEGRAM_ALLOWED_CHATS get answers; anyone else is told their chat id so
// Jonathan can add it. Each chat is its own saved session. Voice notes are transcribed through OpenAI.
const API = 'https://api.telegram.org';
export const MAX_MESSAGE = 4096;

export class Telegram {
  constructor({ token, allowed = [], ask, transcribe, fetchImpl = fetch, log = () => {}, offset = 0 }) {
    this.token = token;
    this.allowed = new Set(String(allowed ?? '').split(/[,\s]+/).filter(Boolean));
    this.ask = ask;                 // async (chatId, text) => { text, images }
    this.transcribe = transcribe;   // async (bytes, filename) => text
    this.fetch = fetchImpl;
    this.log = log;
    this.offset = offset;
    this.running = false;
    this.me = null;
    this.poll = null;
  }

  async api(method, body, signal) {
    const res = await this.fetch(`${API}/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  async test() {
    this.me = await this.api('getMe');
    return `Bot @${this.me.username} is live. ${this.allowed.size ? `${this.allowed.size} chat${this.allowed.size === 1 ? '' : 's'} allowed.` : 'No chats allowed yet: message the bot once and add the chat id it tells you.'}`;
  }

  start() {
    if (this.running) return;
    this.running = true;
    (async () => {
      while (this.running) {
        try {
          this.poll = new AbortController();
          const updates = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, this.poll.signal);
          for (const u of updates) {
            if (!this.running) break;
            this.offset = u.update_id + 1;
            await this.handle(u.message).catch((err) => this.log(`telegram: ${err.message}`));
          }
        } catch (err) {
          if (!this.running) break;
          this.log(`telegram poll: ${err.message}`); await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }
  // Stops delivering and aborts the open long poll, so a replacement bot can start at once.
  stop() { this.running = false; this.poll?.abort(); }

  async handle(msg) {
    if (!msg) return;
    const chatId = String(msg.chat.id);
    if (!this.allowed.has(chatId)) {
      await this.send(chatId, `This hub only answers approved chats. Your chat id is ${chatId}. Add it under Connect → Telegram in the Agent Hub.`);
      return;
    }
    let text = msg.text ?? msg.caption ?? '';
    if (msg.voice || msg.audio) {
      if (!this.transcribe) return this.send(chatId, 'Voice notes need ChatGPT connected in the hub for transcription.');
      const f = await this.api('getFile', { file_id: (msg.voice ?? msg.audio).file_id });
      const bytes = Buffer.from(await (await this.fetch(`${API}/file/bot${this.token}/${f.file_path}`)).arrayBuffer());
      text = await this.transcribe(bytes, `voice.${(f.file_path.split('.').pop() || 'ogg')}`);
      if (!text) return this.send(chatId, 'I could not make out the voice note.');
    }
    if (!text.trim()) return;
    if (/^\/(start|help)\b/.test(text)) return this.send(chatId, 'This is your Agent Hub. Ask anything, or send a voice note. /id shows this chat\'s id.');
    if (/^\/id\b/.test(text)) return this.send(chatId, `Chat id: ${chatId}`);
    await this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const out = await this.ask(chatId, text);
    for (const img of out.images ?? []) await this.api('sendPhoto', { chat_id: chatId, photo: img }).catch(() => {});
    await this.send(chatId, out.text || '(no answer)');
  }

  async send(chatId, text) {
    for (const part of chunk(text)) await this.api('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
  }

  // Deliver a scheduled result to every allowed chat.
  async broadcast(text) { for (const id of this.allowed) await this.send(id, text).catch((err) => this.log(`telegram broadcast: ${err.message}`)); }
}

// Telegram caps a message at 4096 characters; split on paragraph, then line, then hard.
export function chunk(text, max = MAX_MESSAGE) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
