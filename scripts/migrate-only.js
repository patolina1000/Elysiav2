/* eslint-disable no-console */
require('dotenv').config();
const { Client } = require('pg');

async function run() {
  const cn = process.env.DATABASE_URL;
  if (!cn) {
    console.error('[MIGRATE] DATABASE_URL não definido');
    process.exit(2);
  }

  const client = new Client({ connectionString: cn, ssl: { rejectUnauthorized: false } });
  const t0 = Date.now();
  console.log('[MIGRATE] start');

  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);

    // Tabela bots (idempotente)
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.bots (
        id BIGSERIAL PRIMARY KEY,
        name TEXT,
        slug TEXT,
        provider TEXT,
        use_album BOOLEAN,
        token TEXT,
        token_encrypted BYTEA,
        rate_per_minute INTEGER NOT NULL DEFAULT 60,
        sandbox BOOLEAN NOT NULL DEFAULT false,
        renderer TEXT NOT NULL DEFAULT 'MarkdownV2',
        typing_delay_ms INTEGER NOT NULL DEFAULT 0,
        watermark TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Garante colunas em esquemas legados (idempotente) — evita quebra em ALTERs posteriores
    await client.query(`
      ALTER TABLE public.bots
        ADD COLUMN IF NOT EXISTS name              TEXT,
        ADD COLUMN IF NOT EXISTS slug              TEXT,
        ADD COLUMN IF NOT EXISTS provider          TEXT,
        ADD COLUMN IF NOT EXISTS use_album         BOOLEAN,
        ADD COLUMN IF NOT EXISTS token             TEXT,
        ADD COLUMN IF NOT EXISTS token_encrypted   BYTEA,
        ADD COLUMN IF NOT EXISTS rate_per_minute   INTEGER,
        ADD COLUMN IF NOT EXISTS sandbox           BOOLEAN,
        ADD COLUMN IF NOT EXISTS renderer          TEXT,
        ADD COLUMN IF NOT EXISTS typing_delay_ms   INTEGER,
        ADD COLUMN IF NOT EXISTS watermark         TEXT,
        ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ;
    `);

    // UNIQUE slug na mãe (idempotente)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname='public' AND indexname='ux_bots_slug'
        ) THEN
          EXECUTE 'CREATE UNIQUE INDEX ux_bots_slug ON public.bots(slug)';
        END IF;
      END
      $$;
    `);

    // Remover NOT NULL legado em token_encrypted, se houver
    await client.query(`
      DO $$
      DECLARE nn boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='bots'
            AND column_name='token_encrypted'
            AND is_nullable='NO'
        ) INTO nn;
        IF nn THEN
          EXECUTE 'ALTER TABLE public.bots ALTER COLUMN token_encrypted DROP NOT NULL';
        END IF;
      END $$;
    `);

    // Forçar defaults imutáveis
    await client.query(`ALTER TABLE public.bots ALTER COLUMN rate_per_minute SET DEFAULT 60`);
    await client.query(`ALTER TABLE public.bots ALTER COLUMN sandbox SET DEFAULT false`);
    await client.query(`ALTER TABLE public.bots ALTER COLUMN renderer SET DEFAULT 'MarkdownV2'`);
    await client.query(`ALTER TABLE public.bots ALTER COLUMN typing_delay_ms SET DEFAULT 0`);

    // Atualizações condicionais (idempotente)
    // Backfill seguro para registros legados
    await client.query(`UPDATE public.bots SET rate_per_minute = 60     WHERE rate_per_minute IS NULL`);
    await client.query(`UPDATE public.bots SET sandbox = false          WHERE sandbox IS NULL`);
    await client.query(`UPDATE public.bots SET renderer = 'MarkdownV2'  WHERE renderer IS NULL`);
    await client.query(`UPDATE public.bots SET typing_delay_ms = 0      WHERE typing_delay_ms IS NULL`);
    await client.query(`UPDATE public.bots SET created_at = now()       WHERE created_at IS NULL`);

    await client.query('COMMIT');
    console.log('[MIGRATE] done in', Date.now() - t0, 'ms');
    process.exit(0);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[MIGRATE] error:', err && err.stack || err);
    process.exit(1);
  } finally {
    try { await client.end(); } catch {}
  }
}

run();
