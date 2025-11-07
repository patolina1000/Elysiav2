/**
 * Cleanup periódico de rate limiters para evitar memory leaks
 * Limpa entradas inativas de Maps que crescem indefinidamente
 */

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const MAX_IDLE_TIME_MS = 10 * 60 * 1000;   // 10 minutos sem uso

/**
 * Inicia cleanup periódico de rate limiters
 * @param {object} rateLimiters - Objeto com Maps byBot e byChat
 */
function startCleanup(rateLimiters) {
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleanedBot = 0;
    let cleanedChat = 0;
    
    // Cleanup byBot (token bucket por bot)
    for (const [slug, limit] of rateLimiters.byBot.entries()) {
      const idleTime = now - limit.lastRefill;
      if (idleTime > MAX_IDLE_TIME_MS) {
        rateLimiters.byBot.delete(slug);
        cleanedBot++;
      }
    }
    
    // Cleanup byChat (timestamp de último envio por chat)
    for (const [chatId, lastSent] of rateLimiters.byChat.entries()) {
      const idleTime = now - lastSent;
      if (idleTime > MAX_IDLE_TIME_MS) {
        rateLimiters.byChat.delete(chatId);
        cleanedChat++;
      }
    }
    
    // Log apenas se houver limpeza
    if (cleanedBot > 0 || cleanedChat > 0) {
      console.info('[RATE_LIMITER][CLEANUP]', {
        cleaned_bots: cleanedBot,
        cleaned_chats: cleanedChat,
        remaining_bots: rateLimiters.byBot.size,
        remaining_chats: rateLimiters.byChat.size,
        total_memory_entries: rateLimiters.byBot.size + rateLimiters.byChat.size
      });
    }
  }, CLEANUP_INTERVAL_MS);
  
  // Permitir que processo termine mesmo com timer ativo (previne warning em testes)
  cleanupInterval.unref();
  
  // Retornar função para parar o cleanup (útil para testes)
  return () => clearInterval(cleanupInterval);
}

/**
 * Obtém estatísticas de memória dos rate limiters
 * @param {object} rateLimiters - Objeto com Maps byBot e byChat
 * @returns {object} Estatísticas
 */
function getStats(rateLimiters) {
  const now = Date.now();
  let botsActive = 0;
  let botsIdle = 0;
  let chatsActive = 0;
  let chatsIdle = 0;
  
  // Contar bots ativos vs inativos
  for (const [slug, limit] of rateLimiters.byBot.entries()) {
    const idleTime = now - limit.lastRefill;
    if (idleTime < MAX_IDLE_TIME_MS) {
      botsActive++;
    } else {
      botsIdle++;
    }
  }
  
  // Contar chats ativos vs inativos
  for (const [chatId, lastSent] of rateLimiters.byChat.entries()) {
    const idleTime = now - lastSent;
    if (idleTime < MAX_IDLE_TIME_MS) {
      chatsActive++;
    } else {
      chatsIdle++;
    }
  }
  
  return {
    bots: {
      total: rateLimiters.byBot.size,
      active: botsActive,
      idle: botsIdle
    },
    chats: {
      total: rateLimiters.byChat.size,
      active: chatsActive,
      idle: chatsIdle
    },
    memory: {
      total_entries: rateLimiters.byBot.size + rateLimiters.byChat.size,
      estimated_kb: Math.round((rateLimiters.byBot.size + rateLimiters.byChat.size) * 0.5) // ~500 bytes por entrada
    }
  };
}

module.exports = {
  startCleanup,
  getStats,
  CLEANUP_INTERVAL_MS,
  MAX_IDLE_TIME_MS
};
