# Implementação da UI de Downsells - Resumo

## ✅ Implementado

### Backend
1. **Endpoints de API** (`lib/adminEndpoints.js`):
   - `GET /api/admin/bots/:slug/downsells` - Listar
   - `POST /api/admin/bots/:slug/downsells` - Criar
   - `PUT /api/admin/bots/:slug/downsells/:id` - Editar
   - `PATCH /api/admin/bots/:slug/downsells/:id/toggle` - Ativar/Desativar
   - `DELETE /api/admin/bots/:slug/downsells/:id` - Excluir
   - `POST /api/admin/bots/:slug/downsells/test` - Testar

2. **Suporte a filtros de teste** (`lib/downsellService.js`):
   - `scheduleDownsellsForStart()` - Aceita `downsell_id_filter`
   - `scheduleDownsellsForPix()` - Aceita `downsell_id_filter`

### Frontend
1. **HTML** (`public/admin/index.html`):
   - Botão "Gerenciar downsells" na página de detalhes do bot
   - Modal principal de listagem com busca e filtros
   - Modal de formulário (criar/editar)
   - Modal de teste
   - Modal de exclusão
   - Modal de prévia

2. **Estrutura dos modais**:
   - Aviso sobre regra de negócio (PIX não pago)
   - Tabela responsiva com colunas: Título, Gatilhos, Delay, Ativo, Prévia, Ações
   - Estados: loading, empty, error, success
   - Validações inline
   - Contadores de caracteres
   - Prévia dinâmica de delay

## 📝 Próximos Passos

### 1. Criar arquivo JavaScript (`public/admin/downsells.js`)

O arquivo deve conter:
- Estado local (lista, filtros, etc.)
- Funções de API (fetch, create, update, delete, toggle, test)
- Renderização da tabela
- Gerenciamento de modais
- Event listeners
- Validações
- Formatação de dados (delay, truncate, etc.)

### 2. Integrar no `admin.js`

Adicionar no final do `admin.js`:
```javascript
// Carregar módulo de downsells
const downsellsScript = document.createElement('script');
downsellsScript.src = 'downsells.js';
document.head.appendChild(downsellsScript);
```

### 3. Testar fluxos

- [ ] Abrir modal de downsells
- [ ] Criar novo downsell
- [ ] Editar downsell existente
- [ ] Ativar/desativar inline
- [ ] Testar com gatilho /start
- [ ] Testar com gatilho PIX
- [ ] Excluir downsell
- [ ] Buscar/filtrar
- [ ] Ver prévia

## 🎨 Características da UI

- **Visual consistente** com o resto do Admin
- **Tailwind CSS** via CDN
- **Toasts** para feedback
- **Modais** com overlay e focus trap
- **Validações** inline com mensagens claras
- **Loading states** com spinners
- **Empty states** com CTAs
- **Error states** com retry
- **Responsive** para mobile
- **Acessibilidade** (ARIA labels, keyboard navigation)

## 🔒 Segurança

- Todos os endpoints exigem `Bearer ADMIN_API_TOKEN`
- Validações no backend e frontend
- Sanitização de inputs
- Confirmação para ações destrutivas

## 📊 Observabilidade

- Logs com prefixo `[ADMIN][DOWNSELLS]`
- Métricas de ações principais
- Contadores de total, ativos, inativos

## ⚠️ Avisos Importantes

1. **MarkdownV2**: Aviso visível sobre necessidade de escape
2. **Regra de gating**: Explicação clara sobre PIX não pago
3. **Cancelamento**: Informação sobre cancelamento automático ao pagar
4. **Teste**: Aviso sobre verificação de elegibilidade no teste

---

**Status**: Backend completo ✅ | Frontend HTML completo ✅ | JavaScript pendente ⏳
