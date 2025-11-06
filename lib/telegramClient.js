/**
 * Cliente HTTP otimizado para Telegram Bot API
 * Usa o dispatcher global do undici configurado no server.js
 */

const { fetch } = require('undici');

/**
 * Faz requisição HTTP com keep-alive (usa dispatcher global)
 * @param {string} url - URL completa
 * @param {object} options - Opções do fetch
 * @returns {Promise<Response>}
 */
async function fetchWithKeepAlive(url, options = {}) {
  // Reutiliza o dispatcher global configurado no server.js
  return await fetch(url, options);
}

/**
 * Warm-up: faz getMe para pré-estabelecer conexão TLS
 * @param {string} token - Token do bot
 * @returns {Promise<object>}
 */
async function warmUp(token) {
  const url = `https://api.telegram.org/bot${token}/getMe`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetchWithKeepAlive(url, {
      method: 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const data = await response.json();
    
    if (data.ok) {
      console.info('[TELEGRAM][WARMUP][OK]', {
        bot_id: data.result?.id,
        username: data.result?.username
      });
      return { ok: true, result: data.result };
    }
    
    console.warn('[TELEGRAM][WARMUP][ERR]', { error: data.description });
    return { ok: false, error: data.description };
  } catch (err) {
    console.warn('[TELEGRAM][WARMUP][EXCEPTION]', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Envia mensagem via Telegram com keep-alive e métricas
 * @param {string} token - Token do bot
 * @param {string} chat_id - ID do chat
 * @param {string} text - Texto da mensagem
 * @param {object} options - Opções adicionais
 * @returns {Promise<object>}
 */
async function sendMessage(token, chat_id, text, options = {}) {
  const {
    parse_mode = 'MarkdownV2',
    disable_web_page_preview = true,
    retries = 3
  } = options;
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    const httpStart = Date.now();
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetchWithKeepAlive(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id,
          text,
          parse_mode,
          disable_web_page_preview
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      const httpLatency = Date.now() - httpStart;
      const data = await response.json();
      
      if (data.ok) {
        return {
          ok: true,
          message_id: data.result?.message_id,
          username: data.result?.chat?.username,
          http_latency_ms: httpLatency
        };
      }
      
      // Erro 429 - Rate limit do Telegram
      if (response.status === 429) {
        const retry_after = data.parameters?.retry_after || 1;
        console.warn('[TELEGRAM][429]', { retry_after, attempt, http_latency_ms: httpLatency });
        
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, retry_after * 1000));
          continue;
        }
        
        // Retornar 429 com retry_after para backoff inteligente
        return {
          ok: false,
          status_code: 429,
          error: 'RATE_LIMIT_EXCEEDED',
          description: data.description,
          retry_after: retry_after,
          http_latency_ms: httpLatency
        };
      }
      
      return {
        ok: false,
        status_code: response.status,
        error: data.description || 'TELEGRAM_ERROR',
        description: data.description,
        http_latency_ms: httpLatency
      };
      
    } catch (err) {
      const httpLatency = Date.now() - httpStart;
      
      if (err.name === 'AbortError') {
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
          continue;
        }
        return { ok: false, error: 'TIMEOUT', http_latency_ms: httpLatency };
      }
      
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
        continue;
      }
      
      return { ok: false, error: 'NETWORK_ERROR', description: err.message, http_latency_ms: httpLatency };
    }
  }
  
  return { ok: false, error: 'MAX_RETRIES_EXCEEDED' };
}

module.exports = {
  sendMessage,
  warmUp
};
