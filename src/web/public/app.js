'use strict';

const apiBase = new URL('../api', window.location.href).href.replace(/\/$/, '');
const $ = (selector) => document.querySelector(selector);

const TYPE_LABEL = { tv: 'TV en vivo', movie: 'Películas', series: 'Series' };
let playlists = [];

const toast = (message, isError = false) => {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 4000);
};

const TOKEN_KEY = 'nuvio-iptv-token';
const getToken = () => window.localStorage.getItem(TOKEN_KEY) || '';

const request = (path, options) => {
  const token = getToken();
  return fetch(`${apiBase}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
};

const api = async (path, options = {}) => {
  let response = await request(path, options);
  if (response.status === 401) {
    const token = window.prompt('Este addon está protegido. Introduce el ADMIN_TOKEN:', getToken());
    if (!token) throw new Error('No autorizado');
    window.localStorage.setItem(TOKEN_KEY, token.trim());
    response = await request(path, options);
    if (response.status === 401) {
      window.localStorage.removeItem(TOKEN_KEY);
      throw new Error('Token incorrecto');
    }
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);
  return payload;
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
};

const formatNumber = (value) => new Intl.NumberFormat('es-ES').format(value || 0);

const statusBadge = (playlist) => {
  if (playlist.syncing) return { text: 'sincronizando…', className: 'warn' };
  switch (playlist.lastSyncStatus) {
    case 'ok':
      return { text: 'sincronizada', className: 'ok' };
    case 'unchanged':
      return { text: 'sin cambios', className: 'ok' };
    case 'error':
      return { text: 'error', className: 'err' };
    default:
      return { text: 'pendiente', className: '' };
  }
};

const expiryBadge = (playlist) => {
  if (playlist.daysUntilExpiry === null || playlist.daysUntilExpiry === undefined) return null;
  if (playlist.daysUntilExpiry < 0) return { text: 'vencida', className: 'err' };
  if (playlist.daysUntilExpiry <= 7) return { text: `vence en ${playlist.daysUntilExpiry} d`, className: 'warn' };
  return { text: `vence en ${playlist.daysUntilExpiry} d`, className: '' };
};

const badge = (spec) => {
  if (!spec) return '';
  return `<span class="badge ${spec.className}">${spec.text}</span>`;
};

const renderCard = (playlist) => {
  const card = document.createElement('div');
  card.className = `card${playlist.enabled ? '' : ' disabled'}`;
  card.draggable = true;
  card.dataset.id = playlist.id;

  const resources = playlist.resources.length
    ? playlist.resources
        .map(
          (resource) =>
            `<div class="resource"><b>${formatNumber(resource.items)}</b> ${TYPE_LABEL[resource.type] || resource.type} · ${formatNumber(resource.groups)} grupos</div>`
        )
        .join('')
    : '<div class="resource">Sin recursos todavía</div>';

  card.innerHTML = `
    <div class="card-head">
      <span class="drag" title="Arrastrar para reordenar">⠿</span>
      <button class="move" data-action="up" title="Subir">↑</button>
      <button class="move" data-action="down" title="Bajar">↓</button>
      <span class="card-title">${playlist.name}</span>
      <span class="badge">${playlist.kind}</span>
      ${badge(statusBadge(playlist))}
      ${badge(expiryBadge(playlist))}
      <span class="spacer"></span>
      <label class="switch"><input type="checkbox" data-action="toggle" ${playlist.enabled ? 'checked' : ''} /> visible en Nuvio</label>
    </div>
    <div class="resources">${resources}</div>
    <div class="meta">
      <span>Total: <b>${formatNumber(playlist.totalItems)}</b></span>
      <span>Última sincronización: <b>${formatDate(playlist.lastSyncAt)}</b></span>
      <span>Duración: <b>${playlist.lastSyncDurationMs ? `${(playlist.lastSyncDurationMs / 1000).toFixed(1)} s` : '—'}</b></span>
      <span>Descargado: <b>${playlist.bytesDownloaded ? `${(playlist.bytesDownloaded / 1048576).toFixed(1)} MB` : '—'}</b></span>
      <span>Refresco: <b>${playlist.refreshHours} h</b></span>
      <span>Vencimiento: <b>${playlist.expiresAt ? formatDate(playlist.expiresAt) : '—'}</b></span>
    </div>
    ${playlist.lastSyncError ? `<div class="error">${playlist.lastSyncError}</div>` : ''}
    <div class="actions">
      <button data-action="sync">Sincronizar</button>
      <button data-action="force">Forzar recarga</button>
      <label class="switch">Refresco (h)<input type="number" min="0" step="0.5" value="${playlist.refreshHours}" data-action="refresh-hours" style="width:80px" /></label>
      <label class="switch">Vence<input type="date" value="${playlist.expiresAt ? playlist.expiresAt.slice(0, 10) : ''}" data-action="expires" /></label>
      <span class="spacer"></span>
      <button class="danger" data-action="delete">Eliminar</button>
    </div>
  `;

  card.addEventListener('change', async (event) => {
    const action = event.target.dataset.action;
    if (!action) return;
    try {
      if (action === 'toggle') await patch(playlist.id, { enabled: event.target.checked });
      if (action === 'refresh-hours') await patch(playlist.id, { refreshHours: Number(event.target.value) });
      if (action === 'expires') await patch(playlist.id, { expiresAt: event.target.value || null });
    } catch (error) {
      toast(error.message, true);
    }
  });

  card.addEventListener('click', async (event) => {
    const action = event.target.dataset.action;
    if (!action) return;
    try {
      if (action === 'sync' || action === 'force') {
        event.target.disabled = true;
        toast(`Sincronizando ${playlist.name}…`);
        const result = await api(`/playlists/${playlist.id}/sync`, {
          method: 'POST',
          body: { force: action === 'force' },
        });
        toast(`${playlist.name}: ${result.result.items} elementos en ${(result.result.durationMs / 1000).toFixed(1)} s`);
        await refresh();
      }
      if (action === 'up' || action === 'down') {
        await move(playlist.id, action === 'up' ? -1 : 1);
      }
      if (action === 'delete' && confirm(`¿Eliminar "${playlist.name}"?`)) {
        await api(`/playlists/${playlist.id}`, { method: 'DELETE' });
        await refresh();
      }
    } catch (error) {
      toast(error.message, true);
      await refresh();
    }
  });

  return card;
};

const patch = async (id, body) => {
  await api(`/playlists/${id}`, { method: 'PATCH', body });
  await refresh();
};

const move = async (id, delta) => {
  const ids = playlists.map((playlist) => playlist.id);
  const index = ids.indexOf(id);
  const target = index + delta;
  if (target < 0 || target >= ids.length) return;
  ids.splice(target, 0, ids.splice(index, 1)[0]);
  await api('/playlists/reorder', { method: 'POST', body: { ids } });
  await refresh();
};

let draggedId = null;

const attachDragHandlers = (container) => {
  container.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
    draggedId = Number(card.dataset.id);
    card.classList.add('dragging');
  });

  container.addEventListener('dragend', (event) => {
    const card = event.target.closest('.card');
    if (card) card.classList.remove('dragging');
    container.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  });

  container.addEventListener('dragover', (event) => {
    event.preventDefault();
    const card = event.target.closest('.card');
    container.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    if (card) card.classList.add('drop-target');
  });

  container.addEventListener('drop', async (event) => {
    event.preventDefault();
    const card = event.target.closest('.card');
    if (!card || draggedId === null) return;
    const targetId = Number(card.dataset.id);
    if (targetId === draggedId) return;
    const ids = playlists.map((playlist) => playlist.id).filter((id) => id !== draggedId);
    ids.splice(ids.indexOf(targetId), 0, draggedId);
    draggedId = null;
    try {
      await api('/playlists/reorder', { method: 'POST', body: { ids } });
      await refresh();
    } catch (error) {
      toast(error.message, true);
    }
  });
};

const renderTmdb = (status) => {
  const badge = $('#tmdb-badge');
  const statusEl = $('#tmdb-status');
  if (!status.configured) {
    badge.textContent = 'sin configurar';
    badge.className = 'badge warn';
    statusEl.innerHTML = '<div class="error">Añade <b>TMDB_API_KEY</b> o <b>TMDB_ACCESS_TOKEN</b> en las variables de entorno del servidor.</div>';
    $('#enrich-tmdb').disabled = true;
    return;
  }
  badge.textContent = 'activo';
  badge.className = 'badge ok';
  $('#enrich-tmdb').disabled = false;
  const rows = status.totals.length
    ? status.totals.map((row) => `<div class="tmdb-row"><span>${TYPE_LABEL[row.type] || row.type}</span><b>${formatNumber(row.matched)} / ${formatNumber(row.total)}</b></div>`).join('')
    : '<span class="hint">Todavía no hay películas o series indexadas.</span>';
  statusEl.innerHTML = `<div class="tmdb-grid">${rows}</div><div class="hint">Idiomas: ${status.languages.join(', ')} · máximo por sincronización: ${formatNumber(status.maxMatchesPerSync)}</div>`;
};

const renderStats = (stats) => {
  $('#stats').innerHTML = `
    <div class="stat"><b>${formatNumber(stats.totalItems)}</b><span>elementos indexados</span></div>
    <div class="stat"><b>${stats.enabledPlaylists}/${stats.playlists}</b><span>listas visibles</span></div>
    ${stats.totals
      .map((row) => `<div class="stat"><b>${formatNumber(row.items)}</b><span>${TYPE_LABEL[row.type] || row.type}</span></div>`)
      .join('')}
    <div class="stat"><b>${(stats.cache.hitRate * 100).toFixed(1)}%</b><span>aciertos de caché (${stats.cache.entries})</span></div>
    <div class="stat"><b>${stats.memoryMb} MB</b><span>memoria del proceso</span></div>
  `;
};

const refresh = async () => {
  const [listResponse, stats, tmdb] = await Promise.all([api('/playlists'), api('/stats'), api('/tmdb')]);
  playlists = listResponse.playlists;
  const container = $('#playlists');
  container.innerHTML = '';
  if (!playlists.length) {
    container.innerHTML = '<p class="hint">Todavía no hay listas. Añade la primera en el panel de la derecha.</p>';
  }
  playlists.forEach((playlist) => container.appendChild(renderCard(playlist)));
  renderStats(stats);
  renderTmdb(tmdb);
};

$('#enrich-tmdb').addEventListener('click', async (event) => {
  event.target.disabled = true;
  toast('Actualizando asociaciones TMDb…');
  try {
    await api('/tmdb/enrich', { method: 'POST', body: {} });
    toast('Asociaciones TMDb actualizadas');
    await refresh();
  } catch (error) {
    toast(error.message, true);
    await refresh();
  }
});

$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = Object.fromEntries([...form.entries()].filter(([, value]) => value !== ''));
  if (body.refreshHours) body.refresh_hours = Number(body.refreshHours);
  if (body.expiresAt) body.expires_at = new Date(body.expiresAt).toISOString();
  if (body.userAgent) body.user_agent = body.userAgent;
  try {
    await api('/playlists', { method: 'POST', body });
    event.target.reset();
    toast('Lista añadida, sincronizando en segundo plano…');
    await refresh();
    setTimeout(refresh, 5000);
  } catch (error) {
    toast(error.message, true);
  }
});

$('#copy-manifest').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#manifest-url').value);
    toast('Manifest copiado');
  } catch {
    toast('Copia manualmente la URL', true);
  }
});

$('#manifest-url').value = new URL('../manifest.json', window.location.href).href;
attachDragHandlers($('#playlists'));
refresh().catch((error) => toast(error.message, true));
setInterval(() => refresh().catch(() => {}), 30000);
