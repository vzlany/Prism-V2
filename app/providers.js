(() => {
'use strict';

// Every model call goes through here: DeepSeek straight from the page, OpenAI, ChatGPT and Anthropic through the main process.
// Whatever the provider, a call resolves to the same result: content, reasoning, tool calls, finish reason and usage.
const bridge = window.openghost?.llm || null;
const listeners = new Map();
bridge?.onEvent(data => listeners.get(data.id)?.(data));

const NAMES = { deepseek: 'DeepSeek', openai: 'OpenAI', chatgpt: 'ChatGPT', anthropic: 'Anthropic', 'opencode-go': 'OpenCode Go' };

class ProviderError extends Error {
 constructor(message, status = 0, code = '') {
  super(message);
  this.name = 'ProviderError';
  this.status = status;
  this.code = code;
 }
}

function explain(provider, { status = 0, code = '', message = '' }) {
 const name = NAMES[provider] || provider;
 if (code === 'network') return I18n.t('error.connect', { provider: name });
 if (status === 401) return I18n.t(provider === 'chatgpt' ? 'error.signin' : 'error.key', { provider: name });
 if (status === 402 || code === 'insufficient_quota' || code === 'billing_error') return I18n.t('error.quota', { provider: name });
 if (status === 429) return I18n.t('error.rate', { provider: name });
 if (status >= 500) return I18n.t('error.server', { provider: name });
 return message || I18n.t('error.statusOf', { provider: name, status });
}

const aborted = partial => Object.assign(new DOMException('Aborted', 'AbortError'), { partial });

function viaMain(config, { messages, tools, signal, onReasoning, onContent, maxTokens, session }) {
 if (!bridge) return Promise.reject(new ProviderError(I18n.t('error.desktop', { provider: NAMES[config.provider] })));
 const id = `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
 const request = {
  provider: config.provider, key: config.key, model: config.model, effort: config.effort, vision: config.vision,
  thinking: config.thinking, output: config.output, messages, tools, maxTokens, session,
 };
 return new Promise((resolve, reject) => {
  const partial = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
  if (signal?.aborted) { reject(aborted(partial)); return; }
  const stop = () => bridge.abort(id);
  const finish = () => {
   listeners.delete(id);
   signal?.removeEventListener('abort', stop);
  };
  listeners.set(id, event => {
   if (event.type === 'content') {
    partial.content += event.delta;
    onContent?.(event.delta, partial);
   } else if (event.type === 'reasoning') {
    partial.reasoning += event.delta;
    onReasoning?.(event.delta, partial);
   } else if (event.type === 'done') {
    finish();
    resolve({ ...partial, ...event.result });
   } else if (event.type === 'error') {
    finish();
    reject(event.aborted ? aborted(partial) : new ProviderError(explain(config.provider, event), event.status, event.code));
   }
  });
  signal?.addEventListener('abort', stop, { once: true });
  bridge.start(id, request);
 });
}

function stream(config, options) {
 if (config.provider !== 'deepseek') return viaMain(config, options);
 const { messages, tools, signal, onReasoning, onContent } = options;
 return DeepSeek.streamChat({ key: config.key, model: config.model, effort: config.effort, vision: config.vision, messages, tools, signal, onReasoning, onContent });
}

// A dropped connection is the most common failure a long agent turn meets ("Can't connect to
// OpenCode Go" when the network blinks, the VPN re-keys or the provider is briefly down).
// Nothing came back yet, so the same request is simply asked again a few times, with the wait
// growing, before the error reaches the chat. Once tokens have arrived a retry would double
// them, so the error stands and the Retry button takes over.
const RETRY_WAITS = [2000, 5000, 10000];
function networkError(error) {
 if (error?.name === 'AbortError') return false;
 if (error instanceof ProviderError) return error.code === 'network';
 return error?.name === 'DeepSeekError' && typeof error.message === 'string' && /connect/i.test(error.message);
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
 const stop = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
 const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
 if (signal?.aborted) stop();
 else signal?.addEventListener('abort', stop, { once: true });
});
async function resilient(config, options) {
 const total = RETRY_WAITS.length + 1;
 for (let attempt = 1; ; attempt++) {
  try {
   return await stream(config, options);
  } catch (error) {
   const empty = !error?.partial?.content && !error?.partial?.reasoning;
   if (attempt >= total || !empty || !networkError(error) || options.signal?.aborted) throw error;
   const wait = RETRY_WAITS[attempt - 1];
   try { options.onRetry?.({ attempt, total, wait, error }); } catch {}
   await sleep(wait, options.signal);
  }
 }
}

// Short side jobs, such as naming a chat or compacting it, think as little as the model allows.
async function complete(config, { messages, signal, maxTokens = 40 }) {
 if (config.provider === 'deepseek') return DeepSeek.complete({ key: config.key, model: config.model, messages, signal, maxTokens });
 const efforts = config.efforts || [];
 const effort = efforts.includes('none') ? 'none' : efforts.find(level => level !== 'default') || '';
 const room = config.provider === 'anthropic' ? Math.max(maxTokens, 2048) : maxTokens;
 const result = await viaMain({ ...config, effort }, { messages, signal, maxTokens: room });
 return result.content.trim();
}

async function models(provider, key) {
 if (provider === 'deepseek') return (await DeepSeek.listModels(key)).map(model => ({ ...model, provider: 'deepseek', api: model.id }));
 if (!bridge) return [];
 const reply = await bridge.models(provider, key);
 if (reply.error) throw new ProviderError(explain(provider, reply.error), reply.error.status);
 return reply.models;
}

window.Providers = { stream, resilient, complete, models, NAMES, available: !!bridge };
})();
