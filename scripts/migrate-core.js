// scripts/migrate-core.js
/* eslint-disable no-console */
const { Client } = require('pg');

async function exec(client, sql) { await client.query(sql); }

async function run() {
  const cn = process.env.DATABASE_URL;
  if (!cn) { console.error('[MIGRATE:CORE] DATABASE_URL não definido'); process.exit(2); }

  const client = new Client({ connectionString: cn, ssl: { rejectUnauthorized: false } });
  const t0 = Date.now();
  console.log('[MIGRATE:CORE] start');

  try {
    await client.connect();
    await exec(client, 'BEGIN');
    await exec(client, `SET LOCAL lock_timeout = '5s'`);
    await exec(client, `SET LOCAL statement_timeout = '120s'`);

    // 1) payments
    await exec(client, `
      CREATE TABLE IF NOT EXISTS public.payments (
        id BIGSERIAL PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NULL,
        status TEXT NOT NULL,            -- PENDING | PAID | CANCELED | FAILED
        amount_cents INTEGER NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_payments_tx') THEN
          EXECUTE 'CREATE UNIQUE INDEX ux_payments_tx ON public.payments(transaction_id)';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ix_payments_provider_external') THEN
          EXECUTE 'CREATE INDEX ix_payments_provider_external ON public.payments(provider, external_id)';
        END IF;
      END $$;
    `);

    // 2) gateway_events (dedupe de webhooks)
    await exec(client, `
      CREATE TABLE IF NOT EXISTS public.gateway_events (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        payload JSONB NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (provider, provider_event_id)
      );
    `);

    // 3) outbox (p/ workers)
    await exec(client, `
      CREATE TABLE IF NOT EXISTS public.outbox (
        id BIGSERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        payload JSONB NOT NULL,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        processed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ix_outbox_pick
        ON public.outbox (next_attempt_at, id) WHERE processed_at IS NULL;
    `);

    // 4) funnel_events (sem partição por enquanto)
    await exec(client, `
      CREATE TABLE IF NOT EXISTS public.funnel_events (
        id BIGSERIAL PRIMARY KEY,
        bot_id BIGINT NULL,
        bot_slug TEXT NULL,
        event_name TEXT NOT NULL,
        event_id TEXT NOT NULL,
        tg_id BIGINT NULL,
        transaction_id TEXT NULL,
        payload_id TEXT NULL,
        price_cents INTEGER NULL,
        meta JSONB NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_funnel_events_event_id') THEN
          EXECUTE 'CREATE UNIQUE INDEX ux_funnel_events_event_id ON public.funnel_events(event_id)';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ix_funnel_events_bot_time') THEN
          EXECUTE 'CREATE INDEX ix_funnel_events_bot_time ON public.funnel_events(bot_id, occurred_at DESC)';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ix_funnel_events_bot_tg') THEN
          EXECUTE 'CREATE INDEX ix_funnel_events_bot_tg ON public.funnel_events(bot_id, tg_id)';
        END IF;
      END $$;
    `);

    await exec(client, 'COMMIT');
    console.log('[MIGRATE:CORE] done in', Date.now() - t0, 'ms');
    process.exit(0);
  } catch (err) {
    try { await exec(client, 'ROLLBACK'); } catch {}
    console.error('[MIGRATE:CORE] error:', err && err.stack || err);
    process.exit(1);
  } finally {
    try { await client.end(); } catch {}
  }
}
run();
