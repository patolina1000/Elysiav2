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
    elements.modalOverlay.setAttribute('aria-hidden', 'false');
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
      elements.modalOverlay.setAttribute('aria-hidden', 'true');
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
    elements.modalOverlay.setAttribute('aria-hidden', 'true');
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
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${baseUrl}/api/admin/bots/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.ok) {
        showToast('success', `Bot ${slug} excluído com sucesso.`);
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
      showToast('error', 'Erro ao excluir bot.');
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
      
      // Preencher formulário
      document.getElementById('start-message-active').checked = data.active || false;
      document.getElementById('start-message-text').value = data.message?.text || '';
      document.getElementById('start-message-disable-preview').checked = data.message?.disable_web_page_preview || false;
      document.getElementById('start-message-raw').checked = data.message?.raw || false;
      
      // Atualizar contador
      updateCharCount();
      
      // Atualizar data
      if (data.updated_at) {
        const date = new Date(data.updated_at);
        document.getElementById('start-message-updated-at').textContent = 
          `Última atualização: ${date.toLocaleString('pt-BR')}`;
      } else {
        document.getElementById('start-message-updated-at').textContent = '';
      }
      
      // Mostrar/ocultar campos baseado no toggle
      toggleStartMessageFields();
      
    } catch (err) {
      console.error('[START_MESSAGE][LOAD][ERR]', err);
      showToast('error', 'Erro ao carregar mensagem');
    }
    
    modal.classList.remove('hidden');
    overlay.classList.remove('hidden');
  }

  function toggleStartMessageFields() {
    const active = document.getElementById('start-message-active').checked;
    const textField = document.getElementById('start-message-text-field');
    const options = document.getElementById('start-message-options');
    const testSection = document.getElementById('start-message-test-section');
    const saveBtn = document.getElementById('start-message-save-btn');
    const saveCloseBtn = document.getElementById('start-message-save-close-btn');
    
    if (active) {
      textField.classList.remove('opacity-50', 'pointer-events-none');
      options.classList.remove('opacity-50', 'pointer-events-none');
      testSection.classList.remove('opacity-50', 'pointer-events-none');
    } else {
      textField.classList.add('opacity-50', 'pointer-events-none');
      options.classList.add('opacity-50', 'pointer-events-none');
      testSection.classList.add('opacity-50', 'pointer-events-none');
    }
    
    // Validar botão salvar
    validateStartMessageForm();
  }

  function updateCharCount() {
    const text = document.getElementById('start-message-text').value;
    document.getElementById('start-message-char-count').textContent = text.length;
  }

  function validateStartMessageForm() {
    const active = document.getElementById('start-message-active').checked;
    const text = document.getElementById('start-message-text').value.trim();
    const saveBtn = document.getElementById('start-message-save-btn');
    const saveCloseBtn = document.getElementById('start-message-save-close-btn');
    
    const isValid = !active || (text.length > 0 && text.length <= 4096);
    
    saveBtn.disabled = !isValid;
    saveCloseBtn.disabled = !isValid;
  }

  function toggleRawWarning() {
    const raw = document.getElementById('start-message-raw').checked;
    const warning = document.getElementById('start-message-raw-warning');
    
    if (raw) {
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
    }
  }

  async function saveStartMessage(closeAfter = false) {
    if (!currentStartMessageSlug) return;
    
    const active = document.getElementById('start-message-active').checked;
    const text = document.getElementById('start-message-text').value.trim();
    const disablePreview = document.getElementById('start-message-disable-preview').checked;
    const raw = document.getElementById('start-message-raw').checked;
    
    // Validação
    if (active && !text) {
      showToast('error', 'Texto obrigatório quando ativo');
      return;
    }
    
    if (text.length > 4096) {
      showToast('error', 'Texto muito longo (máx 4096)');
      return;
    }
    
    const payload = {
      active,
      message: active ? {
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: disablePreview,
        raw
      } : null
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
    
    const chatId = document.getElementById('start-message-test-chat-id').value.trim();
    const text = document.getElementById('start-message-text').value.trim();
    const disablePreview = document.getElementById('start-message-disable-preview').checked;
    const raw = document.getElementById('start-message-raw').checked;
    const resultDiv = document.getElementById('start-message-test-result');
    const testBtn = document.getElementById('start-message-test-btn');
    
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
    
    try {
      await adminRouter();
      console.log('[ADMIN][INIT] Admin SPA inicializado com sucesso.');
    } catch (err) {
      console.error('[ADMIN][ERR] init:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
