-- Migration 011: Sistema de Mídia com R2 e Cache de file_id
-- Implementa armazenamento em R2 + cache de file_id do Telegram
-- Objetivo: latência p95 < 500ms com cache hit

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- 1. Adicionar warmup_chat_id à tabela bots
ALTER TABLE public.bots 
  ADD COLUMN IF NOT EXISTS warmup_chat_id text;

COMMENT ON COLUMN public.bots.warmup_chat_id IS 
  'ID do chat/canal privado usado para pré-aquecer mídias (envio offline para obter file_id)';

-- 2. Tabela de armazenamento de mídia no R2
CREATE TABLE IF NOT EXISTS public.media_store (
  id bigserial PRIMARY KEY,
  bot_slug text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('photo', 'video', 'document', 'audio')),
  r2_key text NOT NULL,
  r2_etag text,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  ext text,
  mime text,
  width int,
  height int,
  duration int,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Índices para media_store
CREATE UNIQUE INDEX IF NOT EXISTS ux_media_store_r2_key 
  ON public.media_store(r2_key);

CREATE INDEX IF NOT EXISTS ix_media_store_bot_slug 
  ON public.media_store(bot_slug);

CREATE INDEX IF NOT EXISTS ix_media_store_sha256 
  ON public.media_store(sha256);

CREATE INDEX IF NOT EXISTS ix_media_store_bot_kind 
  ON public.media_store(bot_slug, kind);

COMMENT ON TABLE public.media_store IS 
  'Armazena metadados de mídias enviadas ao R2 (Cloudflare Object Storage)';

-- 3. Tabela de cache de file_id do Telegram
CREATE TABLE IF NOT EXISTS public.media_cache (
  id bigserial PRIMARY KEY,
  bot_slug text NOT NULL,
  sha256 text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('photo', 'video', 'document', 'audio')),
  tg_file_id text,
  tg_file_unique_id text,
  warmup_chat_id text,
  warmup_message_id bigint,
  warmup_at timestamptz,
  status text NOT NULL DEFAULT 'warming' CHECK (status IN ('ready', 'warming', 'error')),
  last_error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Índice ÚNICO para chave de cache (bot + sha256 + kind)
CREATE UNIQUE INDEX IF NOT EXISTS ux_media_cache_key 
  ON public.media_cache(bot_slug, sha256, kind);

-- Índices adicionais
CREATE INDEX IF NOT EXISTS ix_media_cache_status 
  ON public.media_cache(status);

CREATE INDEX IF NOT EXISTS ix_media_cache_bot_slug 
  ON public.media_cache(bot_slug);

CREATE INDEX IF NOT EXISTS ix_media_cache_file_id 
  ON public.media_cache(tg_file_id) WHERE tg_file_id IS NOT NULL;

COMMENT ON TABLE public.media_cache IS 
  'Cache de file_id do Telegram por conteúdo (sha256), permite envios rápidos sem re-upload';

-- 4. Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_media_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_media_store_updated_at') THEN
    CREATE TRIGGER update_media_store_updated_at
      BEFORE UPDATE ON public.media_store
      FOR EACH ROW
      EXECUTE FUNCTION update_media_updated_at();
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_media_cache_updated_at') THEN
    CREATE TRIGGER update_media_cache_updated_at
      BEFORE UPDATE ON public.media_cache
      FOR EACH ROW
      EXECUTE FUNCTION update_media_updated_at();
  END IF;
END $$;

COMMIT;
