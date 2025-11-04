// scripts/seed-dev-event.js
/* eslint-disable no-console */
const { Client } = require('pg');

function yyyymmdd(d=new Date()) {
  return d.toISOString().slice(0,10).replace(/-/g,'');
}
function monthKey(d=new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  return `${y}_${m}`; // ex: 2025_11
}

async function run() {
  const cn = process.env.DATABASE_URL;
  const slug = process.argv[2] || process.env.SEED_SLUG || 'bot-exemplo';
  const tg = BigInt(process.argv[3] || process.env.SEED_TG_ID || 111111);
  const today = new Date();
  const eventDate = yyyymmdd(today);
  const event_id = `st:${slug}:${tg}:${eventDate}`;
  const part = `public.funnel_events_${monthKey(today)}`;

  if (!cn) { console.error('[SEED] DATABASE_URL não definido'); process.exit(2); }

  const client = new Client({ connectionString: cn, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    // garante que a partição do mês existe
    await client.query(`SELECT to_regclass($1)`, [part]).then(async r => {
      if (!r.rows[0].to_regclass) throw new Error(`Partição ausente: ${part}`);
    });

    // upsert direto no filho (há UNIQUE(event_id) na partição)
    const sql = `
      INSERT INTO ${part} (bot_id, bot_slug, event_name, event_id, tg_id, occurred_at)
      VALUES ((SELECT id FROM public.bots WHERE slug=$1), $1, 'start', $2, $3, now())
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id
    `;
    const r = await client.query(sql, [slug, event_id, tg.toString()]);
    const dedup = r.rowCount === 0;
    console.log(JSON.stringify({ ok: true, event_id, dedup }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('[SEED] error:', e && e.stack || e);
    process.exit(1);
  } finally {
    try { await client.end(); } catch {}
  }
}
run();
