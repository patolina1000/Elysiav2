/**
 * Multi-Media Selector Component
 * Permite selecionar 1-3 mídias com reordenação e prioridade
 * Ordem de envio: áudio > vídeo > foto
 */

class MultiMediaSelector {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      maxItems: 3,
      types: ['audio', 'video', 'photo'],
      showTypeFilter: true,
      ...options
    };
    
    // Mapear allowedKinds para types se fornecido
    if (options.allowedKinds) {
      this.options.types = options.allowedKinds;
    }
    
    this.selectedMedias = [];
    this.currentFilter = 'all';
    this.onMediaSelected = options.onMediaSelected || (() => {});
    
    this.init();
    
    // Definir valor inicial se fornecido
    if (options.value && Array.isArray(options.value)) {
      this.setValue(options.value);
    }
  }
  
  init() {
    this.render();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="multi-media-selector space-y-4">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <label class="form-label">Mídias (0-3)</label>
            <p class="text-xs text-zinc-500">As mídias serão enviadas em mensagens separadas, na ordem: Áudio > Vídeo > Foto</p>
          </div>
          <button type="button" class="btn-secondary text-xs px-4 py-2" id="select-medias-btn">
            🎬 Selecionar mídias aquecidas (1-3)
          </button>
        </div>
        
        <!-- Type Filter -->
        ${this.options.showTypeFilter ? `
        <div class="flex gap-2">
          <button type="button" class="filter-btn active" data-type="all">Todos</button>
          <button type="button" class="filter-btn" data-type="photo">🖼️ Fotos</button>
          <button type="button" class="filter-btn" data-type="video">🎬 Vídeos</button>
          <button type="button" class="filter-btn" data-type="audio">🎧 Áudios</button>
        </div>
        ` : ''}
        
        <!-- Selected Medias -->
        <div id="selected-medias-list" class="space-y-2">
          <!-- Items will be added dynamically -->
        </div>
        
        <!-- Empty State -->
        <div id="empty-medias-state" class="text-center py-8 text-zinc-500 border-2 border-dashed border-zinc-700 rounded-lg">
          <p class="text-sm">Nenhuma mídia selecionada</p>
          <p class="text-xs mt-1">Clique em "Selecionar mídias" para adicionar</p>
        </div>
        
        <!-- Hidden inputs for form submission -->
        <div id="media-hidden-inputs">
          <!-- Will be populated dynamically -->
        </div>
      </div>
    `;
    
    this.updateStyles();
  }
  
  updateStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .multi-media-selector .filter-btn {
        @apply px-3 py-1 text-xs rounded-lg border border-zinc-600 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors;
      }
      .multi-media-selector .filter-btn.active {
        @apply bg-accent text-white border-accent;
      }
      .media-item {
        @apply flex items-center gap-3 p-3 bg-zinc-800 rounded-lg border border-zinc-700;
      }
      .media-item.dragging {
        @apply opacity-50 border-accent;
      }
      .media-item .drag-handle {
        @apply cursor-move text-zinc-500 hover:text-zinc-300;
      }
      .media-item .media-thumb {
        @apply w-12 h-12 object-cover rounded;
      }
      .media-item .media-info {
        @apply flex-1;
      }
      .media-item .media-name {
        @apply text-sm font-medium text-zinc-200;
      }
      .media-item .media-details {
        @apply text-xs text-zinc-500;
      }
      .media-item .media-badge {
        @apply inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full;
      }
      .media-item .badge-audio {
        @apply bg-purple-900/30 text-purple-300 border border-purple-700/50;
      }
      .media-item .badge-video {
        @apply bg-blue-900/30 text-blue-300 border border-blue-700/50;
      }
      .media-item .badge-photo {
        @apply bg-green-900/30 text-green-300 border border-green-700/50;
      }
      .media-item .badge-ready {
        @apply bg-emerald-900/30 text-emerald-300;
      }
      .media-item .badge-warming {
        @apply bg-amber-900/30 text-amber-300;
      }
      .media-item .badge-error {
        @apply bg-red-900/30 text-red-300;
      }
      .media-item .remove-btn {
        @apply text-red-400 hover:text-red-300 text-sm;
      }
      .media-item .add-btn {
        @apply text-accent hover:text-accent/80 text-sm;
      }
    `;
    
    if (!document.querySelector('#multi-media-selector-styles')) {
      style.id = 'multi-media-selector-styles';
      document.head.appendChild(style);
    }
  }
  
  bindEvents() {
    // Select medias button
    this.container.querySelector('#select-medias-btn').addEventListener('click', () => {
      this.openMediaSelector();
    });
    
    // Type filter buttons
    this.container.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.setFilter(e.target.dataset.type);
      });
    });
  }
  
  setFilter(type) {
    this.currentFilter = type;
    
    // Update button states
    this.container.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
    
    // Update visibility
    this.updateMediaVisibility();
  }
  
  updateMediaVisibility() {
    this.selectedMedias.forEach((media, index) => {
      const item = this.container.querySelector(`[data-media-index="${index}"]`);
      if (item) {
        const visible = this.currentFilter === 'all' || media.kind === this.currentFilter;
        item.style.display = visible ? 'flex' : 'none';
      }
    });
    
    // Update empty state
    const visibleItems = this.selectedMedias.filter(media => 
      this.currentFilter === 'all' || media.kind === this.currentFilter
    );
    
    const emptyState = this.container.querySelector('#empty-medias-state');
    emptyState.style.display = visibleItems.length === 0 ? 'block' : 'none';
  }
  
  openMediaSelector() {
    // Dispatch custom event to open media selector modal
    const event = new CustomEvent('openMediaSelector', {
      detail: {
        multiSelect: true,
        maxItems: this.options.maxItems - this.selectedMedias.length,
        selectedItems: this.selectedMedias,
        onMediaSelected: (medias) => this.addMedias(medias)
      }
    });
    document.dispatchEvent(event);
  }
  
  addMedias(medias) {
    const availableSlots = this.options.maxItems - this.selectedMedias.length;
    const mediasToAdd = medias.slice(0, availableSlots);
    
    mediasToAdd.forEach(media => {
      // Check if already selected
      const exists = this.selectedMedias.some(m => m.sha256 === media.sha256 && m.kind === media.kind);
      if (!exists) {
        this.selectedMedias.push(media);
      }
    });
    
    this.sortByPriority();
    this.renderSelectedMedias();
    this.updateHiddenInputs();
    this.onMediaSelected(this.selectedMedias);
  }
  
  removeMedia(index) {
    this.selectedMedias.splice(index, 1);
    this.renderSelectedMedias();
    this.updateHiddenInputs();
    this.onMediaSelected(this.selectedMedias);
  }
  
  sortByPriority() {
    // Sort by priority: audio > video > photo, then by original order
    const priority = { audio: 0, video: 1, photo: 2 };
    
    this.selectedMedias.sort((a, b) => {
      const priorityDiff = priority[a.kind] - priority[b.kind];
      if (priorityDiff !== 0) return priorityDiff;
      return 0; // Keep original order for same type
    });
  }
  
  renderSelectedMedias() {
    const container = this.container.querySelector('#selected-medias-list');
    container.innerHTML = '';
    
    this.selectedMedias.forEach((media, index) => {
      const item = document.createElement('div');
      item.className = 'media-item';
      item.dataset.mediaIndex = index;
      item.draggable = true;
      
      const kindIcon = { audio: '🎧', video: '🎬', photo: '🖼️' }[media.kind];
      const statusBadge = this.getStatusBadge(media.status);
      
      item.innerHTML = `
        <span class="drag-handle">☰</span>
        ${media.kind === 'photo' && media.thumb_url ? 
          `<img src="${media.thumb_url}" class="media-thumb" alt="Preview" />` :
          `<div class="w-12 h-12 bg-zinc-700 rounded flex items-center justify-center text-lg">${kindIcon}</div>`
        }
        <div class="media-info">
          <div class="media-name">${media.name || media.r2_key?.split('/').pop() || 'Mídia'}</div>
          <div class="media-details">
            ${media.kind} • ${this.formatBytes(media.bytes || 0)}
            ${statusBadge}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="media-item-index text-xs text-zinc-500">${index + 1}</span>
          <button type="button" class="remove-btn" onclick="multiMediaSelector.removeMedia(${index})">✖️</button>
        </div>
      `;
      
      // Drag and drop events
      item.addEventListener('dragstart', (e) => this.handleDragStart(e, index));
      item.addEventListener('dragover', (e) => this.handleDragOver(e));
      item.addEventListener('drop', (e) => this.handleDrop(e, index));
      item.addEventListener('dragend', (e) => this.handleDragEnd(e));
      
      container.appendChild(item);
    });
    
    this.updateMediaVisibility();
  }
  
  getStatusBadge(status) {
    const badges = {
      ready: '<span class="media-badge badge-ready">✅ Ready</span>',
      warming: '<span class="media-badge badge-warming">⏳ Warming</span>',
      error: '<span class="media-badge badge-error">❌ Error</span>'
    };
    return badges[status] || '';
  }
  
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
  
  handleDragStart(e, index) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
    e.target.classList.add('dragging');
  }
  
  handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  
  handleDrop(e, dropIndex) {
    e.preventDefault();
    const dragIndex = parseInt(e.dataTransfer.getData('text/plain'));
    
    if (dragIndex !== dropIndex) {
      const draggedMedia = this.selectedMedias[dragIndex];
      this.selectedMedias.splice(dragIndex, 1);
      this.selectedMedias.splice(dropIndex, 0, draggedMedia);
      
      this.renderSelectedMedias();
      this.updateHiddenInputs();
      this.onMediaSelected(this.selectedMedias);
    }
  }
  
  handleDragEnd(e) {
    e.target.classList.remove('dragging');
  }
  
  updateHiddenInputs() {
    const container = this.container.querySelector('#media-hidden-inputs');
    container.innerHTML = '';
    
    // Create JSON input for form submission
    const jsonInput = document.createElement('input');
    jsonInput.type = 'hidden';
    jsonInput.name = 'media_refs';
    jsonInput.value = JSON.stringify(this.selectedMedias.map(media => ({
      sha256: media.sha256,
      kind: media.kind
    })));
    container.appendChild(jsonInput);
  }
  
  getValue() {
    return this.selectedMedias.map(media => ({
      sha256: media.sha256,
      kind: media.kind
    }));
  }
  
  setValue(mediaRefs) {
    this.selectedMedias = mediaRefs || [];
    this.renderSelectedMedias();
    this.updateHiddenInputs();
    this.onMediaSelected(this.selectedMedias);
  }
  
  clear() {
    this.selectedMedias = [];
    this.renderSelectedMedias();
    this.updateHiddenInputs();
    this.onMediaSelected(this.selectedMedias);
  }
}

// Export for global use
if (typeof window !== 'undefined') {
  window.MultiMediaSelector = MultiMediaSelector;
}
