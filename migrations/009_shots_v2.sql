-- Migração 009: Atualização do sistema de disparos (shots)
-- Adiciona campos de agendamento, filtros e melhora dedupe
-- Idempotente e segura (IF NOT EXISTS, sem DROP)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Adicionar novos campos na tabela shots (se não existirem)
DO $$ 
BEGIN
  -- Campo trigger (now ou schedule)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots' AND column_name = 'trigger'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN trigger text NOT NULL DEFAULT 'now';
  END IF;
  
  -- Campo scheduled_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots' AND column_name = 'scheduled_at'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN scheduled_at timestamptz;
  END IF;
  
  -- Campo message (JSONB com texto, mídia, parse_mode)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots' AND column_name = 'message'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN message jsonb;
  END IF;
  
  -- Campo parse_mode
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots' AND column_name = 'parse_mode'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN parse_mode text DEFAULT 'MarkdownV2';
  END IF;
  
  -- Campo filters (JSONB com regras de segmentação)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots' AND column_name = 'filters'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN filters jsonb DEFAULT '{}'::jsonb;
  END IF;
  
  -- Campo created_by
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN created_by text;
  END IF;
  
  -- Campo bot_slug (redundância com slug, mas para consistência)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots' AND column_name = 'bot_slug'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN bot_slug text;
    -- Copiar slug para bot_slug se necessário
    UPDATE public.shots SET bot_slug = slug WHERE bot_slug IS NULL;
  END IF;
END $$;

-- 2. Atualizar tabela shots_queue
DO $$ 
BEGIN
  -- Adicionar telegram_id (bigint) se não existir
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots_queue' AND column_name = 'telegram_id'
  ) THEN
    ALTER TABLE public.shots_queue ADD COLUMN telegram_id bigint;
    -- Converter tg_id para telegram_id se necessário
    UPDATE public.shots_queue 
    SET telegram_id = tg_id::bigint 
    WHERE telegram_id IS NULL AND tg_id IS NOT NULL;
  END IF;
  
  -- Adicionar bot_slug se não existir
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots_queue' AND column_name = 'bot_slug'
  ) THEN
    ALTER TABLE public.shots_queue ADD COLUMN bot_slug text;
    -- Copiar slug para bot_slug se necessário
    UPDATE public.shots_queue SET bot_slug = slug WHERE bot_slug IS NULL;
  END IF;
  
  -- Adicionar message_id (para tracking)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots_queue' AND column_name = 'message_id'
  ) THEN
    ALTER TABLE public.shots_queue ADD COLUMN message_id bigint;
  END IF;
  
  -- Adicionar event_id (para idempotência)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shots_queue' AND column_name = 'event_id'
  ) THEN
    ALTER TABLE public.shots_queue ADD COLUMN event_id text;
  END IF;
END $$;

-- 3. Criar índice único para dedupe (shot_id, telegram_id)
CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_queue_shot_telegram 
ON public.shots_queue (shot_id, telegram_id);

-- 4. Criar índice no event_id para idempotência extra
CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_queue_event_id 
ON public.shots_queue (event_id) 
WHERE event_id IS NOT NULL;

-- 5. Índices adicionais para performance
CREATE INDEX IF NOT EXISTS ix_shots_trigger_scheduled 
ON public.shots (trigger, scheduled_at) 
WHERE status IN ('scheduled', 'queued');

CREATE INDEX IF NOT EXISTS ix_shots_queue_telegram_id 
ON public.shots_queue (bot_slug, telegram_id, status);

-- 6. Migrar dados antigos de content para message (se necessário)
UPDATE public.shots 
SET message = content 
WHERE message IS NULL AND content IS NOT NULL;

-- 7. Comentários nas tabelas
COMMENT ON TABLE public.shots IS 'Disparos (broadcasts) agendados ou imediatos';
COMMENT ON COLUMN public.shots.trigger IS 'Tipo de disparo: now (imediato) ou schedule (agendado)';
COMMENT ON COLUMN public.shots.scheduled_at IS 'Data/hora agendada (timezone UTC)';
COMMENT ON COLUMN public.shots.message IS 'Conteúdo da mensagem (text, file_id, caption, etc)';
COMMENT ON COLUMN public.shots.filters IS 'Filtros de segmentação: all_started, has_unpaid_pix, exclude_paid';

COMMENT ON TABLE public.shots_queue IS 'Fila de envio de disparos por destinatário';
COMMENT ON COLUMN public.shots_queue.event_id IS 'ID único para idempotência: sh:<bot_slug>:<shot_id>:<telegram_id>';

COMMIT;
