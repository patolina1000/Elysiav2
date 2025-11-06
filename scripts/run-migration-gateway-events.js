require('dotenv').config();
const { Pool } = require('pg');

async function runMigration() {
  console.log('[MIGRATION] Iniciando migração da tabela gateway_events...');
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await pool.query('BEGIN');
    
    // Criar tabela
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.gateway_events (
        id bigserial PRIMARY KEY,
        request_id text NOT NULL,
        slug text NOT NULL,
        chat_id text NOT NULL,
        message_id bigint,
        status text NOT NULL,
        lat_ms integer,
        purpose text NOT NULL,
        dedupe_key text NOT NULL,
        error_code text,
        occurred_at timestamptz DEFAULT now()
      )
    `);
    console.log('[MIGRATION] ✅ Tabela gateway_events criada/verificada');

    // Adicionar colunas se não existirem
    await pool.query(`ALTER TABLE public.gateway_events ADD COLUMN IF NOT EXISTS dedupe_key text NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE public.gateway_events ADD COLUMN IF NOT EXISTS slug text`);
    await pool.query(`ALTER TABLE public.gateway_events ADD COLUMN IF NOT EXISTS purpose text`);
    await pool.query(`ALTER TABLE public.gateway_events ADD COLUMN IF NOT EXISTS error_code text`);
    await pool.query(`ALTER TABLE public.gateway_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz DEFAULT now()`);
    console.log('[MIGRATION] ✅ Colunas adicionadas/verificadas');

    // Índice único para deduplicação
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_gateway_events_dedupe 
      ON public.gateway_events(dedupe_key)
    `);
    console.log('[MIGRATION] ✅ Índice ux_gateway_events_dedupe criado');

    // Índice para consultas por slug/purpose
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_gateway_events_slug_purpose 
      ON public.gateway_events(slug, purpose)
    `);
    console.log('[MIGRATION] ✅ Índice ix_gateway_events_slug_purpose criado');

    // Índice para consultas temporais
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_gateway_events_occurred_at 
      ON public.gateway_events(occurred_at DESC)
    `);
    console.log('[MIGRATION] ✅ Índice ix_gateway_events_occurred_at criado');

    await pool.query('COMMIT');
    console.log('[MIGRATION] ✅ Migração concluída com sucesso!');

    // Verificar
    const result = await pool.query(`
      SELECT COUNT(*) as count FROM public.gateway_events
    `);
    console.log(`[MIGRATION] 📊 Registros na tabela: ${result.rows[0].count}`);

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('[MIGRATION] ❌ Erro:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
