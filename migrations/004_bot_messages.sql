-- Migração 004: Tabela de mensagens configuráveis por bot
-- Idempotente e segura (IF NOT EXISTS, sem DROP)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Tabela de mensagens do /start por bot
CREATE TABLE IF NOT EXISTS public.bot_messages (
  id bigserial PRIMARY KEY,
  bot_id bigint,
  slug text NOT NULL,
  sequence_order integer NOT NULL DEFAULT 1,
  message_type text NOT NULL DEFAULT 'text', -- text, photo, video, album
  content jsonb NOT NULL, -- { text, photo_url, video_url, parse_mode, disable_web_page_preview, etc }
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS ix_bot_messages_slug_active ON public.bot_messages(slug, active);
CREATE INDEX IF NOT EXISTS ix_bot_messages_slug_order ON public.bot_messages(slug, sequence_order);

-- Adicionar constraint de foreign key se a coluna bot_id existir na tabela bots
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='bots' AND column_name='id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_bot_messages_bot_id'
  ) THEN
    ALTER TABLE public.bot_messages 
    ADD CONSTRAINT fk_bot_messages_bot_id 
    FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL; -- constraint já existe ou outro erro
END $$;

COMMIT;
