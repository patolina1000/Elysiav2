-- Migration 012: Adicionar suporte a mídia em bot_messages
-- Data: 2024-11-06
-- Objetivo: Permitir que mensagens do bot incluam foto/vídeo/documento/áudio

-- Adicionar colunas de mídia à tabela bot_messages
ALTER TABLE bot_messages 
  ADD COLUMN IF NOT EXISTS media_sha256 text,
  ADD COLUMN IF NOT EXISTS media_kind text CHECK (media_kind IS NULL OR media_kind IN ('photo', 'video', 'document', 'audio')),
  ADD COLUMN IF NOT EXISTS media_r2_key text;

-- Comentários explicativos
COMMENT ON COLUMN bot_messages.media_sha256 IS 'SHA256 da mídia para lookup no cache';
COMMENT ON COLUMN bot_messages.media_kind IS 'Tipo de mídia: photo, video, document, audio';
COMMENT ON COLUMN bot_messages.media_r2_key IS 'Chave R2 para download (fallback se cache miss)';

-- Criar índice para busca por mídia
CREATE INDEX IF NOT EXISTS ix_bot_messages_media_sha256 
  ON bot_messages(media_sha256) 
  WHERE media_sha256 IS NOT NULL;

-- Criar índice composto para busca eficiente
CREATE INDEX IF NOT EXISTS ix_bot_messages_bot_media 
  ON bot_messages(slug, media_sha256) 
  WHERE media_sha256 IS NOT NULL;

-- View para mensagens com mídia (útil para queries)
CREATE OR REPLACE VIEW bot_messages_with_media AS
SELECT 
  bm.id,
  bm.slug,
  bm.message_type,
  bm.content,
  bm.sequence_order,
  bm.active,
  bm.media_sha256,
  bm.media_kind,
  bm.media_r2_key,
  ms.bytes as media_bytes,
  ms.mime as media_mime,
  ms.width as media_width,
  ms.height as media_height,
  ms.duration as media_duration,
  mc.status as cache_status,
  mc.tg_file_id,
  mc.warmup_at as media_warmed_at
FROM bot_messages bm
LEFT JOIN media_store ms ON bm.media_sha256 = ms.sha256 AND bm.slug = ms.bot_slug
LEFT JOIN media_cache mc ON bm.media_sha256 = mc.sha256 AND bm.slug = mc.bot_slug AND bm.media_kind = mc.kind
WHERE bm.media_sha256 IS NOT NULL;

COMMENT ON VIEW bot_messages_with_media IS 'Mensagens do bot com informações completas de mídia';

-- Exemplo de uso:
-- 1. Inserir mensagem com foto:
/*
INSERT INTO bot_messages (
  slug, message_type, content, media_sha256, media_kind, media_r2_key, sequence_order, active
) VALUES (
  'mybot',
  'photo',
  '{"text": "Olá! Veja esta imagem:"}', -- caption em JSON
  'abc123def456...', -- SHA256 da mídia (obtido do upload)
  'photo',
  'mybot/photo/abc123def456.jpg', -- R2 key (obtido do upload)
  1,
  true
);
*/

-- 2. Buscar mensagens com mídia pronta:
/*
SELECT * FROM bot_messages_with_media 
WHERE slug = 'mybot' 
  AND active = true 
  AND cache_status = 'ready'
ORDER BY sequence_order;
*/

-- 3. Buscar mensagens aguardando aquecimento:
/*
SELECT * FROM bot_messages_with_media 
WHERE slug = 'mybot' 
  AND cache_status = 'warming';
*/

-- Função auxiliar para validar mensagem com mídia
CREATE OR REPLACE FUNCTION validate_bot_message_media()
RETURNS TRIGGER AS $$
BEGIN
  -- Se tem mídia, todos os campos de mídia devem estar presentes
  IF NEW.media_sha256 IS NOT NULL THEN
    IF NEW.media_kind IS NULL THEN
      RAISE EXCEPTION 'media_kind é obrigatório quando media_sha256 está presente';
    END IF;
    
    IF NEW.media_r2_key IS NULL THEN
      RAISE EXCEPTION 'media_r2_key é obrigatório quando media_sha256 está presente';
    END IF;
    
    -- message_type deve ser compatível com media_kind
    IF NEW.message_type NOT IN ('photo', 'video', 'document', 'audio') THEN
      RAISE EXCEPTION 'message_type deve ser photo, video, document ou audio quando mídia está presente';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para validação
DROP TRIGGER IF EXISTS trg_validate_bot_message_media ON bot_messages;
CREATE TRIGGER trg_validate_bot_message_media
  BEFORE INSERT OR UPDATE ON bot_messages
  FOR EACH ROW
  EXECUTE FUNCTION validate_bot_message_media();

-- Log de migração
DO $$
BEGIN
  RAISE NOTICE 'Migration 012 completed: bot_messages now supports media (photo, video, document, audio)';
END $$;
