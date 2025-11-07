require('dotenv').config();
const { Client } = require('pg');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  const bot_slug = 'bot1';
  const telegram_id = 7205343917;
  const downsell_id = 2;
  const scheduled_at = new Date(Date.now() + 2 * 60 * 1000); // 2 min
  const event_id = `dw:${bot_slug}:${telegram_id}:${downsell_id}:st:${scheduled_at.toISOString()}`;
  
  console.log('🧪 Tentando inserir downsell na fila...\n');
  console.log('Dados:');
  console.log('  bot_slug:', bot_slug);
  console.log('  telegram_id:', telegram_id);
  console.log('  downsell_id:', downsell_id);
  console.log('  event_id:', event_id);
  console.log('  scheduled_at:', scheduled_at.toISOString());
  console.log('');
  
  try {
    const query = `
      INSERT INTO public.downsells_queue (
        slug, bot_slug, tg_id, telegram_id, downsell_id, transaction_id, trigger,
        schedule_at, scheduled_at, status, meta, event_id, created_at, updated_at
      )
      VALUES ($1, $1, $2, $3, $4, NULL, 'start', $5, $5, 'pending', $6, $7, now(), now())
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id, downsell_id, bot_slug, telegram_id, scheduled_at
    `;
    
    const meta = JSON.stringify({ test: true });
    const result = await client.query(query, [
      bot_slug,
      String(telegram_id),
      telegram_id,
      downsell_id,
      scheduled_at,
      meta,
      event_id
    ]);
    
    if (result.rows.length > 0) {
      console.log('✅ Downsell inserido com sucesso!');
      console.log('   ID:', result.rows[0].id);
    } else {
      console.log('⚠️  Downsell já existe (ON CONFLICT ignorado)');
    }
  } catch (err) {
    console.error('❌ Erro ao inserir:', err.message);
    console.error('\nDetalhes:', err.detail || 'N/A');
    console.error('Hint:', err.hint || 'N/A');
  }
  
  await client.end();
}

run().catch(err => {
  console.error('❌ Erro fatal:', err.message);
  process.exit(1);
});
