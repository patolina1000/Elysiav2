/**
 * Configuração fixa de rate limiting e comportamento do sistema
 * Valores de negócio fixos - NÃO carregar do .env
 * NÃO adicionar novas variáveis ao .env
 */

module.exports = {
  // Rate limiting
  RATE_PER_CHAT_RPS: 5,           // 5 mensagens por segundo por chat
  RATE_GLOBAL_RPS: 30,            // 30 mensagens por segundo global (bot inteiro)
  BURST_SIZE: 10,                 // Burst de 10 mensagens (global e por chat)
  
  // Prioridades de envio (menor = maior prioridade)
  // Ordem de drenagem: START > DISPARO > DOWNSELL
  PRIORITY: {
    START: 1,      // /start tem maior prioridade (≤ 0.5s p95)
    DISPARO: 2,    // disparo/broadcast é segunda prioridade
    DOWNSELL: 3    // downsell é menor prioridade
  },
  
  // Backoff para 429 (Telegram) - exponencial por chat
  BACKOFF_429_INITIAL_MS: 1500,   // Iniciar em 1.5s
  BACKOFF_429_MAX_MS: 15000,      // Máximo 15s
  BACKOFF_429_MULTIPLIER: 2,      // Dobrar exponencialmente (1.5 → 3 → 6 → 12 → 15)
  
  // Fallback por chat após 429 repetido (≥3x)
  FALLBACK_CHAT_RPS: 1,           // Reduzir para 1 msg/s por 60s
  FALLBACK_DURATION_MS: 60000,    // Por 60 segundos
  FALLBACK_RECOVERY_STEP: 1,      // Recuperar +1 rps por ciclo até voltar a 5 rps
  
  // Heartbeats (manter conexões quentes)
  HEARTBEAT_HTTP_INTERVAL_MS: 30000,  // 30s por bot (Telegram)
  HEARTBEAT_HTTP_JITTER_MS: 5000,     // Jitter de 0-5s por bot (evitar thundering herd)
  HEARTBEAT_PG_INTERVAL_MS: 60000,    // 60s para Postgres
  
  // Webhook
  WEBHOOK_ACK_IMMEDIATE: true,    // Responder 200 imediatamente (ACK em ~1-5ms)
  
  // Dedupe
  DEDUPE_START_DISABLED: true,    // Sem dedupe no /start (sempre enviar)
  
  // Gateway events (feature flag para dev)
  GATEWAY_EVENTS_DISABLED_BY_DEFAULT: true  // Desligado por padrão em dev (evita I/O no hot-path)
};
