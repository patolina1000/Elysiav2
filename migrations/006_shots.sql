-- Migração 006: Tabelas de disparo/broadcast
-- Idempotente e segura (IF NOT EXISTS, sem DROP)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Tabela de disparos (broadcasts)
CREATE TABLE IF NOT EXISTS public.shots (
  id bigserial PRIMARY KEY,
  bot_id bigint,
  slug text NOT NULL,
  title text NOT NULL,
  content jsonb NOT NULL, -- { text, photo_url, video_url, parse_mode, etc }
  target text NOT NULL DEFAULT 'all_started', -- all_started, after_pix, custom
  status text NOT NULL DEFAULT 'DRAFT', -- DRAFT, QUEUED, SENDING, PAUSED, COMPLETED, CANCELED
  total_targets integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

-- Tabela de fila de disparos
CREATE TABLE IF NOT EXISTS public.shots_queue (
  id bigserial PRIMARY KEY,
  shot_id bigint NOT NULL,
  slug text NOT NULL,
  tg_id text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', -- PENDING, SENT, FAILED, SKIPPED
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS ix_shots_slug_status ON public.shots(slug, status);
CREATE INDEX IF NOT EXISTS ix_shots_status ON public.shots(status);
CREATE INDEX IF NOT EXISTS ix_shots_queue_shot_status ON public.shots_queue(shot_id, status);
CREATE INDEX IF NOT EXISTS ix_shots_queue_status ON public.shots_queue(status) WHERE status = 'PENDING';

-- Foreign keys (idempotente)
DO $$ 
BEGIN
  -- FK para shots
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_shots_bot_id'
  ) THEN
    BEGIN
      ALTER TABLE public.shots 
      ADD CONSTRAINT fk_shots_bot_id 
      FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  
  -- FK para shots_queue
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_shots_queue_shot_id'
  ) THEN
    BEGIN
      ALTER TABLE public.shots_queue 
      ADD CONSTRAINT fk_shots_queue_shot_id 
      FOREIGN KEY (shot_id) REFERENCES public.shots(id) ON DELETE CASCADE;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END $$;

COMMIT;
