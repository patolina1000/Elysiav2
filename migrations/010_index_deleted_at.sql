-- Migração 010: Índice parcial em deleted_at para performance
-- Melhora performance de listagem de bots ativos
-- Idempotente e segura
--
-- IMPORTANTE: CREATE INDEX CONCURRENTLY não pode estar em transaction block
-- Por isso, não usamos BEGIN/COMMIT aqui

-- Índice parcial apenas para bots NÃO deletados (WHERE deleted_at IS NULL)
-- Isso torna a query de listagem muito mais rápida
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bots_active_deleted_at 
ON public.bots(deleted_at, created_at DESC) 
WHERE deleted_at IS NULL;

-- Índice para busca por slug em bots ativos
-- Útil para validações e lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bots_slug_not_deleted
ON public.bots(slug)
WHERE deleted_at IS NULL;

-- Índice para queries que filtram bots deletados
-- Útil para admin e relatórios
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bots_deleted_at_not_null
ON public.bots(deleted_at DESC)
WHERE deleted_at IS NOT NULL;

-- Análise para atualizar estatísticas
ANALYZE public.bots;
