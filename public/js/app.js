/* ==========================================================================
   e-Office — runtime frontend bersama
   - Klien API dengan token CSRF
   - Layout (sidebar + topbar) + navigasi per role
   - Toast, modal konfirmasi, badge status, formatting tanggal Indonesia
   Seluruh keputusan otorisasi tetap divalidasi backend; kode di sini hanya
   mengatur tampilan.
   ========================================================================== */
(function () {
  'use strict';

  const State = { csrf: null, user: null, notifications: 0 };

  // ---------------------------------------------------------------- helpers
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function ensureCsrf() {
    if (State.csrf) return State.csrf;
    const res = await fetch('/api/csrf', { credentials: 'same-origin' });
    const data = await res.json();
    State.csrf = data.csrfToken;
    return State.csrf;
  }

  class ApiError extends Error {
    constructor(message, status, code, details) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details || null;
    }
  }

  async function api(method, url, body) {
    await ensureCsrf();
    const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['X-CSRF-Token'] = State.csrf;
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: 'Respons server tidak dapat dibaca.' };
      }
    }
    if (!res.ok) {
      const message = (data && data.error) || `Permintaan gagal (${res.status})`;
      if (res.status === 401) {
        // Sesi berakhir: kembali ke halaman login.
        setTimeout(() => { window.location.href = '/login?sesi=berakhir'; }, 900);
      }
      throw new ApiError(message, res.status, data && data.code, data && data.details);
    }
    if (data && data.csrfToken) State.csrf = data.csrfToken;
    return data;
  }

  const get = (url) => api('GET', url);
  const post = (url, body) => api('POST', url, body || {});
  const put = (url, body) => api('PUT', url, body || {});
  const patch = (url, body) => api('PATCH', url, body || {});

  // ------------------------------------------------------------------ toast
  function toast(kind, title, message) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.innerHTML = `<strong>${escapeHtml(title)}</strong>${message ? `<div>${escapeHtml(message)}</div>` : ''}`;
    container.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4200);
  }

  const success = (title, message) => toast('success', title, message);
  const error = (title, message) => toast('error', title, message);
  const info = (title, message) => toast('info', title, message);

  // ------------------------------------------------------------------ modal
  /**
   * Modal konfirmasi. `requireReason: true` menambahkan textarea wajib untuk
   * alasan (revisi/penolakan) — divalidasi lagi di backend.
   */
  function confirmDialog({ title, message, confirmLabel = 'Lanjutkan', cancelLabel = 'Batal', danger = false, requireReason = false, reasonLabel = 'Alasan' }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${escapeHtml(title)}</h3>
          <p class="text-muted">${escapeHtml(message || '')}</p>
          ${requireReason ? `<div class="form-group"><label for="modal-reason">${escapeHtml(reasonLabel)} <span class="req">*</span></label>
            <textarea id="modal-reason" placeholder="Tuliskan alasan secara jelas (minimal 5 karakter)"></textarea>
            <div class="field-error hidden" id="modal-reason-error">Alasan wajib diisi minimal 5 karakter.</div></div>` : ''}
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">${escapeHtml(cancelLabel)}</button>
            <button class="btn ${danger ? 'btn-danger' : ''}" data-act="confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const close = (result) => { backdrop.remove(); resolve(result); };
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close({ confirmed: false }); });
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => close({ confirmed: false }));
      backdrop.querySelector('[data-act="confirm"]').addEventListener('click', () => {
        if (requireReason) {
          const value = backdrop.querySelector('#modal-reason').value.trim();
          if (value.length < 5) {
            backdrop.querySelector('#modal-reason-error').classList.remove('hidden');
            return;
          }
          return close({ confirmed: true, reason: value });
        }
        return close({ confirmed: true });
      });
      if (requireReason) backdrop.querySelector('#modal-reason').focus();
    });
  }

  // ------------------------------------------------------------- formatting
  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

  function formatDate(value) {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    return `${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    const jam = String(d.getHours()).padStart(2, '0');
    const menit = String(d.getMinutes()).padStart(2, '0');
    return `${formatDate(value)}, ${jam}:${menit}`;
  }

  function relativeDeadline(value) {
    if (!value) return '';
    const diff = new Date(value).getTime() - Date.now();
    const hari = Math.ceil(diff / 86400000);
    if (hari < 0) return 'sudah lewat batas';
    if (hari === 0) return 'berakhir hari ini';
    return `${hari} hari tersisa`;
  }

  const STATUS_LABEL = {
    DRAFT: 'Draft',
    MENUNGGU_VERIFIKASI_STAF: 'Menunggu verifikasi staf',
    MENUNGGU_PERSETUJUAN: 'Menunggu persetujuan',
    PERLU_REVISI: 'Perlu revisi',
    DITOLAK: 'Ditolak',
    KEDALUWARSA: 'Kedaluwarsa',
    SELESAI: 'Selesai',
    DIBATALKAN: 'Dibatalkan',
    MENUNGGU: 'Menunggu',
    DISETUJUI: 'Disetujui',
    DILANJUTKAN: 'Diverifikasi',
    REVISI: 'Minta revisi',
    PENDING: 'Menunggu diproses',
    READY: 'Siap',
    FAILED: 'Gagal',
  };

  function statusBadge(status) {
    const map = {
      DRAFT: 'badge-neutral',
      MENUNGGU_VERIFIKASI_STAF: 'badge-info',
      MENUNGGU_PERSETUJUAN: 'badge-warning',
      PERLU_REVISI: 'badge-warning',
      DITOLAK: 'badge-danger',
      KEDALUWARSA: 'badge-danger',
      SELESAI: 'badge-success',
      DIBATALKAN: 'badge-neutral',
      MENUNGGU: 'badge-warning',
      DISETUJUI: 'badge-success',
      DILANJUTKAN: 'badge-success',
      REVISI: 'badge-warning',
      DIBATALKANX: 'badge-neutral',
    };
    return `<span class="badge ${map[status] || 'badge-neutral'}">${escapeHtml(STATUS_LABEL[status] || status || '-')}</span>`;
  }

  const statusLabel = (status) => STATUS_LABEL[status] || status || '-';
  const initials = (name) => String(name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  function loading(container, text) {
    if (container) container.innerHTML = `<div class="loading"><span class="spinner"></span> ${escapeHtml(text || 'Memuat data…')}</div>`;
  }

  function emptyState(title, message, actionHtml) {
    return `<div class="empty-state"><span class="empty-icon">🗂️</span><strong>${escapeHtml(title)}</strong>
      <p class="text-muted">${escapeHtml(message || '')}</p>${actionHtml || ''}</div>`;
  }

  function errorState(container, err) {
    const message = err && err.message ? err.message : 'Terjadi kesalahan.';
    container.innerHTML = `<div class="alert alert-danger"><strong>Tidak dapat memuat data.</strong><div>${escapeHtml(message)}</div></div>`;
  }

  // ------------------------------------------------------------------ layout
  const NAV = {
    MAHASISWA: [
      { group: 'Layanan Surat' },
      { href: '/mahasiswa/dashboard', label: 'Dashboard', icon: '📊' },
      { href: '/mahasiswa/katalog', label: 'Katalog Surat', icon: '📚' },
      { href: '/mahasiswa/pengajuan', label: 'Pengajuan Saya', icon: '🗂️' },
      { group: 'Akun' },
      { href: '/mahasiswa/notifikasi', label: 'Notifikasi', icon: '🔔', badge: 'notifications' },
      { href: '/mahasiswa/profil', label: 'Profil', icon: '👤' },
    ],
    STAF: [
      { group: 'Verifikasi' },
      { href: '/staf/dashboard', label: 'Dashboard', icon: '📊' },
      { href: '/staf/antrean', label: 'Antrean Verifikasi', icon: '📥' },
      { href: '/staf/proses', label: 'Menunggu Pejabat', icon: '⏳' },
      { group: 'Data Surat' },
      { href: '/staf/pengajuan', label: 'Semua Pengajuan', icon: '🗂️' },
      { group: 'Pengaturan' },
      { href: '/staf/template', label: 'Katalog Template', icon: '📚' },
      { href: '/staf/rute', label: 'Rute Approval', icon: '🔗' },
      { group: 'Lainnya' },
      { href: '/staf/laporan', label: 'Laporan', icon: '📈' },
      { href: '/staf/akun', label: 'Akun Pegawai', icon: '👥' },
      { href: '/staf/notifikasi', label: 'Notifikasi', icon: '🔔', badge: 'notifications' },
    ],
    PEJABAT: [
      { group: 'Persetujuan' },
      { href: '/pejabat/dashboard', label: 'Dashboard', icon: '📊' },
      { href: '/pejabat/antrean', label: 'Antrean Persetujuan', icon: '✍️' },
      { href: '/pejabat/riwayat', label: 'Riwayat Persetujuan', icon: '📜' },
      { group: 'Akun' },
      { href: '/pejabat/notifikasi', label: 'Notifikasi', icon: '🔔', badge: 'notifications' },
    ],
  };

  const ROLE_LABEL = { MAHASISWA: 'Mahasiswa', STAF: 'Staf Administrasi', PEJABAT: 'Pejabat Pemaraf' };
  const homeFor = (role) => (role === 'MAHASISWA' ? '/mahasiswa/dashboard' : role === 'STAF' ? '/staf/dashboard' : '/pejabat/dashboard');

  function buildNav(role, activePath) {
    const items = NAV[role] || [];
    return items
      .map((item) => {
        if (item.group) return `<div class="nav-group-title">${escapeHtml(item.group)}</div>`;
        const active = activePath === item.href || (item.href !== '/' && activePath.startsWith(item.href)) ? ' active' : '';
        const badge = item.badge && State[item.badge] ? `<span class="nav-count">${State[item.badge]}</span>` : '';
        return `<a class="nav-link${active}" href="${item.href}"><span class="nav-icon">${item.icon}</span><span>${escapeHtml(item.label)}</span>${badge}</a>`;
      })
      .join('');
  }

  async function mountLayout() {
    const app = document.getElementById('app');
    const partialRes = await fetch('/partials/layout', { credentials: 'same-origin' });
    if (!partialRes.ok) throw new Error('Gagal memuat kerangka halaman (layout).');
    const partial = await partialRes.text();
    if (!partial.trim()) throw new Error('Kerangka halaman kosong.');
    app.innerHTML = partial;

    const me = await get('/api/auth/me');
    if (!me.authenticated) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      return null;
    }
    State.user = me.user;

    const required = document.body.dataset.role;
    if (required && me.user.role !== required) {
      window.location.href = '/akses-ditolak';
      return null;
    }

    document.getElementById('nav-links').innerHTML = buildNav(me.user.role, window.location.pathname);
    document.getElementById('user-avatar').textContent = initials(me.user.full_name);
    document.getElementById('user-name').textContent = me.user.full_name;
    document.getElementById('user-role').textContent =
      `${ROLE_LABEL[me.user.role] || me.user.role}${me.user.position_name ? ' · ' + me.user.position_name : ''}`;
    document.getElementById('page-title').textContent = document.body.dataset.title || '';
    document.getElementById('page-subtitle').textContent = document.body.dataset.subtitle || '';

    const notifLink = document.getElementById('notif-link');
    if (notifLink) notifLink.href = `${homeFor(me.user.role).split('/').slice(0, 2).join('/')}/notifikasi`;

    document.getElementById('logout-btn').addEventListener('click', async () => {
      const answer = await confirmDialog({ title: 'Keluar dari aplikasi', message: 'Anda akan mengakhiri sesi ini.', confirmLabel: 'Keluar' });
      if (!answer.confirmed) return;
      try {
        await post('/api/auth/logout');
        window.location.href = '/login';
      } catch (err) {
        error('Gagal keluar', err.message);
      }
    });

    const toggle = document.getElementById('menu-toggle');
    const sidebar = document.getElementById('sidebar');
    if (toggle) {
      toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
      document.addEventListener('click', (e) => {
        if (window.innerWidth <= 900 && !sidebar.contains(e.target) && e.target !== toggle) sidebar.classList.remove('open');
      });
    }

    refreshNotificationCount();
    return me.user;
  }

  async function refreshNotificationCount() {
    try {
      const data = await get('/api/notifications');
      State.notifications = data.belum_dibaca;
      const badge = document.getElementById('notif-count');
      const navBadge = document.querySelector('.nav-link .nav-count');
      if (badge) {
        badge.textContent = data.belum_dibaca;
        badge.classList.toggle('hidden', data.belum_dibaca === 0);
      }
      if (navBadge) navBadge.textContent = data.belum_dibaca;
    } catch {
      /* senyap: penghitung notifikasi bukan fungsi kritis */
    }
  }

  // ------------------------------------------------------------------ pages
  const PAGES = {};
  function registerPage(name, handler) {
    PAGES[name] = handler;
  }

  /** Halaman notifikasi dipakai bersama oleh ketiga role. */
  async function renderNotifications(content) {
    loading(content, 'Memuat notifikasi…');
    const data = await get('/api/notifications');

    if (!data.notifications.length) {
      content.innerHTML = emptyState('Belum ada notifikasi', 'Notifikasi akan muncul ketika ada perubahan status pada pengajuan Anda.');
      return;
    }

    const linkFor = (id) => {
      if (!id) return null;
      const role = State.user.role;
      if (role === 'MAHASISWA') return `/mahasiswa/pengajuan/${id}`;
      if (role === 'STAF') return `/staf/pengajuan/${id}`;
      return `/pejabat/pengajuan/${id}`;
    };

    content.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>Notifikasi</h2>
          <span class="badge badge-info">${data.belum_dibaca} belum dibaca</span>
          <div class="spacer"></div>
          <button class="btn btn-secondary btn-sm" id="read-all" ${data.belum_dibaca ? '' : 'disabled'}>Tandai semua dibaca</button>
        </div>
        <ul class="list-plain">
          ${data.notifications
            .map((n) => {
              const href = linkFor(n.related_submission_id);
              return `<li data-notif="${n.id}">
                <div class="li-main">
                  <div class="li-title">${n.is_read ? '' : '<span class="badge badge-info">Baru</span> '}${escapeHtml(n.title)}</div>
                  <div>${escapeHtml(n.message)}</div>
                  <div class="li-meta">${formatDateTime(n.created_at)}</div>
                </div>
                <div class="btn-row">
                  ${href ? `<a class="btn btn-secondary btn-sm" href="${href}">Buka</a>` : ''}
                  ${n.is_read ? '' : `<button class="btn btn-ghost btn-sm" data-read="${n.id}">Tandai dibaca</button>`}
                </div>
              </li>`;
            })
            .join('')}
        </ul>
      </div>`;

    content.querySelectorAll('[data-read]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await post(`/api/notifications/${btn.dataset.read}/read`);
        renderNotifications(content);
        refreshNotificationCount();
      });
    });
    const all = content.querySelector('#read-all');
    if (all) {
      all.addEventListener('click', async () => {
        await post('/api/notifications/read-all');
        success('Selesai', 'Semua notifikasi ditandai sudah dibaca.');
        renderNotifications(content);
        refreshNotificationCount();
      });
    }
  }

  registerPage('notifikasi', (content) => renderNotifications(content));

  /** Mengubah status penyimpanan hash tanpa memuat ulang halaman. */
  function setQuery(params) {
    const url = new URL(window.location.href);
    Object.entries(params).forEach(([k, v]) => (v === null || v === undefined ? url.searchParams.delete(k) : url.searchParams.set(k, v)));
    window.history.replaceState({}, '', url);
  }

  const query = (name) => new URL(window.location.href).searchParams.get(name);

  // --------------------------------------------------------------------- init
  async function init() {
    const page = document.body.dataset.page;
    const isPublic = document.body.hasAttribute('data-public');

    if (isPublic) {
      if (PAGES[page]) await PAGES[page](null);
      return;
    }

    if (!page) return;
    try {
      const user = await mountLayout();
      if (!user) return;
      const content = document.getElementById('page-content');
      if (!content) return;
      if (PAGES[page]) await PAGES[page](content, user);
      else content.innerHTML = emptyState('Halaman belum tersedia', `Tidak ada penanganan untuk halaman "${page}".`);
    } catch (err) {
      const content = document.getElementById('page-content');
      if (content) errorState(content, err);
      else toast('error', 'Gagal memuat halaman', err.message);
    }
  }

  function redirectByRole() {
    get('/api/auth/me')
      .then((me) => {
        if (me.authenticated) window.location.href = homeFor(me.user.role);
        else window.location.href = '/login';
      })
      .catch(() => { window.location.href = '/login'; });
  }

  window.App = {
    api, get, post, put, patch, ApiError,
    toast, success, error, info, confirmDialog,
    escapeHtml, formatDate, formatDateTime, relativeDeadline,
    statusBadge, statusLabel, STATUS_LABEL, initials, loading, emptyState,
    registerPage, renderNotifications, refreshNotificationCount,
    query, setQuery, redirectByRole, refreshNotificationCount, State, homeFor, ROLE_LABEL,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
