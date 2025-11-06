-- Migração 005: Tabelas de downsell agendado
-- Idempotente e segura (IF NOT EXISTS, sem DROP)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Tabela de configuração de downsells por bot
CREATE TABLE IF NOT EXISTS public.bot_downsells (
  id bigserial PRIMARY KEY,
  bot_id bigint,
  slug text NOT NULL,
  name text NOT NULL,
  content jsonb NOT NULL, -- { text, photo_url, video_url, parse_mode, etc }
  delay_seconds integer NOT NULL DEFAULT 1200, -- 20 minutos por padrão
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Tabela de fila de downsells agendados
CREATE TABLE IF NOT EXISTS public.downsells_queue (
  id bigserial PRIMARY KEY,
  downsell_id bigint NOT NULL,
  bot_id bigint,
  slug text NOT NULL,
  tg_id text NOT NULL,
  schedule_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', -- PENDING, SENT, CANCELED, FAILED
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS ix_bot_downsells_slug_active ON public.bot_downsells(slug, active);
CREATE INDEX IF NOT EXISTS ix_downsells_queue_schedule ON public.downsells_queue(schedule_at, status) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_downsells_queue_slug_tg ON public.downsells_queue(slug, tg_id);
CREATE INDEX IF NOT EXISTS ix_downsells_queue_status ON public.downsells_queue(status);

-- Foreign keys (idempotente)
DO $$ 
BEGIN
  -- FK para bot_downsells
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_bot_downsells_bot_id'
  ) THEN
    BEGIN
      ALTER TABLE public.bot_downsells 
      ADD CONSTRAINT fk_bot_downsells_bot_id 
      FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  
  -- FK para downsells_queue
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_downsells_queue_downsell_id'
  ) THEN
    BEGIN
      ALTER TABLE public.downsells_queue 
      ADD CONSTRAINT fk_downsells_queue_downsell_id 
      FOREIGN KEY (downsell_id) REFERENCES public.bot_downsells(id) ON DELETE CASCADE;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END $$;

COMMIT;
