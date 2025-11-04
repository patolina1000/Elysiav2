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
      for (let j = 0; j < 6; j++) {
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
      const cells = [
        bot.name || '—',
        bot.slug || '—',
        bot.provider || '—',
        bot.sandbox ? 'Sim' : 'Não',
        typeof bot.rate_per_min === 'number' ? bot.rate_per_min : bot.rate_per_min || '—',
        formatFlags(bot.flags),
      ];

      cells.forEach((value) => {
        const cell = document.createElement('td');
        cell.className = 'table-cell text-sm text-zinc-200';
        cell.textContent = value;
        row.appendChild(cell);
      });

      elements.tableBody.appendChild(row);
    });
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
      return;
    }

    if (state.abortController) {
      state.abortController.abort();
    }

    const headers = getAuthHeaders();
    if (!headers) return;

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
        return;
      }

      if (response.status === 429) {
        showToast('warning', 'Muitas requisições. Aguarde alguns segundos.');
        displayErrorHint('Muitas requisições. Aguarde alguns segundos.');
        return;
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
      document.querySelector('#bot-sandbox').value = 'false';
      document.querySelector('#bot-rate').value = '60';
      document.querySelector('#bot-renderer').value = 'markdownV2';
      document.querySelector('#bot-album').checked = true;
      document.querySelector('#bot-typing-delay').value = '400';
      document.querySelector('#bot-watermark').value = '';
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
    const rateValue = Number.parseInt(formData.get('rate_per_min'), 10);
    const typingDelayValue = Number.parseInt(formData.get('typing_delay_ms'), 10);
    const payload = {
      name: (formData.get('name') || '').toString().trim(),
      slug: (formData.get('slug') || '').toString().trim(),
      provider: (formData.get('provider') || '').toString().trim(),
      sandbox: formData.get('sandbox') === 'true',
      rate_per_min: Number.isFinite(rateValue) && rateValue > 0 ? rateValue : 60,
      renderer: (formData.get('renderer') || '').toString().trim(),
      use_album: formData.get('use_album') === 'on',
      typing_delay_ms:
        Number.isFinite(typingDelayValue)
          ? Math.min(Math.max(typingDelayValue, 0), 5000)
          : 0,
    };

    const watermark = (formData.get('watermark') || '').toString().trim();
    if (watermark) {
      payload.watermark = watermark;
    }

    return payload;
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
    fetchBots();
  }

  function handleTokenClear() {
    clearToken();
    elements.tokenInput.value = '';
    showToast('success', 'Token limpo.');
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

  function init() {
    registerEventListeners();
    initToken();
    if (state.token) {
      fetchBots();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
