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
  // Se o bot não existir, o SELECT não retorna linha → INSERT não acontece (no-op, sem erro)
  const sql = `
    INSERT INTO ${part} (bot_id, bot_slug, event_name, event_id, tg_id, occurred_at)
    SELECT b.id, $1, 'start', $2, $3, $4
    FROM public.bots b
    WHERE b.slug = $1
    ON CONFLICT (event_id) DO NOTHING
  `;
  const vals = [slug, event_id, String(tg_id), occurredAt];
  const r = await pool.query(sql, vals);
  const dedup = r.rowCount === 0;
  try { console.info('[FUNNEL][START]', { slug, tg_id, event_id, dedup }); } catch {}
  return { ok: true, dedup, event_id };
}

module.exports = { insertStartEvent };
