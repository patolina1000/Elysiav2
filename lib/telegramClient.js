/**
 * Cliente HTTP otimizado para Telegram Bot API
 * Usa o dispatcher global do undici configurado no server.js
 */

const { fetch, FormData, File } = require('undici');

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

/**
 * Envia foto via Telegram (multipart ou file_id)
 * @param {string} token - Token do bot
 * @param {string} chat_id - ID do chat
 * @param {Buffer|string} photo - Buffer da imagem ou file_id
 * @param {object} options - Opções adicionais
 * @returns {Promise<object>}
 */
async function sendPhoto(token, chat_id, photo, options = {}) {
  const {
    caption = '',
    parse_mode,
    filename = 'photo.jpg',
    retries = 3
  } = options;
  
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  const isFileId = typeof photo === 'string';
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    const httpStart = Date.now();
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s para upload
      
      let response;
      
      if (isFileId) {
        // Enviar usando file_id (rápido)
        response = await fetchWithKeepAlive(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id,
            photo,
            caption,
            parse_mode
          }),
          signal: controller.signal
        });
      } else {
        // Enviar usando multipart (upload de arquivo)
        const formData = new FormData();
        formData.append('chat_id', chat_id.toString());
        
        // Criar Blob com o buffer
        const blob = new Blob([photo], { type: 'image/jpeg' });
        formData.append('photo', blob, filename);
        
        if (caption) formData.append('caption', caption);
        if (parse_mode) formData.append('parse_mode', parse_mode);
        
        response = await fetchWithKeepAlive(url, {
          method: 'POST',
          body: formData,
          signal: controller.signal
        });
      }
      
      clearTimeout(timeout);
      
      const httpLatency = Date.now() - httpStart;
      const data = await response.json();
      
      if (data.ok) {
        const result = data.result;
        const photo_sizes = result.photo || [];
        const largest_photo = photo_sizes[photo_sizes.length - 1] || {};
        
        return {
          ok: true,
          message_id: result.message_id,
          file_id: largest_photo.file_id,
          file_unique_id: largest_photo.file_unique_id,
          file_size: largest_photo.file_size,
          width: largest_photo.width,
          height: largest_photo.height,
          http_latency_ms: httpLatency
        };
      }
      
      // Erro 429 - Rate limit do Telegram
      if (response.status === 429) {
        const retry_after = data.parameters?.retry_after || 1;
        console.warn('[TELEGRAM][PHOTO][429]', { retry_after, attempt, http_latency_ms: httpLatency });
        
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, retry_after * 1000));
          continue;
        }
        
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

/**
 * Envia vídeo via Telegram (multipart ou file_id)
 * @param {string} token - Token do bot
 * @param {string} chat_id - ID do chat
 * @param {Buffer|string} video - Buffer do vídeo ou file_id
 * @param {object} options - Opções adicionais
 * @returns {Promise<object>}
 */
async function sendVideo(token, chat_id, video, options = {}) {
  const {
    caption = '',
    parse_mode,
    filename = 'video.mp4',
    duration,
    width,
    height,
    retries = 3
  } = options;
  
  const url = `https://api.telegram.org/bot${token}/sendVideo`;
  const isFileId = typeof video === 'string';
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    const httpStart = Date.now();
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s para upload de vídeo
      
      let response;
      
      if (isFileId) {
        // Enviar usando file_id (rápido)
        response = await fetchWithKeepAlive(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id,
            video,
            caption,
            parse_mode,
            duration,
            width,
            height
          }),
          signal: controller.signal
        });
      } else {
        // Enviar usando multipart (upload de arquivo)
        const formData = new FormData();
        formData.append('chat_id', chat_id.toString());
        
        // Criar Blob com o buffer
        const blob = new Blob([video], { type: 'video/mp4' });
        formData.append('video', blob, filename);
        
        if (caption) formData.append('caption', caption);
        if (parse_mode) formData.append('parse_mode', parse_mode);
        if (duration) formData.append('duration', duration.toString());
        if (width) formData.append('width', width.toString());
        if (height) formData.append('height', height.toString());
        
        response = await fetchWithKeepAlive(url, {
          method: 'POST',
          body: formData,
          signal: controller.signal
        });
      }
      
      clearTimeout(timeout);
      
      const httpLatency = Date.now() - httpStart;
      const data = await response.json();
      
      if (data.ok) {
        const result = data.result;
        const video_data = result.video || {};
        
        return {
          ok: true,
          message_id: result.message_id,
          file_id: video_data.file_id,
          file_unique_id: video_data.file_unique_id,
          file_size: video_data.file_size,
          width: video_data.width,
          height: video_data.height,
          duration: video_data.duration,
          http_latency_ms: httpLatency
        };
      }
      
      // Erro 429 - Rate limit do Telegram
      if (response.status === 429) {
        const retry_after = data.parameters?.retry_after || 1;
        console.warn('[TELEGRAM][VIDEO][429]', { retry_after, attempt, http_latency_ms: httpLatency });
        
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, retry_after * 1000));
          continue;
        }
        
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

/**
 * Envia documento via Telegram (multipart ou file_id)
 * @param {string} token - Token do bot
 * @param {string} chat_id - ID do chat
 * @param {Buffer|string} document - Buffer do documento ou file_id
 * @param {object} options - Opções adicionais
 * @returns {Promise<object>}
 */
async function sendDocument(token, chat_id, document, options = {}) {
  const {
    caption = '',
    parse_mode,
    filename = 'document.pdf',
    retries = 3
  } = options;
  
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const isFileId = typeof document === 'string';
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    const httpStart = Date.now();
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s para upload
      
      let response;
      
      if (isFileId) {
        // Enviar usando file_id (rápido)
        response = await fetchWithKeepAlive(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id,
            document,
            caption,
            parse_mode
          }),
          signal: controller.signal
        });
      } else {
        // Enviar usando multipart (upload de arquivo)
        const formData = new FormData();
        formData.append('chat_id', chat_id.toString());
        
        // Criar Blob com o buffer
        const blob = new Blob([document], { type: 'application/octet-stream' });
        formData.append('document', blob, filename);
        
        if (caption) formData.append('caption', caption);
        if (parse_mode) formData.append('parse_mode', parse_mode);
        
        response = await fetchWithKeepAlive(url, {
          method: 'POST',
          body: formData,
          signal: controller.signal
        });
      }
      
      clearTimeout(timeout);
      
      const httpLatency = Date.now() - httpStart;
      const data = await response.json();
      
      if (data.ok) {
        const result = data.result;
        const document_data = result.document || {};
        
        return {
          ok: true,
          message_id: result.message_id,
          file_id: document_data.file_id,
          file_unique_id: document_data.file_unique_id,
          file_size: document_data.file_size,
          file_name: document_data.file_name,
          http_latency_ms: httpLatency
        };
      }
      
      // Erro 429 - Rate limit do Telegram
      if (response.status === 429) {
        const retry_after = data.parameters?.retry_after || 1;
        console.warn('[TELEGRAM][DOCUMENT][429]', { retry_after, attempt, http_latency_ms: httpLatency });
        
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, retry_after * 1000));
          continue;
        }
        
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
  sendPhoto,
  sendVideo,
  sendDocument,
  warmUp
};
