/**
 * Multi-Media Send Service
 * Handles sending 1-3 media items separately with priority ordering
 * Audio > Video > Photo, no captions, separate messages
 */

const { getTokenBySlug } = require('./tokenService');
const telegramClient = require('./telegramClient');
const { observe } = require('./metricsService');
const { getCachedFileId, createCacheEntry } = require('./mediaService');
const { enqueuePrewarm } = require('./mediaPrewarmWorker');
const crypto = require('crypto');

/**
 * Busca r2_key de uma mídia pelo sha256 e kind
 */
async function getMediaR2Key(pool, bot_slug, sha256, kind) {
  try {
    const query = `
      SELECT r2_key, bytes
      FROM media_store
      WHERE bot_slug = $1 AND sha256 = $2 AND kind = $3
      LIMIT 1
    `;
    
    const result = await pool.query(query, [bot_slug, sha256, kind]);
    
    if (result.rowCount === 0) {
      console.warn('[MEDIA][R2_KEY][NOT_FOUND]', { bot_slug, sha256, kind });
      return null;
    }
    
    return {
      r2_key: result.rows[0].r2_key,
      bytes: result.rows[0].bytes
    };
  } catch (err) {
    console.error('[MEDIA][R2_KEY][ERR]', { bot_slug, sha256, kind, error: err.message });
    return null;
  }
}

/**
 * Sorts media refs by priority: audio > video > photo
 */
function sortByPriority(mediaRefs) {
  const priority = { audio: 0, video: 1, photo: 2 };
  
  return [...mediaRefs].sort((a, b) => {
    const priorityDiff = priority[a.kind] - priority[b.kind];
    if (priorityDiff !== 0) return priorityDiff;
    return 0; // Keep original order for same type
  });
}

/**
 * Generates deterministic event_id for media send
 */
function generateMediaEventId(slug, kind, sha256, chatId) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `md:${kind}:${sha256.slice(0, 8)}:${chatId}:${date}`;
}

/**
 * Sends a single media item with fallback and pre-warm
 */
async function sendSingleMedia(pool, slug, chat_id, mediaRef, purpose, requestId) {
  const { sha256, kind, r2_key, bytes } = mediaRef;
  const startTime = Date.now();
  
  try {
    // Get bot token
    const token = await getTokenBySlug(pool, slug);
    if (!token) {
      throw new Error('BOT_TOKEN_NOT_FOUND');
    }
    
    // Check cache first
    let cached = await getCachedFileId(pool, slug, sha256, kind);
    
    if (!cached || cached.status !== 'ready') {
      // Usar r2_key do mediaRef se disponível, senão buscar
      let mediaR2Key = r2_key;
      let mediaBytes = bytes;
      
      if (!mediaR2Key) {
        const mediaInfo = await getMediaR2Key(pool, slug, sha256, kind);
        
        if (!mediaInfo || !mediaInfo.r2_key) {
          console.error('[MULTI_MEDIA_SEND][NO_R2_KEY]', {
            request_id: requestId,
            slug,
            sha256: sha256.slice(0, 8),
            kind,
            chat_id: chat_id
          });
          throw new Error('MEDIA_R2_KEY_NOT_FOUND');
        }
        
        mediaR2Key = mediaInfo.r2_key;
        mediaBytes = mediaInfo.bytes;
      }
      
      // Try to pre-warm if not ready
      console.info('[MULTI_MEDIA_SEND][PREWARM]', {
        request_id: requestId,
        slug,
        sha256: sha256.slice(0, 8),
        kind,
        chat_id: chat_id,
        cache_status: cached?.status || 'missing',
        r2_key: mediaR2Key,
        from_media_ref: !!r2_key
      });
      
      await enqueuePrewarm({
        pool,
        bot_slug: slug,
        sha256,
        kind,
        r2_key: mediaR2Key,
        bytes: mediaBytes,
        priority: kind === 'audio' ? 300 : kind === 'photo' ? 200 : 100 // Prioridade explícita
      });
      
      // Try cache again after pre-warm enqueue
      cached = await getCachedFileId(pool, slug, sha256, kind);
    }
    
    let result;
    const telegramStart = Date.now();
    
    if (cached && cached.file_id) {
      // Use cached file_id
      switch (kind) {
        case 'photo':
          result = await telegramClient.sendPhoto(token, chat_id, cached.file_id, {});
          break;
        case 'video':
          result = await telegramClient.sendVideo(token, chat_id, cached.file_id, {});
          break;
        case 'audio':
          result = await telegramClient.sendAudio(token, chat_id, cached.file_id, {});
          break;
        default:
          throw new Error(`UNSUPPORTED_MEDIA_KIND: ${kind}`);
      }
      
      const totalLat = Date.now() - startTime;
      
      // Metrics
      observe('media_send_attempt_ms', totalLat, { bot: slug, kind, cache_hit: true });
      if (result.http_latency_ms) {
        observe('telegram_http_ms', result.http_latency_ms, { bot: slug, method: `send_${kind}` });
      }
      
      console.info('[MULTI_MEDIA_SEND][OK]', {
        request_id: requestId,
        slug,
        chat_id: chat_id,
        kind,
        purpose,
        message_id: result.message_id,
        cache_hit: true,
        send_attempt_ms: totalLat,
        telegram_http_ms: result.http_latency_ms || (Date.now() - telegramStart)
      });
      
      return {
        ok: true,
        message_id: result.message_id,
        kind,
        cache_hit: true,
        lat_ms: totalLat,
        telegram_lat_ms: result.http_latency_ms || (Date.now() - telegramStart)
      };
      
    } else {
      // Fallback: try direct upload (should rarely happen)
      console.warn('[MULTI_MEDIA_SEND][FALLBACK]', {
        request_id: requestId,
        slug,
        sha256: sha256.slice(0, 8),
        kind,
        chat_id: chat_id,
        reason: 'cache_miss_or_error'
      });
      
      // For now, we'll fail gracefully - in a full implementation
      // you might want to fetch from R2 and upload here
      throw new Error('MEDIA_NOT_READY_IN_CACHE');
    }
    
  } catch (err) {
    const totalLat = Date.now() - startTime;
    
    console.error('[MULTI_MEDIA_SEND][ERR]', {
      request_id: requestId,
      slug,
      chat_id: chat_id,
      kind,
      purpose,
      error: err.message,
      send_attempt_ms: totalLat
    });
    
    // Metrics
    observe('media_send_attempt_ms', totalLat, { bot: slug, kind, cache_hit: false });
    observe('media_send_error', 1, { bot: slug, kind, error: err.message });
    
    return {
      ok: false,
      kind,
      error: err.message,
      lat_ms: totalLat
    };
  }
}

/**
 * Sends multiple media items in priority order
 * Each media is sent as a separate message without captions
 */
async function sendMultipleMedias(pool, params) {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  const {
    slug,
    chat_id,
    media_refs,
    purpose = 'unknown'
  } = params;
  
  // Validation
  if (!slug) throw new Error('MISSING_SLUG');
  if (!chat_id) throw new Error('MISSING_CHAT_ID');
  if (!media_refs || !Array.isArray(media_refs)) {
    throw new Error('MISSING_MEDIA_REFS');
  }
  if (media_refs.length === 0) {
    return { ok: true, results: [], total_ms: 0 };
  }
  if (media_refs.length > 3) {
    throw new Error('TOO_MANY_MEDIA_REFS');
  }
  
  console.info('[MULTI_MEDIA_SEND][START]', {
    request_id: requestId,
    slug,
    chat_id: chat_id,
    media_count: media_refs.length,
    purpose
  });
  
  try {
    // Sort by priority: audio > video > photo
    const sortedMediaRefs = sortByPriority(media_refs);
    
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    
    // Send each media item separately
    for (const mediaRef of sortedMediaRefs) {
      const event_id = generateMediaEventId(slug, mediaRef.kind, mediaRef.sha256, chat_id);
      
      const result = await sendSingleMedia(pool, slug, chat_id, mediaRef, purpose, requestId);
      
      results.push({
        ...result,
        event_id,
        sha256: mediaRef.sha256
      });
      
      if (result.ok) {
        successCount++;
        // Log gateway event for each successful media send
        if (!process.env.DISABLE_GATEWAY_EVENTS) {
          // TODO: Add gateway event logging here if needed
        }
      } else {
        errorCount++;
      }
    }
    
    const totalLat = Date.now() - startTime;
    
    console.info('[MULTI_MEDIA_SEND][COMPLETE]', {
      request_id: requestId,
      slug,
      chat_id: chat_id,
      purpose,
      total_media: media_refs.length,
      success_count: successCount,
      error_count: errorCount,
      total_ms: totalLat
    });
    
    // Overall metrics
    observe('multi_media_send_ms', totalLat, { 
      bot: slug, 
      media_count: media_refs.length,
      purpose 
    });
    
    return {
      ok: successCount > 0,
      results,
      summary: {
        total: media_refs.length,
        success: successCount,
        errors: errorCount
      },
      total_ms: totalLat
    };
    
  } catch (err) {
    const totalLat = Date.now() - startTime;
    
    console.error('[MULTI_MEDIA_SEND][FATAL_ERR]', {
      request_id: requestId,
      slug,
      chat_id: chat_id,
      purpose,
      error: err.message,
      total_ms: totalLat
    });
    
    throw err;
  }
}

module.exports = {
  sendMultipleMedias,
  sortByPriority,
  generateMediaEventId
};
