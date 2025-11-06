-- Migração 008: Downsell com duplo gatilho (START + PIX)
-- Adiciona suporte para gatilhos múltiplos e verificação de elegibilidade
-- Idempotente e segura

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Adicionar colunas novas à tabela downsells_queue
ALTER TABLE public.downsells_queue 
  ADD COLUMN IF NOT EXISTS bot_slug text,
  ADD COLUMN IF NOT EXISTS telegram_id bigint,
  ADD COLUMN IF NOT EXISTS transaction_id text,
  ADD COLUMN IF NOT EXISTS trigger text,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS meta jsonb,
  ADD COLUMN IF NOT EXISTS event_id text;

-- 2. Migrar dados existentes (se houver)
UPDATE public.downsells_queue 
SET 
  bot_slug = slug,
  telegram_id = CASE WHEN tg_id ~ '^\d+$' THEN tg_id::bigint ELSE NULL END,
  scheduled_at = schedule_at,
  trigger = 'start',
  meta = '{}'::jsonb
WHERE bot_slug IS NULL;

-- 3. Adicionar constraint de trigger
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'downsells_queue_trigger_check'
  ) THEN
    ALTER TABLE public.downsells_queue 
      ADD CONSTRAINT downsells_queue_trigger_check 
      CHECK (trigger IN ('start', 'pix'));
  END IF;
END $$;

-- 4. Atualizar constraint de status para incluir novos estados
DO $$ 
BEGIN
  -- Remover constraint antiga se existir
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'downsells_queue_status_check'
  ) THEN
    ALTER TABLE public.downsells_queue DROP CONSTRAINT downsells_queue_status_check;
  END IF;
  
  -- Adicionar constraint nova
  ALTER TABLE public.downsells_queue 
    ADD CONSTRAINT downsells_queue_status_check 
    CHECK (status IN ('pending', 'sent', 'failed', 'canceled', 'expired', 'skipped'));
END $$;

-- 5. Normalizar coluna status (uppercase -> lowercase)
UPDATE public.downsells_queue 
SET status = lower(status)
WHERE status != lower(status);

-- 6. Definir NOT NULL para colunas obrigatórias (após migração de dados)
ALTER TABLE public.downsells_queue 
  ALTER COLUMN bot_slug SET NOT NULL,
  ALTER COLUMN telegram_id SET NOT NULL,
  ALTER COLUMN scheduled_at SET NOT NULL,
  ALTER COLUMN trigger SET NOT NULL;

-- 7. Definir defaults
ALTER TABLE public.downsells_queue 
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN meta SET DEFAULT '{}'::jsonb;

-- 8. Criar índice único em event_id (para idempotência)
CREATE UNIQUE INDEX IF NOT EXISTS ux_downsells_queue_event_id 
  ON public.downsells_queue (event_id) 
  WHERE event_id IS NOT NULL;

-- 9. Criar índice único parcial para evitar duplicados pendentes
-- Garante que o mesmo downsell não fique pendente duas vezes ao mesmo tempo
CREATE UNIQUE INDEX IF NOT EXISTS ux_downsells_queue_pending_unique
  ON public.downsells_queue (bot_slug, telegram_id, downsell_id)
  WHERE status = 'pending';

-- 10. Criar índices para consultas de elegibilidade e performance
CREATE INDEX IF NOT EXISTS ix_downsells_queue_scheduled_status 
  ON public.downsells_queue (scheduled_at, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ix_downsells_queue_bot_status 
  ON public.downsells_queue (bot_slug, status);

CREATE INDEX IF NOT EXISTS ix_downsells_queue_transaction_status 
  ON public.downsells_queue (transaction_id, status)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_downsells_queue_telegram_id 
  ON public.downsells_queue (bot_slug, telegram_id, status);

-- 11. Atualizar tabela bot_downsells para incluir gatilhos
ALTER TABLE public.bot_downsells 
  ADD COLUMN IF NOT EXISTS after_start boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS after_pix boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS delay_minutes integer;

-- 12. Migrar delay_seconds para delay_minutes
UPDATE public.bot_downsells 
SET delay_minutes = ROUND(delay_seconds / 60.0)
WHERE delay_minutes IS NULL AND delay_seconds IS NOT NULL;

-- 13. Definir default para delay_minutes (20 minutos)
ALTER TABLE public.bot_downsells 
  ALTER COLUMN delay_minutes SET DEFAULT 20;

UPDATE public.bot_downsells 
SET delay_minutes = 20 
WHERE delay_minutes IS NULL;

-- 14. Remover índices antigos que não são mais necessários
DROP INDEX IF EXISTS ix_downsells_queue_schedule;
DROP INDEX IF EXISTS ix_downsells_queue_slug_tg;

COMMIT;
