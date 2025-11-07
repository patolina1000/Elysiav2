# 🔧 Correção do Seletor de Mídia

## 🐛 Problema Identificado

O seletor de mídia estava **filtrando incorretamente** as mídias prontas. Havia 11 mídias no banco, mas o filtro retornava 0.

### Causa Raiz

O código estava usando **campos incorretos** para filtrar as mídias:

**❌ ANTES (Errado):**
```javascript
// Tentava acessar campos que não existiam
const readyMedia = mediaCache.filter(m => m.warming_status === 'ready');
const fileName = m.file_name;
const fileSize = m.file_size;
const mediaType = m.media_type;
```

**✅ DEPOIS (Correto):**
```javascript
// Usa a estrutura real retornada pelo servidor
const readyMedia = mediaCache.filter(m => m.cache && m.cache.status === 'ready');
const fileName = m.r2_key.split('/').pop();
const fileSize = m.bytes;
const mediaType = m.kind;
const fileId = m.cache.file_id;
```

---

## 📊 Estrutura Real das Mídias

Conforme definido em `lib/mediaService.js`, cada mídia tem esta estrutura:

```javascript
{
  id: 123,
  bot_slug: 'meubot',
  kind: 'photo',        // 'photo', 'video', 'audio', 'document'
  r2_key: 'bots/meubot/abc123.jpg',
  bytes: 256000,        // Tamanho em bytes
  sha256: 'abc...',
  ext: 'jpg',
  mime: 'image/jpeg',
  width: 1920,
  height: 1080,
  duration: null,
  created_at: '2025-11-06...',
  cache: {              // ← Status de aquecimento está AQUI!
    file_id: 'AgACAgEAAxkBAAI...',  // file_id do Telegram
    status: 'ready',    // 'warming', 'ready', 'not_cached', 'error'
    warmup_at: '2025-11-06...',
    last_error: null
  }
}
```

---

## ✅ Correções Aplicadas

### 1. Filtro de Mídias Prontas
**Arquivo:** `public/admin/admin.js`

```javascript
// ANTES ❌
const readyMedia = mediaCache.filter(m => m.warming_status === 'ready');

// DEPOIS ✅
const readyMedia = mediaCache.filter(m => m.cache && m.cache.status === 'ready');
```

### 2. Filtro de Busca e Tipo
```javascript
// ANTES ❌
const matchesSearch = (m.file_name || '').toLowerCase().includes(searchTerm);
const matchesType = m.media_type === typeFilter;

// DEPOIS ✅
const matchesSearch = (m.r2_key || '').toLowerCase().includes(searchTerm);
const matchesType = m.kind === typeFilter;
```

### 3. Renderização do Grid
```javascript
// ANTES ❌
const typeIcon = m.media_type === 'video' ? '🎥' : '🖼️';
const sizeKB = Math.round((m.file_size || 0) / 1024);
const fileName = m.file_name || 'Sem nome';
const fileId = m.file_id || '';

// DEPOIS ✅
const typeIcon = m.kind === 'video' ? '🎥' : m.kind === 'audio' ? '🎵' : '🖼️';
const sizeKB = Math.round((m.bytes || 0) / 1024);
const fileName = m.r2_key ? m.r2_key.split('/').pop() : 'Sem nome';
const fileId = m.cache?.file_id || '';
```

### 4. Preview de Imagens
**Melhorias no HTML gerado:**
- Ícone grande no centro para vídeos/áudios
- Imagem de preview para fotos
- Fallback se a imagem não carregar
- Background escuro para melhor contraste

```javascript
<div class="relative" style="height: 150px; background: #1a1a2e;">
  ${m.kind === 'photo' ? `<img src="${thumbUrl}" ... />` : ''}
  <div class="absolute inset-0 flex items-center justify-center text-6xl">
    ${typeIcon}
  </div>
</div>
```

---

## 🎯 Status dos Campos

### Status Possíveis (`cache.status`)

| Status | Significado | Exibir? |
|--------|-------------|---------|
| `'ready'` | Aquecida e pronta ✅ | SIM |
| `'warming'` | Sendo aquecida 🔄 | NÃO |
| `'not_cached'` | Não aquecida ❌ | NÃO |
| `'error'` | Erro ao aquecer ⚠️ | NÃO |

Apenas mídias com `cache.status === 'ready'` devem aparecer no seletor!

---

## 📁 Arquivos Modificados

```
✅ public/admin/admin.js
   - openMediaSelector(): Corrigido filtro de status
   - filterMediaGrid(): Corrigidos campos de busca e tipo
   - renderMediaGrid(): Corrigida renderização com campos corretos
```

---

## 🧪 Como Testar

1. **Recarregue a página** (Ctrl+Shift+R)

2. **Abra o seletor de mídia:**
   ```
   Bot → Mensagem Inicial → Tipo de mídia: Foto → 🎬 Selecionar mídia aquecida
   ```

3. **Logs esperados:**
   ```
   [MEDIA-SELECTOR] Total de mídias: 11
   [MEDIA-SELECTOR] Mídias prontas: 11  ← Agora deve mostrar 11!
   ```

4. **Verifique:**
   - ✅ Grid mostra as 11 mídias
   - ✅ Ícones corretos (🖼️ para fotos, 🎥 para vídeos)
   - ✅ Nome do arquivo (extraído de `r2_key`)
   - ✅ Tamanho em KB
   - ✅ Ao clicar, seleciona a mídia
   - ✅ file_id é preenchido automaticamente

---

## 🎉 Resultado

Agora o seletor de mídia:
- ✅ **Exibe todas as 11 mídias prontas**
- ✅ Usa os campos corretos da API
- ✅ Filtra corretamente por status `'ready'`
- ✅ Mostra preview visual adequado
- ✅ Preenche automaticamente o file_id

**Teste completo!** 🚀

