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
    return { active: false, message: null, start_media_refs: [], updated_at: null };
  }

  try {
    const result = await pool.query(
      `SELECT start_message, start_media_refs, start_message_updated_at 
       FROM public.bots 
       WHERE slug = $1`,
      [slug]
    );

    if (result.rows.length === 0) {
      return { active: false, message: null, start_media_refs: [], updated_at: null };
    }

    const row = result.rows[0];
    const startMessage = row.start_message || {};
    
    const data = {
      active: startMessage.active || false,
      message: startMessage.message || null,
      start_media_refs: row.start_media_refs || [],
      updated_at: row.start_message_updated_at || null
    };

    // Cachear
    cache.set(slug, { data, timestamp: Date.now() });

    return data;
  } catch (err) {
    console.error('[START_MESSAGE][GET][ERR]', { slug, error: err.message });
    return { active: false, message: null, start_media_refs: [], updated_at: null };
  }
}

/**
 * Salva mensagem inicial
 */
async function saveStartMessage(pool, slug, { active, message, start_media_refs }) {
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

  // Validação e enriquecimento de media_refs
  let enrichedMediaRefs = [];
  
  if (start_media_refs) {
    if (!Array.isArray(start_media_refs)) {
      throw new Error('START_MEDIA_REFS_MUST_BE_ARRAY');
    }
    if (start_media_refs.length > 3) {
      throw new Error('START_MEDIA_REFS_MAX_3');
    }
    
    // Validar e enriquecer cada item com r2_key
    for (const item of start_media_refs) {
      if (!item.sha256 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
        throw new Error('INVALID_MEDIA_SHA256');
      }
      if (!item.kind || !['audio', 'video', 'photo'].includes(item.kind)) {
        throw new Error('INVALID_MEDIA_KIND');
      }
      
      // Se não tem r2_key, buscar do media_store
      if (!item.r2_key) {
        const mediaQuery = `
          SELECT r2_key, bytes
          FROM media_store
          WHERE sha256 = $1 AND kind = $2
          LIMIT 1
        `;
        const mediaResult = await pool.query(mediaQuery, [item.sha256, item.kind]);
        
        if (mediaResult.rowCount > 0) {
          enrichedMediaRefs.push({
            sha256: item.sha256,
            kind: item.kind,
            r2_key: mediaResult.rows[0].r2_key,
            bytes: mediaResult.rows[0].bytes
          });
        } else {
          // Mídia não encontrada, adicionar sem r2_key (vai falhar no envio)
          console.warn('[START_MESSAGE][SAVE][MEDIA_NOT_FOUND]', {
            sha256: item.sha256,
            kind: item.kind
          });
          enrichedMediaRefs.push({
            sha256: item.sha256,
            kind: item.kind
          });
        }
      } else {
        enrichedMediaRefs.push({
          sha256: item.sha256,
          kind: item.kind,
          r2_key: item.r2_key,
          bytes: item.bytes
        });
      }
    }
  }

  const payload = {
    active: !!active,
    message: message || null,
    start_media_refs: enrichedMediaRefs
  };

  try {
    const result = await pool.query(
      `UPDATE public.bots 
       SET start_message = $1, start_media_refs = $2, start_message_updated_at = now() 
       WHERE slug = $3 
       RETURNING start_message_updated_at`,
      [JSON.stringify(payload), JSON.stringify(enrichedMediaRefs), slug]
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
      start_media_refs: enrichedMediaRefs,
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
