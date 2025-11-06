# Sistema de Downsell com Duplo Gatilho (START + PIX)

## Resumo Executivo

Sistema completo de downsell implementado com:
- ✅ Duplo gatilho: **after_start** e **after_pix**
- ✅ Verificação de elegibilidade (gating): só envia se houver PIX não pago
- ✅ Cancelamento automático ao pagar
- ✅ Idempotência total (event_id único)
- ✅ Prioridade na fila: START > SHOT > DOWNSELL
- ✅ Sem novas variáveis no .env
- ✅ Logs e métricas completos

---

## 1. Arquitetura

### 1.1 Fluxo Completo

```
┌─────────────────────────────────────────────────────────────┐
│                    GATILHOS DE AGENDAMENTO                   │
├─────────────────────────────────────────────────────────────┤
│  /start                              PIX Criado              │
│    ↓                                    ↓                    │
│  scheduleDownsellsForStart    scheduleDownsellsForPix       │
│    ↓                                    ↓                    │
│  INSERT downsells_queue (trigger='start' | 'pix')           │
│  • Unique constraint evita duplicados                        │
│  • event_id único por downsell/trigger/timestamp            │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    DOWNSELL SCHEDULER                        │
│  • Loop a cada 3s                                            │
│  • Busca pendentes com scheduled_at <= now()                │
│  • Enfileira no queueManager (prioridade DOWNSELL)          │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    DOWNSELL WORKER                           │
│  • Processa fila a cada 10s                                 │
│  • GATING: verifica elegibilidade antes de enviar           │
│    - trigger='pix': verifica transaction_id não pago        │
│    - trigger='start': verifica se usuário tem PIX não pago  │
│  • Se não elegível: marca como 'skipped'                    │
│  • Se elegível: envia via sendService                       │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    CANCELAMENTO                              │
│  • Ao pagar: cancela TODOS os pendentes do usuário          │
│  • Ao expirar PIX: cancela pendentes da transação           │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Estrutura de Dados

### 2.1 Tabela `bot_downsells`

```sql
CREATE TABLE bot_downsells (
  id bigserial PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  content jsonb NOT NULL,
  delay_minutes integer NOT NULL DEFAULT 20,
  active boolean NOT NULL DEFAULT true,
  after_start boolean DEFAULT true,   -- NOVO
  after_pix boolean DEFAULT false,    -- NOVO
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### 2.2 Tabela `downsells_queue`

```sql
CREATE TABLE downsells_queue (
  id bigserial PRIMARY KEY,
  bot_slug text NOT NULL,              -- NOVO
  telegram_id bigint NOT NULL,         -- NOVO
  downsell_id bigint NOT NULL,
  transaction_id text,                 -- NOVO (null para trigger='start')
  trigger text NOT NULL,               -- NOVO ('start' | 'pix')
  scheduled_at timestamptz NOT NULL,   -- NOVO (renomeado de schedule_at)
  status text NOT NULL DEFAULT 'pending',
  cancel_reason text,                  -- NOVO
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,  -- NOVO
  event_id text NOT NULL UNIQUE,       -- NOVO (idempotência)
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  CONSTRAINT downsells_queue_trigger_check 
    CHECK (trigger IN ('start', 'pix')),
  CONSTRAINT downsells_queue_status_check 
    CHECK (status IN ('pending', 'sent', 'failed', 'canceled', 'expired', 'skipped'))
);

-- Índices
CREATE UNIQUE INDEX ux_downsells_queue_event_id 
  ON downsells_queue (event_id);

CREATE UNIQUE INDEX ux_downsells_queue_pending_unique
  ON downsells_queue (bot_slug, telegram_id, downsell_id)
  WHERE status = 'pending';

CREATE INDEX ix_downsells_queue_scheduled_status 
  ON downsells_queue (scheduled_at, status)
  WHERE status = 'pending';
```

---

## 3. Arquivos Criados/Modificados

### 3.1 Novos Arquivos

```
migrations/
  008_downsells_dual_trigger.sql        # Migração idempotente

lib/
  pixEligibilityService.js              # Verifica PIX não pago
  downsellScheduler.js                  # Loop de enfileiramento
  paymentWebhookService.js              # Handlers de webhooks de pagamento

DOWNSELL_DUAL_TRIGGER.md               # Este documento
```

### 3.2 Arquivos Modificados

```
lib/
  downsellService.js                    # Novas funções de agendamento e cancelamento
  downsellWorker.js                     # Gating antes de enviar
  adminEndpoints.js                     # Suporte a after_start/after_pix

server.js                               # Integração dos novos componentes
```

---

## 4. Funções Principais

### 4.1 Agendamento

#### `scheduleDownsellsForStart(pool, params)`
Agenda downsells após `/start` (para downsells com `after_start=true`).

```javascript
await scheduleDownsellsForStart(pool, {
  bot_slug: 'meubot',
  telegram_id: 123456789,
  correlation_id: 'req-xyz',
  now: new Date()
});
```

#### `scheduleDownsellsForPix(pool, params)`
Agenda downsells após PIX criado (para downsells com `after_pix=true`).

```javascript
await scheduleDownsellsForPix(pool, {
  bot_slug: 'meubot',
  telegram_id: 123456789,
  transaction_id: 'tx-abc123',
  correlation_id: 'req-xyz',
  now: new Date()
});
```

### 4.2 Elegibilidade

#### `checkDownsellEligibility(pool, params)`
Verifica se o downsell deve ser enviado (double-check).

```javascript
const { eligible, reason } = await checkDownsellEligibility(pool, {
  trigger: 'pix',
  transaction_id: 'tx-abc123',
  bot_slug: 'meubot',
  telegram_id: 123456789
});

if (!eligible) {
  console.log('Não elegível:', reason); // 'no_unpaid_pix'
}
```

### 4.3 Cancelamento

#### `cancelDownsellsOnPayment(pool, params)`
Cancela todos os downsells pendentes ao pagar.

```javascript
const canceled = await cancelDownsellsOnPayment(pool, {
  bot_slug: 'meubot',
  telegram_id: 123456789,
  transaction_id: 'tx-abc123'
});
```

#### `cancelDownsellsOnExpiration(pool, transaction_id)`
Cancela downsells ao expirar PIX.

```javascript
const canceled = await cancelDownsellsOnExpiration(pool, 'tx-abc123');
```

---

## 5. Integração com Gateway de Pagamento

### 5.1 Webhook: PIX Criado

```javascript
const paymentWebhookService = require('./lib/paymentWebhookService');

app.post('/api/payment/webhook/pix-created', async (req, res) => {
  res.status(200).json({ ok: true }); // ACK imediato
  
  setImmediate(async () => {
    const pool = await getPgPool();
    await paymentWebhookService.handlePixCreated(pool, {
      bot_slug: req.body.bot_slug,
      telegram_id: req.body.telegram_id,
      transaction_id: req.body.transaction_id,
      correlation_id: req.body.correlation_id || genReqId()
    });
  });
});
```

### 5.2 Webhook: Pagamento Aprovado

```javascript
app.post('/api/payment/webhook/payment-approved', async (req, res) => {
  res.status(200).json({ ok: true }); // ACK imediato
  
  setImmediate(async () => {
    const pool = await getPgPool();
    await paymentWebhookService.handlePaymentApproved(pool, {
      bot_slug: req.body.bot_slug,
      telegram_id: req.body.telegram_id,
      transaction_id: req.body.transaction_id
    });
  });
});
```

### 5.3 Webhook: PIX Expirado

```javascript
app.post('/api/payment/webhook/pix-expired', async (req, res) => {
  res.status(200).json({ ok: true }); // ACK imediato
  
  setImmediate(async () => {
    const pool = await getPgPool();
    await paymentWebhookService.handlePixExpired(pool, {
      transaction_id: req.body.transaction_id
    });
  });
});
```

---

## 6. API Admin

### 6.1 Criar Downsell

```bash
POST /api/admin/bots/:slug/downsells
{
  "name": "Downsell 20min",
  "content": {
    "text": "Ainda está aí? Temos uma oferta especial!",
    "parse_mode": "MarkdownV2"
  },
  "delay_minutes": 20,
  "active": true,
  "after_start": true,   # Envia após /start
  "after_pix": false     # Não envia após PIX
}
```

### 6.2 Atualizar Downsell

```bash
PUT /api/admin/bots/:slug/downsells/:id
{
  "delay_minutes": 30,
  "after_start": true,
  "after_pix": true      # Agora envia em ambos os gatilhos
}
```

### 6.3 Listar Downsells

```bash
GET /api/admin/bots/:slug/downsells

# Resposta
{
  "ok": true,
  "downsells": [
    {
      "id": 1,
      "name": "Downsell 20min",
      "delay_minutes": 20,
      "active": true,
      "after_start": true,
      "after_pix": false,
      ...
    }
  ]
}
```

---

## 7. Logs e Métricas

### 7.1 Logs

```
[DOWNSELL][SCHEDULED][START]    # Agendado após /start
[DOWNSELL][SCHEDULED][PIX]      # Agendado após PIX
[DOWNSELL][DUE]                 # Batch pronto para envio
[DOWNSELL][ENQUEUED]            # Enfileirado no queueManager
[DOWNSELL][SKIP]                # Pulado por não elegibilidade
[DOWNSELL][SEND][OK]            # Enviado com sucesso
[DOWNSELL][SEND][ERR]           # Erro no envio
[DOWNSELL][CANCEL][PAID]        # Cancelado ao pagar
[DOWNSELL][CANCEL][EXPIRED]     # Cancelado ao expirar
```

### 7.2 Métricas

```javascript
downsells_scheduled_start       # Agendados após /start
downsells_scheduled_pix         # Agendados após PIX
downsells_enqueued              # Enfileirados
downsells_sent                  # Enviados
downsells_failed                # Falhas
downsells_skipped_gate          # Pulados por gating
downsells_canceled_paid         # Cancelados ao pagar
```

---

## 8. Critérios de Aceite

### ✅ Implementado

1. **Agendamento duplo gatilho**
   - `/start` agenda downsells com `after_start=true`
   - `pix_created` agenda downsells com `after_pix=true`
   - Sem duplicados (unique constraint)

2. **Gating (double-check)**
   - `trigger='pix'`: verifica `transaction_id` não pago
   - `trigger='start'`: verifica se usuário tem PIX não pago
   - Se não elegível: marca como `skipped`

3. **Cancelamento automático**
   - Ao pagar: cancela todos os pendentes do usuário
   - Ao expirar: cancela pendentes da transação

4. **Idempotência**
   - `event_id` único por downsell/trigger/timestamp
   - `ON CONFLICT (event_id) DO NOTHING`

5. **Prioridade**
   - START (1) > SHOT (2) > DOWNSELL (3)

6. **Sem novas variáveis no .env**
   - Tudo configurável via banco de dados

7. **Logs e métricas**
   - Logs estruturados com contexto completo
   - Métricas para observabilidade

---

## 9. Testes

### 9.1 Teste do Gatilho START

```bash
# 1. Criar downsell com after_start=true
POST /api/admin/bots/teste/downsells
{
  "name": "Downsell START",
  "content": { "text": "Oferta especial!" },
  "delay_minutes": 1,
  "active": true,
  "after_start": true,
  "after_pix": false
}

# 2. Enviar /start no Telegram
# 3. Aguardar 1 minuto
# 4. Verificar se recebeu o downsell
```

### 9.2 Teste do Gatilho PIX

```bash
# 1. Criar downsell com after_pix=true
POST /api/admin/bots/teste/downsells
{
  "name": "Downsell PIX",
  "content": { "text": "Finalize seu pagamento!" },
  "delay_minutes": 1,
  "active": true,
  "after_start": false,
  "after_pix": true
}

# 2. Simular webhook de PIX criado
POST /api/payment/webhook/pix-created
{
  "bot_slug": "teste",
  "telegram_id": 123456789,
  "transaction_id": "tx-test-123"
}

# 3. Aguardar 1 minuto
# 4. Verificar se recebeu o downsell
```

### 9.3 Teste de Cancelamento

```bash
# 1. Agendar downsell (via /start ou PIX)
# 2. Simular pagamento aprovado
POST /api/payment/webhook/payment-approved
{
  "bot_slug": "teste",
  "telegram_id": 123456789,
  "transaction_id": "tx-test-123"
}

# 3. Verificar que downsells pendentes foram cancelados
# 4. Verificar que não recebeu o downsell
```

### 9.4 Teste de Gating

```bash
# 1. Agendar downsell com trigger='start'
# 2. NÃO criar PIX
# 3. Aguardar scheduled_at
# 4. Verificar log: [DOWNSELL][SKIP] reason=no_unpaid_pix
# 5. Verificar status='skipped' no banco
```

---

## 10. Migração

### 10.1 Aplicar Migração

```bash
# Aplicar migração 008
psql $DATABASE_URL -f migrations/008_downsells_dual_trigger.sql
```

### 10.2 Verificar Estrutura

```sql
-- Verificar colunas novas
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'downsells_queue'
ORDER BY ordinal_position;

-- Verificar índices
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'downsells_queue';
```

---

## 11. Troubleshooting

### Problema: Downsells não estão sendo agendados após /start

**Verificar:**
1. Downsell está ativo (`active=true`)
2. Downsell tem `after_start=true`
3. Logs mostram `[START][DOWNSELLS_SCHEDULED]`

### Problema: Downsells não estão sendo enviados

**Verificar:**
1. `downsellScheduler` está rodando (logs no boot)
2. `downsellWorker` está rodando (logs no boot)
3. Status na fila: `SELECT * FROM downsells_queue WHERE status='pending'`
4. Logs de gating: `[DOWNSELL][SKIP]` reason=?

### Problema: Downsells sendo enviados mesmo após pagar

**Verificar:**
1. Webhook de pagamento está sendo chamado
2. Logs mostram `[DOWNSELL][CANCEL][PAID]`
3. Status na fila: `SELECT * FROM downsells_queue WHERE status='canceled'`

---

## 12. Próximos Passos

1. **Frontend Admin UI**
   - Adicionar checkboxes `after_start` e `after_pix` na interface
   - Mostrar badge "Só envia se houver PIX não pago"
   - Botão "Testar agora" com campo `telegram_id`

2. **Testes Automatizados**
   - Testes unitários dos serviços
   - Testes de integração dos workers
   - Testes de gating e cancelamento

3. **Monitoramento**
   - Dashboard de métricas em tempo real
   - Alertas para downsells skipped > threshold

---

## 13. Referências

- **Prioridade da fila**: `config/rate.js`
- **Estrutura de eventos**: `lib/funnel.js`
- **Envio de mensagens**: `lib/sendService.js`
- **Documentação geral**: `INSTANT-MESSAGING.md`

---

**Versão:** 1.0.0  
**Data:** 2025-01-06  
**Autor:** Sistema Elysiav2
