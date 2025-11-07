-- Migration 014: Suporte a múltiplas mídias (1-3) em /start, Downsell e Disparo
-- Permite áudio, vídeo e foto, enviados separadamente (nunca em álbum)
-- Prioridade: áudio > vídeo > foto

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- 1. Adicionar start_media_refs à tabela bots
ALTER TABLE public.bots 
  ADD COLUMN IF NOT EXISTS start_media_refs jsonb DEFAULT '[]'::jsonb;

-- Validar que start_media_refs é um array com no máximo 3 itens
ALTER TABLE public.bots 
  ADD CONSTRAINT chk_start_media_refs_array 
  CHECK (jsonb_typeof(start_media_refs) = 'array' AND jsonb_array_length(start_media_refs) <= 3);

-- Validar estrutura dos itens em start_media_refs
ALTER TABLE public.bots 
  ADD CONSTRAINT chk_start_media_refs_structure 
  CHECK (
    start_media_refs = '[]'::jsonb OR (
      start_media_refs @> '[]'::jsonb AND
      (SELECT COUNT(*) FROM jsonb_array_elements(start_media_refs) elem 
       WHERE 
         elem->>'sha256' ~ '^[a-f0-9]{64}$' AND
         elem->>'kind' IN ('audio', 'video', 'photo')
      ) = jsonb_array_length(start_media_refs)
    )
  );

COMMENT ON COLUMN public.bots.start_media_refs IS 
  'Array de referências de mídia para /start (máx 3 itens): [{"sha256": "...", "kind": "audio|video|photo"}, ...]';

-- 2. Adicionar media_refs à tabela bot_downsells
ALTER TABLE public.bot_downsells 
  ADD COLUMN IF NOT EXISTS media_refs jsonb DEFAULT '[]'::jsonb;

-- Validar que media_refs é um array com no máximo 3 itens
ALTER TABLE public.bot_downsells 
  ADD CONSTRAINT chk_media_refs_array 
  CHECK (jsonb_typeof(media_refs) = 'array' AND jsonb_array_length(media_refs) <= 3);

-- Validar estrutura dos itens em media_refs
ALTER TABLE public.bot_downsells 
  ADD CONSTRAINT chk_media_refs_structure 
  CHECK (
    media_refs = '[]'::jsonb OR (
      media_refs @> '[]'::jsonb AND
      (SELECT COUNT(*) FROM jsonb_array_elements(media_refs) elem 
       WHERE 
         elem->>'sha256' ~ '^[a-f0-9]{64}$' AND
         elem->>'kind' IN ('audio', 'video', 'photo')
      ) = jsonb_array_length(media_refs)
    )
  );

COMMENT ON COLUMN public.bot_downsells.media_refs IS 
  'Array de referências de mídia para downsell (máx 3 itens): [{"sha256": "...", "kind": "audio|video|photo"}, ...]';

-- 3. Adicionar media_refs à tabela shots
ALTER TABLE public.shots 
  ADD COLUMN IF NOT EXISTS media_refs jsonb DEFAULT '[]'::jsonb;

-- Validar que media_refs é um array com no máximo 3 itens
ALTER TABLE public.shots 
  ADD CONSTRAINT chk_shots_media_refs_array 
  CHECK (jsonb_typeof(media_refs) = 'array' AND jsonb_array_length(media_refs) <= 3);

-- Validar estrutura dos itens em media_refs
ALTER TABLE public.shots 
  ADD CONSTRAINT chk_shots_media_refs_structure 
  CHECK (
    media_refs = '[]'::jsonb OR (
      media_refs @> '[]'::jsonb AND
      (SELECT COUNT(*) FROM jsonb_array_elements(media_refs) elem 
       WHERE 
         elem->>'sha256' ~ '^[a-f0-9]{64}$' AND
         elem->>'kind' IN ('audio', 'video', 'photo')
      ) = jsonb_array_length(media_refs)
    )
  );

COMMENT ON COLUMN public.shots.media_refs IS 
  'Array de referências de mídia para disparo (máx 3 itens): [{"sha256": "...", "kind": "audio|video|photo"}, ...]';

-- 4. Índices para performance de consultas por mídia
CREATE INDEX IF NOT EXISTS ix_bots_start_media_refs 
  ON public.bots USING GIN (start_media_refs) 
  WHERE start_media_refs != '[]'::jsonb;

CREATE INDEX IF NOT EXISTS ix_bot_downsells_media_refs 
  ON public.bot_downsells USING GIN (media_refs) 
  WHERE media_refs != '[]'::jsonb;

CREATE INDEX IF NOT EXISTS ix_shots_media_refs 
  ON public.shots USING GIN (media_refs) 
  WHERE media_refs != '[]'::jsonb;

COMMIT;
