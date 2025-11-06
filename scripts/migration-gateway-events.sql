-- Migração: Tabela gateway_events para registro de envios
-- Execução manual: psql $DATABASE_URL -f scripts/migration-gateway-events.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Tabela de eventos de gateway (envios)
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
);

-- Índice único para deduplicação
CREATE UNIQUE INDEX IF NOT EXISTS ux_gateway_events_dedupe ON public.gateway_events(dedupe_key);

-- Índices para consultas
CREATE INDEX IF NOT EXISTS ix_gateway_events_slug_purpose ON public.gateway_events(slug, purpose);
CREATE INDEX IF NOT EXISTS ix_gateway_events_occurred_at ON public.gateway_events(occurred_at DESC);

COMMIT;

-- Verificar criação
SELECT 
  'gateway_events' as table_name,
  COUNT(*) as row_count
FROM public.gateway_events;

SELECT 
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'gateway_events'
ORDER BY indexname;
