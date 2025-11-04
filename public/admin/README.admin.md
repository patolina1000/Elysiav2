# Painel Admin • Bots

Interface estática para gestão de bots no endpoint `/public/admin/`.

## Pré-requisitos
- Servir o arquivo com Tailwind via CDN (já incluso em `index.html`).
- Opcionalmente disponibilizar `/env.js` com `window.__ENV__ = { ADMIN_API_TOKEN, APP_BASE_URL, PUBLIC_BASE_URL }`.

## Funcionalidades
- Listagem de bots (`GET /api/admin/bots`) com estado de carregamento, busca local e recarregamento manual.
- Criação de bots (`POST /api/admin/bots`) com validação de campos e tratamento de respostas 4xx/5xx.
- Modal para gerenciamento da chave admin (persistência em `localStorage`).
- Toasts de feedback, skeletons e cartão de instruções com URL de webhook após criação.

## Fluxo de uso
1. Defina a chave admin pelo modal “Chave Admin”.
2. Use “Atualizar” para buscar os bots existentes.
3. Clique em “Novo Bot” para abrir o formulário de criação.
4. Após criar um bot, copie a URL do webhook exibida no cartão informativo.

## Observações
- A lista aplica filtros apenas em memória.
- Se uma variável de ambiente `ADMIN_API_TOKEN` for injetada via `window.__ENV__`, ela será usada como valor inicial, mas pode ser sobrescrita manualmente.
- Em caso de `401`, o modal de token abre automaticamente para redefinição da chave.
