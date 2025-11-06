const { getTokenBySlug } = require('./tokenService');

/**
 * Serviço de envio de mensagens via Telegram Bot API
 * Contrato interno para uso do token criptografado
 * IMPLEMENTAÇÃO COMPLETA NO PROMPT 06
 */

/**
 * Envia uma mensagem de texto via Telegram
 * @param {object} pool - Pool de conexão PostgreSQL
 * @param {object} params - Parâmetros do envio
 * @param {string} params.slug - Slug do bot
 * @param {string|number} params.chat_id - ID do chat de destino
 * @param {string} params.text - Texto da mensagem
 * @param {string} [params.parse_mode='MarkdownV2'] - Modo de parse (MarkdownV2, HTML, Markdown)
 * @returns {Promise<{ok: boolean, message_id?: number, error?: string, latency_ms: number}>}
 */
async function sendText(pool, { slug, chat_id, text, parse_mode = 'MarkdownV2' }) {
  const startTime = Date.now();
  
  // Validações básicas
  if (!slug || typeof slug !== 'string') {
    return {
      ok: false,
      error: 'INVALID_SLUG',
      latency_ms: Date.now() - startTime
    };
  }
  
  if (!chat_id) {
    return {
      ok: false,
      error: 'INVALID_CHAT_ID',
      latency_ms: Date.now() - startTime
    };
  }
  
  if (!text || typeof text !== 'string') {
    return {
      ok: false,
      error: 'INVALID_TEXT',
      latency_ms: Date.now() - startTime
    };
  }
  
  try {
    // Obter token do bot
    const token = await getTokenBySlug(pool, slug);
    
    if (!token) {
      console.warn('[TELEGRAM_SENDER][SEND_TEXT][NO_TOKEN]', { slug });
      return {
        ok: false,
        error: 'NO_TOKEN_CONFIGURED',
        latency_ms: Date.now() - startTime
      };
    }
    
    // IMPLEMENTAÇÃO COMPLETA NO PROMPT 06
    // Por enquanto, apenas retorna estrutura de sucesso simulado
    console.info('[TELEGRAM_SENDER][SEND_TEXT][STUB]', {
      slug,
      chat_id,
      text_length: text.length,
      parse_mode,
      message: 'Implementação completa no PROMPT 06'
    });
    
    const latency = Date.now() - startTime;
    
    return {
      ok: true,
      message_id: null, // Será preenchido na implementação real
      stub: true,
      latency_ms: latency
    };
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error('[TELEGRAM_SENDER][SEND_TEXT][ERR]', {
      slug,
      error: err.message,
      latency_ms: latency
    });
    
    return {
      ok: false,
      error: err.message || 'SEND_FAILED',
      latency_ms: latency
    };
  }
}

/**
 * Registra métrica de envio (latência e sucesso/erro)
 * @param {string} slug - Slug do bot
 * @param {boolean} success - Se o envio foi bem-sucedido
 * @param {number} latencyMs - Latência em milissegundos
 */
function recordSendMetric(slug, success, latencyMs) {
  // IMPLEMENTAÇÃO COMPLETA NO PROMPT 06
  console.info('[TELEGRAM_SENDER][METRIC]', {
    slug,
    success,
    latency_ms: latencyMs,
    message: 'Métrica registrada (stub)'
  });
}

module.exports = {
  sendText,
  recordSendMetric
};
