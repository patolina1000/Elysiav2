-- Migração 003: Deduplicação forte do /start via índice único em event_id
-- Garante que cada st:<slug>:<tg_id>:<yyyymmdd> seja único

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Criar índice único em event_id (idempotente)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'ux_funnel_events_event_id'
  ) THEN
    -- Tentar criar o índice único
    -- Se houver duplicatas, a criação falhará - nesse caso, limpe manualmente
    CREATE UNIQUE INDEX ux_funnel_events_event_id
      ON public.funnel_events (event_id);
    
    RAISE NOTICE 'Índice único ux_funnel_events_event_id criado com sucesso';
  ELSE
    RAISE NOTICE 'Índice único ux_funnel_events_event_id já existe';
  END IF;
EXCEPTION
  WHEN unique_violation THEN
    RAISE WARNING 'Não foi possível criar índice único - existem event_id duplicados. Execute limpeza manual.';
  WHEN OTHERS THEN
    RAISE WARNING 'Erro ao criar índice único: %', SQLERRM;
END $$;

COMMIT;
