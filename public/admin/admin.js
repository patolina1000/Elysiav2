(() => {
  // Guard para evitar múltiplas inicializações
  if (window.__ADMIN_INITIALIZED__) {
    console.warn('[ADMIN][INIT] Já inicializado, abortando.');
    return;
  }
  window.__ADMIN_INITIALIZED__ = true;

  const ADMIN_TOKEN_KEY = 'ADMIN_API_TOKEN';
  const FETCH_TIMEOUT = 10000;
  const SEARCH_DEBOUNCE = 250;
  const MAX_TOASTS = 3;

  // Escapa metacaracteres para usar com new RegExp com segurança
  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Cabeçalhos de autorização (nunca logar token)
  function authHeaders() {
    try {
      const t =
        window.ADMIN_API_TOKEN ||
        sessionStorage.getItem('ADMIN_API_TOKEN') ||
        localStorage.getItem('ADMIN_API_TOKEN');
      return t ? { Authorization: 'Bearer ' + t } : {};
    } catch (err) {
      return {};
    }
  }

  const env = window.__ENV__ || window.env || {};
  const appOrigin = window.location.origin;
  const baseUrl = (env.APP_BASE_URL && env.APP_BASE_URL.trim()) || appOrigin;
  const publicBaseUrl = (env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.trim()) || '';

  const elements = {
    botsListView: document.querySelector('#bots-list-view'),
    botDetailView: document.querySelector('#bot-detail-view'),
    tableBody: document.querySelector('#bots-table-body'),
    emptyState: document.querySelector('#empty-state'),
    refreshBtn: document.querySelector('#refresh-btn'),
    searchInput: document.querySelector('#search-input'),
    newBotBtn: document.querySelector('#new-bot-btn'),
    adminTokenBtn: document.querySelector('#admin-token-btn'),
    tokenModal: document.querySelector('#token-modal'),
    botModal: document.querySelector('#bot-modal'),
    modalOverlay: document.querySelector('#modal-overlay'),
    tokenForm: document.querySelector('#token-form'),
    tokenInput: document.querySelector('#token-input'),
    toggleTokenVisibility: document.querySelector('#toggle-token-visibility'),
    tokenSourceText: document.querySelector('#token-source'),
    clearTokenBtn: document.querySelector('#clear-token'),
    botForm: document.querySelector('#bot-form'),
    createBotBtn: document.querySelector('#create-bot-btn'),
    validateTokenBtn: document.querySelector('#btn-validate-token'),
    botTokenInput: document.querySelector('#bot-token'),
    tokenStatus: document.querySelector('#token-status'),
    toastContainer: document.querySelector('#toast-container'),
    publicBaseInfo: document.querySelector('#public-base-info'),
    instructionsCard: document.querySelector('#instructions-card'),
    webhookUrl: document.querySelector('#webhook-url'),
    copyWebhookBtn: document.querySelector('#copy-webhook'),
    closeInstructionsBtn: document.querySelector('#close-instructions'),
    errorHint: document.querySelector('#error-hint'),
  };

  const focusState = {
    lastFocused: null,
  };

  const state = {
    bots: [],
    loading: false,
    searchTerm: '',
    token: '',
    tokenSource: 'não configurado',
    lastCreatedSlug: null,
    abortController: null,
  };

  const INTERNAL_RATE_PER_MINUTE = 60;

  const BOT_DEFAULTS = {
    rate_per_minute: 60,
    sandbox: false,
    renderer: 'MarkdownV2',
    typing_delay_ms: 0,
    watermark: null,
  };

  function currentAdminSlug() {
    const cleanedPath = window.location.pathname.replace(/\/+$/, '');
    const parts = cleanedPath.split('/');
    if (parts.length >= 3 && parts[1] === 'admin') {
      try {
        return decodeURIComponent(parts[2]);
      } catch (err) {
        return parts[2];
      }
    }
    return null;
  }

  async function adminRouter() {
    const slug = currentAdminSlug();
    if (elements.botsListView) {
      elements.botsListView.style.display = slug ? 'none' : '';
    }
    if (elements.botDetailView) {
      elements.botDetailView.style.display = slug ? '' : 'none';
    }

    if (slug) {
      await renderBotDetail(slug);
    } else {
      await renderBotsList();
    }
  }

  function safeGetLocalToken() {
    try {
      return localStorage.getItem(ADMIN_TOKEN_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  function safeSetLocalToken(value) {
    try {
      if (value) {
        localStorage.setItem(ADMIN_TOKEN_KEY, value);
      } else {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
      }
    } catch (err) {
      // ignore storage issues silently
    }
  }

  function initToken() {
    const envToken = typeof env.ADMIN_API_TOKEN === 'string' ? env.ADMIN_API_TOKEN.trim() : '';
    const storedToken = safeGetLocalToken().trim();

    if (storedToken) {
      state.token = storedToken;
      state.tokenSource = 'localStorage';
    } else if (envToken) {
      state.token = envToken;
      state.tokenSource = 'variável de ambiente';
    } else {
      state.token = '';
      state.tokenSource = 'não configurado';
    }

    updateTokenSourceDisplay();
    if (!state.token) {
      setTimeout(() => openModal('token-modal'), 200);
    }
  }

  function updateTokenSourceDisplay() {
    if (elements.publicBaseInfo) {
      elements.publicBaseInfo.textContent = publicBaseUrl
        ? `Base pública: ${publicBaseUrl}`
        : 'Base pública não configurada';
    }

    if (!elements.tokenSourceText) return;
    const sourceLabel =
      state.tokenSource === 'variável de ambiente'
        ? 'Origem: Variável de ambiente'
        : state.tokenSource === 'localStorage'
        ? 'Origem: localStorage'
        : 'Origem: não configurado';
    elements.tokenSourceText.textContent = sourceLabel;
  }

  function getAuthHeaders() {
    const token = state.token && state.token.trim();
    if (token) {
      return {
        Authorization: `Bearer ${token}`,
      };
    }
    const headers = authHeaders();
    return headers && headers.Authorization ? headers : null;
  }

  function renderSkeletonRows(count = 5) {
    elements.tableBody.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const row = document.createElement('tr');
      row.className = 'loading';
      for (let j = 0; j < 7; j++) {
        const cell = document.createElement('td');
        cell.className = 'table-cell';
        const placeholder = document.createElement('div');
        placeholder.className = 'skeleton';
        cell.appendChild(placeholder);
        row.appendChild(cell);
      }
      elements.tableBody.appendChild(row);
    }
    elements.emptyState.classList.add('hidden');
  }

  function renderBots(bots) {
    elements.tableBody.innerHTML = '';
    if (!bots.length) {
      elements.emptyState.classList.remove('hidden');
      return;
    }
    elements.emptyState.classList.add('hidden');

    bots.forEach((bot) => {
      const row = document.createElement('tr');
      const rpm =
        typeof bot.rate_per_minute === 'number'
          ? bot.rate_per_minute
          : typeof bot.rate_per_min === 'number'
          ? bot.rate_per_min
          : INTERNAL_RATE_PER_MINUTE;
      const cells = [
        bot.name || '—',
        bot.slug || '—',
        bot.provider || '—',
        bot.sandbox ? 'Sim' : 'Não',
        rpm,
        formatFlags(bot.flags),
      ];

      cells.forEach((value) => {
        const cell = document.createElement('td');
        cell.className = 'table-cell text-sm text-zinc-200';
        cell.textContent = value;
        row.appendChild(cell);
      });

      const actionsCell = document.createElement('td');
      actionsCell.className = 'table-cell text-sm text-zinc-200';
      const btnEdit = document.createElement('button');
      btnEdit.type = 'button';
      btnEdit.className = 'btn-secondary text-xs px-3 py-1';
      btnEdit.textContent = 'Editar';
      if (bot.slug) {
        btnEdit.dataset.action = 'edit-bot';
        btnEdit.dataset.slug = bot.slug;
        console.log('[ADMIN][RENDER] Botão Editar criado para:', bot.slug);
      } else {
        btnEdit.disabled = true;
      }
      actionsCell.appendChild(btnEdit);
      row.appendChild(actionsCell);

      elements.tableBody.appendChild(row);
    });
  }

  async function renderBotsList() {
    if (!state.token) {
      await fetchBots();
      return;
    }

    if (!state.bots.length) {
      await fetchBots();
    } else {
      applyFilter();
    }
  }

  function formatFlags(flags) {
    if (Array.isArray(flags)) {
      return flags.length ? flags.join(', ') : '—';
    }
    if (typeof flags === 'object' && flags !== null) {
      return Object.keys(flags).length ? JSON.stringify(flags) : '—';
    }
    return flags ? String(flags) : '—';
  }

  function applyFilter() {
    const term = state.searchTerm.trim();
    let filtered = state.bots;
    if (term) {
      const rx = new RegExp(escapeRegExp(term), 'i');
      filtered = state.bots.filter((bot) => {
        const name = String(bot.name || '');
        const slug = String(bot.slug || '');
        return rx.test(name) || rx.test(slug);
      });
    }
    renderBots(filtered);
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    elements.refreshBtn.disabled = isLoading;
    if (isLoading) {
      elements.refreshBtn.textContent = 'Carregando…';
      renderSkeletonRows(4 + Math.floor(Math.random() * 2));
    } else {
      elements.refreshBtn.textContent = '🔄 Atualizar';
    }
  }

  async function fetchBots() {
    console.log('[ADMIN][API] fetchBots iniciado');
    
    if (!state.token) {
      console.warn('[ADMIN][API] Token ausente');
      showToast('warning', 'Informe a chave admin para listar os bots.');
      openModal('token-modal');
      return state.bots;
    }

    if (state.abortController) {
      state.abortController.abort();
    }

    const headers = getAuthHeaders();
    if (!headers) {
      console.error('[ADMIN][API] Headers de autenticação ausentes');
      return state.bots;
    }

    setLoading(true);
    elements.errorHint.classList.add('hidden');
    elements.errorHint.textContent = '';

    const controller = new AbortController();
    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, FETCH_TIMEOUT);
    state.abortController = controller;

    try {
      console.log('[ADMIN][API] GET /api/admin/bots');
      const response = await fetch(`${baseUrl}/api/admin/bots`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      console.log('[ADMIN][API] Response status:', response.status);

      if (response.status === 401) {
        console.error('[ADMIN][API] 401 Unauthorized');
        handleUnauthorized();
        return state.bots;
      }

      if (response.status === 429) {
        console.warn('[ADMIN][API] 429 Too Many Requests');
        showToast('warning', 'Muitas requisições. Aguarde alguns segundos.');
        displayErrorHint('Muitas requisições. Aguarde alguns segundos.');
        return state.bots;
      }

      if (!response.ok) {
        console.error('[ADMIN][API] Fetch failed:', response.status);
        throw new Error('fetch_failed');
      }

      const data = await response.json();
      console.log('[ADMIN][API] Bots recebidos:', data.length);
      state.bots = Array.isArray(data) ? data : [];
      applyFilter();
    } catch (error) {
      if (controller.signal.aborted && didTimeout) {
        console.error('[ADMIN][API] Timeout');
        showToast('error', 'Tempo excedido ao carregar bots.');
        displayErrorHint('Tempo excedido ao carregar bots.');
      } else if (controller.signal.aborted) {
        console.log('[ADMIN][API] Abortado manualmente');
      } else {
        console.error('[ADMIN][ERR] fetchBots:', error);
        showToast('error', 'Não foi possível carregar a lista.');
        if (!state.bots.length) {
          elements.emptyState.classList.remove('hidden');
        } else {
          applyFilter();
        }
      }
    } finally {
      setLoading(false);
      clearTimeout(timer);
      if (state.abortController === controller) {
        state.abortController = null;
      }
    }

    return state.bots;
  }

  function handleUnauthorized() {
    showToast('error', 'Token inválido. Informe novamente.');
    clearToken();
    openModal('token-modal');
  }

  function displayErrorHint(message) {
    if (!elements.errorHint) return;
    elements.errorHint.textContent = message;
    elements.errorHint.classList.remove('hidden');
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    focusState.lastFocused = document.activeElement;
    modal.classList.remove('hidden');
    elements.modalOverlay.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    trapFocus(modal);

    if (id === 'token-modal') {
      elements.tokenInput.value = state.token;
      elements.toggleTokenVisibility.textContent = 'Mostrar';
      elements.tokenInput.type = 'password';
      setTimeout(() => elements.tokenInput.focus(), 50);
    }

    if (id === 'bot-modal') {
      elements.botForm.reset();
      document.querySelector('#bot-provider').value = 'pushinpay';
      document.querySelector('#bot-album').checked = true;
      if (elements.botTokenInput) {
        elements.botTokenInput.value = '';
      }
      if (elements.tokenStatus) {
        elements.tokenStatus.textContent = '';
      }
      clearFieldErrors();
      setTimeout(() => {
        const firstInput = modal.querySelector('input, select, textarea, button:not([type="button"])');
        if (firstInput) firstInput.focus();
      }, 50);
    }
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');

    const anyOpen = document.querySelectorAll('.modal:not(.hidden)').length > 0;
    if (!anyOpen) {
      elements.modalOverlay.classList.add('hidden');
    }

    if (focusState.lastFocused && typeof focusState.lastFocused.focus === 'function') {
      focusState.lastFocused.focus();
    }
  }

  function closeAllModals() {
    document.querySelectorAll('.modal').forEach((modal) => {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    });
    elements.modalOverlay.classList.add('hidden');
    if (focusState.lastFocused) {
      focusState.lastFocused.focus();
    }
  }

  function trapFocus(modal) {
    if (!modal.dataset.trapBound) {
      modal.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') {
          const focusable = Array.from(
            modal.querySelectorAll(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1")]'
            )
          ).filter((el) => el.offsetParent !== null);
          if (!focusable.length) return;
          const firstEl = focusable[0];
          const lastEl = focusable[focusable.length - 1];
          if (event.shiftKey) {
            if (document.activeElement === firstEl) {
              event.preventDefault();
              lastEl.focus();
            }
          } else if (document.activeElement === lastEl) {
            event.preventDefault();
            firstEl.focus();
          }
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeModal(modal.id);
        }
      });
      modal.dataset.trapBound = 'true';
    }
  }

  function clearToken() {
    safeSetLocalToken('');
    const envToken = typeof env.ADMIN_API_TOKEN === 'string' ? env.ADMIN_API_TOKEN.trim() : '';
    if (envToken) {
      state.token = envToken;
      state.tokenSource = 'variável de ambiente';
    } else {
      state.token = '';
      state.tokenSource = 'não configurado';
    }
    updateTokenSourceDisplay();
  }

  function showToast(type, message) {
    if (!elements.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.innerHTML = `<span>${typeIcon(type)}</span><span>${message}</span>`;

    elements.toastContainer.appendChild(toast);
    while (elements.toastContainer.children.length > MAX_TOASTS) {
      elements.toastContainer.removeChild(elements.toastContainer.firstChild);
    }

    setTimeout(() => {
      toast.classList.add('toast-hiding');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function typeIcon(type) {
    switch (type) {
      case 'success':
        return '✅';
      case 'warning':
        return '⚠️';
      case 'error':
      default:
        return '⛔';
    }
  }

  function debounce(fn, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(null, args), delay);
    };
  }

  function clearFieldErrors() {
    elements.botForm.querySelectorAll('.form-input, .form-select').forEach((input) => {
      input.classList.remove('error');
    });
    elements.botForm.querySelectorAll('.form-hint').forEach((hint) => {
      hint.classList.add('hidden');
      hint.textContent = '';
    });
  }

  function applyFieldErrors(errors) {
    if (!errors || typeof errors !== 'object') return;
    Object.entries(errors).forEach(([field, messages]) => {
      const hint = elements.botForm.querySelector(`.form-hint[data-error-for="${field}"]`);
      const input = elements.botForm.querySelector(`[name="${field}"]`);
      if (hint) {
        hint.textContent = Array.isArray(messages) ? messages.join(' ') : String(messages);
        hint.classList.remove('hidden');
      }
      if (input) {
        input.classList.add('error');
      }
    });
  }

  function serializeBotForm() {
    const formData = new FormData(elements.botForm);
    const payload = {
      name: (formData.get('name') || '').toString().trim(),
      slug: (formData.get('slug') || '').toString().trim(),
      provider: (formData.get('provider') || '').toString().trim(),
      use_album: formData.get('use_album') === 'on',
      ...BOT_DEFAULTS,
    };
    const token = (formData.get('token') || '').toString().trim();
    if (token) {
      payload.token = token;
    }
    return payload;
  }

  async function handleValidateTokenClick() {
    if (!elements.validateTokenBtn || !elements.botTokenInput || !elements.tokenStatus) {
      return;
    }

    const token = elements.botTokenInput.value.trim();
    if (!token) {
      elements.tokenStatus.textContent = 'Informe o token para validar.';
      return;
    }

    const previousLabel = elements.validateTokenBtn.textContent;
    elements.validateTokenBtn.disabled = true;
    elements.validateTokenBtn.textContent = 'Validando…';
    elements.tokenStatus.textContent = '';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(`${baseUrl}/api/telegram/validate-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));
      if (response.ok && data && data.ok) {
        const info = data.result || {};
        const username = info.username ? `@${info.username}` : '@sem_username';
        const id = info.id || 'desconhecido';
        elements.tokenStatus.textContent = `✅ Válido: ${username} (id ${id})`;
      } else {
        const reason = (data && (data.error || data.description)) || 'TOKEN_INVALID';
        elements.tokenStatus.textContent = `❌ Inválido: ${reason}`;
      }
    } catch (error) {
      elements.tokenStatus.textContent = '❌ Erro de rede/timeout na validação.';
    } finally {
      elements.validateTokenBtn.disabled = false;
      elements.validateTokenBtn.textContent = previousLabel;
    }
  }

  async function handleBotSubmit(event) {
    event.preventDefault();
    console.log('[ADMIN][SUBMIT] handleBotSubmit iniciado');
    clearFieldErrors();

    if (!state.token) {
      console.warn('[ADMIN][SUBMIT] Token ausente');
      showToast('warning', 'Defina a chave admin antes de criar.');
      openModal('token-modal');
      return;
    }

    if (!elements.botForm.reportValidity()) {
      console.warn('[ADMIN][SUBMIT] Formulário inválido');
      return;
    }

    const payload = serializeBotForm();
    console.log('[ADMIN][SUBMIT] Payload:', { ...payload, token: payload.token ? '***' : undefined });
    
    elements.createBotBtn.disabled = true;
    const previousLabel = elements.createBotBtn.textContent;
    elements.createBotBtn.textContent = 'Criando…';

    try {
      const headers = {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      };

      const controller = new AbortController();
      let didTimeout = false;
      const timer = setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, FETCH_TIMEOUT);

      let response;
      try {
        console.log('[ADMIN][API] POST /api/admin/bots');
        response = await fetch(`${baseUrl}/api/admin/bots`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        console.log('[ADMIN][API] Response status:', response.status);
      } catch (error) {
        console.error('[ADMIN][ERR] Fetch error:', error);
        if (controller.signal.aborted && didTimeout) {
          showToast('error', 'Tempo excedido ao criar. Tente novamente.');
        } else {
          showToast('error', 'Erro ao criar. Tente novamente.');
        }
        return;
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 401) {
        console.error('[ADMIN][API] 401 Unauthorized');
        handleUnauthorized();
        return;
      }

      if (response.status === 409) {
        console.warn('[ADMIN][API] 409 Conflict - Slug já existe');
        applyFieldErrors({ slug: 'Slug já existente.' });
        showToast('error', 'Slug já existente.');
        return;
      }

      if (response.status === 422 || response.status === 400) {
        console.warn('[ADMIN][API] Validation error:', response.status);
        const data = await response.json().catch(() => ({}));
        if (data && typeof data === 'object') {
          const fieldErrors = data.errors || data;
          applyFieldErrors(fieldErrors);
        }
        showToast('error', 'Revise os campos destacados.');
        return;
      }

      if (!response.ok) {
        console.error('[ADMIN][API] Create failed:', response.status);
        throw new Error('create_failed');
      }

      const result = await response.json().catch(() => ({}));
      const slug = result.slug || payload.slug;
      console.log('[ADMIN][API] Bot criado:', slug);
      state.lastCreatedSlug = slug;
      updateInstructionsCard();

      showToast('success', 'Bot criado com sucesso.');
      closeModal('bot-modal');
      await fetchBots();
    } catch (error) {
      console.error('[ADMIN][ERR] handleBotSubmit:', error);
      showToast('error', 'Erro ao criar. Tente novamente.');
    } finally {
      elements.createBotBtn.disabled = false;
      elements.createBotBtn.textContent = previousLabel;
    }
  }

  function updateInstructionsCard() {
    if (!state.lastCreatedSlug) return;
    const base = publicBaseUrl || appOrigin;
    const url = `${base.replace(/\/$/, '')}/tg/${state.lastCreatedSlug}/webhook`;
    elements.webhookUrl.textContent = url;
    elements.instructionsCard.classList.remove('hidden');
  }

  async function renderBotDetail(slug) {
    if (!elements.botDetailView) return;

    const root = elements.botDetailView;
    root.innerHTML = '';

    const template = document.getElementById('tpl-bot-detail');
    if (!template) {
      const fallback = document.createElement('p');
      fallback.className = 'text-sm text-zinc-400';
      fallback.textContent = 'Detalhe indisponível.';
      root.appendChild(fallback);
      return;
    }

    if (!slug) {
      const message = document.createElement('p');
      message.className = 'text-sm text-zinc-400';
      message.textContent = 'Bot não encontrado.';
      root.appendChild(message);
      return;
    }

    if (!state.token) {
      const message = document.createElement('p');
      message.className = 'text-sm text-zinc-400';
      message.textContent = 'Informe a chave admin para visualizar os detalhes do bot.';
      root.appendChild(message);
      openModal('token-modal');
      showToast('warning', 'Informe a chave admin para visualizar os detalhes do bot.');
      return;
    }

    const loading = document.createElement('p');
    loading.className = 'text-sm text-zinc-400';
    loading.textContent = 'Carregando…';
    root.appendChild(loading);

    // Buscar detalhes do bot via API
    let bot = null;
    try {
      const headers = getAuthHeaders();
      if (!headers) {
        throw new Error('NO_AUTH');
      }

      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}`, {
        method: 'GET',
        headers
      });

      if (response.ok) {
        bot = await response.json();
      } else if (response.status === 404) {
        root.innerHTML = '';
        const message = document.createElement('p');
        message.className = 'text-sm text-zinc-400';
        message.textContent = 'Bot não encontrado.';
        root.appendChild(message);
        return;
      } else {
        throw new Error('FETCH_FAILED');
      }
    } catch (err) {
      console.error('[ADMIN][DETAIL][ERR]', err);
      root.innerHTML = '';
      const message = document.createElement('p');
      message.className = 'text-sm text-zinc-400';
      message.textContent = 'Erro ao carregar detalhes do bot.';
      root.appendChild(message);
      return;
    }

    root.innerHTML = '';

    if (!bot) {
      const message = document.createElement('p');
      message.className = 'text-sm text-zinc-400';
      message.textContent = 'Bot não encontrado.';
      root.appendChild(message);
      return;
    }

    const fragment = template.content.cloneNode(true);

    const assignField = (field, value) => {
      const normalized = value ?? '';
      fragment.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.value = normalized;
        } else {
          el.textContent = normalized;
        }
      });
    };

    assignField('name', bot.name || '');
    assignField('slug', bot.slug || '');
    assignField('provider', bot.provider || '');

    const base = publicBaseUrl || appOrigin;
    const webhookValue = bot.webhook_url || `${base.replace(/\/$/, '')}/tg/${bot.slug}/webhook`;
    assignField('webhook', webhookValue);
    assignField('webhook-url-display', webhookValue);

    // Status do token
    const hasTokenBadge = bot.has_token ? '✅ Token configurado' : '⚠️ Sem token';
    assignField('has-token-badge', hasTokenBadge);

    if (bot.token_updated_at) {
      const date = new Date(bot.token_updated_at);
      const formatted = date.toLocaleString('pt-BR');
      assignField('token-updated-at', `Atualizado em: ${formatted}`);
    } else {
      assignField('token-updated-at', '');
    }

    if (bot.has_token) {
      assignField('token-info', 'Token criptografado armazenado com segurança.');
    } else {
      assignField('token-info', 'Nenhum token configurado. Cole e salve o token do bot.');
    }

    assignField('token-status', '');

    // Atribuir data-slug ao botão de configurar mensagem inicial
    const configureStartBtn = fragment.querySelector('[data-field="configure-start-message-btn"]');
    if (configureStartBtn) {
      configureStartBtn.setAttribute('data-slug', bot.slug);
    }

    root.appendChild(fragment);
  }

  function copyWebhookUrl() {
    const text = elements.webhookUrl.textContent.trim();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => showToast('success', 'URL copiada.'))
        .catch(() => showToast('error', 'Não foi possível copiar.'));
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showToast('success', 'URL copiada.');
      } catch (err) {
        showToast('error', 'Não foi possível copiar.');
      }
      document.body.removeChild(textarea);
    }
  }

  async function handleTokenSubmit(event) {
    event.preventDefault();
    const value = elements.tokenInput.value.trim();
    if (!value) {
      showToast('warning', 'Informe um token válido.');
      return;
    }
    state.token = value;
    state.tokenSource = 'localStorage';
    safeSetLocalToken(value);
    updateTokenSourceDisplay();
    closeModal('token-modal');
    showToast('success', 'Token salvo.');
    await adminRouter();
  }

  async function handleTokenClear() {
    clearToken();
    elements.tokenInput.value = '';
    showToast('success', 'Token limpo.');
    await adminRouter();
  }

  function handleOverlayClick(event) {
    if (event.target === elements.modalOverlay) {
      closeAllModals();
    }
  }

  function handleDocumentKeydown(event) {
    if (event.key === 'Escape') {
      closeAllModals();
    }
  }

  function toggleTokenVisibility() {
    if (elements.tokenInput.type === 'password') {
      elements.tokenInput.type = 'text';
      elements.toggleTokenVisibility.textContent = 'Ocultar';
    } else {
      elements.tokenInput.type = 'password';
      elements.toggleTokenVisibility.textContent = 'Mostrar';
    }
  }

  function registerEventListeners() {
    console.log('[ADMIN][INIT] Registrando event listeners...');

    // Delegação de eventos para cliques em botões
    document.addEventListener('click', async (event) => {
      const target = event.target.closest('button[data-action], a[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      console.log('[ADMIN][CLICK]', action, target.dataset);

      event.preventDefault();

      switch (action) {
        case 'edit-bot': {
          const slug = target.dataset.slug;
          if (slug) {
            history.pushState(null, '', `/admin/${encodeURIComponent(slug)}`);
            await adminRouter();
          }
          break;
        }
        case 'back': {
          history.pushState(null, '', '/admin');
          await adminRouter();
          break;
        }
        case 'reveal': {
          const input = target.closest('.flex').querySelector('input[data-field="token"]');
          if (input) {
            input.type = input.type === 'password' ? 'text' : 'password';
          }
          break;
        }
        case 'save-token': {
          await handleDetailSaveToken(target);
          break;
        }
        case 'validate': {
          await handleDetailValidateToken(target);
          break;
        }
        case 'copy-webhook': {
          await handleDetailCopyWebhook(target);
          break;
        }
        case 'delete-bot': {
          await handleDeleteBot(target);
          break;
        }
        case 'send-test': {
          await handleSendTest(target);
          break;
        }
        case 'webhook-set': {
          await handleWebhookSet(target);
          break;
        }
        case 'webhook-delete': {
          await handleWebhookDelete(target);
          break;
        }
        case 'webhook-status': {
          await handleWebhookStatus(target);
          break;
        }
        case 'configure-start-message': {
          const slug = target.dataset.slug || currentAdminSlug();
          if (!slug) {
            console.error('[ADMIN][CONFIGURE_START_MESSAGE] Slug não encontrado');
            showToast('error', 'Slug não encontrado');
            return;
          }
          try {
            console.log('[ADMIN][CONFIGURE_START_MESSAGE]', { slug });
            await openStartMessageModal(slug);
          } catch (err) {
            console.error('[ADMIN][CONFIGURE_START_MESSAGE][ERR]', err);
            showToast('error', `Erro ao abrir modal: ${err.message}`);
          }
          break;
        }
        case 'manage-downsells': {
          const slug = target.dataset.slug || currentAdminSlug();
          if (!slug) {
            console.error('[ADMIN][MANAGE_DOWNSELLS] Slug não encontrado');
            showToast('error', 'Slug não encontrado');
            return;
          }
          try {
            console.log('[ADMIN][MANAGE_DOWNSELLS]', { slug });
            await openDownsellsModal(slug);
          } catch (err) {
            console.error('[ADMIN][MANAGE_DOWNSELLS][ERR]', err);
            showToast('error', `Erro ao abrir modal: ${err.message}`);
          }
          break;
        }
        case 'new-downsell': {
          const slug = currentDownsellsSlug;
          if (!slug) {
            showToast('error', 'Slug não encontrado');
            return;
          }
          await openDownsellFormModal(slug);
          break;
        }
        case 'retry-load-downsells': {
          const slug = currentDownsellsSlug;
          if (slug) {
            await loadDownsells(slug);
          }
          break;
        }
        case 'manage-shots': {
          const slug = target.dataset.slug || currentAdminSlug();
          if (!slug) {
            console.error('[ADMIN][MANAGE_SHOTS] Slug não encontrado');
            showToast('error', 'Slug não encontrado');
            return;
          }
          try {
            console.log('[ADMIN][MANAGE_SHOTS]', { slug });
            await openShotsModal(slug);
          } catch (err) {
            console.error('[ADMIN][MANAGE_SHOTS][ERR]', err);
            showToast('error', `Erro ao abrir modal: ${err.message}`);
          }
          break;
        }
        case 'new-shot': {
          const slug = currentShotsSlug;
          if (!slug) {
            showToast('error', 'Slug não encontrado');
            return;
          }
          await openShotFormModal(slug);
          break;
        }
        case 'retry-load-shots': {
          const slug = currentShotsSlug;
          if (slug) {
            await loadShots(slug);
          }
          break;
        }
      }
    });

    // Event listeners diretos (não dinâmicos)
    elements.adminTokenBtn.addEventListener('click', () => {
      console.log('[ADMIN][CLICK] admin-token-btn');
      openModal('token-modal');
    });

    elements.newBotBtn.addEventListener('click', () => {
      console.log('[ADMIN][CLICK] new-bot-btn');
      openModal('bot-modal');
    });

    elements.refreshBtn.addEventListener('click', async () => {
      console.log('[ADMIN][CLICK] refresh-btn');
      await fetchBots();
    });

    elements.tokenForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      console.log('[ADMIN][SUBMIT] token-form');
      await handleTokenSubmit(event);
    });

    elements.clearTokenBtn.addEventListener('click', async () => {
      console.log('[ADMIN][CLICK] clear-token-btn');
      await handleTokenClear();
    });

    elements.toggleTokenVisibility.addEventListener('click', () => {
      console.log('[ADMIN][CLICK] toggle-token-visibility');
      toggleTokenVisibility();
    });

    elements.botForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      console.log('[ADMIN][SUBMIT] bot-form');
      await handleBotSubmit(event);
    });

    if (elements.validateTokenBtn) {
      elements.validateTokenBtn.addEventListener('click', async () => {
        console.log('[ADMIN][CLICK] validate-token-btn');
        await handleValidateTokenClick();
      });
    }

    elements.modalOverlay.addEventListener('click', (event) => {
      console.log('[ADMIN][CLICK] modal-overlay');
      handleOverlayClick(event);
    });

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close-modal');
        console.log('[ADMIN][CLICK] close-modal:', modalId);
        closeModal(modalId);
      });
    });

    // Event listeners do modal de exclusão
    const deleteCheckbox = document.getElementById('delete-confirm-checkbox');
    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    
    if (deleteCheckbox && confirmDeleteBtn) {
      deleteCheckbox.addEventListener('change', () => {
        confirmDeleteBtn.disabled = !deleteCheckbox.checked;
      });

      confirmDeleteBtn.addEventListener('click', async () => {
        await handleConfirmDelete();
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        console.log('[ADMIN][KEY] Escape');
        handleDocumentKeydown(event);
      }
    });

    elements.copyWebhookBtn.addEventListener('click', () => {
      console.log('[ADMIN][CLICK] copy-webhook-btn');
      copyWebhookUrl();
    });

    elements.closeInstructionsBtn.addEventListener('click', () => {
      console.log('[ADMIN][CLICK] close-instructions-btn');
      elements.instructionsCard.classList.add('hidden');
    });

    elements.searchInput.addEventListener(
      'input',
      debounce((event) => {
        console.log('[ADMIN][INPUT] search:', event.target.value);
        state.searchTerm = event.target.value || '';
        applyFilter();
      }, SEARCH_DEBOUNCE)
    );

    console.log('[ADMIN][INIT] Event listeners registrados.');
  }

  window.addEventListener('popstate', async () => {
    try {
      await adminRouter();
    } catch (err) {
      console.error('[ADMIN][ERR] popstate:', err);
    }
  });

  async function handleDetailSaveToken(button) {
    const slug = currentAdminSlug();
    if (!slug) {
      showToast('error', 'Slug não encontrado.');
      return;
    }

    const container = button.closest('.form-field');
    const input = container.querySelector('input[data-field="token"]');
    const statusEl = container.querySelector('[data-field="token-status"]');

    if (!input || !statusEl) return;

    const token = input.value.trim();
    if (!token) {
      statusEl.textContent = 'Cole o token antes de salvar.';
      showToast('warning', 'Informe o token antes de salvar.');
      return;
    }

    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }

    statusEl.textContent = 'Salvando…';
    button.disabled = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}/token`, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.ok) {
        statusEl.textContent = `✅ Token salvo com sucesso! (${data.token_masked})`;
        showToast('success', 'Token salvo com segurança.');
        
        // Atualizar badges
        const hasBadge = document.querySelector('[data-field="has-token-badge"]');
        if (hasBadge) hasBadge.textContent = '✅ Token configurado';
        
        const updatedAt = document.querySelector('[data-field="token-updated-at"]');
        if (updatedAt && data.token_updated_at) {
          const date = new Date(data.token_updated_at);
          updatedAt.textContent = `Atualizado em: ${date.toLocaleString('pt-BR')}`;
        }

        const tokenInfo = document.querySelector('[data-field="token-info"]');
        if (tokenInfo) tokenInfo.textContent = 'Token criptografado armazenado com segurança.';

        // Limpar input após salvar
        input.value = '';
      } else {
        const errorMsg = data.error || 'SAVE_FAILED';
        statusEl.textContent = `❌ Erro: ${errorMsg}`;
        showToast('error', `Erro ao salvar: ${errorMsg}`);
      }
    } catch (err) {
      statusEl.textContent = 'Timeout/Erro de rede';
      showToast('error', 'Erro ao salvar token.');
      console.error('[ADMIN][ERR] save-token:', err);
    } finally {
      button.disabled = false;
    }
  }

  async function handleDetailValidateToken(button) {
    const slug = currentAdminSlug();
    if (!slug) {
      showToast('error', 'Slug não encontrado.');
      return;
    }

    const container = button.closest('.form-field');
    const input = container.querySelector('input[data-field="token"]');
    const statusEl = container.querySelector('[data-field="token-status"]');

    if (!input || !statusEl) return;

    const token = input.value.trim();
    
    // Se não há token no input, validar o token salvo
    if (!token) {
      const headers = getAuthHeaders();
      if (!headers) {
        showToast('error', 'Token admin não configurado.');
        return;
      }

      statusEl.textContent = 'Validando token salvo…';
      button.disabled = true;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}/token/status`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const data = await response.json().catch(() => ({}));

        if (data && data.ok) {
          const username = data.username ? `@${data.username}` : 'sem username';
          statusEl.textContent = `✅ Token válido: ${username} (ID: ${data.bot_id})`;
          showToast('success', `Token válido: ${username}`);
        } else {
          const errorMsg = data.error || 'INVALID_TOKEN';
          statusEl.textContent = `❌ ${errorMsg}`;
          showToast('error', `Erro: ${errorMsg}`);
        }
      } catch (err) {
        statusEl.textContent = 'Timeout/Erro de rede';
        showToast('error', 'Erro ao validar token.');
        console.error('[ADMIN][ERR] validate-saved-token:', err);
      } finally {
        button.disabled = false;
      }
      return;
    }

    // Validar token do input (sem salvar)
    statusEl.textContent = 'Validando…';
    button.disabled = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${baseUrl}/api/telegram/validate-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        if (data && data.ok) {
          const username = data.result?.username ? `@${data.result.username}` : 'sem username';
          statusEl.textContent = `✅ Válido: ${username}`;
          showToast('success', `Token válido: ${username}`);
        } else {
          const message = (data && data.error) || 'Inválido';
          statusEl.textContent = `❌ ${message}`;
          showToast('error', `Token inválido: ${message}`);
        }
      } else {
        statusEl.textContent = response.status === 400 ? 'Inválido ❌' : 'Erro ao validar';
        showToast('error', 'Erro ao validar token.');
      }
    } catch (err) {
      statusEl.textContent = 'Timeout/Erro de rede';
      showToast('error', 'Erro ao validar token.');
      console.error('[ADMIN][ERR] validate-token:', err);
    } finally {
      button.disabled = false;
    }
  }

  async function handleDeleteBot(button) {
    const slug = currentAdminSlug();
    if (!slug) {
      showToast('error', 'Slug não encontrado.');
      return;
    }

    // Buscar dados do bot para exibir no modal
    const bot = state.bots.find(b => b.slug === slug);
    if (!bot) {
      showToast('error', 'Bot não encontrado.');
      return;
    }

    // Preencher modal com dados do bot
    const nameEl = document.querySelector('[data-field="delete-bot-name"]');
    const slugEl = document.querySelector('[data-field="delete-bot-slug"]');
    if (nameEl) nameEl.textContent = bot.name || slug;
    if (slugEl) slugEl.textContent = slug;

    // Resetar checkbox
    const checkbox = document.getElementById('delete-confirm-checkbox');
    const confirmBtn = document.getElementById('confirm-delete-btn');
    if (checkbox) checkbox.checked = false;
    if (confirmBtn) confirmBtn.disabled = true;

    // Abrir modal
    openModal('delete-modal');
  }

  async function handleConfirmDelete() {
    const slug = currentAdminSlug();
    if (!slug) {
      showToast('error', 'Slug não encontrado.');
      return;
    }

    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }

    const confirmBtn = document.getElementById('confirm-delete-btn');
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000); // Aumentado para 15s por ser hard delete
      
      // HARD DELETE - passa ?hard=1 para deletar TODOS os dados permanentemente
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}?hard=1`, {
        method: 'DELETE',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.ok) {
        const recordsDeleted = data.deleted_records || {};
        const totalRecords = Object.values(recordsDeleted).reduce((sum, count) => sum + count, 0);
        
        console.log('[ADMIN][DELETE][HARD][SUCCESS]', { slug, deleted_records: recordsDeleted, total: totalRecords });
        
        showToast('success', `Bot ${slug} e todos os seus dados (${totalRecords} registros) foram excluídos permanentemente.`);
        closeModal('delete-modal');
        
        // Navegar de volta para lista
        history.pushState(null, '', '/admin');
        await adminRouter();
        
        // Recarregar lista
        await fetchBots();
      } else {
        const errorMsg = data.error || 'DELETE_FAILED';
        showToast('error', `Erro ao excluir: ${errorMsg}`);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        showToast('error', 'Timeout ao excluir bot. Tente novamente.');
      } else {
        showToast('error', 'Erro ao excluir bot.');
      }
      console.error('[ADMIN][ERR] delete-bot:', err);
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  async function handleSendTest(button) {
    const slug = currentAdminSlug();
    if (!slug) {
      showToast('error', 'Slug não encontrado.');
      return;
    }

    const container = button.closest('.form-field');
    const chatIdInput = container.querySelector('input[data-field="test-chat-id"]');
    const textInput = container.querySelector('textarea[data-field="test-text"]');
    const statusEl = container.querySelector('[data-field="send-test-status"]');

    if (!chatIdInput || !textInput || !statusEl) return;

    const chat_id = chatIdInput.value.trim();
    const text = textInput.value.trim();

    if (!chat_id) {
      statusEl.textContent = 'Informe o Chat ID.';
      showToast('warning', 'Informe o Chat ID.');
      return;
    }

    if (!text) {
      statusEl.textContent = 'Informe o texto da mensagem.';
      showToast('warning', 'Informe o texto da mensagem.');
      return;
    }

    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }

    statusEl.textContent = 'Enviando...';
    button.disabled = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}/send-test`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chat_id, text }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.ok) {
        const dedupeMsg = data.dedupe_applied ? ' (deduplicado)' : '';
        statusEl.textContent = `✅ Enviado! Message ID: ${data.message_id}, Latência: ${data.lat_ms}ms${dedupeMsg}`;
        showToast('success', `Mensagem enviada com sucesso!${dedupeMsg}`);
        
        console.info('[ADMIN][SEND_TEST][OK]', {
          slug,
          chat_id,
          message_id: data.message_id,
          lat_ms: data.lat_ms,
          telegram_lat_ms: data.telegram_lat_ms,
          dedupe_applied: data.dedupe_applied
        });
      } else {
        const errorMsg = data.error || 'SEND_FAILED';
        const description = data.description ? ` (${data.description})` : '';
        statusEl.textContent = `❌ Erro: ${errorMsg}${description}`;
        showToast('error', `Erro ao enviar: ${errorMsg}`);
        
        console.error('[ADMIN][SEND_TEST][ERR]', {
          slug,
          chat_id,
          error: errorMsg,
          description: data.description
        });
      }
    } catch (err) {
      statusEl.textContent = 'Timeout/Erro de rede';
      showToast('error', 'Erro ao enviar mensagem.');
      console.error('[ADMIN][ERR] send-test:', err);
    } finally {
      button.disabled = false;
    }
  }

  async function handleWebhookSet(button) {
    const slug = currentAdminSlug();
    if (!slug) {
      showToast('error', 'Slug não encontrado.');
      return;
    }

    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }

    button.disabled = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      
      // Construir URL HTTPS pública do webhook
      const publicBase = (window.env?.PUBLIC_BASE_URL || publicBaseUrl || window.location.origin).replace(/\/+$/, '');
      const webhookUrl = `${publicBase}/tg/${encodeURIComponent(slug)}/webhook`;
      
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}/webhook/set`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.ok) {
        showToast('success', 'Webhook definido com sucesso!');
        
        const statusDisplay = document.querySelector('[data-field="webhook-status-display"]');
        const statusText = document.querySelector('[data-field="webhook-status-text"]');
        
        if (statusDisplay && statusText) {
          statusDisplay.style.display = 'block';
          statusText.innerHTML = `✅ <strong>Webhook configurado!</strong><br>URL: ${data.webhook_url}`;
        }
        
        console.info('[ADMIN][WEBHOOK][SET][OK]', { slug, webhook_url: data.webhook_url });
      } else {
        const errorMsg = data.error || 'SET_FAILED';
        const description = data.description ? `<br>${data.description}` : '';
        showToast('error', `Erro ao definir webhook: ${errorMsg}`);
        
        const statusDisplay = document.querySelector('[data-field="webhook-status-display"]');
        const statusText = document.querySelector('[data-field="webhook-status-text"]');
        
        if (statusDisplay && statusText) {
          statusDisplay.style.display = 'block';
          statusText.innerHTML = `❌ <strong>Erro:</strong> ${errorMsg}${description}`;
        }
      }
    } catch (err) {
      showToast('error', 'Erro ao definir webhook.');
      console.error('[ADMIN][ERR] webhook-set:', err);
    } finally {
      button.disabled = false;
    }
  }

  async function handleWebhookDelete(button) {
    const slug = currentAdminSlug();
    if (!slug) {
      showToast('error', 'Slug não encontrado.');
      return;
    }

    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }

    button.disabled = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}/webhook/delete`, {
        method: 'POST',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.ok) {
        showToast('success', 'Webhook removido com sucesso!');
        
        const statusDisplay = document.querySelector('[data-field="webhook-status-display"]');
        const statusText = document.querySelector('[data-field="webhook-status-text"]');
        
        if (statusDisplay && statusText) {
          statusDisplay.style.display = 'block';
          statusText.innerHTML = `✅ <strong>Webhook removido!</strong>`;
        }
        
        console.info('[ADMIN][WEBHOOK][DELETE][OK]', { slug });
      } else {
        const errorMsg = data.error || 'DELETE_FAILED';
        showToast('error', `Erro ao remover webhook: ${errorMsg}`);
      }
    } catch (err) {
      showToast('error', 'Erro ao remover webhook.');
      console.error('[ADMIN][ERR] webhook-delete:', err);
    } finally {
      button.disabled = false;
    }
  }

  async function handleWebhookStatus(button) {
    const slug = currentAdminSlug();
    if (!slug) {
      showToast('error', 'Slug não encontrado.');
      return;
    }

    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }

    button.disabled = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}/webhook/status`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.ok) {
        const statusDisplay = document.querySelector('[data-field="webhook-status-display"]');
        const statusText = document.querySelector('[data-field="webhook-status-text"]');
        
        if (statusDisplay && statusText) {
          statusDisplay.style.display = 'block';
          
          if (data.url) {
            let statusHtml = `✅ <strong>Webhook ativo</strong><br>`;
            statusHtml += `URL: ${data.url}<br>`;
            statusHtml += `Updates pendentes: ${data.pending_update_count || 0}`;
            
            if (data.last_error_message) {
              statusHtml += `<br>⚠️ Último erro: ${data.last_error_message}`;
            }
            
            statusText.innerHTML = statusHtml;
          } else {
            statusText.innerHTML = `⚠️ <strong>Sem webhook configurado</strong><br>Use "Definir Webhook" para configurar.`;
          }
        }
        
        showToast('info', 'Status obtido com sucesso!');
        console.info('[ADMIN][WEBHOOK][STATUS][OK]', { slug, has_webhook: !!data.url });
      } else {
        const errorMsg = data.error || 'STATUS_FAILED';
        showToast('error', `Erro ao obter status: ${errorMsg}`);
      }
    } catch (err) {
      showToast('error', 'Erro ao obter status do webhook.');
      console.error('[ADMIN][ERR] webhook-status:', err);
    } finally {
      button.disabled = false;
    }
  }

  async function handleDetailCopyWebhook(button) {
    const container = button.closest('.form-field');
    const input = container.querySelector('input[data-field="webhook"]');
    const statusEl = container.closest('.grid').querySelector('[data-field="token-status"]');

    if (!input) return;

    const webhookValue = input.value.trim();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(webhookValue);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = webhookValue;
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
        } finally {
          document.body.removeChild(textarea);
        }
      }
      if (statusEl) statusEl.textContent = 'Webhook copiado ✔';
      showToast('success', 'Webhook copiado.');
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Falha ao copiar';
      showToast('error', 'Falha ao copiar.');
      console.error('[ADMIN][ERR] copy-webhook:', err);
    }
  }

  // ========== MENSAGEM INICIAL DO /START ==========
  
  let currentStartMessageSlug = null;

  async function openStartMessageModal(slug) {
    console.log('[START_MESSAGE][OPEN_MODAL]', { slug });
    currentStartMessageSlug = slug;
    setCurrentMediaBotSlug(slug); // Para o seletor de mídia
    const modal = document.getElementById('start-message-modal');
    const overlay = document.getElementById('modal-overlay');
    
    if (!modal) {
      console.error('[START_MESSAGE][MODAL_NOT_FOUND]');
      return;
    }
    if (!overlay) {
      console.error('[START_MESSAGE][OVERLAY_NOT_FOUND]');
      return;
    }

    // Carregar dados atuais
    let startMediaRefs = [];
    try {
      const headers = getAuthHeaders();
      if (!headers) {
        showToast('error', 'Token admin não configurado.');
        return;
      }
      
      console.log('[START_MESSAGE][FETCH]', `${baseUrl}/api/admin/bots/${slug}/start-message`);
      const response = await fetch(`${baseUrl}/api/admin/bots/${slug}/start-message`, {
        headers
      });
      
      console.log('[START_MESSAGE][RESPONSE]', { status: response.status, ok: response.ok });
      
      if (!response.ok) throw new Error('Falha ao carregar mensagem');
      
      const data = await response.json();
      console.log('[START_MESSAGE][DATA]', data);
      
      // Armazenar start_media_refs para uso posterior
      startMediaRefs = data?.start_media_refs || [];
      
      // Preencher formulário
      const activeEl = document.getElementById('start-message-active');
      const textEl = document.getElementById('start-message-text');
      const disablePreviewEl = document.getElementById('start-message-disable-preview');
      const rawEl = document.getElementById('start-message-raw');
      
      if (activeEl) activeEl.checked = data.active || false;
      if (textEl) textEl.value = data.message?.text || '';
      if (disablePreviewEl) disablePreviewEl.checked = data.message?.disable_web_page_preview || false;
      if (rawEl) rawEl.checked = data.message?.raw || false;
      
      // Atualizar contador
      updateCharCount();
      
      // Atualizar data
      const updatedAtEl = document.getElementById('start-message-updated-at');
      if (data.updated_at) {
        const date = new Date(data.updated_at);
        if (updatedAtEl) updatedAtEl.textContent = 
          `Última atualização: ${date.toLocaleString('pt-BR')}`;
      } else {
        if (updatedAtEl) updatedAtEl.textContent = '';
      }
      
      // Mostrar/ocultar campos baseado no toggle
      toggleStartMessageFields();
      
    } catch (err) {
      console.error('[START_MESSAGE][LOAD][ERR]', err);
      showToast('error', 'Erro ao carregar mensagem');
    }
    
    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
    
    // Montar o componente multi-mídia após o modal estar visível
    requestAnimationFrame(() => {
      const container = document.getElementById('start-message-multi-media-container');
      if (container && typeof MultiMediaSelector !== 'undefined') {
        // Montar o seletor com as configurações solicitadas
        window.multiMediaSelector = new MultiMediaSelector(container, {
          maxItems: 3,
          allowedKinds: ['audio', 'video', 'photo'],
          showTypeFilter: true,
          value: startMediaRefs
        });
        
        console.log('[START_MESSAGE][MULTI_MEDIA] Componente montado com', startMediaRefs.length, 'mídias');
      } else {
        console.error('[START_MESSAGE][MULTI_MEDIA] Container ou MultiMediaSelector não encontrado');
      }
    });
  }

  function toggleStartMessageFields() {
    const activeEl = document.getElementById('start-message-active');
    const textField = document.getElementById('start-message-text-field');
    const options = document.getElementById('start-message-options');
    const testSection = document.getElementById('start-message-test-section');
    const saveBtn = document.getElementById('start-message-save-btn');
    const saveCloseBtn = document.getElementById('start-message-save-close-btn');
    
    const active = activeEl ? activeEl.checked : false;
    
    if (active) {
      if (textField) textField.classList.remove('opacity-50', 'pointer-events-none');
      if (options) options.classList.remove('opacity-50', 'pointer-events-none');
      if (testSection) testSection.classList.remove('opacity-50', 'pointer-events-none');
    } else {
      if (textField) textField.classList.add('opacity-50', 'pointer-events-none');
      if (options) options.classList.add('opacity-50', 'pointer-events-none');
      if (testSection) testSection.classList.add('opacity-50', 'pointer-events-none');
    }
    
    // Validar botão salvar
    validateStartMessageForm();
  }

  function updateCharCount() {
    const textEl = document.getElementById('start-message-text');
    const charCountEl = document.getElementById('start-message-char-count');
    
    if (textEl && charCountEl) {
      const text = textEl.value;
      charCountEl.textContent = text.length;
    }
  }

  function validateStartMessageForm() {
    const activeEl = document.getElementById('start-message-active');
    const textEl = document.getElementById('start-message-text');
    const saveBtn = document.getElementById('start-message-save-btn');
    const saveCloseBtn = document.getElementById('start-message-save-close-btn');
    
    const active = activeEl ? activeEl.checked : false;
    const text = textEl ? textEl.value.trim() : '';
    
    const isValid = !active || (text.length > 0 && text.length <= 4096);
    
    if (saveBtn) saveBtn.disabled = !isValid;
    if (saveCloseBtn) saveCloseBtn.disabled = !isValid;
  }

  function toggleRawWarning() {
    const rawEl = document.getElementById('start-message-raw');
    const warning = document.getElementById('start-message-raw-warning');
    
    const raw = rawEl ? rawEl.checked : false;
    
    if (raw && warning) {
      warning.classList.remove('hidden');
    } else if (warning) {
      warning.classList.add('hidden');
    }
  }

  async function saveStartMessage(closeAfter = false) {
    if (!currentStartMessageSlug) return;
    
    const activeEl = document.getElementById('start-message-active');
    const textEl = document.getElementById('start-message-text');
    const disablePreviewEl = document.getElementById('start-message-disable-preview');
    const rawEl = document.getElementById('start-message-raw');
    
    const active = activeEl ? activeEl.checked : false;
    const text = textEl ? textEl.value.trim() : '';
    const disablePreview = disablePreviewEl ? disablePreviewEl.checked : false;
    const raw = rawEl ? rawEl.checked : false;
    
    // Obter mídias do multi-media-selector
    let startMediaRefs = [];
    if (window.multiMediaSelector && typeof window.multiMediaSelector.getValue === 'function') {
      startMediaRefs = window.multiMediaSelector.getValue();
      console.log('[START_MESSAGE][SAVE] Mídias selecionadas:', startMediaRefs.length);
    }
    
    // Validação
    if (active && !text) {
      showToast('error', 'Texto obrigatório quando ativo');
      return;
    }
    
    if (text.length > 4096) {
      showToast('error', 'Texto muito longo (máx 4096)');
      return;
    }
    
    const message = active ? {
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: disablePreview,
      raw
    } : null;
    
    const payload = {
      active,
      message,
      start_media_refs: startMediaRefs // Incluir as mídias do multi-media-selector
    };
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }
    
    try {
      const response = await fetch(`${baseUrl}/api/admin/bots/${currentStartMessageSlug}/start-message`, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Falha ao salvar');
      }
      
      showToast('success', 'Mensagem salva com sucesso');
      
      if (closeAfter) {
        closeModal('start-message-modal');
      }
    } catch (err) {
      console.error('[START_MESSAGE][SAVE][ERR]', err);
      showToast('error', `Erro: ${err.message}`);
    }
  }

  async function testStartMessage() {
    if (!currentStartMessageSlug) return;
    
    const chatIdEl = document.getElementById('start-message-test-chat-id');
    const textEl = document.getElementById('start-message-text');
    const disablePreviewEl = document.getElementById('start-message-disable-preview');
    const rawEl = document.getElementById('start-message-raw');
    const resultDiv = document.getElementById('start-message-test-result');
    const testBtn = document.getElementById('start-message-test-btn');
    
    const chatId = chatIdEl ? chatIdEl.value.trim() : '';
    const text = textEl ? textEl.value.trim() : '';
    const disablePreview = disablePreviewEl ? disablePreviewEl.checked : false;
    const raw = rawEl ? rawEl.checked : false;
    
    if (!chatId) {
      showToast('error', 'Chat ID obrigatório');
      return;
    }
    
    if (!text) {
      showToast('error', 'Texto obrigatório');
      return;
    }
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }
    
    testBtn.disabled = true;
    testBtn.textContent = 'Enviando...';
    resultDiv.classList.add('hidden');
    
    try {
      const response = await fetch(`${baseUrl}/api/admin/bots/${currentStartMessageSlug}/start-message:test`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          message: {
            text,
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: disablePreview,
            raw
          }
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Falha ao enviar teste');
      }
      
      const result = await response.json();
      
      resultDiv.textContent = `✅ Enviado! message_id: ${result.message_id}, latência: ${result.telegram_http_ms}ms`;
      resultDiv.classList.remove('hidden', 'text-red-400');
      resultDiv.classList.add('text-green-400');
      
      showToast('success', 'Teste enviado com sucesso');
    } catch (err) {
      console.error('[START_MESSAGE][TEST][ERR]', err);
      resultDiv.textContent = `❌ Erro: ${err.message}`;
      resultDiv.classList.remove('hidden', 'text-green-400');
      resultDiv.classList.add('text-red-400');
      showToast('error', `Erro no teste: ${err.message}`);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Enviar teste';
    }
  }

  // ========== DOWNSELLS ==========
  
  let currentDownsellsSlug = null;
  let currentDownsells = [];
  let downsellsSearchTerm = '';
  let currentEditingDownsellId = null;

  // ========== SHOTS (DISPAROS) ==========
  
  let currentShotsSlug = null;
  let currentShots = [];
  let shotsSearchTerm = '';
  let currentEditingShotId = null;

  async function openDownsellsModal(slug) {
    console.log('[DOWNSELLS][OPEN_MODAL]', { slug });
    currentDownsellsSlug = slug;
    setCurrentMediaBotSlug(slug); // Para o seletor de mídia
    
    const modal = document.getElementById('downsells-modal');
    const overlay = document.getElementById('modal-overlay');
    
    if (!modal || !overlay) {
      console.error('[DOWNSELLS][MODAL_NOT_FOUND]');
      return;
    }

    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
    
    await loadDownsells(slug);
  }

  async function loadDownsells(slug) {
    const loadingEl = document.getElementById('downsells-loading');
    const emptyEl = document.getElementById('downsells-empty');
    const errorEl = document.getElementById('downsells-error');
    const tableWrapper = document.getElementById('downsells-table-wrapper');
    
    // Mostrar loading
    loadingEl?.classList.remove('hidden');
    emptyEl?.classList.add('hidden');
    errorEl?.classList.add('hidden');
    tableWrapper?.classList.add('hidden');
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      errorEl?.classList.remove('hidden');
      loadingEl?.classList.add('hidden');
      return;
    }
    
    try {
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}/downsells`, {
        headers
      });
      
      if (!response.ok) throw new Error('Falha ao carregar downsells');
      
      const data = await response.json();
      currentDownsells = data.downsells || [];
      
      console.log('[DOWNSELLS][LOADED]', { count: currentDownsells.length });
      
      if (currentDownsells.length === 0) {
        emptyEl?.classList.remove('hidden');
        loadingEl?.classList.add('hidden');
      } else {
        renderDownsellsTable(currentDownsells);
        tableWrapper?.classList.remove('hidden');
        loadingEl?.classList.add('hidden');
      }
      
      updateDownsellsCount();
    } catch (err) {
      console.error('[DOWNSELLS][LOAD][ERR]', err);
      errorEl?.classList.remove('hidden');
      loadingEl?.classList.add('hidden');
      showToast('error', 'Erro ao carregar downsells');
    }
  }

  function renderDownsellsTable(downsells) {
    const tbody = document.getElementById('downsells-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    // Filtrar por busca
    let filtered = downsells;
    if (downsellsSearchTerm) {
      const term = downsellsSearchTerm.toLowerCase();
      filtered = downsells.filter(d => {
        const name = (d.name || '').toLowerCase();
        const content = JSON.stringify(d.content || {}).toLowerCase();
        return name.includes(term) || content.includes(term);
      });
    }
    
    if (filtered.length === 0 && downsellsSearchTerm) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-cell text-center text-zinc-500">Nenhum resultado encontrado</td></tr>';
      return;
    }
    
    filtered.forEach(downsell => {
      tbody.appendChild(renderDownsellRow(downsell));
    });
  }

  function renderDownsellRow(downsell) {
    const tr = document.createElement('tr');
    
    // Título
    const tdTitle = document.createElement('td');
    tdTitle.className = 'table-cell';
    tdTitle.textContent = downsell.name || 'Sem título';
    tr.appendChild(tdTitle);
    
    // Gatilhos
    const tdTriggers = document.createElement('td');
    tdTriggers.className = 'table-cell';
    const triggers = [];
    if (downsell.after_start) triggers.push('START');
    if (downsell.after_pix) triggers.push('PIX');
    tdTriggers.innerHTML = triggers.length > 0 
      ? triggers.map(t => `<span class="px-2 py-1 text-xs rounded bg-blue-900/30 text-blue-300">${t}</span>`).join(' ')
      : '<span class="text-zinc-500 text-xs">Nenhum</span>';
    tr.appendChild(tdTriggers);
    
    // Delay
    const tdDelay = document.createElement('td');
    tdDelay.className = 'table-cell';
    const delayMinutes = downsell.delay_minutes || Math.round((downsell.delay_seconds || 0) / 60);
    tdDelay.textContent = `${delayMinutes} min`;
    tr.appendChild(tdDelay);
    
    // Ativo
    const tdActive = document.createElement('td');
    tdActive.className = 'table-cell';
    const activeSpan = document.createElement('span');
    activeSpan.className = `px-2 py-1 text-xs rounded ${downsell.active ? 'bg-green-900/30 text-green-300' : 'bg-zinc-700 text-zinc-400'}`;
    activeSpan.textContent = downsell.active ? 'Ativo' : 'Inativo';
    tdActive.appendChild(activeSpan);
    tr.appendChild(tdActive);
    
    // Prévia
    const tdPreview = document.createElement('td');
    tdPreview.className = 'table-cell';
    try {
      const content = typeof downsell.content === 'string' ? JSON.parse(downsell.content) : downsell.content;
      const preview = (content.text || '').substring(0, 50);
      tdPreview.textContent = preview ? `${preview}...` : 'Sem texto';
      tdPreview.title = content.text || '';
    } catch {
      tdPreview.textContent = 'Erro no conteúdo';
    }
    tr.appendChild(tdPreview);
    
    // Ações
    const tdActions = document.createElement('td');
    tdActions.className = 'table-cell';
    
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex gap-2';
    
    // Botão toggle
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600';
    toggleBtn.textContent = downsell.active ? '⏸️' : '▶️';
    toggleBtn.title = downsell.active ? 'Desativar' : 'Ativar';
    toggleBtn.onclick = () => toggleDownsell(downsell.id);
    actionsDiv.appendChild(toggleBtn);
    
    // Botão editar
    const editBtn = document.createElement('button');
    editBtn.className = 'text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600';
    editBtn.textContent = '✏️';
    editBtn.title = 'Editar';
    editBtn.onclick = () => openDownsellFormModal(currentDownsellsSlug, downsell.id);
    actionsDiv.appendChild(editBtn);
    
    // Botão deletar
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'text-xs px-2 py-1 rounded bg-red-700 hover:bg-red-600';
    deleteBtn.textContent = '🗑️';
    deleteBtn.title = 'Deletar';
    deleteBtn.onclick = () => deleteDownsell(downsell.id);
    actionsDiv.appendChild(deleteBtn);
    
    tdActions.appendChild(actionsDiv);
    tr.appendChild(tdActions);
    
    return tr;
  }

  function updateDownsellsCount() {
    const countEl = document.getElementById('downsells-count');
    if (countEl) {
      const filtered = downsellsSearchTerm 
        ? currentDownsells.filter(d => {
            const term = downsellsSearchTerm.toLowerCase();
            const name = (d.name || '').toLowerCase();
            const content = JSON.stringify(d.content || {}).toLowerCase();
            return name.includes(term) || content.includes(term);
          })
        : currentDownsells;
      countEl.textContent = filtered.length;
    }
  }

  async function openDownsellFormModal(slug, downsellId = null) {
    console.log('[DOWNSELLS][OPEN_FORM]', { slug, downsellId });
    currentEditingDownsellId = downsellId;
    
    const modal = document.getElementById('downsell-form-modal');
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('downsell-form-modal-title');
    
    if (!modal || !overlay) {
      console.error('[DOWNSELLS][FORM_MODAL_NOT_FOUND]');
      return;
    }
    
    title.textContent = downsellId ? 'Editar Downsell' : 'Novo Downsell';
    
    // Limpar formulário
    document.getElementById('downsell-title').value = '';
    document.getElementById('downsell-copy').value = '';
    const mediaTypeEl = document.getElementById('downsell-media-type');
    if (mediaTypeEl) mediaTypeEl.value = 'none';
    const fileIdEl = document.getElementById('downsell-file-id');
    if (fileIdEl) fileIdEl.value = '';
    const captionEl = document.getElementById('downsell-caption');
    if (captionEl) captionEl.value = '';
    document.getElementById('downsell-delay').value = '20';
    document.getElementById('downsell-active').checked = true;
    document.getElementById('downsell-after-start').checked = true;
    document.getElementById('downsell-after-pix').checked = false;
    
    // Se editando, carregar dados
    if (downsellId) {
      const downsell = currentDownsells.find(d => d.id === downsellId);
      if (downsell) {
        document.getElementById('downsell-title').value = downsell.name || '';
        
        try {
          const content = typeof downsell.content === 'string' ? JSON.parse(downsell.content) : downsell.content;
          document.getElementById('downsell-copy').value = content.text || '';
          
          const fileIdEl = document.getElementById('downsell-file-id');
          const mediaIdEl = document.getElementById('downsell-media-id');
          const sha256El = document.getElementById('downsell-media-sha256');
          const r2KeyEl = document.getElementById('downsell-media-r2-key');
          const kindEl = document.getElementById('downsell-media-kind');
          const captionEl = document.getElementById('downsell-caption');
          const mediaTypeEl = document.getElementById('downsell-media-type');
          
          // Carregar mídia se houver (novo formato estruturado)
          if (content.media) {
            const media = content.media;
            if (fileIdEl) fileIdEl.value = media.file_id || '';
            if (mediaIdEl) mediaIdEl.value = media.media_id || '';
            if (sha256El) sha256El.value = media.sha256 || '';
            if (r2KeyEl) r2KeyEl.value = media.r2_key || '';
            if (kindEl) kindEl.value = media.kind || '';
            if (captionEl) captionEl.value = content.caption || '';
            if (mediaTypeEl) mediaTypeEl.value = media.kind || 'none';
            
            // Mostrar preview
            if (media.file_id && media.kind) {
              const selectedDiv = document.getElementById('downsell-selected-media');
              const thumb = document.getElementById('downsell-media-thumb');
              const nameEl = document.getElementById('downsell-media-name');
              const infoEl = document.getElementById('downsell-media-info');
              
              if (selectedDiv) selectedDiv.classList.remove('hidden');
              if (thumb && media.media_id) thumb.src = `${baseUrl}/api/media/preview/${media.media_id}`;
              if (nameEl) nameEl.textContent = media.r2_key ? media.r2_key.split('/').pop() : 'Mídia selecionada';
              if (infoEl) infoEl.textContent = `${media.kind}`;
              
              const mediaFields = document.getElementById('downsell-media-fields');
              if (mediaFields) mediaFields.classList.remove('hidden');
            }
          } 
          // Fallback para formato antigo
          else if (content.video_file_id || content.photo_file_id) {
            if (fileIdEl) fileIdEl.value = content.video_file_id || content.photo_file_id || '';
            if (captionEl) captionEl.value = content.caption || '';
            if (mediaTypeEl) {
              mediaTypeEl.value = content.video_file_id ? 'video' : 'photo';
            }
          } else {
            if (mediaTypeEl) mediaTypeEl.value = 'none';
          }
        } catch (err) {
          console.error('[DOWNSELLS][PARSE_CONTENT]', err);
        }
        
        const delayMinutes = downsell.delay_minutes || Math.round((downsell.delay_seconds || 0) / 60);
        document.getElementById('downsell-delay').value = delayMinutes;
        document.getElementById('downsell-active').checked = downsell.active !== false;
        document.getElementById('downsell-after-start').checked = downsell.after_start !== false;
        document.getElementById('downsell-after-pix').checked = downsell.after_pix === true;
      }
    }
    
    // Atualizar contadores
    updateDownsellFormCounters();
    
    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
    
    // Montar componente multi-mídia após modal estar visível
    requestAnimationFrame(() => {
      const container = document.getElementById('downsell-multi-media-container');
      if (container && typeof MultiMediaSelector !== 'undefined') {
        // TODO: Carregar downsell_media_refs dos dados do downsell
        const downsellMediaRefs = []; // Por enquanto vazio, implementar carregamento
        
        window.downsellMultiMediaSelector = new MultiMediaSelector(container, {
          maxItems: 3,
          allowedKinds: ['audio', 'video', 'photo'],
          showTypeFilter: true,
          value: downsellMediaRefs
        });
        
        console.log('[DOWNSELL][MULTI_MEDIA] Componente montado');
      }
    });
  }

  function updateDownsellFormCounters() {
    const titleInput = document.getElementById('downsell-title');
    const copyInput = document.getElementById('downsell-copy');
    const titleCount = document.getElementById('downsell-title-count');
    const copyCount = document.getElementById('downsell-copy-count');
    
    if (titleInput && titleCount) {
      titleCount.textContent = titleInput.value.length;
    }
    if (copyInput && copyCount) {
      copyCount.textContent = copyInput.value.length;
    }
  }

  async function saveDownsell() {
    if (!currentDownsellsSlug) {
      showToast('error', 'Slug não encontrado');
      return;
    }
    
    const title = document.getElementById('downsell-title').value.trim();
    const copy = document.getElementById('downsell-copy').value.trim();
    const mediaTypeEl = document.getElementById('downsell-media-type');
    const mediaType = mediaTypeEl ? mediaTypeEl.value : 'none';
    const fileIdEl = document.getElementById('downsell-file-id');
    const fileId = fileIdEl ? fileIdEl.value.trim() : '';
    const captionEl = document.getElementById('downsell-caption');
    const caption = captionEl ? captionEl.value.trim() : '';
    const delayMinutes = parseInt(document.getElementById('downsell-delay').value, 10);
    const active = document.getElementById('downsell-active').checked;
    const afterStart = document.getElementById('downsell-after-start').checked;
    const afterPix = document.getElementById('downsell-after-pix').checked;
    
    // Validações
    if (!title) {
      showToast('error', 'Título obrigatório');
      return;
    }
    
    if (!copy) {
      showToast('error', 'Texto obrigatório');
      return;
    }
    
    if (copy.length > 4096) {
      showToast('error', 'Texto muito longo (máx 4096)');
      return;
    }
    
    if (!afterStart && !afterPix) {
      showToast('error', 'Selecione ao menos um gatilho (START ou PIX)');
      return;
    }
    
    if (isNaN(delayMinutes) || delayMinutes < 1) {
      showToast('error', 'Delay inválido (mínimo 1 minuto)');
      return;
    }
    
    // Dados de mídia (se selecionada)
    const mediaId = document.getElementById('downsell-media-id')?.value || '';
    const sha256 = document.getElementById('downsell-media-sha256')?.value || '';
    const r2Key = document.getElementById('downsell-media-r2-key')?.value || '';
    const kind = document.getElementById('downsell-media-kind')?.value || '';
    
    // Montar content
    const content = {
      text: copy,
      parse_mode: 'MarkdownV2'
    };
    
    // Adicionar mídia se selecionada (novo formato estruturado)
    if (mediaType !== 'none' && fileId && sha256 && kind && r2Key) {
      content.media = {
        file_id: fileId,
        media_id: mediaId ? parseInt(mediaId) : undefined,
        sha256,
        kind,
        r2_key: r2Key
      };
      
      // Manter compatibilidade com formato antigo (se necessário)
      if (mediaType === 'video') {
        content.video_file_id = fileId;
      } else if (mediaType === 'photo') {
        content.photo_file_id = fileId;
      }
      if (caption) {
        content.caption = caption;
      }
    }
    
    const payload = {
      name: title,
      content: JSON.stringify(content),
      delay_minutes: delayMinutes,
      active,
      after_start: afterStart,
      after_pix: afterPix
    };
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }
    
    try {
      const isEditing = currentEditingDownsellId !== null;
      const url = isEditing
        ? `${baseUrl}/api/admin/bots/${encodeURIComponent(currentDownsellsSlug)}/downsells/${currentEditingDownsellId}`
        : `${baseUrl}/api/admin/bots/${encodeURIComponent(currentDownsellsSlug)}/downsells`;
      
      const response = await fetch(url, {
        method: isEditing ? 'PUT' : 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Falha ao salvar');
      }
      
      showToast('success', isEditing ? 'Downsell atualizado' : 'Downsell criado');
      
      closeModal('downsell-form-modal');
      await loadDownsells(currentDownsellsSlug);
    } catch (err) {
      console.error('[DOWNSELLS][SAVE][ERR]', err);
      showToast('error', `Erro: ${err.message}`);
    }
  }

  async function deleteDownsell(downsellId) {
    if (!currentDownsellsSlug) return;
    
    const downsell = currentDownsells.find(d => d.id === downsellId);
    const name = downsell?.name || 'este downsell';
    
    if (!confirm(`Tem certeza que deseja deletar "${name}"? Esta ação não pode ser desfeita.`)) {
      return;
    }
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }
    
    try {
      const response = await fetch(
        `${baseUrl}/api/admin/bots/${encodeURIComponent(currentDownsellsSlug)}/downsells/${downsellId}`,
        {
          method: 'DELETE',
          headers
        }
      );
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Falha ao deletar');
      }
      
      showToast('success', 'Downsell deletado');
      await loadDownsells(currentDownsellsSlug);
    } catch (err) {
      console.error('[DOWNSELLS][DELETE][ERR]', err);
      showToast('error', `Erro: ${err.message}`);
    }
  }

  async function toggleDownsell(downsellId) {
    if (!currentDownsellsSlug) return;
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }
    
    try {
      const response = await fetch(
        `${baseUrl}/api/admin/bots/${encodeURIComponent(currentDownsellsSlug)}/downsells/${downsellId}/toggle`,
        {
          method: 'PATCH',
          headers
        }
      );
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Falha ao alternar status');
      }
      
      const data = await response.json();
      const newStatus = data.downsell?.active ? 'ativado' : 'desativado';
      showToast('success', `Downsell ${newStatus}`);
      
      // Atualizar localmente
      const index = currentDownsells.findIndex(d => d.id === downsellId);
      if (index >= 0) {
        currentDownsells[index] = data.downsell;
        renderDownsellsTable(currentDownsells);
      }
    } catch (err) {
      console.error('[DOWNSELLS][TOGGLE][ERR]', err);
      showToast('error', `Erro: ${err.message}`);
    }
  }

  // ========== FUNÇÕES DE DISPAROS (SHOTS) ==========

  /**
   * Função auxiliar para escapar caracteres especiais do MarkdownV2
   */
  function escapeMarkdownV2(text) {
    if (!text) return '';
    const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    let escaped = String(text);
    specialChars.forEach(char => {
      escaped = escaped.split(char).join('\\' + char);
    });
    return escaped;
  }

  /**
   * Gera opções de horário de 15 em 15 minutos
   */
  function generateTimeOptions() {
    const options = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        const hour = String(h).padStart(2, '0');
        const minute = String(m).padStart(2, '0');
        options.push(`${hour}:${minute}`);
      }
    }
    return options;
  }

  /**
   * Popula o select de horário com opções de 15 em 15 minutos
   */
  function populateTimeSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    
    const options = generateTimeOptions();
    select.innerHTML = '';
    
    options.forEach(time => {
      const option = document.createElement('option');
      option.value = time;
      option.textContent = time;
      select.appendChild(option);
    });
  }

  /**
   * Abre o modal de gerenciamento de disparos
   */
  async function openShotsModal(slug) {
    console.log('[SHOTS][OPEN_MODAL]', { slug });
    currentShotsSlug = slug;
    setCurrentMediaBotSlug(slug); // Para o seletor de mídia
    
    const modal = document.getElementById('shots-modal');
    const overlay = document.getElementById('modal-overlay');
    
    if (!modal || !overlay) {
      console.error('[SHOTS][MODAL_NOT_FOUND]');
      return;
    }

    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
    
    await loadShots(slug);
  }

  /**
   * Carrega a lista de disparos do backend
   */
  async function loadShots(slug) {
    const loadingEl = document.getElementById('shots-loading');
    const emptyEl = document.getElementById('shots-empty');
    const errorEl = document.getElementById('shots-error');
    const tableWrapper = document.getElementById('shots-table-wrapper');
    
    // Mostrar loading
    loadingEl?.classList.remove('hidden');
    emptyEl?.classList.add('hidden');
    errorEl?.classList.add('hidden');
    tableWrapper?.classList.add('hidden');
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      errorEl?.classList.remove('hidden');
      loadingEl?.classList.add('hidden');
      return;
    }
    
    try {
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}/shots`, {
        headers
      });
      
      if (!response.ok) throw new Error('Falha ao carregar disparos');
      
      const data = await response.json();
      currentShots = data.shots || [];
      
      console.log('[SHOTS][LOADED]', { count: currentShots.length });
      
      if (currentShots.length === 0) {
        emptyEl?.classList.remove('hidden');
        loadingEl?.classList.add('hidden');
      } else {
        renderShotsTable(currentShots);
        tableWrapper?.classList.remove('hidden');
        loadingEl?.classList.add('hidden');
      }
      
      updateShotsCount();
    } catch (err) {
      console.error('[SHOTS][LOAD][ERR]', err);
      errorEl?.classList.remove('hidden');
      loadingEl?.classList.add('hidden');
      showToast('error', 'Erro ao carregar disparos');
    }
  }

  /**
   * Renderiza a tabela de disparos
   */
  function renderShotsTable(shots) {
    const tbody = document.getElementById('shots-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    // Filtrar por busca
    let filtered = shots;
    if (shotsSearchTerm) {
      const term = shotsSearchTerm.toLowerCase();
      filtered = shots.filter(s => {
        const title = (s.title || '').toLowerCase();
        const message = JSON.stringify(s.message || {}).toLowerCase();
        return title.includes(term) || message.includes(term);
      });
    }
    
    if (filtered.length === 0 && shotsSearchTerm) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-cell text-center text-zinc-500">Nenhum resultado encontrado</td></tr>';
      return;
    }
    
    filtered.forEach(shot => {
      tbody.appendChild(renderShotRow(shot));
    });
  }

  /**
   * Renderiza uma linha individual da tabela de disparos
   */
  function renderShotRow(shot) {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-surfaceMuted/50 transition-colors';
    
    // Título
    const tdTitle = document.createElement('td');
    tdTitle.className = 'table-cell';
    const titleDiv = document.createElement('div');
    titleDiv.className = 'flex flex-col gap-1';
    const titleText = document.createElement('span');
    titleText.className = 'font-medium text-zinc-200';
    titleText.textContent = shot.title || 'Sem título';
    titleDiv.appendChild(titleText);
    
    // Adicionar ícone se inativo
    if (shot.active === false) {
      const inactiveSpan = document.createElement('span');
      inactiveSpan.className = 'text-xs text-zinc-500';
      inactiveSpan.textContent = '⏸️ Inativo';
      titleDiv.appendChild(inactiveSpan);
    }
    tdTitle.appendChild(titleDiv);
    tr.appendChild(tdTitle);
    
    // Status
    const tdStatus = document.createElement('td');
    tdStatus.className = 'table-cell';
    const statusMap = {
      'draft': { label: 'Draft', color: 'bg-zinc-700 text-zinc-400', icon: '📝' },
      'scheduled': { label: 'Agendado', color: 'bg-blue-900/30 text-blue-300 border border-blue-700/30', icon: '📅' },
      'sending': { label: 'Enviando', color: 'bg-yellow-900/30 text-yellow-300 border border-yellow-700/30', icon: '⚡' },
      'sent': { label: 'Concluído', color: 'bg-green-900/30 text-green-300 border border-green-700/30', icon: '✅' },
      'cancelled': { label: 'Cancelado', color: 'bg-red-900/30 text-red-300 border border-red-700/30', icon: '❌' }
    };
    const statusInfo = statusMap[shot.status] || statusMap['draft'];
    const statusSpan = document.createElement('span');
    statusSpan.className = `inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg ${statusInfo.color}`;
    statusSpan.innerHTML = `${statusInfo.icon} ${statusInfo.label}`;
    tdStatus.appendChild(statusSpan);
    tr.appendChild(tdStatus);
    
    // Horário/Agendamento
    const tdSchedule = document.createElement('td');
    tdSchedule.className = 'table-cell text-sm text-zinc-300';
    if (shot.scheduled_at) {
      try {
        const scheduleDate = new Date(shot.scheduled_at);
        if (!isNaN(scheduleDate.getTime())) {
          const formattedDate = scheduleDate.toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
          tdSchedule.innerHTML = `📅 ${formattedDate}`;
        } else {
          tdSchedule.textContent = 'Data inválida';
        }
      } catch {
        tdSchedule.textContent = 'Data inválida';
      }
    } else {
      tdSchedule.innerHTML = '⚡ Imediato';
    }
    tr.appendChild(tdSchedule);
    
    // Audiência (filtros)
    const tdAudience = document.createElement('td');
    tdAudience.className = 'table-cell text-xs text-zinc-400';
    try {
      const filters = shot.filters ? (typeof shot.filters === 'string' ? JSON.parse(shot.filters) : shot.filters) : {};
      const filterLabels = [];
      if (filters.all_started) filterLabels.push('Todos');
      if (filters.has_unpaid_pix) filterLabels.push('PIX aberto');
      if (filters.exclude_paid) filterLabels.push('Exclui pagos');
      tdAudience.textContent = filterLabels.length > 0 ? filterLabels.join(' • ') : 'Todos';
    } catch {
      tdAudience.textContent = 'Todos';
    }
    tr.appendChild(tdAudience);
    
    // Progresso
    const tdProgress = document.createElement('td');
    tdProgress.className = 'table-cell text-xs';
    const sent = shot.sent_count || 0;
    const total = shot.total_targets || 0;
    if (total > 0) {
      const percent = Math.round((sent / total) * 100);
      tdProgress.innerHTML = `<div class="flex flex-col gap-1"><span class="text-zinc-300">${sent}/${total}</span><span class="text-zinc-500">${percent}%</span></div>`;
    } else {
      tdProgress.innerHTML = '<span class="text-zinc-500">—</span>';
    }
    tr.appendChild(tdProgress);
    
    // Ações
    const tdActions = document.createElement('td');
    tdActions.className = 'table-cell';
    
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex gap-2';
    
    // Botão preview
    const previewBtn = document.createElement('button');
    previewBtn.className = 'text-xs px-2 py-1 rounded-lg bg-zinc-700 hover:bg-zinc-600 transition-colors';
    previewBtn.textContent = '👁️';
    previewBtn.title = 'Preview';
    previewBtn.onclick = () => {
      try {
        const message = typeof shot.message === 'string' ? JSON.parse(shot.message) : shot.message;
        showShotPreview(message.text || '');
      } catch (err) {
        showToast('error', 'Erro ao carregar preview');
      }
    };
    actionsDiv.appendChild(previewBtn);
    
    // Botão editar (apenas draft ou scheduled)
    if (shot.status === 'draft' || shot.status === 'scheduled') {
      const editBtn = document.createElement('button');
      editBtn.className = 'text-xs px-2 py-1 rounded-lg bg-blue-700 hover:bg-blue-600 transition-colors';
      editBtn.textContent = '✏️';
      editBtn.title = 'Editar';
      editBtn.onclick = () => openShotFormModal(currentShotsSlug, shot.id);
      actionsDiv.appendChild(editBtn);
    }
    
    // Botão deletar (apenas draft ou scheduled)
    if (shot.status === 'draft' || shot.status === 'scheduled') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'text-xs px-2 py-1 rounded-lg bg-red-700 hover:bg-red-600 transition-colors';
      deleteBtn.textContent = '🗑️';
      deleteBtn.title = 'Excluir';
      deleteBtn.onclick = () => deleteShot(shot.id);
      actionsDiv.appendChild(deleteBtn);
    }
    
    tdActions.appendChild(actionsDiv);
    tr.appendChild(tdActions);
    
    return tr;
  }

  /**
   * Atualiza o contador de disparos exibidos
   */
  function updateShotsCount() {
    const countEl = document.getElementById('shots-count');
    if (countEl) {
      const filtered = shotsSearchTerm 
        ? currentShots.filter(s => {
            const term = shotsSearchTerm.toLowerCase();
            const title = (s.title || '').toLowerCase();
            const message = JSON.stringify(s.message || {}).toLowerCase();
            return title.includes(term) || message.includes(term);
          })
        : currentShots;
      countEl.textContent = filtered.length;
    }
  }

  /**
   * Abre o modal de formulário de disparo (criar/editar)
   */
  async function openShotFormModal(slug, shotId = null) {
    console.log('[SHOTS][OPEN_FORM]', { slug, shotId });
    currentEditingShotId = shotId;
    
    const modal = document.getElementById('shot-form-modal');
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('shot-form-modal-title');
    
    if (!modal || !overlay) {
      console.error('[SHOTS][FORM_MODAL_NOT_FOUND]');
      return;
    }
    
    title.textContent = shotId ? 'Editar Disparo' : 'Novo Disparo';
    
    // Popula select de horário de agendamento
    populateTimeSelect('shot-schedule-time');
    
    // Limpar formulário
    const titleInput = document.getElementById('shot-title');
    const messageInput = document.getElementById('shot-message-text');
    const mediaTypeEl = document.getElementById('shot-media-type');
    const fileIdInput = document.getElementById('shot-file-id');
    const activeCheckbox = document.getElementById('shot-active');
    
    if (titleInput) titleInput.value = '';
    if (messageInput) messageInput.value = '';
    if (mediaTypeEl) mediaTypeEl.value = 'none';
    if (fileIdInput) fileIdInput.value = '';
    if (activeCheckbox) activeCheckbox.checked = true;
    
    // Ocultar campos de mídia
    const mediaFields = document.getElementById('shot-media-fields');
    if (mediaFields) mediaFields.classList.add('hidden');
    
    // Resetar trigger para "enviar agora"
    const triggerNow = document.getElementById('shot-trigger-now');
    if (triggerNow) triggerNow.checked = true;
    
    // Ocultar campos de agendamento
    const scheduleFields = document.getElementById('shot-schedule-fields');
    if (scheduleFields) scheduleFields.classList.add('hidden');
    
    // Limpar resumo e warnings de agendamento
    const summaryEl = document.getElementById('shot-schedule-summary');
    const warningEl = document.getElementById('shot-schedule-warning');
    if (summaryEl) summaryEl.textContent = '';
    if (warningEl) warningEl.classList.add('hidden');
    
    // Resetar filtros de audiência
    const filterAllStarted = document.getElementById('shot-filter-all-started');
    const filterHasUnpaidPix = document.getElementById('shot-filter-has-unpaid-pix');
    const filterExcludePaid = document.getElementById('shot-filter-exclude-paid');
    
    if (filterAllStarted) filterAllStarted.checked = true;
    if (filterHasUnpaidPix) filterHasUnpaidPix.checked = false;
    if (filterExcludePaid) filterExcludePaid.checked = true;
    
    // Limpar resultado de teste
    const testResult = document.getElementById('shot-test-result');
    if (testResult) {
      testResult.classList.add('hidden');
      testResult.textContent = '';
    }
    
    // Se editando, carregar dados
    if (shotId) {
      const shot = currentShots.find(s => s.id === shotId);
      if (shot) {
        if (titleInput) titleInput.value = shot.title || '';
        
        try {
          const message = typeof shot.message === 'string' ? JSON.parse(shot.message) : shot.message;
          if (messageInput) messageInput.value = message.text || '';
          
          // Carregar mídia
          if (message.video_file_id || message.photo_file_id) {
            if (mediaTypeEl) {
              mediaTypeEl.value = message.video_file_id ? 'video' : 'photo';
            }
            if (fileIdInput) {
              fileIdInput.value = message.video_file_id || message.photo_file_id || '';
            }
            // Mostrar campos de mídia
            if (mediaFields) mediaFields.classList.remove('hidden');
          } else {
            if (mediaTypeEl) mediaTypeEl.value = 'none';
          }
        } catch (err) {
          console.error('[SHOTS][PARSE_MESSAGE]', err);
        }
        
        // Carregar campo ativo
        if (activeCheckbox) {
          activeCheckbox.checked = shot.active !== false;
        }
        
        // Carregar filtros
        try {
          const filters = typeof shot.filters === 'string' ? JSON.parse(shot.filters) : shot.filters || {};
          if (filterAllStarted) filterAllStarted.checked = filters.all_started === true;
          if (filterHasUnpaidPix) filterHasUnpaidPix.checked = filters.has_unpaid_pix === true;
          if (filterExcludePaid) filterExcludePaid.checked = filters.exclude_paid === true;
        } catch (err) {
          console.error('[SHOTS][PARSE_FILTERS]', err);
        }
        
        // Se tem scheduled_at e trigger === 'schedule', é agendado
        if (shot.trigger === 'schedule' && shot.scheduled_at) {
          const triggerSchedule = document.getElementById('shot-trigger-schedule');
          if (triggerSchedule) triggerSchedule.checked = true;
          if (scheduleFields) scheduleFields.classList.remove('hidden');
          
          // Parse scheduled_at (formato ISO)
          const scheduleDate = new Date(shot.scheduled_at);
          const dateInput = document.getElementById('shot-schedule-date');
          const timeSelect = document.getElementById('shot-schedule-time');
          
          if (dateInput && !isNaN(scheduleDate.getTime())) {
            const year = scheduleDate.getFullYear();
            const month = String(scheduleDate.getMonth() + 1).padStart(2, '0');
            const day = String(scheduleDate.getDate()).padStart(2, '0');
            dateInput.value = `${year}-${month}-${day}`;
          }
          
          if (timeSelect && !isNaN(scheduleDate.getTime())) {
            const hour = String(scheduleDate.getHours()).padStart(2, '0');
            const minute = String(scheduleDate.getMinutes()).padStart(2, '0');
            timeSelect.value = `${hour}:${minute}`;
          }
        }
      }
    }
    
    // Atualizar contadores
    updateShotFormCounters();
    
    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
    
    // Montar componente multi-mídia após modal estar visível
    requestAnimationFrame(() => {
      const container = document.getElementById('shot-multi-media-container');
      if (container && typeof MultiMediaSelector !== 'undefined') {
        // TODO: Carregar shot_media_refs dos dados do shot
        const shotMediaRefs = []; // Por enquanto vazio, implementar carregamento
        
        window.shotMultiMediaSelector = new MultiMediaSelector(container, {
          maxItems: 3,
          allowedKinds: ['audio', 'video', 'photo'],
          showTypeFilter: true,
          value: shotMediaRefs
        });
        
        console.log('[SHOT][MULTI_MEDIA] Componente montado');
      }
    });
  }

  /**
   * Atualiza contadores de caracteres no formulário de disparo
   */
  function updateShotFormCounters() {
    const titleInput = document.getElementById('shot-title');
    const messageInput = document.getElementById('shot-message-text');
    const titleCount = document.getElementById('shot-title-count');
    const messageCount = document.getElementById('shot-message-count');
    
    if (titleInput && titleCount) {
      titleCount.textContent = titleInput.value.length;
    }
    if (messageInput && messageCount) {
      messageCount.textContent = messageInput.value.length;
    }
  }

  /**
   * Valida e salva o disparo
   */
  async function saveShot() {
    if (!currentShotsSlug) {
      showToast('error', 'Slug não encontrado');
      return;
    }
    
    const titleInput = document.getElementById('shot-title');
    const messageInput = document.getElementById('shot-message-text');
    const mediaTypeEl = document.getElementById('shot-media-type');
    const fileIdInput = document.getElementById('shot-file-id');
    const activeCheckbox = document.getElementById('shot-active');
    const triggerNow = document.getElementById('shot-trigger-now');
    const triggerSchedule = document.getElementById('shot-trigger-schedule');
    const scheduleDateInput = document.getElementById('shot-schedule-date');
    const scheduleTimeSelect = document.getElementById('shot-schedule-time');
    const filterAllStarted = document.getElementById('shot-filter-all-started');
    const filterHasUnpaidPix = document.getElementById('shot-filter-has-unpaid-pix');
    const filterExcludePaid = document.getElementById('shot-filter-exclude-paid');
    
    if (!titleInput || !messageInput) {
      showToast('error', 'Campos obrigatórios não encontrados');
      return;
    }
    
    const title = titleInput.value.trim();
    const message = messageInput.value.trim();
    const mediaType = mediaTypeEl ? mediaTypeEl.value : 'none';
    const fileId = fileIdInput ? fileIdInput.value.trim() : '';
    const active = activeCheckbox ? activeCheckbox.checked : true;
    
    // Validações básicas
    if (!title) {
      showToast('error', 'Título obrigatório');
      return;
    }
    
    if (!message) {
      showToast('error', 'Mensagem obrigatória');
      return;
    }
    
    if (message.length > 4096) {
      showToast('error', 'Mensagem muito longa (máx 4096)');
      return;
    }
    
    // Validar mídia se selecionada
    if (mediaType !== 'none' && !fileId) {
      showToast('error', 'Informe o File ID da mídia ou selecione "Nenhuma"');
      return;
    }
    
    // Dados de mídia (se selecionada)
    const mediaId = document.getElementById('shot-media-id')?.value || '';
    const sha256 = document.getElementById('shot-media-sha256')?.value || '';
    const r2Key = document.getElementById('shot-media-r2-key')?.value || '';
    const kind = document.getElementById('shot-media-kind')?.value || '';
    
    // Montar objeto de mensagem
    const messageObj = {
      text: message,
      parse_mode: 'MarkdownV2'
    };
    
    // Adicionar mídia se selecionada (novo formato estruturado)
    if (mediaType !== 'none' && fileId && sha256 && kind && r2Key) {
      messageObj.media = {
        file_id: fileId,
        media_id: mediaId ? parseInt(mediaId) : undefined,
        sha256,
        kind,
        r2_key: r2Key
      };
      
      // Manter compatibilidade com formato antigo (se necessário)
      if (mediaType === 'video') {
        messageObj.video_file_id = fileId;
      } else if (mediaType === 'photo') {
        messageObj.photo_file_id = fileId;
      }
    }
    
    // Montar payload base (padronizado com downsells - envia content como string JSON)
    const payload = {
      title: title,
      content: JSON.stringify(messageObj),  // ✅ Convertendo para JSON aqui (como downsells)
      trigger: 'now', // Default
      active: active
    };
    
    // Debug: log do payload antes de enviar
    console.log('[SHOTS][SAVE][PAYLOAD]', {
      title,
      message,
      messageObj,
      content: payload.content,
      active,
      payload
    });
    
    // Determinar trigger e scheduled_at
    if (triggerSchedule && triggerSchedule.checked) {
      // Agendado
      if (!scheduleDateInput || !scheduleTimeSelect) {
        showToast('error', 'Campos de agendamento não encontrados');
        return;
      }
      
      const scheduleDate = scheduleDateInput.value;
      const scheduleTime = scheduleTimeSelect.value;
      
      if (!scheduleDate || !scheduleTime) {
        showToast('error', 'Data e hora de agendamento obrigatórias');
        return;
      }
      
      // Montar timestamp ISO
      const scheduleDateTime = new Date(`${scheduleDate}T${scheduleTime}:00`);
      
      if (isNaN(scheduleDateTime.getTime())) {
        showToast('error', 'Data/hora inválida');
        return;
      }
      
      // Verificar se é no futuro
      if (scheduleDateTime <= new Date()) {
        showToast('error', 'Data/hora deve ser no futuro');
        return;
      }
      
      payload.trigger = 'schedule';
      payload.scheduled_at = scheduleDateTime.toISOString();
    }
    
    // Adicionar filtros de audiência
    const filters = {};
    if (filterAllStarted && filterAllStarted.checked) filters.all_started = true;
    if (filterHasUnpaidPix && filterHasUnpaidPix.checked) filters.has_unpaid_pix = true;
    if (filterExcludePaid && filterExcludePaid.checked) filters.exclude_paid = true;
    
    payload.filters = filters;
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }
    
    try {
      const isEditing = currentEditingShotId !== null;
      const url = isEditing
        ? `${baseUrl}/api/admin/bots/${encodeURIComponent(currentShotsSlug)}/shots/${currentEditingShotId}`
        : `${baseUrl}/api/admin/bots/${encodeURIComponent(currentShotsSlug)}/shots`;
      
      const response = await fetch(url, {
        method: isEditing ? 'PUT' : 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Falha ao salvar');
      }
      
      const result = await response.json();
      
      // Verificar se foi iniciado automaticamente
      if (result.auto_started) {
        showToast('success', `Disparo criado e iniciado! Enviando para ${result.shot.total_targets || 0} pessoas...`);
      } else if (result.auto_start_error) {
        showToast('warning', `Disparo criado, mas erro ao iniciar: ${result.auto_start_error}`);
      } else {
        showToast('success', isEditing ? 'Disparo atualizado' : 'Disparo criado');
      }
      
      closeModal('shot-form-modal');
      await loadShots(currentShotsSlug);
    } catch (err) {
      console.error('[SHOTS][SAVE][ERR]', err);
      showToast('error', `Erro: ${err.message}`);
    }
  }

  /**
   * Atualiza o resumo de agendamento
   */
  function updateShotScheduleSummary() {
    const dateInput = document.getElementById('shot-schedule-date');
    const timeSelect = document.getElementById('shot-schedule-time');
    const summaryEl = document.getElementById('shot-schedule-summary');
    const warningEl = document.getElementById('shot-schedule-warning');
    
    if (!dateInput || !timeSelect || !summaryEl) return;
    
    const date = dateInput.value;
    const time = timeSelect.value;
    
    if (!date || !time) {
      summaryEl.textContent = '';
      if (warningEl) warningEl.classList.add('hidden');
      return;
    }
    
    try {
      const scheduleDateTime = new Date(`${date}T${time}:00`);
      const now = new Date();
      
      if (isNaN(scheduleDateTime.getTime())) {
        summaryEl.textContent = '';
        if (warningEl) {
          warningEl.textContent = '⚠️ Data/hora inválida';
          warningEl.classList.remove('hidden');
        }
        return;
      }
      
      if (scheduleDateTime <= now) {
        summaryEl.textContent = '';
        if (warningEl) {
          warningEl.textContent = '⚠️ A data/hora deve ser no futuro';
          warningEl.classList.remove('hidden');
        }
        return;
      }
      
      // Formatar data/hora em PT-BR
      const formatted = scheduleDateTime.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      summaryEl.textContent = `Será enviado em: ${formatted}`;
      if (warningEl) warningEl.classList.add('hidden');
    } catch (err) {
      console.error('[SHOTS][SCHEDULE_SUMMARY]', err);
      summaryEl.textContent = '';
    }
  }
  
  /**
   * Mostra preview da mensagem
   */
  function showShotPreview(text) {
    const modal = document.getElementById('shot-preview-modal');
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('shot-preview-content');
    
    if (!modal || !overlay || !content) {
      console.error('[SHOTS][PREVIEW] Modal não encontrado');
      return;
    }
    
    // Escapar MarkdownV2 se necessário
    const escaped = escapeMarkdownV2(text);
    content.textContent = escaped;
    
    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
  }
  
  /**
   * Envia mensagem de teste
   */
  async function sendShotTest() {
    const chatIdInput = document.getElementById('shot-test-chat-id');
    const messageInput = document.getElementById('shot-message-text');
    const resultDiv = document.getElementById('shot-test-result');
    const sendBtn = document.getElementById('shot-test-send-btn');
    
    if (!chatIdInput || !messageInput || !resultDiv) {
      showToast('error', 'Elementos do formulário não encontrados');
      return;
    }
    
    const chatId = chatIdInput.value.trim();
    const message = messageInput.value.trim();
    
    if (!chatId) {
      showToast('warning', 'Informe o Chat ID');
      chatIdInput.focus();
      return;
    }
    
    if (!message) {
      showToast('warning', 'Digite uma mensagem');
      messageInput.focus();
      return;
    }
    
    if (!currentShotsSlug) {
      showToast('error', 'Slug não encontrado');
      return;
    }
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado');
      return;
    }
    
    // Desabilitar botão e mostrar loading
    if (sendBtn) sendBtn.disabled = true;
    resultDiv.textContent = 'Enviando...';
    resultDiv.className = 'mt-2 text-xs text-blue-400';
    resultDiv.classList.remove('hidden');
    
    try {
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(currentShotsSlug)}/test-message`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'MarkdownV2'
        })
      });
      
      const data = await response.json();
      
      if (response.ok && data.ok) {
        resultDiv.textContent = '✅ Teste enviado com sucesso!';
        resultDiv.className = 'mt-2 text-xs text-green-400';
        showToast('success', 'Teste enviado com sucesso');
      } else {
        const errorMsg = data.error || 'Erro desconhecido';
        resultDiv.textContent = `❌ Erro: ${errorMsg}`;
        resultDiv.className = 'mt-2 text-xs text-red-400';
        showToast('error', `Erro ao enviar: ${errorMsg}`);
      }
    } catch (err) {
      console.error('[SHOTS][TEST_SEND]', err);
      resultDiv.textContent = `❌ Erro: ${err.message}`;
      resultDiv.className = 'mt-2 text-xs text-red-400';
      showToast('error', 'Erro ao enviar teste');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  /**
   * Deleta um disparo
   */
  async function deleteShot(shotId) {
    if (!currentShotsSlug) return;
    
    const shot = currentShots.find(s => s.id === shotId);
    const name = shot?.name || 'este disparo';
    
    if (!confirm(`Tem certeza que deseja deletar "${name}"? Esta ação não pode ser desfeita.`)) {
      return;
    }
    
    const headers = getAuthHeaders();
    if (!headers) {
      showToast('error', 'Token admin não configurado.');
      return;
    }
    
    try {
      const response = await fetch(
        `${baseUrl}/api/admin/bots/${encodeURIComponent(currentShotsSlug)}/shots/${shotId}`,
        {
          method: 'DELETE',
          headers
        }
      );
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Falha ao deletar');
      }
      
      showToast('success', 'Disparo deletado');
      await loadShots(currentShotsSlug);
    } catch (err) {
      console.error('[SHOTS][DELETE][ERR]', err);
      showToast('error', `Erro: ${err.message}`);
    }
  }

  async function init() {
    console.log('[ADMIN][INIT] Iniciando Admin SPA...');
    registerEventListeners();
    initToken();
    
    // Event listeners para modal de mensagem inicial (elementos fixos no HTML)
    const activeToggle = document.getElementById('start-message-active');
    if (activeToggle) {
      activeToggle.addEventListener('change', toggleStartMessageFields);
    }
    
    const textArea = document.getElementById('start-message-text');
    if (textArea) {
      textArea.addEventListener('input', () => {
        updateCharCount();
        validateStartMessageForm();
      });
    }
    
    const rawCheckbox = document.getElementById('start-message-raw');
    if (rawCheckbox) {
      rawCheckbox.addEventListener('change', toggleRawWarning);
    }
    
    const saveBtn = document.getElementById('start-message-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => saveStartMessage(false));
    }
    
    const saveCloseBtn = document.getElementById('start-message-save-close-btn');
    if (saveCloseBtn) {
      saveCloseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        saveStartMessage(true);
      });
    }
    
    const testBtn = document.getElementById('start-message-test-btn');
    if (testBtn) {
      testBtn.addEventListener('click', testStartMessage);
    }
    
    // Listener para evento customizado do MultiMediaSelector
    document.addEventListener('openMediaSelector', (e) => {
      console.log('[MULTI_MEDIA][EVENT] openMediaSelector', e.detail);
      openMediaSelectorMulti(e.detail);
    });
    
    // Event listeners para modal de downsells (elementos fixos no HTML)
    const newDownsellBtn = document.getElementById('new-downsell-btn');
    if (newDownsellBtn) {
      newDownsellBtn.addEventListener('click', () => {
        if (currentDownsellsSlug) {
          openDownsellFormModal(currentDownsellsSlug);
        }
      });
    }
    
    const downsellsSearch = document.getElementById('downsells-search');
    if (downsellsSearch) {
      let searchTimeout;
      downsellsSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          downsellsSearchTerm = e.target.value.trim();
          renderDownsellsTable(currentDownsells);
          updateDownsellsCount();
        }, 300);
      });
    }
    
    const downsellForm = document.getElementById('downsell-form');
    if (downsellForm) {
      downsellForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveDownsell();
      });
    }
    
    // Event listeners para contadores do formulário de downsell
    const downsellTitle = document.getElementById('downsell-title');
    if (downsellTitle) {
      downsellTitle.addEventListener('input', updateDownsellFormCounters);
    }
    
    const downsellCopy = document.getElementById('downsell-copy');
    if (downsellCopy) {
      downsellCopy.addEventListener('input', updateDownsellFormCounters);
    }
    
    // Mostrar/ocultar campos de mídia baseado no tipo selecionado
    const downsellMediaType = document.getElementById('downsell-media-type');
    if (downsellMediaType) {
      downsellMediaType.addEventListener('change', (e) => {
        const mediaFields = document.getElementById('downsell-media-fields');
        if (mediaFields) {
          if (e.target.value === 'none') {
            mediaFields.classList.add('hidden');
          } else {
            mediaFields.classList.remove('hidden');
          }
        }
      });
    }
    
    // Event listeners para modal de disparos (shots) - elementos fixos no HTML
    const newShotBtn = document.getElementById('new-shot-btn');
    if (newShotBtn) {
      newShotBtn.addEventListener('click', () => {
        if (currentShotsSlug) {
          openShotFormModal(currentShotsSlug);
        }
      });
    }
    
    const shotsSearch = document.getElementById('shot-search');
    if (shotsSearch) {
      let searchTimeout;
      shotsSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          shotsSearchTerm = e.target.value.trim();
          renderShotsTable(currentShots);
          updateShotsCount();
        }, 300);
      });
    }
    
    const shotForm = document.getElementById('shot-form');
    if (shotForm) {
      shotForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveShot();
      });
    }
    
    // Event listeners para contadores do formulário de shot
    const shotTitle = document.getElementById('shot-title');
    if (shotTitle) {
      shotTitle.addEventListener('input', updateShotFormCounters);
    }
    
    const shotMessageText = document.getElementById('shot-message-text');
    if (shotMessageText) {
      shotMessageText.addEventListener('input', updateShotFormCounters);
    }
    
    // Mostrar/ocultar campos de agendamento baseado no trigger selecionado
    const triggerNow = document.getElementById('shot-trigger-now');
    const triggerSchedule = document.getElementById('shot-trigger-schedule');
    const scheduleFields = document.getElementById('shot-schedule-fields');
    
    if (triggerNow && scheduleFields) {
      triggerNow.addEventListener('change', () => {
        if (triggerNow.checked) {
          scheduleFields.classList.add('hidden');
        }
      });
    }
    
    if (triggerSchedule && scheduleFields) {
      triggerSchedule.addEventListener('change', () => {
        if (triggerSchedule.checked) {
          scheduleFields.classList.remove('hidden');
          updateShotScheduleSummary();
        }
      });
    }
    
    // Atualizar resumo de agendamento quando data/hora mudar
    const shotScheduleDate = document.getElementById('shot-schedule-date');
    const shotScheduleTime = document.getElementById('shot-schedule-time');
    if (shotScheduleDate) {
      shotScheduleDate.addEventListener('change', updateShotScheduleSummary);
    }
    if (shotScheduleTime) {
      shotScheduleTime.addEventListener('change', updateShotScheduleSummary);
    }
    
    // Mostrar/ocultar campos de mídia baseado no tipo selecionado (shots)
    const shotMediaType = document.getElementById('shot-media-type');
    if (shotMediaType) {
      shotMediaType.addEventListener('change', (e) => {
        const mediaFields = document.getElementById('shot-media-fields');
        if (mediaFields) {
          if (e.target.value === 'none') {
            mediaFields.classList.add('hidden');
          } else {
            mediaFields.classList.remove('hidden');
          }
        }
      });
    }
    
    // Botão de preview
    const shotPreviewBtn = document.getElementById('shot-preview-btn');
    if (shotPreviewBtn) {
      shotPreviewBtn.addEventListener('click', () => {
        const messageInput = document.getElementById('shot-message-text');
        if (messageInput) {
          const text = messageInput.value.trim();
          if (!text) {
            showToast('warning', 'Digite uma mensagem para visualizar');
            return;
          }
          showShotPreview(text);
        }
      });
    }
    
    // Botão de limpar
    const shotClearBtn = document.getElementById('shot-clear-btn');
    if (shotClearBtn) {
      shotClearBtn.addEventListener('click', () => {
        const messageInput = document.getElementById('shot-message-text');
        if (messageInput && confirm('Limpar toda a mensagem?')) {
          messageInput.value = '';
          updateShotFormCounters();
        }
      });
    }
    
    // Botão de teste de envio
    const shotTestSendBtn = document.getElementById('shot-test-send-btn');
    if (shotTestSendBtn) {
      shotTestSendBtn.addEventListener('click', async () => {
        await sendShotTest();
      });
    }
    
    // Validação: se "PIX aberto" estiver marcado, "Excluir quem já pagou" deve estar marcado
    const shotFilterHasUnpaidPix = document.getElementById('shot-filter-has-unpaid-pix');
    const shotFilterExcludePaid = document.getElementById('shot-filter-exclude-paid');
    if (shotFilterHasUnpaidPix && shotFilterExcludePaid) {
      shotFilterHasUnpaidPix.addEventListener('change', () => {
        if (shotFilterHasUnpaidPix.checked) {
          shotFilterExcludePaid.checked = true;
        }
      });
    }
    
    try {
      await adminRouter();
      console.log('[ADMIN][INIT] Admin SPA inicializado com sucesso.');
    } catch (err) {
      console.error('[ADMIN][ERR] init:', err);
    }
  }

  // ========================================
  // SELETOR DE MÍDIA
  // ========================================
  
  let currentMediaContext = null; // Para saber qual modal está selecionando
  let currentMediaBotSlug = null; // Slug do bot atual
  let mediaCache = [];
  
  function initMediaSelector() {
    // Botões de abrir o seletor
    const startMediaBtn = document.querySelector('#start-message-select-media-btn');
    const downsellMediaBtn = document.querySelector('#downsell-select-media-btn');
    const shotMediaBtn = document.querySelector('#shot-select-media-btn');
    
    // Botões de remover mídia selecionada
    const startRemoveBtn = document.querySelector('#start-message-remove-media');
    const downsellRemoveBtn = document.querySelector('#downsell-remove-media');
    const shotRemoveBtn = document.querySelector('#shot-remove-media');
    
    // Quando o tipo de mídia muda, mostra/esconde o seletor
    const startMediaType = document.querySelector('#start-message-media-type');
    const downsellMediaType = document.querySelector('#downsell-media-type');
    const shotMediaType = document.querySelector('#shot-media-type');
    
    if (startMediaType) {
      startMediaType.addEventListener('change', (e) => {
        const selector = document.querySelector('#start-message-media-selector');
        if (e.target.value !== 'none') {
          selector?.classList.remove('hidden');
        } else {
          selector?.classList.add('hidden');
        }
      });
    }
    
    if (downsellMediaType) {
      downsellMediaType.addEventListener('change', (e) => {
        const fields = document.querySelector('#downsell-media-fields');
        if (e.target.value !== 'none') {
          fields?.classList.remove('hidden');
        } else {
          fields?.classList.add('hidden');
        }
      });
    }
    
    if (shotMediaType) {
      shotMediaType.addEventListener('change', (e) => {
        const fields = document.querySelector('#shot-media-fields');
        if (e.target.value !== 'none') {
          fields?.classList.remove('hidden');
        } else {
          fields?.classList.add('hidden');
        }
      });
    }
    
    // Abrir modal de seleção
    if (startMediaBtn) {
      startMediaBtn.addEventListener('click', () => openMediaSelector('start'));
    }
    if (downsellMediaBtn) {
      downsellMediaBtn.addEventListener('click', () => openMediaSelector('downsell'));
    }
    if (shotMediaBtn) {
      shotMediaBtn.addEventListener('click', () => openMediaSelector('shot'));
    }
    
    // Remover mídia selecionada
    if (startRemoveBtn) {
      startRemoveBtn.addEventListener('click', () => clearMediaSelection('start'));
    }
    if (downsellRemoveBtn) {
      downsellRemoveBtn.addEventListener('click', () => clearMediaSelection('downsell'));
    }
    if (shotRemoveBtn) {
      shotRemoveBtn.addEventListener('click', () => clearMediaSelection('shot'));
    }
    
    // Busca e filtro
    const searchInput = document.querySelector('#media-search');
    const typeFilter = document.querySelector('#media-type-filter');
    
    if (searchInput) {
      searchInput.addEventListener('input', filterMediaGrid);
    }
    if (typeFilter) {
      typeFilter.addEventListener('change', filterMediaGrid);
    }
  }
  
  async function openMediaSelectorMulti(options) {
    console.log('[MULTI_MEDIA][OPEN] Abrindo seletor multi-mídia', options);
    
    const modal = document.querySelector('#media-selector-modal');
    const grid = document.querySelector('#media-grid');
    const loading = document.querySelector('#media-loading');
    const emptyState = document.querySelector('#media-empty-state');
    
    if (!modal || !grid) {
      console.error('[MULTI_MEDIA][OPEN] Modal ou grid não encontrado');
      return;
    }
    
    // Armazenar callback e opções
    window.__multiMediaCallback = options.onMediaSelected;
    window.__multiMediaOptions = options;
    
    // Mostrar modal
    modal.classList.remove('hidden');
    document.querySelector('#modal-overlay')?.classList.remove('hidden');
    loading?.classList.remove('hidden');
    grid.classList.add('hidden');
    emptyState?.classList.add('hidden');
    
    try {
      const botSlug = getCurrentBotSlug();
      if (!botSlug) {
        showToast('error', 'Nenhum bot selecionado');
        closeModal('media-selector-modal');
        return;
      }
      
      const headers = getAuthHeaders();
      if (!headers) {
        showToast('error', 'Token não configurado');
        closeModal('media-selector-modal');
        return;
      }
      
      const response = await fetch(`${baseUrl}/api/admin/bots/${botSlug}/media`, {
        headers: headers,
      });
      
      if (!response.ok) {
        throw new Error('Falha ao carregar mídias');
      }
      
      const data = await response.json();
      const medias = data.media || [];
      
      console.log('[MULTI_MEDIA][LOADED]', medias.length, 'mídias');
      
      if (medias.length === 0) {
        loading?.classList.add('hidden');
        emptyState?.classList.remove('hidden');
      } else {
        loading?.classList.add('hidden');
        grid.classList.remove('hidden');
        renderMediaGridMulti(medias, options);
      }
    } catch (err) {
      console.error('[MULTI_MEDIA][ERROR]', err);
      showToast('error', 'Erro ao carregar mídias');
      loading?.classList.add('hidden');
      emptyState?.classList.remove('hidden');
    }
  }
  
  function renderMediaGridMulti(medias, options) {
    const grid = document.querySelector('#media-grid');
    const modal = document.querySelector('#media-selector-modal');
    if (!grid || !modal) return;
    
    const selectedSha256s = new Set((options.selectedItems || []).map(m => m.sha256));
    const maxItems = options.maxItems || 3;
    
    grid.innerHTML = medias.map(m => {
      const thumbUrl = m.r2_key ? `${baseUrl}/api/media/preview/${m.id}` : '/placeholder.png';
      const typeIcon = m.kind === 'video' ? '🎥' : m.kind === 'audio' ? '🎵' : '🖼️';
      const sizeKB = Math.round((m.bytes || 0) / 1024);
      const fileName = m.r2_key ? m.r2_key.split('/').pop() : 'Sem nome';
      const isSelected = selectedSha256s.has(m.sha256);
      
      return `
        <div class="media-card cursor-pointer hover:ring-2 hover:ring-blue-500 rounded-lg overflow-hidden bg-zinc-800 transition-all ${isSelected ? 'ring-2 ring-green-500' : ''}"
             data-media-id="${m.id}"
             data-media-sha256="${m.sha256}"
             data-media-kind="${m.kind}"
             data-media-name="${fileName}"
             data-media-bytes="${m.bytes || 0}"
             data-media-r2-key="${m.r2_key}"
             data-selected="${isSelected}">
          <div class="relative" style="height: 150px; background: #1a1a2e;">
            ${m.kind === 'photo' ? `<img src="${thumbUrl}" alt="${fileName}" class="w-full h-full object-cover" onerror="this.style.display='none'" />` : ''}
            <div class="absolute inset-0 flex items-center justify-center text-6xl">
              ${typeIcon}
            </div>
            <div class="absolute top-2 right-2 bg-black/70 px-2 py-1 rounded text-xs">
              ${typeIcon} ${m.kind}
            </div>
            ${isSelected ? '<div class="absolute top-2 left-2 bg-green-500 text-white px-2 py-1 rounded text-xs">✓ Selecionado</div>' : ''}
          </div>
          <div class="p-3">
            <p class="text-sm font-medium text-white truncate" title="${fileName}">${fileName}</p>
            <p class="text-xs text-zinc-400 mt-1">${sizeKB} KB • ID: ${m.id}</p>
          </div>
        </div>
      `;
    }).join('');
    
    // Adicionar event listeners nos cards
    const selectedMedias = [];
    grid.querySelectorAll('.media-card').forEach(card => {
      if (card.dataset.selected === 'true') {
        selectedMedias.push({
          sha256: card.dataset.mediaSha256,
          kind: card.dataset.mediaKind,
          name: card.dataset.mediaName,
          bytes: parseInt(card.dataset.mediaBytes),
          r2_key: card.dataset.mediaR2Key,
          thumb_url: card.querySelector('img')?.src
        });
      }
      
      card.addEventListener('click', () => {
        const isSelected = card.dataset.selected === 'true';
        
        if (isSelected) {
          // Desselecionar
          card.dataset.selected = 'false';
          card.classList.remove('ring-2', 'ring-green-500');
          card.querySelector('.absolute.top-2.left-2')?.remove();
          
          const index = selectedMedias.findIndex(m => m.sha256 === card.dataset.mediaSha256);
          if (index > -1) selectedMedias.splice(index, 1);
        } else {
          // Verificar limite
          if (selectedMedias.length >= maxItems) {
            showToast('warning', `Máximo de ${maxItems} mídias permitido`);
            return;
          }
          
          // Selecionar
          card.dataset.selected = 'true';
          card.classList.add('ring-2', 'ring-green-500');
          
          const badge = document.createElement('div');
          badge.className = 'absolute top-2 left-2 bg-green-500 text-white px-2 py-1 rounded text-xs';
          badge.textContent = '✓ Selecionado';
          card.querySelector('.relative').appendChild(badge);
          
          selectedMedias.push({
            sha256: card.dataset.mediaSha256,
            kind: card.dataset.mediaKind,
            name: card.dataset.mediaName,
            bytes: parseInt(card.dataset.mediaBytes),
            r2_key: card.dataset.mediaR2Key,
            thumb_url: card.querySelector('img')?.src
          });
        }
        
        console.log('[MULTI_MEDIA][SELECTED]', selectedMedias.length, 'mídias');
        updateConfirmButton();
      });
    });
    
    // Botão de confirmar seleção
    const modalContent = modal.querySelector('.modal-content');
    let confirmBtnContainer = modal.querySelector('#confirm-multi-media-container');
    
    if (!confirmBtnContainer) {
      confirmBtnContainer = document.createElement('div');
      confirmBtnContainer.id = 'confirm-multi-media-container';
      confirmBtnContainer.className = 'flex justify-end gap-3 mt-4 pt-4 border-t border-zinc-700';
      
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-secondary px-6 py-2';
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.onclick = () => closeModal('media-selector-modal');
      
      const confirmBtn = document.createElement('button');
      confirmBtn.id = 'confirm-multi-media-btn';
      confirmBtn.type = 'button';
      confirmBtn.className = 'btn-primary px-6 py-2';
      confirmBtn.textContent = 'Confirmar Seleção (0)';
      
      confirmBtn.onclick = () => {
        console.log('[MULTI_MEDIA][CONFIRM]', selectedMedias);
        if (window.__multiMediaCallback) {
          window.__multiMediaCallback(selectedMedias);
        }
        closeModal('media-selector-modal');
      };
      
      confirmBtnContainer.appendChild(cancelBtn);
      confirmBtnContainer.appendChild(confirmBtn);
      modalContent.appendChild(confirmBtnContainer);
    }
    
    // Atualizar contador no botão quando seleção mudar
    const updateConfirmButton = () => {
      const confirmBtn = modal.querySelector('#confirm-multi-media-btn');
      if (confirmBtn) {
        confirmBtn.textContent = `Confirmar Seleção (${selectedMedias.length})`;
        confirmBtn.disabled = selectedMedias.length === 0;
      }
    };
    
    updateConfirmButton();
  }
  
  async function openMediaSelector(context) {
    currentMediaContext = context;
    const modal = document.querySelector('#media-selector-modal');
    const grid = document.querySelector('#media-grid');
    const loading = document.querySelector('#media-loading');
    const emptyState = document.querySelector('#media-empty-state');
    
    if (!modal || !grid) return;
    
    // Mostrar modal
    modal.classList.remove('hidden');
    loading?.classList.remove('hidden');
    grid.classList.add('hidden');
    emptyState?.classList.add('hidden');
    
    try {
      // Buscar mídias do bot atual
      const botSlug = getCurrentBotSlug();
      if (!botSlug) {
        showToast('Nenhum bot selecionado', 'error');
        closeModal('media-selector-modal');
        return;
      }
      
      console.log('[MEDIA-SELECTOR] Buscando mídias para:', botSlug);
      console.log('[MEDIA-SELECTOR] URL:', `${baseUrl}/api/admin/bots/${botSlug}/media`);
      
      const headers = getAuthHeaders();
      
      if (!headers) {
        showToast('Token não configurado. Faça login primeiro.', 'error');
        closeModal('media-selector-modal');
        return;
      }
      
      console.log('[MEDIA-SELECTOR] Headers:', headers);
      console.log('[MEDIA-SELECTOR] Token exists:', !!headers.Authorization);
      
      const response = await fetch(`${baseUrl}/api/admin/bots/${botSlug}/media`, {
        headers: headers,
      });
      
      console.log('[MEDIA-SELECTOR] Response status:', response.status);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[MEDIA-SELECTOR] Response error:', errorData);
        throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
      }
      
      const data = await response.json();
      console.log('[MEDIA-SELECTOR] Data recebido:', data);
      
      mediaCache = data.media || [];
      
      // Filtrar apenas mídias aquecidas (cache.status = 'ready')
      const readyMedia = mediaCache.filter(m => m.cache && m.cache.status === 'ready');
      
      console.log('[MEDIA-SELECTOR] Total de mídias:', mediaCache.length);
      console.log('[MEDIA-SELECTOR] Mídias prontas:', readyMedia.length);
      
      if (readyMedia.length === 0) {
        emptyState?.classList.remove('hidden');
      } else {
        renderMediaGrid(readyMedia);
        grid.classList.remove('hidden');
      }
    } catch (err) {
      console.error('[MEDIA-SELECTOR] Erro:', err);
      showToast('Erro ao carregar mídias: ' + err.message, 'error');
    } finally {
      loading?.classList.add('hidden');
    }
  }
  
  function renderMediaGrid(media) {
    const grid = document.querySelector('#media-grid');
    if (!grid) return;
    
    grid.innerHTML = media.map(m => {
      // Construir URL da thumbnail/preview (pode ser via backend ou placeholder)
      const thumbUrl = m.r2_key ? `${baseUrl}/api/media/preview/${m.id}` : '/placeholder.png';
      const typeIcon = m.kind === 'video' ? '🎥' : m.kind === 'audio' ? '🎵' : '🖼️';
      const sizeKB = Math.round((m.bytes || 0) / 1024);
      const fileName = m.r2_key ? m.r2_key.split('/').pop() : 'Sem nome';
      const fileId = m.cache?.file_id || '';
      
      return `
        <div class="media-card cursor-pointer hover:ring-2 hover:ring-blue-500 rounded-lg overflow-hidden bg-zinc-800 transition-all"
             data-media-id="${m.id}"
             data-file-id="${fileId}"
             data-media-name="${fileName}"
             data-media-type="${m.kind}"
             data-media-size="${sizeKB}"
             data-media-sha256="${m.sha256}"
             data-media-r2-key="${m.r2_key}">
          <div class="relative" style="height: 150px; background: #1a1a2e;">
            ${m.kind === 'photo' ? `<img src="${thumbUrl}" alt="${fileName}" class="w-full h-full object-cover" onerror="this.style.display='none'" />` : ''}
            <div class="absolute inset-0 flex items-center justify-center text-6xl">
              ${typeIcon}
            </div>
            <div class="absolute top-2 right-2 bg-black/70 px-2 py-1 rounded text-xs">
              ${typeIcon} ${m.kind}
            </div>
          </div>
          <div class="p-3">
            <p class="text-sm font-medium text-white truncate" title="${fileName}">${fileName}</p>
            <p class="text-xs text-zinc-400 mt-1">${sizeKB} KB • ID: ${m.id}</p>
          </div>
        </div>
      `;
    }).join('');
    
    // Adicionar event listeners nos cards
    grid.querySelectorAll('.media-card').forEach(card => {
      card.addEventListener('click', () => {
        const fileId = card.dataset.fileId;
        const mediaId = card.dataset.mediaId;
        const name = card.dataset.mediaName;
        const type = card.dataset.mediaType;
        const size = card.dataset.mediaSize;
        const sha256 = card.dataset.mediaSha256;
        const r2Key = card.dataset.mediaR2Key;
        const thumbUrl = card.querySelector('img')?.src || '';
        
        selectMedia(fileId, mediaId, name, type, size, sha256, r2Key, thumbUrl);
        closeModal('media-selector-modal');
      });
    });
  }
  
  function selectMedia(fileId, mediaId, name, type, size, sha256, r2Key, thumbUrl) {
    if (!currentMediaContext) return;
    
    const prefix = currentMediaContext === 'start' ? 'start-message' : currentMediaContext;
    
    // Preencher hidden inputs
    const fileIdInput = document.querySelector(`#${prefix}-file-id`);
    const mediaIdInput = document.querySelector(`#${prefix}-media-id`);
    const sha256Input = document.querySelector(`#${prefix}-media-sha256`);
    const r2KeyInput = document.querySelector(`#${prefix}-media-r2-key`);
    const kindInput = document.querySelector(`#${prefix}-media-kind`);
    
    if (fileIdInput) fileIdInput.value = fileId || '';
    if (mediaIdInput) mediaIdInput.value = mediaId || '';
    if (sha256Input) sha256Input.value = sha256 || '';
    if (r2KeyInput) r2KeyInput.value = r2Key || '';
    if (kindInput) kindInput.value = type || '';
    
    // Mostrar preview da mídia selecionada
    const selectedDiv = document.querySelector(`#${prefix}-selected-media`);
    const thumb = document.querySelector(`#${prefix}-media-thumb`);
    const nameEl = document.querySelector(`#${prefix}-media-name`);
    const infoEl = document.querySelector(`#${prefix}-media-info`);
    
    if (selectedDiv) selectedDiv.classList.remove('hidden');
    if (thumb) thumb.src = thumbUrl;
    if (nameEl) nameEl.textContent = name;
    if (infoEl) infoEl.textContent = `${type} • ${size} KB`;
    
    showToast('Mídia selecionada: ' + name, 'success');
  }
  
  function clearMediaSelection(context) {
    const prefix = context === 'start' ? 'start-message' : context;
    
    const fileIdInput = document.querySelector(`#${prefix}-file-id`);
    const selectedDiv = document.querySelector(`#${prefix}-selected-media`);
    
    if (fileIdInput) fileIdInput.value = '';
    if (selectedDiv) selectedDiv.classList.add('hidden');
    
    showToast('Mídia removida', 'info');
  }
  
  function filterMediaGrid() {
    const searchTerm = document.querySelector('#media-search')?.value.toLowerCase() || '';
    const typeFilter = document.querySelector('#media-type-filter')?.value || '';
    
    const filtered = mediaCache.filter(m => {
      const matchesSearch = !searchTerm || (m.r2_key || '').toLowerCase().includes(searchTerm);
      const matchesType = !typeFilter || m.kind === typeFilter;
      const isReady = m.cache && m.cache.status === 'ready';
      return matchesSearch && matchesType && isReady;
    });
    
    const grid = document.querySelector('#media-grid');
    const emptyState = document.querySelector('#media-empty-state');
    
    if (filtered.length === 0) {
      grid?.classList.add('hidden');
      emptyState?.classList.remove('hidden');
    } else {
      renderMediaGrid(filtered);
      grid?.classList.remove('hidden');
      emptyState?.classList.add('hidden');
    }
  }
  
  function getCurrentBotSlug() {
    // Usa o slug armazenado quando abrimos os modais, ou pega da URL
    if (currentMediaBotSlug) {
      return currentMediaBotSlug;
    }
    return currentAdminSlug();
  }
  
  function setCurrentMediaBotSlug(slug) {
    currentMediaBotSlug = slug;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      initMediaSelector();
    });
  } else {
    init();
    initMediaSelector();
  }
})();
