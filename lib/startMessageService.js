/**
 * Serviço para gerenciar mensagem inicial personalizada do /start
 * Usa coluna bots.start_message (jsonb) como ponto único de verdade
 */

// Cache em memória (TTL 60s)
const cache = new Map();
const CACHE_TTL_MS = 60000;

/**
 * Limpa cache de um bot
 */
function invalidateCache(slug) {
  cache.delete(slug);
}

/**
 * Obtém mensagem inicial do cache ou DB
 */
async function getStartMessage(pool, slug) {
  // Verificar cache
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Buscar no DB
  if (!pool) {
    return { active: false, message: null, updated_at: null };
  }

  try {
    const result = await pool.query(
      `SELECT start_message, start_message_updated_at 
       FROM public.bots 
       WHERE slug = $1`,
      [slug]
    );

    if (result.rows.length === 0) {
      return { active: false, message: null, updated_at: null };
    }

    const row = result.rows[0];
    const startMessage = row.start_message || {};
    
    const data = {
      active: startMessage.active || false,
      message: startMessage.message || null,
      updated_at: row.start_message_updated_at || null
    };

    // Cachear
    cache.set(slug, { data, timestamp: Date.now() });

    return data;
  } catch (err) {
    console.error('[START_MESSAGE][GET][ERR]', { slug, error: err.message });
    return { active: false, message: null, updated_at: null };
  }
}

/**
 * Salva mensagem inicial
 */
async function saveStartMessage(pool, slug, { active, message }) {
  if (!pool) {
    throw new Error('DATABASE_UNAVAILABLE');
  }

  // Validações
  if (active && !message) {
    throw new Error('MESSAGE_REQUIRED_WHEN_ACTIVE');
  }

  if (message) {
    if (!message.text || typeof message.text !== 'string') {
      throw new Error('MESSAGE_TEXT_REQUIRED');
    }
    if (message.text.length > 4096) {
      throw new Error('MESSAGE_TEXT_TOO_LONG');
    }
    if (message.parse_mode && message.parse_mode !== 'MarkdownV2') {
      throw new Error('ONLY_MARKDOWNV2_SUPPORTED');
    }
  }

  const payload = {
    active: !!active,
    message: message || null
  };

  try {
    const result = await pool.query(
      `UPDATE public.bots 
       SET start_message = $1, start_message_updated_at = now() 
       WHERE slug = $2 
       RETURNING start_message_updated_at`,
      [JSON.stringify(payload), slug]
    );

    if (result.rows.length === 0) {
      throw new Error('BOT_NOT_FOUND');
    }

    const updated_at = result.rows[0].start_message_updated_at;

    // Invalidar cache
    invalidateCache(slug);

    // Log
    console.info('[ADMIN_START_MESSAGE_SAVED]', {
      slug,
      active: payload.active,
      text_len: message?.text?.length || 0
    });

    return {
      active: payload.active,
      message: payload.message,
      updated_at
    };
  } catch (err) {
    console.error('[START_MESSAGE][SAVE][ERR]', { slug, error: err.message });
    throw err;
  }
}

/**
 * Testa envio de mensagem sem salvar
 */
async function testStartMessage(pool, slug, chatId, message) {
  const { sendMessage } = require('./queuedSend');
  
  if (!message || !message.text) {
    throw new Error('MESSAGE_TEXT_REQUIRED');
  }

  if (message.text.length > 4096) {
    throw new Error('MESSAGE_TEXT_TOO_LONG');
  }

  const t0 = Date.now();

  try {
    // Enviar usando a estrutura correta de params
    const result = await sendMessage(pool, {
      slug,
      chat_id: chatId,
      text: message.text,
      parse_mode: message.parse_mode || 'MarkdownV2',
      disable_web_page_preview: message.disable_web_page_preview !== false,
      raw: message.raw || false,
      purpose: 'start-message-test'
    });
    
    const telegram_http_ms = Date.now() - t0;

    if (!result.ok) {
      throw new Error(result.error || 'SEND_FAILED');
    }

    console.info('[ADMIN_START_MESSAGE_TEST_OK]', {
      slug,
      chat_id: chatId,
      telegram_http_ms,
      message_id: result.message_id
    });

    return {
      success: true,
      message_id: result.message_id,
      telegram_http_ms: result.telegram_lat_ms || telegram_http_ms
    };
  } catch (err) {
    const telegram_http_ms = Date.now() - t0;
    
    console.warn('[ADMIN_START_MESSAGE_TEST_ERR]', {
      slug,
      chat_id: chatId,
      telegram_http_ms,
      error: err.message
    });

    throw err;
  }
}

/**
 * Escape MarkdownV2 (reutilizado do sendService)
 */
function escapeMarkdownV2(text) {
  if (!text) return '';
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

module.exports = {
  getStartMessage,
  saveStartMessage,
  testStartMessage,
  invalidateCache,
  escapeMarkdownV2
};
