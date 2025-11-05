(() => {
  const ADMIN_TOKEN_KEY = 'ADMIN_API_TOKEN';
  const FETCH_TIMEOUT = 10000;
  const SEARCH_DEBOUNCE = 250;
  const MAX_TOASTS = 3;

  const env = window.__ENV__ || {};
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
    const cleanedPath = window.location.pathname.replace(/\/+$, '');
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
    if (!state.token) return null;
    return {
      Authorization: `Bearer ${state.token}`,
    };
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
        btnEdit.addEventListener('click', (event) => {
          event.preventDefault();
          const slug = encodeURIComponent(bot.slug);
          window.open(`/admin/${slug}`, '_blank', 'noopener');
        });
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
    const term = state.searchTerm.trim().toLowerCase();
    let filtered = state.bots;
    if (term) {
      filtered = state.bots.filter((bot) => {
        const name = String(bot.name || '').toLowerCase();
        const slug = String(bot.slug || '').toLowerCase();
        return name.includes(term) || slug.includes(term);
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
    if (!state.token) {
      showToast('warning', 'Informe a chave admin para listar os bots.');
      openModal('token-modal');
      return state.bots;
    }

    if (state.abortController) {
      state.abortController.abort();
    }

    const headers = getAuthHeaders();
    if (!headers) return state.bots;

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
      const response = await fetch(`${baseUrl}/api/admin/bots`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (response.status === 401) {
        handleUnauthorized();
        return state.bots;
      }

      if (response.status === 429) {
        showToast('warning', 'Muitas requisições. Aguarde alguns segundos.');
        displayErrorHint('Muitas requisições. Aguarde alguns segundos.');
        return state.bots;
      }

      if (!response.ok) {
        throw new Error('fetch_failed');
      }

      const data = await response.json();
      state.bots = Array.isArray(data) ? data : [];
      applyFilter();
    } catch (error) {
      if (controller.signal.aborted && didTimeout) {
        showToast('error', 'Tempo excedido ao carregar bots.');
        displayErrorHint('Tempo excedido ao carregar bots.');
      } else if (controller.signal.aborted) {
        // abort manual (nova requisição); não exibir toast
      } else {
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
    clearFieldErrors();

    if (!state.token) {
      showToast('warning', 'Defina a chave admin antes de criar.');
      openModal('token-modal');
      return;
    }

    if (!elements.botForm.reportValidity()) {
      return;
    }

    const payload = serializeBotForm();
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
        response = await fetch(`${baseUrl}/api/admin/bots`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
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
        handleUnauthorized();
        return;
      }

      if (response.status === 409) {
        applyFieldErrors({ slug: 'Slug já existente.' });
        showToast('error', 'Slug já existente.');
        return;
      }

      if (response.status === 422 || response.status === 400) {
        const data = await response.json().catch(() => ({}));
        if (data && typeof data === 'object') {
          const fieldErrors = data.errors || data;
          applyFieldErrors(fieldErrors);
        }
        showToast('error', 'Revise os campos destacados.');
        return;
      }

      if (!response.ok) {
        throw new Error('create_failed');
      }

      const result = await response.json().catch(() => ({}));
      const slug = result.slug || payload.slug;
      state.lastCreatedSlug = slug;
      updateInstructionsCard();

      showToast('success', 'Bot criado com sucesso.');
      closeModal('bot-modal');
      await fetchBots();
    } catch (error) {
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

    let bot = state.bots.find((item) => item.slug === slug);
    if (!bot) {
      const bots = await fetchBots();
      bot = Array.isArray(bots) ? bots.find((item) => item.slug === slug) : null;
    }

    root.innerHTML = '';

    if (!bot) {
      const message = document.createElement('p');
      message.className = 'text-sm text-zinc-400';
      message.textContent = state.token
        ? 'Bot não encontrado.'
        : 'Informe a chave admin para visualizar os detalhes do bot.';
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

    const backLink = fragment.querySelector('[data-action="back"]');
    if (backLink) {
      backLink.addEventListener('click', (event) => {
        event.preventDefault();
        window.location.href = '/admin';
      });
    }

    const tokenInput = fragment.querySelector('[data-field="token"]');
    const statusEl = fragment.querySelector('[data-field="token-status"]');

    const revealBtn = fragment.querySelector('[data-action="reveal"]');
    if (revealBtn && tokenInput) {
      revealBtn.addEventListener('click', (event) => {
        event.preventDefault();
        tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
      });
    }

    const validateBtn = fragment.querySelector('[data-action="validate"]');
    if (validateBtn && tokenInput) {
      validateBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        const token = (tokenInput.value || '').trim();
        if (!token) {
          if (statusEl) statusEl.textContent = 'Cole o token antes de validar.';
          return;
        }

        if (statusEl) statusEl.textContent = 'Validando…';

        let timeoutId;
        try {
          const controller = new AbortController();
          timeoutId = setTimeout(() => controller.abort(), 5000);
          const response = await fetch(`${baseUrl}/api/telegram/validate-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok) {
            const data = await response.json().catch(() => ({}));
            if (data && data.ok) {
              if (statusEl) statusEl.textContent = 'Válido ✅';
            } else {
              const message = (data && data.error) || 'Inválido';
              if (statusEl) statusEl.textContent = `${message} ❌`;
            }
          } else {
            if (statusEl) statusEl.textContent = response.status === 400 ? 'Inválido ❌' : 'Erro ao validar';
          }
        } catch (err) {
          if (timeoutId) clearTimeout(timeoutId);
          if (statusEl) statusEl.textContent = 'Timeout/Erro de rede';
        }
      });
    }

    const copyBtn = fragment.querySelector('[data-action="copy-webhook"]');
    if (copyBtn) {
      copyBtn.addEventListener('click', async (event) => {
        event.preventDefault();
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
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Falha ao copiar';
        }
      });
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

  function handleTokenSubmit(event) {
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
    adminRouter();
  }

  function handleTokenClear() {
    clearToken();
    elements.tokenInput.value = '';
    showToast('success', 'Token limpo.');
    adminRouter();
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
    elements.adminTokenBtn.addEventListener('click', () => openModal('token-modal'));
    elements.newBotBtn.addEventListener('click', () => openModal('bot-modal'));
    elements.refreshBtn.addEventListener('click', fetchBots);
    elements.tokenForm.addEventListener('submit', handleTokenSubmit);
    elements.clearTokenBtn.addEventListener('click', handleTokenClear);
    elements.toggleTokenVisibility.addEventListener('click', toggleTokenVisibility);
    elements.botForm.addEventListener('submit', handleBotSubmit);
    if (elements.validateTokenBtn) {
      elements.validateTokenBtn.addEventListener('click', handleValidateTokenClick);
    }
    elements.modalOverlay.addEventListener('click', handleOverlayClick);
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close-modal')));
    });
    document.addEventListener('keydown', handleDocumentKeydown);
    elements.copyWebhookBtn.addEventListener('click', copyWebhookUrl);
    elements.closeInstructionsBtn.addEventListener('click', () => {
      elements.instructionsCard.classList.add('hidden');
    });

    elements.searchInput.addEventListener(
      'input',
      debounce((event) => {
        state.searchTerm = event.target.value || '';
        applyFilter();
      }, SEARCH_DEBOUNCE)
    );
  }

  window.addEventListener('popstate', () => {
    adminRouter();
  });

  function init() {
    registerEventListeners();
    initToken();
    adminRouter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
