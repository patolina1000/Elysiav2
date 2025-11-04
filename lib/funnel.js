// lib/funnel.js
const { partitionName } = require('./partitions');

/**
 * Insere evento de start direto na partição do mês.
 * Dedupe forte por event_id (UNIQUE em cada partição).
 * event_id = st:<slug>:<tg_id>:<yyyymmdd>
 */
async function insertStartEvent(pool, { slug, tg_id, occurredAt = new Date() }) {
  if (!pool) return { ok: false, reason: 'NO_DB' };
  const part = partitionName(occurredAt);
  const yyyymmdd = occurredAt.toISOString().slice(0,10).replace(/-/g,'');
  const event_id = `st:${slug}:${tg_id}:${yyyymmdd}`;
  const sql = `
    INSERT INTO ${part} (bot_id, bot_slug, event_name, event_id, tg_id, occurred_at)
    VALUES ((SELECT id FROM public.bots WHERE slug=$1), $1, 'start', $2, $3, $4)
    ON CONFLICT (event_id) DO NOTHING
  `;
  const vals = [slug, event_id, String(tg_id), occurredAt];
  const r = await pool.query(sql, vals);
  return { ok: true, dedup: r.rowCount === 0, event_id };
}

module.exports = { insertStartEvent };
