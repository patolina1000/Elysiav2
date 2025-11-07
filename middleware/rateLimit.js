/**
 * Rate limiting middleware para proteger Admin API
 * Previne brute force e abuso
 */

// Store em memória (para produção, considerar Redis)
const rateLimitStore = new Map();

// Configurações
const WINDOW_MS = 60 * 1000; // 1 minuto
const MAX_REQUESTS = 100; // 100 requests por minuto por IP
const STRICT_WINDOW_MS = 5 * 60 * 1000; // 5 minutos para endpoints sensíveis
const STRICT_MAX_REQUESTS = 10; // 10 requests por 5 minutos

/**
 * Limpa entradas expiradas do rate limit store
 */
function cleanupExpired() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, data] of rateLimitStore.entries()) {
    if (now - data.resetTime > 0) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.info('[RATE_LIMIT][CLEANUP]', {
      cleaned,
      remaining: rateLimitStore.size
    });
  }
}

// Cleanup automático a cada 5 minutos
const cleanupInterval = setInterval(cleanupExpired, 5 * 60 * 1000);
cleanupInterval.unref();

/**
 * Obtém IP do cliente (considera proxies e load balancers)
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         'unknown';
}

/**
 * Rate limiter padrão (100 req/min)
 */
function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const key = `standard:${ip}`;
  const now = Date.now();
  
  let record = rateLimitStore.get(key);
  
  if (!record || now > record.resetTime) {
    // Nova janela
    record = {
      count: 0,
      resetTime: now + WINDOW_MS
    };
    rateLimitStore.set(key, record);
  }
  
  record.count++;
  
  // Headers informativos
  res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, MAX_REQUESTS - record.count));
  res.setHeader('X-RateLimit-Reset', new Date(record.resetTime).toISOString());
  
  if (record.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    
    console.warn('[RATE_LIMIT][EXCEEDED]', {
      ip,
      path: req.path,
      count: record.count,
      limit: MAX_REQUESTS,
      retry_after_seconds: retryAfter
    });
    
    return res.status(429).json({
      ok: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests. Try again in ${retryAfter} seconds.`,
      retry_after: retryAfter
    });
  }
  
  next();
}

/**
 * Rate limiter estrito para endpoints sensíveis (10 req/5min)
 * Usar em: login, token save, delete bot
 */
function strictRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const key = `strict:${ip}:${req.path}`;
  const now = Date.now();
  
  let record = rateLimitStore.get(key);
  
  if (!record || now > record.resetTime) {
    // Nova janela
    record = {
      count: 0,
      resetTime: now + STRICT_WINDOW_MS
    };
    rateLimitStore.set(key, record);
  }
  
  record.count++;
  
  // Headers informativos
  res.setHeader('X-RateLimit-Limit', STRICT_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, STRICT_MAX_REQUESTS - record.count));
  res.setHeader('X-RateLimit-Reset', new Date(record.resetTime).toISOString());
  
  if (record.count > STRICT_MAX_REQUESTS) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    
    console.warn('[RATE_LIMIT][STRICT][EXCEEDED]', {
      ip,
      path: req.path,
      count: record.count,
      limit: STRICT_MAX_REQUESTS,
      retry_after_seconds: retryAfter
    });
    
    return res.status(429).json({
      ok: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests to sensitive endpoint. Try again in ${retryAfter} seconds.`,
      retry_after: retryAfter
    });
  }
  
  next();
}

/**
 * Obtém estatísticas de rate limiting
 */
function getStats() {
  const now = Date.now();
  let activeStandard = 0;
  let activeStrict = 0;
  let expiredCount = 0;
  
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      expiredCount++;
    } else if (key.startsWith('strict:')) {
      activeStrict++;
    } else {
      activeStandard++;
    }
  }
  
  return {
    total: rateLimitStore.size,
    active_standard: activeStandard,
    active_strict: activeStrict,
    expired: expiredCount,
    memory_kb: Math.round((rateLimitStore.size * 0.1)) // ~100 bytes por entrada
  };
}

/**
 * Limpa rate limit para um IP específico (útil para testes/debug)
 */
function clearIp(ip) {
  let cleared = 0;
  for (const key of rateLimitStore.keys()) {
    if (key.includes(ip)) {
      rateLimitStore.delete(key);
      cleared++;
    }
  }
  return cleared;
}

module.exports = {
  rateLimit,
  strictRateLimit,
  getStats,
  clearIp,
  getClientIp
};
