-- Migração 007: Coluna start_message para mensagem personalizada do /start
-- Idempotente e segura (IF NOT EXISTS, sem DROP)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Adicionar coluna start_message (jsonb nullable)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='bots' AND column_name='start_message'
  ) THEN
    ALTER TABLE public.bots ADD COLUMN start_message jsonb;
  END IF;
END $$;

-- Adicionar coluna start_message_updated_at
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='bots' AND column_name='start_message_updated_at'
  ) THEN
    ALTER TABLE public.bots ADD COLUMN start_message_updated_at timestamptz;
  END IF;
END $$;

-- Índice para busca rápida por bots com mensagem ativa
CREATE INDEX IF NOT EXISTS ix_bots_start_message_active 
ON public.bots ((start_message->>'active')) 
WHERE start_message IS NOT NULL;

COMMIT;
