# 🎬 Melhorias no Sistema de Mídia

## Alterações Implementadas

### 1. ✅ Upload Múltiplo de Mídias

**Arquivo:** `public/admin/media.html`

- Adicionado atributo `multiple` no input de arquivo
- Preview mostra a primeira imagem selecionada
- Upload processa todos os arquivos em sequência
- Mostra progresso: "Enviando 1/5...", "Enviando 2/5..."
- Resultado final: "✅ 5 de 5 arquivos enviados com sucesso!"

**Como usar:**
1. Acesse Mídia → Upload
2. Clique ou arraste múltiplos arquivos de uma vez
3. Clique em "🚀 Fazer Upload"
4. O sistema fará upload de todos os arquivos sequencialmente

---

### 2. ✅ Seletor Visual de Mídia Aquecida

**Arquivos modificados:**
- `public/admin/index.html` - Estrutura HTML dos modais
- `public/admin/admin.js` - Lógica JavaScript

#### Modais Atualizados:

**Modal de Mensagem Inicial (/start):**
- Seleção de tipo de mídia: Nenhuma, Foto, Vídeo
- Botão "🎬 Selecionar mídia aquecida"
- Preview da mídia selecionada com thumbnail
- Botão para remover mídia selecionada

**Modal de Downsell:**
- Mesmo comportamento do modal /start
- Mídia opcional com caption
- Preview visual da mídia escolhida

**Modal de Disparo (Shot):**
- Seleção visual de mídia
- Integrado com a mensagem de disparo
- Preview da mídia antes de enviar

---

### 3. ✅ Modal de Seleção de Mídia

**Novo Modal:** `media-selector-modal`

#### Recursos:
- **Grid Visual:** Mostra todas as mídias aquecidas do bot atual
- **Preview de Imagens:** Thumbnail de cada mídia
- **Filtros:**
  - Busca por nome
  - Filtro por tipo (Todas, Fotos, Vídeos)
- **Informações:** Nome, tipo (🖼️/🎥), tamanho em KB
- **Hover Effect:** Destaque ao passar o mouse sobre a mídia
- **Seleção por Clique:** Clica na mídia para selecionar

#### Como funciona:
1. Abre automaticamente quando você escolhe um tipo de mídia (Foto/Vídeo)
2. Carrega apenas mídias com status "ready" (aquecidas)
3. Mostra loading enquanto busca as mídias
4. Se não houver mídias, mostra mensagem: "Nenhuma mídia aquecida encontrada"
5. Ao clicar em uma mídia:
   - Fecha o modal
   - Preenche automaticamente o file_id (hidden input)
   - Mostra preview da mídia selecionada
   - Toast: "Mídia selecionada: [nome]"

---

## Fluxo de Uso

### Cenário 1: Mensagem /start com mídia

1. Acesse o bot → Mensagem Inicial
2. Selecione "Tipo de mídia" → Foto
3. Clique em "🎬 Selecionar mídia aquecida"
4. Modal abre com grid de todas as fotos aquecidas
5. Clique na foto desejada
6. Modal fecha e mostra preview da mídia
7. Digite o texto da mensagem
8. Clique em "Salvar"

✅ O file_id é automaticamente preenchido e enviado!

### Cenário 2: Downsell com vídeo

1. Crie um novo downsell
2. Selecione "Mídia" → Vídeo
3. Clique em "🎬 Selecionar mídia aquecida"
4. Escolha o vídeo no grid
5. Adicione uma caption (opcional)
6. Configure os gatilhos e delay
7. Salvar

✅ Vídeo vinculado automaticamente!

### Cenário 3: Upload múltiplo de mídias

1. Acesse Mídia → Upload
2. Selecione o bot
3. Arraste 5 imagens de uma vez
4. Escolha o tipo: Foto
5. Clique em "🚀 Fazer Upload"
6. Sistema faz upload de todas: "Enviando 1/5... 2/5... 3/5..."
7. Resultado: "✅ 5 de 5 arquivos enviados com sucesso!"

✅ Todas as 5 imagens foram enviadas!

---

## Benefícios

### Antes:
- ❌ Upload de 1 arquivo por vez (tedioso)
- ❌ Digitar file_id manualmente (propenso a erros)
- ❌ Não saber quais mídias estão disponíveis
- ❌ Sem preview visual

### Depois:
- ✅ Upload de múltiplos arquivos simultaneamente
- ✅ Seleção visual com thumbnail
- ✅ Lista apenas mídias aquecidas (prontas)
- ✅ Busca e filtros para encontrar mídias
- ✅ Preview antes de selecionar
- ✅ file_id preenchido automaticamente
- ✅ Zero digitação manual

---

## Arquitetura Técnica

### Frontend

**HTML Structure:**
```html
<!-- Seletor de Mídia -->
<select id="downsell-media-type">
  <option value="none">Nenhuma</option>
  <option value="photo">Foto</option>
  <option value="video">Vídeo</option>
</select>

<button id="downsell-select-media-btn">
  🎬 Selecionar mídia aquecida
</button>

<input type="hidden" id="downsell-file-id">

<div id="downsell-selected-media" class="hidden">
  <img id="downsell-media-thumb" />
  <p id="downsell-media-name"></p>
  <button id="downsell-remove-media">✖️</button>
</div>
```

**JavaScript Functions:**
- `initMediaSelector()` - Inicializa event listeners
- `openMediaSelector(context)` - Abre modal e carrega mídias
- `renderMediaGrid(media)` - Renderiza grid de mídias
- `selectMedia(fileId, name, type, size, thumbUrl)` - Seleciona mídia
- `clearMediaSelection(context)` - Remove seleção
- `filterMediaGrid()` - Filtra por busca/tipo

### API Endpoints Usados

**GET** `/api/admin/bots/{slug}/media`
- Headers: `Authorization: Bearer {token}`
- Response: `{ media: [ { id, file_id, file_name, media_type, warming_status, r2_url, r2_thumbnail_url, file_size } ] }`

**POST** `/api/admin/bots/{slug}/media`
- Body: `{ kind, data_base64, mime, ext }`
- Response: `{ ok: true, media_id }`

---

## Cache e Performance

- Mídias são carregadas 1x ao abrir o modal
- Cache local (`mediaCache`) evita requests repetidos
- Filtros funcionam no cache local (instantâneos)
- Apenas mídias com `warming_status === 'ready'` são mostradas

---

## Estados do Modal

1. **Loading:** 🔄 Carregando mídias...
2. **Grid:** Mostra todas as mídias disponíveis
3. **Empty:** "Nenhuma mídia aquecida encontrada"
4. **Filtered Empty:** Quando busca/filtro não retorna resultados

---

## Melhorias Futuras (Não Implementadas)

- [ ] Paginação do grid (se houver > 50 mídias)
- [ ] Preview de vídeos no hover
- [ ] Multi-seleção (para enviar múltiplas mídias)
- [ ] Drag & drop direto no modal
- [ ] Editar mídia inline (alterar nome)
- [ ] Delete de mídia diretamente no seletor

---

## Resumo

**3 grandes melhorias:**
1. 📤 **Upload Múltiplo** - Envie várias mídias de uma vez
2. 🎬 **Seletor Visual** - Escolha mídias com preview
3. 🤖 **file_id Automático** - Sistema preenche automaticamente

**Resultado:** Interface muito mais intuitiva e produtiva! 🚀

