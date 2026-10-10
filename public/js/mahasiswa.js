/* ==========================================================================
   Halaman mahasiswa: dashboard, katalog, form dinamis, pengajuan, revisi, profil
   ========================================================================== */
(function () {
  'use strict';

  // ------------------------------------------------------- form dinamis (shared)
  function fieldOptions(field) {
    return (field.options || []).map((o) => (typeof o === 'object' && o !== null ? { value: o.value, label: o.label || o.value } : { value: o, label: o }));
  }

  function renderField(field, value) {
    const id = `field-${field.name}`;
    const required = field.required ? '<span class="req">*</span>' : '';
    const hint = field.minLength ? `<div class="hint">Minimal ${field.minLength} karakter.</div>` : '';
    const common = `id="${id}" name="${field.name}" data-field="${field.name}" ${field.required ? 'required' : ''}`;
    const val = value === undefined || value === null ? '' : App.escapeHtml(value);
    let control = '';

    if (field.type === 'textarea') {
      control = `<textarea ${common} placeholder="${App.escapeHtml(field.placeholder || '')}">${val}</textarea>`;
    } else if (field.type === 'select') {
      control = `<select ${common}>
        <option value="">-- Pilih ${App.escapeHtml(field.label)} --</option>
        ${fieldOptions(field)
          .map((o) => `<option value="${App.escapeHtml(o.value)}" ${String(value) === String(o.value) ? 'selected' : ''}>${App.escapeHtml(o.label)}</option>`)
          .join('')}
      </select>`;
    } else {
      const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : 'text';
      const attrs = [
        field.minLength ? `minlength="${field.minLength}"` : '',
        field.maxLength ? `maxlength="${field.maxLength}"` : '',
        field.type === 'number' && field.min !== undefined ? `min="${field.min}"` : '',
        field.type === 'number' && field.max !== undefined ? `max="${field.max}"` : '',
      ].join(' ');
      control = `<input type="${type}" ${common} ${attrs} value="${val}" placeholder="${App.escapeHtml(field.placeholder || '')}">`;
    }

    const wide = field.type === 'textarea' ? ' full' : '';
    return `<div class="form-group${wide}">
      <label for="${id}">${App.escapeHtml(field.label)} ${required}</label>
      ${control}
      ${hint}
      <div class="field-error hidden" data-error-for="${field.name}"></div>
    </div>`;
  }

  function renderDynamicForm(schema, values) {
    const fields = (schema || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    return `<div class="form-grid">${fields.map((f) => renderField(f, values ? values[f.name] : '')).join('')}</div>`;
  }

  function collectValues(form, schema) {
    const values = {};
    for (const field of schema || []) {
      const input = form.querySelector(`[data-field="${field.name}"]`);
      if (!input) continue;
      values[field.name] = input.value;
    }
    return values;
  }

  function clearFieldErrors(form) {
    form.querySelectorAll('.field-error').forEach((el) => {
      el.classList.add('hidden');
      el.textContent = '';
    });
    form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
  }

  function showFieldErrors(form, errors) {
    Object.entries(errors || {}).forEach(([name, message]) => {
      const errorEl = form.querySelector(`[data-error-for="${name}"]`);
      const input = form.querySelector(`[data-field="${name}"]`);
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
      }
      if (input) input.classList.add('has-error');
    });
  }

  /** Validasi cepat di klien (backend tetap memvalidasi ulang). */
  function clientValidate(form, schema) {
    const errors = {};
    for (const field of schema || []) {
      const input = form.querySelector(`[data-field="${field.name}"]`);
      if (!input) continue;
      const value = String(input.value || '').trim();
      if (field.required && !value) errors[field.name] = `${field.label} wajib diisi.`;
      else if (value && field.minLength && value.length < field.minLength) errors[field.name] = `${field.label} minimal ${field.minLength} karakter.`;
      else if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) errors[field.name] = `${field.label} harus berupa email valid.`;
    }

    const startKey = (schema || []).find((f) => f.type === 'date' && /mulai|awal|start/i.test(f.name));
    const endKey = (schema || []).find((f) => f.type === 'date' && /selesai|akhir|end/i.test(f.name));
    if (startKey && endKey) {
      const start = form.querySelector(`[data-field="${startKey.name}"]`)?.value;
      const end = form.querySelector(`[data-field="${endKey.name}"]`)?.value;
      if (start && end && end < start) errors[endKey.name] = 'Tanggal selesai tidak boleh lebih awal daripada tanggal mulai.';
    }
    return errors;
  }

  function renderRute(snapshot) {
    return `<ol style="margin:.3rem 0 .3rem 1.1rem;padding:0;font-size:.87rem">
      ${snapshot.map((s) => `<li>${App.escapeHtml(s.position_name)}${s.is_required === false || s.is_required === 0 ? ' <span class="badge badge-neutral">opsional</span>' : ''}</li>`).join('')}
    </ol>`;
  }

  function summaryTable(rows) {
    if (!rows || !rows.length) return '<p class="text-muted text-sm">Tidak ada data.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Isi</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${App.escapeHtml(r.label || r.name)}</td><td>${App.escapeHtml(r.value ?? '-')}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function payloadRows(detail) {
    const schema = detail.template?.form_schema || [];
    const payload = detail.pengajuan.payload_isian || {};
    const sorted = schema.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    return sorted.map((f) => ({ label: f.label, name: f.name, value: payload[f.name] }));
  }

  function statusCard(p) {
    return `<li>
      <div class="li-main">
        <div class="li-title">${App.escapeHtml(p.nama_surat)} ${App.statusBadge(p.status_pengajuan)}</div>
        <div class="li-meta">${App.escapeHtml(p.public_reference)} · diajukan ${App.formatDateTime(p.tanggal_diajukan)}${p.version_number > 1 ? ` · versi ${p.version_number}` : ''}</div>
      </div>
      <a class="btn btn-secondary btn-sm" href="/mahasiswa/pengajuan/${p.id}">Detail</a>
    </li>`;
  }

  function detailLinkPrefix() {
    return '/mahasiswa/pengajuan';
  }

  // ------------------------------------------------------------------ dashboard
  App.registerPage('mahasiswa-dashboard', async (content) => {
    const data = await App.get('/api/mahasiswa/dashboard');
    const r = data.ringkasan;
    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat is-info"><div class="stat-label">Total Pengajuan</div><div class="stat-value">${r.total}</div></div>
        <div class="stat is-info"><div class="stat-label">Menunggu Verifikasi</div><div class="stat-value">${r.menunggu_verifikasi}</div></div>
        <div class="stat is-warn"><div class="stat-label">Menunggu Persetujuan</div><div class="stat-value">${r.menunggu_persetujuan}</div></div>
        <div class="stat is-warn"><div class="stat-label">Perlu Revisi</div><div class="stat-value">${r.perlu_revisi}</div></div>
        <div class="stat is-ok"><div class="stat-label">Selesai</div><div class="stat-value">${r.selesai}</div></div>
        <div class="stat is-bad"><div class="stat-label">Ditolak</div><div class="stat-value">${r.ditolak}</div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Pengajuan Terbaru</h2><div class="spacer"></div>
            <a class="btn btn-sm" href="/mahasiswa/katalog">Ajukan Surat Baru</a></div>
          ${data.pengajuan_terbaru.length
            ? `<ul class="list-plain">${data.pengajuan_terbaru.map(statusCard).join('')}</ul>`
            : App.emptyState('Belum ada pengajuan', 'Ajukan surat pertama Anda melalui katalog surat.', '<a class="btn mt-2" href="/mahasiswa/katalog">Buka Katalog Surat</a>')}
        </div>
        <div class="card">
          <div class="card-head"><h2>Notifikasi</h2></div>
          <p class="text-muted text-sm">Anda memiliki <strong>${data.notifikasi_belum_dibaca}</strong> notifikasi belum dibaca.</p>
          <a class="btn btn-secondary btn-sm" href="/mahasiswa/notifikasi">Lihat notifikasi</a>
        </div>
      </div>`;
  });

  // ------------------------------------------------------------------ katalog
  App.registerPage('mahasiswa-katalog', async (content) => {
    const { templates } = await App.get('/api/mahasiswa/templates');
    if (!templates.length) {
      content.innerHTML = App.emptyState('Katalog kosong', 'Belum ada template surat aktif. Hubungi staf administrasi jurusan.');
      return;
    }
    content.innerHTML = `<div class="grid-2">
      ${templates
        .map(
          (t) => `<div class="card">
            <div class="card-head"><h2>${App.escapeHtml(t.nama_surat)}</h2><span class="badge badge-navy">${App.escapeHtml(t.kode)}</span></div>
            <p class="text-muted">${App.escapeHtml(t.deskripsi || '')}</p>
            <h3>Persyaratan</h3>
            <ul class="text-sm">${String(t.persyaratan || '-').split('\n').map((line) => `<li>${App.escapeHtml(line)}</li>`).join('')}</ul>
            <p class="text-sm text-muted">Jumlah data yang perlu diisi: ${(t.form_schema || []).length} field.</p>
            <div class="btn-row">
              <a class="btn" href="/mahasiswa/pengajuan-baru?template=${t.id}">Ajukan Surat</a>
              <button class="btn btn-secondary" data-syarat="${t.id}">Lihat Persyaratan</button>
            </div>
          </div>`
        )
        .join('')}
    </div>`;

    content.querySelectorAll('[data-syarat]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const data = await App.get(`/api/mahasiswa/templates/${btn.dataset.syarat}`);
        await App.confirmDialog({
          title: data.template.nama_surat,
          message: `Persyaratan: ${String(data.template.persyaratan || '-').replace(/\n/g, ' | ')}\n\nAlur persetujuan: ${data.rute_persetujuan.map((r) => `${r.urutan_ke}. ${r.position_name}`).join(' → ')}`,
          confirmLabel: 'Mengerti',
          cancelLabel: 'Tutup',
        });
      });
    });
  });

  // -------------------------------------------------------------- form pengajuan
  App.registerPage('mahasiswa-pengajuan-baru', async (content) => {
    const templateId = App.query('template');
    if (!templateId) {
      content.innerHTML = App.emptyState('Template belum dipilih', 'Pilih jenis surat terlebih dahulu dari katalog.', '<a class="btn mt-2" href="/mahasiswa/katalog">Buka Katalog</a>');
      return;
    }

    const data = await App.get(`/api/mahasiswa/templates/${templateId}`);
    const { template, rute_persetujuan } = data;

    content.innerHTML = `
      <div class="card card-accent">
        <div class="card-head"><h2>${App.escapeHtml(template.nama_surat)}</h2><span class="badge badge-navy">${App.escapeHtml(template.kode)}</span></div>
        <p class="text-muted">${App.escapeHtml(template.deskripsi || '')}</p>
        <div class="grid-2">
          <div>
            <h3>Persyaratan</h3>
            <ul class="text-sm">${String(template.persyaratan || '-').split('\n').map((l) => `<li>${App.escapeHtml(l)}</li>`).join('')}</ul>
          </div>
          <div>
            <h3>Alur Persetujuan</h3>
            ${renderRute(rute_persetujuan)}
            <p class="text-sm text-muted">Pengajuan diverifikasi staf administrasi terlebih dahulu, lalu disetujui berurutan sesuai rute di atas.</p>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Data Pengajuan</h2></div>
        <div id="form-alert"></div>
        <form id="pengajuan-form" novalidate>
          <div id="dynamic-fields"></div>
          <div class="btn-row mt-2">
            <button class="btn" type="submit" id="submit-pengajuan">Kirim Pengajuan</button>
            <a class="btn btn-secondary" href="/mahasiswa/katalog">Batal</a>
          </div>
          <p class="hint mt-1">Data akan diverifikasi staf administrasi. Anda dapat memantau status pada halaman Pengajuan Saya.</p>
        </form>
      </div>`;

    const form = content.querySelector('#pengajuan-form');
    content.querySelector('#dynamic-fields').innerHTML = renderDynamicForm(template.form_schema);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(form);
      const values = collectValues(form, template.form_schema);
      const clientErrors = clientValidate(form, template.form_schema);
      if (Object.keys(clientErrors).length) {
        showFieldErrors(form, clientErrors);
        App.error('Data belum lengkap', 'Periksa kembali field yang ditandai merah.');
        return;
      }

      const button = content.querySelector('#submit-pengajuan');
      button.disabled = true;
      button.textContent = 'Mengirim…';
      try {
        const result = await App.post('/api/mahasiswa/pengajuan', { template_id: Number(template.id), payload: values });
        App.success('Pengajuan terkirim', result.message);
        window.location.href = `/mahasiswa/pengajuan/${result.pengajuan.id}`;
      } catch (err) {
        if (err.details) showFieldErrors(form, err.details);
        content.querySelector('#form-alert').innerHTML = `<div class="alert alert-danger">${App.escapeHtml(err.message)}</div>`;
        App.error('Gagal mengirim', err.message);
        button.disabled = false;
        button.textContent = 'Kirim Pengajuan';
      }
    });
  });

  // -------------------------------------------------------------- daftar pengajuan
  App.registerPage('mahasiswa-pengajuan', async (content) => {
    const { pengajuan } = await App.get('/api/mahasiswa/pengajuan');
    const filters = [
      ['', 'Semua'],
      ['MENUNGGU_VERIFIKASI_STAF', 'Menunggu Verifikasi'],
      ['MENUNGGU_PERSETUJUAN', 'Menunggu Persetujuan'],
      ['PERLU_REVISI', 'Perlu Revisi'],
      ['SELESAI', 'Selesai'],
      ['DITOLAK', 'Ditolak'],
      ['KEDALUWARSA', 'Kedaluwarsa'],
      ['DIBATALKAN', 'Dibatalkan'],
    ];

    const render = (status) => {
      const rows = status ? pengajuan.filter((p) => p.status_pengajuan === status) : pengajuan;
      if (!rows.length) {
        return App.emptyState('Tidak ada pengajuan', status ? 'Tidak ada pengajuan dengan status tersebut.' : 'Anda belum membuat pengajuan surat.');
      }
      return `<div class="table-wrap"><table>
        <thead><tr><th>Referensi</th><th>Jenis Surat</th><th>Status</th><th>Versi</th><th>Diajukan</th><th>Aksi</th></tr></thead>
        <tbody>${rows
          .map(
            (p) => `<tr>
              <td><strong>${App.escapeHtml(p.public_reference)}</strong>${p.surat_number ? `<div class="li-meta">${App.escapeHtml(p.surat_number)}</div>` : ''}</td>
              <td>${App.escapeHtml(p.nama_surat)}</td>
              <td>${App.statusBadge(p.status_pengajuan)}${p.status_pengajuan === 'PERLU_REVISI' && p.deadline_revisi ? `<div class="li-meta">${App.relativeDeadline(p.deadline_revisi)}</div>` : ''}</td>
              <td>v${p.version_number}</td>
              <td>${App.formatDate(p.tanggal_diajukan)}</td>
              <td class="actions">
                <a class="btn btn-secondary btn-sm" href="${detailLinkPrefix()}/${p.id}">Detail</a>
                ${p.status_pengajuan === 'PERLU_REVISI' ? `<a class="btn btn-warning btn-sm" href="/mahasiswa/revisi/${p.id}">Perbaiki</a>` : ''}
              </td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;
    };

    content.innerHTML = `<div class="card">
      <div class="card-head"><h2>Daftar Pengajuan</h2><div class="spacer"></div><a class="btn btn-sm" href="/mahasiswa/katalog">Ajukan Surat Baru</a></div>
      <div class="pill-nav" id="filters">${filters.map(([value, label]) => `<button class="pill${value === '' ? ' active' : ''}" data-status="${value}">${label}</button>`).join('')}</div>
      <div id="table-area">${render('')}</div>
    </div>`;

    content.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        content.querySelectorAll('[data-status]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        content.querySelector('#table-area').innerHTML = render(btn.dataset.status);
      });
    });
  });

  // ------------------------------------------------------------------ detail
  async function renderDetail(content, id, { forRevision = false } = {}) {
    const detail = await App.get(`/api/surat/${id}`);
    const p = detail.pengajuan;
    const revisions = detail.revisions || [];
    const lastRevision = revisions.length ? revisions[revisions.length - 1] : null;
    const openRevision = revisions.find((r) => !r.resubmitted_at);

    const timeline = (detail.snapshot || [])
      .slice()
      .sort((a, b) => a.urutan_ke - b.urutan_ke)
      .map((step) => {
        const decision = (detail.approvals || [])
          .filter((a) => a.urutan_hierarki === step.urutan_ke && a.round_number === p.version_number)
          .sort((a, b) => b.id - a.id)[0];
        const cls = !decision || decision.status_persetujuan === 'MENUNGGU' ? 'is-wait' : decision.status_persetujuan === 'DISETUJUI' ? 'is-done' : decision.status_persetujuan === 'DITOLAK' ? 'is-reject' : '';
        return `<li class="${cls}">
          <div class="tl-title">${step.urutan_ke}. ${App.escapeHtml(step.position_name)} ${step.is_required ? '' : '<span class="badge badge-neutral">opsional</span>'}</div>
          <div class="tl-meta">${decision ? `${App.statusBadge(decision.status_persetujuan)} ${App.escapeHtml(decision.employee_name || '')} ${decision.waktu_diproses ? '· ' + App.formatDateTime(decision.waktu_diproses) : ''}` : 'Belum diproses'}</div>
          ${decision && decision.catatan ? `<div class="tl-meta">Catatan: ${App.escapeHtml(decision.catatan)}</div>` : ''}
        </li>`;
      })
      .join('');

    const staffDecision = (detail.approvals || []).find((a) => a.urutan_hierarki === 0 && a.round_number === p.version_number);

    content.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>${App.escapeHtml(p.nama_surat)}</h2>
          ${App.statusBadge(p.status_pengajuan)}
          <span class="badge badge-neutral">${App.escapeHtml(p.public_reference)}</span>
          <span class="badge badge-navy">versi ${p.version_number}</span>
          <div class="spacer"></div>
          <a class="btn btn-secondary btn-sm" href="/mahasiswa/pengajuan">Kembali</a>
        </div>
        <dl class="kv">
          <dt>Tanggal Diajukan</dt><dd>${App.formatDateTime(p.tanggal_diajukan)}</dd>
          <dt>Template</dt><dd>${App.escapeHtml(p.kode_template)} — ${App.escapeHtml(p.nama_surat)}</dd>
          ${p.surat_number ? `<dt>Nomor Surat</dt><dd><strong>${App.escapeHtml(p.surat_number)}</strong></dd>` : ''}
          ${p.issued_at ? `<dt>Tanggal Terbit</dt><dd>${App.formatDate(p.issued_at)}</dd>` : ''}
          ${p.deadline_revisi ? `<dt>Batas Revisi</dt><dd>${App.formatDateTime(p.deadline_revisi)} (${App.relativeDeadline(p.deadline_revisi)})</dd>` : ''}
        </dl>
        ${openRevision ? `<div class="alert alert-warning mt-2"><strong>Revisi diminta oleh ${App.escapeHtml(openRevision.requested_by_name || '-')}.</strong>
          <div>Alasan: ${App.escapeHtml(openRevision.revision_reason)}</div>
          <div class="text-sm">Diminta pada ${App.formatDateTime(openRevision.created_at)}</div></div>` : ''}
        ${p.status_pengajuan === 'DITOLAK' && staffDecision && staffDecision.catatan ? `<div class="alert alert-danger mt-2">Alasan penolakan: ${App.escapeHtml(staffDecision.catatan)}</div>` : ''}
        ${(() => {
          const rejection = (detail.approvals || []).find((a) => a.status_persetujuan === 'DITOLAK');
          return rejection ? `<div class="alert alert-danger mt-2"><strong>Ditolak oleh ${App.escapeHtml(rejection.employee_name || '-')}</strong> (${App.escapeHtml(rejection.employee_position || '')}).<div>Alasan: ${App.escapeHtml(rejection.catatan || '-')}</div></div>` : '';
        })()}
        ${p.pdf_status === 'FAILED' ? '<div class="alert alert-warning mt-2">Dokumen final gagal dibuat. Staf administrasi dapat mencoba ulang tanpa mengulang persetujuan.</div>' : ''}
        <div class="btn-row mt-2">
          ${p.status_pengajuan === 'SELESAI' ? `<a class="btn btn-success" href="/api/surat/${p.id}/pdf">Unduh PDF Final</a>` : ''}
          ${openRevision ? `<a class="btn btn-warning" href="/mahasiswa/revisi/${p.id}">Perbaiki Pengajuan</a>` : ''}
          ${['MENUNGGU_VERIFIKASI_STAF', 'PERLU_REVISI', 'MENUNGGU_PERSETUJUAN', 'DRAFT'].includes(p.status_pengajuan) ? '<button class="btn btn-secondary" id="cancel-btn">Batalkan Pengajuan</button>' : ''}
          ${p.pdf_status === 'FAILED' ? `<button class="btn btn-secondary" id="refresh-pdf">Cek Ulang Status Dokumen</button>` : ''}
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>Riwayat Persetujuan</h3></div>
          <ul class="timeline">
            <li class="${staffDecision ? (staffDecision.status_persetujuan === 'DILANJUTKAN' ? 'is-done' : 'is-reject') : 'is-wait'}">
              <div class="tl-title">Verifikasi Staf Administrasi</div>
              <div class="tl-meta">${staffDecision ? `${App.statusBadge(staffDecision.status_persetujuan)} ${App.escapeHtml(staffDecision.employee_name || '')} ${staffDecision.waktu_diproses ? '· ' + App.formatDateTime(staffDecision.waktu_diproses) : ''}` : 'Menunggu verifikasi'}</div>
              ${staffDecision && staffDecision.catatan ? `<div class="tl-meta">Catatan: ${App.escapeHtml(staffDecision.catatan)}</div>` : ''}
            </li>
            ${timeline}
          </ul>
        </div>
        <div class="card">
          <div class="card-head"><h3>Data Pengajuan</h3></div>
          ${summaryTable(payloadRows(detail))}
        </div>
      </div>

      ${revisions.length
        ? `<div class="card">
            <div class="card-head"><h3>Riwayat Versi & Revisi</h3></div>
            <ul class="list-plain">
              ${revisions
                .map(
                  (r) => `<li><div class="li-main">
                    <div class="li-title">Versi ${r.version_number} ${App.statusBadge('REVISI')}</div>
                    <div class="li-meta">Diminta oleh ${App.escapeHtml(r.requested_by_name || '-')} (${App.escapeHtml(r.requested_by_role || '-')}) pada ${App.formatDateTime(r.created_at)}</div>
                    <div>Alasan: ${App.escapeHtml(r.revision_reason)}</div>
                    <div class="li-meta">Dikirim ulang: ${r.resubmitted_at ? App.formatDateTime(r.resubmitted_at) : 'belum dikirim ulang'}</div>
                  </div></li>`
                )
                .join('')}
            </ul>
          </div>`
        : ''}

      <div class="card">
        <div class="card-head"><h3>Riwayat Peristiwa</h3></div>
        <ul class="timeline">
          ${(detail.events || []).map((e) => `<li><div class="tl-title">${App.escapeHtml(labelEvent(e.event_type))}</div><div class="tl-meta">${App.formatDateTime(e.created_at)}${e.actor_name ? ` · ${App.escapeHtml(e.actor_name)}` : ''}</div></li>`).join('')}
        </ul>
      </div>`;

    const cancelBtn = content.querySelector('#cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        const answer = await App.confirmDialog({
          title: 'Batalkan pengajuan',
          message: 'Pengajuan akan dihentikan dan tidak dapat dilanjutkan. Tindakan ini tercatat pada audit log.',
          confirmLabel: 'Batalkan',
          danger: true,
          requireReason: true,
          reasonLabel: 'Alasan pembatalan',
        });
        if (!answer.confirmed) return;
        await App.post(`/api/mahasiswa/pengajuan/${p.id}/cancel`, { alasan: answer.reason });
        App.success('Pengajuan dibatalkan', 'Status pengajuan menjadi DIBATALKAN.');
        renderDetail(content, id);
      });
    }
    const refreshBtn = content.querySelector('#refresh-pdf');
    if (refreshBtn) refreshBtn.addEventListener('click', () => renderDetail(content, id));

    if (forRevision) {
      const box = content.querySelector('.alert-warning');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function labelEvent(type) {
    const map = {
      PENGAJUAN_DIBUAT: 'Pengajuan dibuat',
      PENGAJUAN_DIKIRIM_ULANG: 'Pengajuan dikirim ulang',
      REVISI_DIMINTA: 'Revisi diminta',
      TAHAP_DIAKTIFKAN: 'Tahap persetujuan diaktifkan',
      TAHAP_DISETUJUI: 'Tahap disetujui',
      MENUNGGU_FINALISASI: 'Seluruh tahap wajib selesai',
      FINALISASI_DIMULAI: 'Pembuatan dokumen final dimulai',
      DOKUMEN_FINAL_DIBUAT: 'Dokumen final dibuat',
      FINALISASI_GAGAL: 'Pembuatan dokumen gagal',
      PENGAJUAN_DITOLAK: 'Pengajuan ditolak',
      PENGAJUAN_DIBATALKAN: 'Pengajuan dibatalkan',
      PENGAJUAN_KEDALUWARSA: 'Pengajuan kedaluwarsa',
      DOKUMEN_DIUNDUH: 'Dokumen diunduh',
    };
    return map[type] || type;
  }

  App.registerPage('mahasiswa-pengajuan-detail', async (content) => {
    const id = window.location.pathname.split('/').pop();
    await renderDetail(content, id);
  });

  // ------------------------------------------------------------------ revisi
  App.registerPage('mahasiswa-pengajuan-revisi', async (content) => {
    const id = window.location.pathname.split('/').pop();
    const detail = await App.get(`/api/surat/${id}`);
    const p = detail.pengajuan;
    const openRevision = (detail.revisions || []).find((r) => !r.resubmitted_at);

    if (p.status_pengajuan !== 'PERLU_REVISI' || !openRevision) {
      content.innerHTML = App.emptyState('Tidak ada revisi aktif', 'Pengajuan ini tidak sedang meminta revisi.', `<a class="btn mt-2" href="/mahasiswa/pengajuan/${id}">Lihat detail</a>`);
      return;
    }

    const schema = detail.template.form_schema;

    content.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Perbaiki Pengajuan</h2>${App.statusBadge('PERLU_REVISI')}<div class="spacer"></div>
          <span class="badge badge-navy">versi ${p.version_number}</span></div>
        <div class="alert alert-warning">
          <strong>Catatan revisi dari ${App.escapeHtml(openRevision.requested_by_name || '-')} (${App.escapeHtml(openRevision.requested_by_role || '-')})</strong>
          <div>${App.escapeHtml(openRevision.revision_reason)}</div>
          <div class="text-sm">Batas waktu: ${App.formatDateTime(p.deadline_revisi)} (${App.relativeDeadline(p.deadline_revisi)}) · ${detail.deadline_days} hari kalender sejak revisi diminta.</div>
        </div>
        <div class="alert alert-info text-sm">
          Setelah dikirim ulang, seluruh tahap persetujuan pejabat wajib dijalankan kembali. Riwayat persetujuan sebelumnya
          tetap tersimpan sebagai histori dan tidak dihapus. Data versi lama juga disimpan.
        </div>
        <div id="form-alert"></div>
        <form id="revisi-form" novalidate>
          <div id="dynamic-fields"></div>
          <div class="btn-row mt-2">
            <button class="btn" type="submit" id="submit-revisi">Kirim Ulang Pengajuan</button>
            <a class="btn btn-secondary" href="/mahasiswa/pengajuan/${id}">Lihat Detail</a>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-head"><h3>Riwayat Versi Sebelumnya</h3></div>
        <ul class="list-plain">
          ${(detail.revisions || [])
            .map(
              (r) => `<li><div class="li-main">
                <div class="li-title">Versi ${r.version_number}</div>
                <div class="li-meta">Diminta ${App.formatDateTime(r.created_at)} oleh ${App.escapeHtml(r.requested_by_name || '-')}</div>
                <div class="li-meta">Dikirim ulang: ${r.resubmitted_at ? App.formatDateTime(r.resubmitted_at) : 'belum'}</div>
              </div></li>`
            )
            .join('')}
        </ul>
      </div>`;

    const form = content.querySelector('#revisi-form');
    content.querySelector('#dynamic-fields').innerHTML = renderDynamicForm(schema, p.payload_isian || {});

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(form);
      const values = collectValues(form, schema);
      const errors = clientValidate(form, schema);
      if (Object.keys(errors).length) {
        showFieldErrors(form, errors);
        App.error('Data belum lengkap', 'Periksa kembali field yang ditandai merah.');
        return;
      }
      const button = content.querySelector('#submit-revisi');
      button.disabled = true;
      button.textContent = 'Mengirim…';
      try {
        const result = await App.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: values });
        App.success('Pengajuan dikirim ulang', result.message);
        window.location.href = `/mahasiswa/pengajuan/${id}`;
      } catch (err) {
        if (err.details) showFieldErrors(form, err.details);
        content.querySelector('#form-alert').innerHTML = `<div class="alert alert-danger">${App.escapeHtml(err.message)}</div>`;
        App.error('Gagal mengirim ulang', err.message);
        button.disabled = false;
        button.textContent = 'Kirim Ulang Pengajuan';
      }
    });
  });

  // ------------------------------------------------------------------ profil
  App.registerPage('mahasiswa-profil', async (content, user) => {
    const data = await App.get('/api/auth/profile');
    const u = data.user;
    content.innerHTML = `
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Data Akun</h2></div>
          <dl class="kv">
            <dt>Nama</dt><dd>${App.escapeHtml(u.full_name)}</dd>
            <dt>NIM</dt><dd>${App.escapeHtml(u.nim || '-')}</dd>
            <dt>Email</dt><dd>${App.escapeHtml(u.email)}</dd>
            <dt>Role</dt><dd>${App.escapeHtml(App.ROLE_LABEL[u.role] || u.role)}</dd>
            <dt>Program Studi</dt><dd>${App.escapeHtml(u.study_program || '-')}</dd>
          </dl>
          <p class="text-muted text-sm mt-2">Password tidak pernah ditampilkan atau dikirim ke browser; hanya hash bcrypt yang tersimpan di server.</p>
        </div>
        <div class="card">
          <div class="card-head"><h2>Perbarui Profil</h2></div>
          <div id="profile-alert"></div>
          <form id="profile-form" novalidate>
            <div class="form-group mb-2"><label for="full_name">Nama Lengkap</label><input id="full_name" value="${App.escapeHtml(u.full_name)}" required></div>
            <div class="form-group mb-2"><label for="study_program">Program Studi</label><input id="study_program" value="${App.escapeHtml(u.study_program || '')}" required></div>
            <div class="form-group mb-2"><label for="email">Email</label><input id="email" type="email" value="${App.escapeHtml(u.email)}" required></div>
            <button class="btn" type="submit">Simpan Perubahan</button>
          </form>
        </div>
      </div>`;

    const form = content.querySelector('#profile-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await App.put('/api/mahasiswa/profile', {
          full_name: form.full_name.value.trim(),
          study_program: form.study_program.value.trim(),
          email: form.email.value.trim(),
        });
        content.querySelector('#profile-alert').innerHTML = '<div class="alert alert-success">Profil berhasil diperbarui.</div>';
        App.success('Profil diperbarui', 'Perubahan telah disimpan di database.');
        App.refreshNotificationCount();
      } catch (err) {
        content.querySelector('#profile-alert').innerHTML = `<div class="alert alert-danger">${App.escapeHtml(err.message)}</div>`;
        App.error('Gagal menyimpan', err.message);
      }
    });
    void user;
  });
})();
