// lib/metrics.js
function recordStartLatency(botSlug, tookMs) {
  try {
    console.info('[METRIC][start_first_send.latency_ms]', { bot: botSlug, took_ms: Math.round(tookMs) });
  } catch {}
}
module.exports = { recordStartLatency };
