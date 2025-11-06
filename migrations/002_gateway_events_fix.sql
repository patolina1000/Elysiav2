-- Migração 002: Correção segura da tabela gateway_events
-- Adiciona colunas faltantes e índice único para deduplicação forte

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Garantir que a tabela existe
CREATE TABLE IF NOT EXISTS public.gateway_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz DEFAULT now()
);

-- Adicionar colunas se não existirem
ALTER TABLE public.gateway_events 
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS chat_id text,
  ADD COLUMN IF NOT EXISTS message_id bigint,
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS purpose text,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Adicionar constraint de status (se não existir)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'gateway_events_status_check'
  ) THEN
    ALTER TABLE public.gateway_events 
      ADD CONSTRAINT gateway_events_status_check 
      CHECK (status IN ('pending', 'sent', 'ok', 'error', 'fail'));
  END IF;
END $$;

-- Criar índice único para deduplicação (idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS ux_gateway_events_dedupe
  ON public.gateway_events (dedupe_key) 
  WHERE dedupe_key IS NOT NULL;

-- Índices para consultas comuns
CREATE INDEX IF NOT EXISTS ix_gateway_events_slug_purpose 
  ON public.gateway_events(slug, purpose);

CREATE INDEX IF NOT EXISTS ix_gateway_events_occurred_at 
  ON public.gateway_events(occurred_at DESC);

CREATE INDEX IF NOT EXISTS ix_gateway_events_request_id 
  ON public.gateway_events(request_id);

COMMIT;
