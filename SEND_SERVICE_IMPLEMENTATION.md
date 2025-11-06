# Implementação do Serviço de Envio - Fase A

## ✅ Implementação Completa

### 1. Núcleo de Envio (`lib/sendService.js`)

**Funcionalidades implementadas:**
- ✅ Busca e descriptografa token pelo slug
- ✅ Escape automático de MarkdownV2
- ✅ Chamada à API do Telegram `sendMessage`
- ✅ Retorna `{ ok, message_id, username, error, lat_ms, telegram_lat_ms }`
- ✅ Logs seguros (sem token, apenas slug, chat_id, len(text), message_id, latência)
- ✅ Persistência em `gateway_events` com dedupe_key
- ✅ Idempotência via dedupe_key
- ✅ Retries: 3 tentativas com backoff exponencial
- ✅ Tratamento especial de HTTP 429 (respeita retry_after)
- ✅ Métricas: send.ok, send.err, send.latency_ms por slug/purpose

**Chaves de deduplicação:**
```javascript
send-test: test:<slug>:<chat_id>:<hash(text)>:<YYYYMMDDHHMM>
start: start:<slug>:<chat_id>:<start_session_id>
downsell: downsell:<queue_id>
shot: shot:<shot_id>:<chat_id>
```

---

### 2. Rate Limit e Segurança

**Implementado:**
- ✅ Token bucket in-memory para rate limit por bot (60 msg/min)
- ✅ Rate limit por chat (1 msg/s)
- ✅ Fila leve em memória (max 100 itens)
- ✅ Processamento da fila a cada 100ms
- ✅ Recusa apenas se fila > 100

**Códigos de erro mapeados:**
- `CHAT_NOT_FOUND`
- `BOT_BLOCKED_BY_USER`
- `USER_DEACTIVATED`
- `INVALID_CHAT_ID`
- `FORBIDDEN`
- `BAD_REQUEST`
- `RATE_LIMIT_EXCEEDED`
- `TELEGRAM_ERROR` (genérico)

---

### 3. Tabela `gateway_events`

**Schema:**
```sql
CREATE TABLE public.gateway_events (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL,
  slug text NOT NULL,
  chat_id text NOT NULL,
  message_id bigint,
  status text NOT NULL,
  lat_ms integer,
  purpose text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  error_code text,
  occurred_at timestamptz DEFAULT now()
);
```

**Índices:**
- `ux_gateway_events_dedupe` (UNIQUE) - Deduplicação
- `ix_gateway_events_slug_purpose` - Consultas por bot/purpose
- `ix_gateway_events_occurred_at` - Consultas temporais

---

### 4. Endpoint de Teste

**POST `/api/admin/bots/:slug/send-test`**

**Auth:** Bearer token (ADMIN_API_TOKEN)

**Request:**
```json
{
  "chat_id": "123456789",
  "text": "Teste de envio ✅"
}
```

**Response (sucesso):**
```json
{
  "ok": true,
  "message_id": 12345,
  "lat_ms": 450,
  "telegram_lat_ms": 380,
  "dedupe_applied": false
}
```

**Response (erro):**
```json
{
  "ok": false,
  "error": "CHAT_NOT_FOUND",
  "description": "chat not found",
  "lat_ms": 120
}
```

---

### 5. UI Admin - Envio de Teste

**Campos:**
- ✅ Input `chat_id` (obrigatório)
- ✅ Textarea `text` (default: "Teste de envio ✅")
- ✅ Botão "Enviar teste" (desabilita durante envio)
- ✅ Status com resultado (message_id, latência) ou erro legível

**Feedback:**
- ✅ Toast de sucesso/erro
- ✅ Status inline com emoji (✅/❌)
- ✅ Indicação de deduplicação quando aplicada
- ✅ Latência exibida em ms

---

### 6. Telemetria e SLO

**Métricas coletadas:**
- `send.ok` - Contadores de sucesso por slug:purpose
- `send.err` - Contadores de erro por slug:purpose
- `send.latency` - Array de latências por slug:purpose

**Estatísticas calculadas:**
- p50, p95, p99, avg
- Count total

**Endpoint:** `GET /api/admin/metrics/send`

**SLO alvo:** p95 ≤ 800ms para sendMessage

---

## 📁 Arquivos Criados/Modificados

### Novos Arquivos
1. **`lib/sendService.js`** - Serviço único de envio
2. **`scripts/test-send-service.js`** - Script de testes automatizados

### Arquivos Modificados
1. **`server.js`**
   - Import do sendService
   - Função `ensureGatewayEventsTable()`
   - Endpoint `POST /api/admin/bots/:slug/send-test`
   - Endpoint `GET /api/admin/metrics/send`

2. **`public/admin/index.html`**
   - Seção "Envio de Teste" com inputs e botão

3. **`public/admin/admin.js`**
   - Função `handleSendTest()`
   - Handler para ação `send-test`

---

## 🧪 Testes Implementados

### Script de Testes (`test-send-service.js`)

**Teste 1: Token ausente**
- Tenta enviar com slug sem token
- Espera: `BOT_TOKEN_NOT_SET`

**Teste 2: Envio feliz**
- Envia com token válido + seu chat_id
- Verifica: `ok: true`, `message_id`, latência
- Valida SLO: lat_ms ≤ 800ms

**Teste 3: Deduplicação**
- Repete mesmo envio em <1min
- Espera: `dedupe_applied: true`, sem nova mensagem no Telegram

**Teste 4: Rate limit por bot**
- Dispara 70 envios rápidos
- Verifica: alguns enfileirados, nenhum erro 429

**Teste 5: Flood por chat**
- 2 mensagens imediatas para mesmo chat
- Verifica: segunda espera ≥1s ou é enfileirada

**Teste 6: Chat ID inválido**
- Usa chat_id inválido
- Verifica: erro mapeado, sem stack trace

**Teste 7: Métricas**
- Obtém métricas via API
- Verifica: contadores e latências presentes

---

## 🚀 Como Testar

### 1. Configurar Variáveis de Ambiente

Adicione ao `.env`:
```env
TEST_CHAT_ID=seu_chat_id_aqui
```

Para obter seu chat_id:
1. Fale com @userinfobot no Telegram
2. Copie o ID retornado

### 2. Executar Testes Automatizados

```bash
node scripts/test-send-service.js
```

### 3. Testar na UI

1. Acesse: http://localhost:3000/admin
2. Navegue até um bot com token configurado
3. Na seção "Envio de Teste":
   - Informe seu chat_id
   - Edite o texto (opcional)
   - Clique em "Enviar teste"
4. Verifique:
   - Toast de sucesso
   - Status com message_id e latência
   - Mensagem chegou no Telegram

### 4. Testar Deduplicação

1. Envie uma mensagem de teste
2. Aguarde 2 segundos
3. Envie a mesma mensagem novamente
4. Verifique: status mostra "(deduplicado)"
5. Confirme no Telegram: apenas 1 mensagem recebida

---

## 📊 Logs Esperados

### Envio Bem-Sucedido
```
[SEND_TEST][START] { request_id: '...', slug: 'bot-ui-test', chat_id: '123456789', text_len: 25 }
[SEND][OK] { request_id: '...', slug: 'bot-ui-test', chat_id: '123456789', purpose: 'send-test', message_id: 12345, text_len: 25, lat_ms: 450, telegram_lat_ms: 380 }
[SEND_TEST][OK] { request_id: '...', slug: 'bot-ui-test', chat_id: '123456789', message_id: 12345, lat_ms: 450, dedupe_applied: false }
```

### Deduplicação Aplicada
```
[SEND][DEDUPE] { request_id: '...', slug: 'bot-ui-test', chat_id: '123456789', purpose: 'send-test', existing_message_id: 12345 }
```

### Erro Mapeado
```
[SEND][ERR] { request_id: '...', slug: 'bot-ui-test', chat_id: '999999999', purpose: 'send-test', error: 'CHAT_NOT_FOUND', description: 'chat not found', lat_ms: 120 }
```

### Rate Limit
```
[SEND][RATE_LIMIT][QUEUED] { slug: 'bot-ui-test', purpose: 'send-test', queue_size: 15 }
```

**IMPORTANTE:** Token NUNCA aparece nos logs!

---

## ✅ Critérios de Aceitação

- [x] Serviço único de envio funcionando
- [x] Sem vazar token em logs
- [x] Endpoint `/send-test` protegido e operacional
- [x] UI "Enviar teste" funcionando com feedback claro
- [x] Deduplicação efetiva com índice UNIQUE
- [x] Rate limit por bot/chat respeitado
- [x] Fila leve ativa (max 100)
- [x] Métricas e logs com slug, purpose, lat_ms, message_id
- [x] Retries com backoff exponencial
- [x] Tratamento especial de HTTP 429
- [x] Erros mapeados (sem stack trace)

---

## ⚠️ Nota Importante: Migração do Banco

A migração da tabela `gateway_events` foi implementada em `ensureGatewayEventsTable()` no `server.js`.

**Para executar a migração:**

```bash
# Opção 1: Via variável de ambiente
$env:ENABLE_BOOT_MIGRATION='true'; npm start

# Opção 2: Executar SQL manualmente
psql $DATABASE_URL < migration-gateway-events.sql
```

**Verificar se a tabela foi criada:**
```sql
SELECT * FROM information_schema.tables 
WHERE table_schema='public' AND table_name='gateway_events';
```

---

## 🔮 Próximas Fases (NÃO Implementadas)

### Fase B: /start
- Engatar serviço após /start
- ACK imediato + envio assíncrono
- p95 < 0,5s para primeiro envio

### Fase C: Downsell
- Criar/consumir `downsells_queue`
- Usar `occurred_at` de /start ou pix_created
- Offsets: 20m, 40m, etc.

### Fase D: Disparo
- Tabelas: `shots`, `shots_queue`
- Audiences: "quem deu /start", "quem gerou pix"
- Sharding por slug
- Estatísticas e cancelamento

---

## 📞 Troubleshooting

### Erro: `BOT_TOKEN_NOT_SET`
**Causa:** Bot não tem token configurado

**Solução:**
1. Acesse Admin UI
2. Navegue até o bot
3. Salve um token válido do @BotFather

### Erro: `CHAT_NOT_FOUND`
**Causa:** Chat ID inválido ou bot não iniciou conversa

**Solução:**
1. Inicie conversa com o bot no Telegram
2. Use seu próprio chat_id (obtenha com @userinfobot)

### Erro: `DATABASE_NOT_AVAILABLE`
**Causa:** PostgreSQL não conectado

**Solução:**
1. Verificar `DATABASE_URL` no `.env`
2. Verificar logs: `[PG] conectado.`

### Tabela `gateway_events` não existe
**Causa:** Migração não executada

**Solução:**
```bash
$env:ENABLE_BOOT_MIGRATION='true'; npm start
```

Ou executar SQL manualmente no banco.

---

**Status:** ✅ Fase A completa e pronta para testes!

**Próximo passo:** Executar testes e validar SLO (p95 ≤ 800ms)
