/* ==========================================================================
   Halaman staf administrasi
   ========================================================================== */
(function () {
  'use strict';

  // ------------------------------------------------------------- dialog pilihan
  function choiceDialog({ title, message, options, reasonFor = null, reasonLabel = 'Alasan', confirmLabel = 'Kirim' }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${App.escapeHtml(title)}</h3>
          <p class="text-muted">${App.escapeHtml(message || '')}</p>
          <div class="form-group mb-2">
            ${options
              .map(
                (o, i) => `<label class="checkbox-row"><input type="radio" name="pilihan" value="${o.value}" ${i === 0 ? 'checked' : ''} data-reason="${o.requireReason ? '1' : '0'}"> <span>${App.escapeHtml(o.label)}</span></label>`
              )
              .join('')}
          </div>
          <div class="form-group hidden" id="reason-wrap">
            <label for="decision-reason">${App.escapeHtml(reasonLabel)} <span class="req">*</span></label>
            <textarea id="decision-reason" placeholder="Minimal 5 karakter"></textarea>
            <div class="field-error hidden" id="reason-error">Alasan wajib diisi minimal 5 karakter.</div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">Batal</button>
            <button class="btn" data-act="confirm">${App.escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const reasonWrap = backdrop.querySelector('#reason-wrap');
      const radios = [...backdrop.querySelectorAll('input[name="pilihan"]')];
      const sync = () => {
        const selected = radios.find((r) => r.checked);
        reasonWrap.classList.toggle('hidden', !selected || selected.dataset.reason !== '1');
      };
      radios.forEach((r) => r.addEventListener('change', sync));
      sync();

      const close = (result) => { backdrop.remove(); resolve(result); };
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => close({ confirmed: false }));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close({ confirmed: false }); });
      backdrop.querySelector('[data-act="confirm"]').addEventListener('click', () => {
        const selected = radios.find((r) => r.checked);
        const value = selected ? selected.value : null;
        if (!value) return;
        if (selected.dataset.reason === '1') {
          const reason = backdrop.querySelector('#decision-reason').value.trim();
          if (reason.length < 5) {
            backdrop.querySelector('#reason-error').classList.remove('hidden');
            return;
          }
          return close({ confirmed: true, value, reason });
        }
        return close({ confirmed: true, value, reason: null });
      });
    });
    void reasonFor;
  }

  function summary(p) {
    return {
      id: p.id,
      referensi: p.public_reference,
      nama_surat: p.nama_surat,
      mahasiswa: p.student_name,
      nim: p.student_nim,
      prodi: p.study_program,
      status: p.status_pengajuan,
      versi: p.version_number,
      diajukan: p.submitted_at || p.tanggal_diajukan,
      deadline: p.deadline_revisi,
      surat_number: p.surat_number,
      pdf_status: p.pdf_status,
    };
  }

  function queueTable(rows, emptyTitle, withActions = true) {
    if (!rows.length) return App.emptyState(emptyTitle, 'Daftar ini akan terisi otomatis ketika ada pengajuan.');
    return `<div class="table-wrap"><table>
      <thead><tr><th>Referensi</th><th>Mahasiswa</th><th>Jenis Surat</th><th>Status</th><th>Diajukan</th><th>Aksi</th></tr></thead>
      <tbody>${rows
        .map(
          (raw) => {
            const p = summary(raw);
            return `<tr>
              <td><strong>${App.escapeHtml(p.referensi)}</strong>${p.surat_number ? `<div class="li-meta">${App.escapeHtml(p.surat_number)}</div>` : ''}</td>
              <td>${App.escapeHtml(p.mahasiswa)}<div class="li-meta">${App.escapeHtml(p.nim || '')}</div></td>
              <td>${App.escapeHtml(p.nama_surat)}</td>
              <td>${App.statusBadge(p.status)}${p.status === 'PERLU_REVISI' && p.deadline ? `<div class="li-meta">${App.relativeDeadline(p.deadline)}</div>` : ''}</td>
              <td>${App.formatDate(p.diajukan)}</td>
              <td class="actions">
                <a class="btn btn-secondary btn-sm" href="/staf/pengajuan/${p.id}">Detail</a>
                ${withActions && p.status === 'MENUNGGU_VERIFIKASI_STAF' ? `<button class="btn btn-sm" data-verify="${p.id}">Verifikasi</button>` : ''}
                ${withActions && p.pdf_status === 'FAILED' ? `<button class="btn btn-warning btn-sm" data-retry="${p.id}">Buat Ulang PDF</button>` : ''}
              </td>
            </tr>`;
          }
        )
        .join('')}</tbody></table></div>`;
  }

  function bindRowActions(content, refresh) {
    content.querySelectorAll('[data-verify]').forEach((btn) => {
      btn.addEventListener('click', () => verifySubmission(content, btn.dataset.verify, refresh));
    });
    content.querySelectorAll('[data-retry]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Memproses…';
        try {
          const res = await App.post(`/api/staf/pengajuan/${btn.dataset.retry}/retry-pdf`);
          App.success('Dokumen dibuat', `Nomor surat: ${res.surat_number}`);
          refresh();
        } catch (err) {
          App.error('Gagal membuat dokumen', err.message);
          btn.disabled = false;
          btn.textContent = 'Buat Ulang PDF';
        }
      });
    });
  }

  async function verifySubmission(content, id, refresh) {
    const detail = await App.get(`/api/surat/${id}`);
    const p = detail.pengajuan;
    const answer = await choiceDialog({
      title: `Verifikasi ${p.public_reference}`,
      message: `${p.nama_surat} dari ${p.student_name} (${p.student_nim}). Periksa kelengkapan dan konsistensi data pada halaman detail.`,
      options: [
        { value: 'LANJUT', label: 'Data lengkap — setujui verifikasi dan teruskan ke pejabat' },
        { value: 'REVISI', label: 'Perlu perbaikan — minta revisi kepada mahasiswa', requireReason: true },
      ],
      reasonLabel: 'Alasan revisi',
      confirmLabel: 'Kirim Keputusan',
    });
    if (!answer.confirmed) return;

    try {
      const res = await App.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: answer.value, catatan: answer.reason || '' });
      App.success('Keputusan tersimpan', res.message);
      if (refresh) refresh();
    } catch (err) {
      App.error('Gagal menyimpan keputusan', err.message);
    }
    void content;
  }

  // ------------------------------------------------------------------ dashboard
  App.registerPage('staf-dashboard', async (content) => {
    const data = await App.get('/api/staf/dashboard');
    const r = data.ringkasan;
    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat is-warn"><div class="stat-label">Antrean Verifikasi</div><div class="stat-value">${r.antrean_verifikasi}</div><div class="stat-note">Perlu tindakan Anda</div></div>
        <div class="stat is-warn"><div class="stat-label">Perlu Revisi</div><div class="stat-value">${r.perlu_revisi}</div></div>
        <div class="stat is-info"><div class="stat-label">Menunggu Pejabat</div><div class="stat-value">${r.menunggu_persetujuan}</div></div>
        <div class="stat is-ok"><div class="stat-label">Selesai</div><div class="stat-value">${r.selesai}</div></div>
        <div class="stat is-bad"><div class="stat-label">Ditolak</div><div class="stat-value">${r.ditolak}</div></div>
        <div class="stat is-bad"><div class="stat-label">Kedaluwarsa</div><div class="stat-value">${r.kedaluwarsa}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Antrean Verifikasi</h2><div class="spacer"></div>
          <button class="btn btn-secondary btn-sm" id="run-expiry">Periksa Kedaluwarsa Revisi</button>
          <a class="btn btn-sm" href="/staf/antrean">Lihat Semua Antrean</a></div>
        <div id="queue">${queueTable(data.antrean_verifikasi, 'Tidak ada pengajuan yang menunggu verifikasi')}</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Pengajuan Terbaru</h2></div>
        ${queueTable(data.pengajuan_terbaru, 'Belum ada pengajuan', false)}
      </div>`;

    const reload = () => window.location.reload();
    bindRowActions(content.querySelector('#queue'), reload);
    const expiry = content.querySelector('#run-expiry');
    expiry.addEventListener('click', async () => {
      const res = await App.post('/api/staf/expiry-check');
      App.success('Pemeriksaan selesai', res.message);
      setTimeout(() => window.location.reload(), 700);
    });
  });

  // ------------------------------------------------------------------ antrean
  App.registerPage('staf-antrean', async (content) => {
    const render = async () => {
      const { pengajuan } = await App.get('/api/staf/antrean');
      content.querySelector('#queue').innerHTML = queueTable(pengajuan, 'Tidak ada pengajuan yang menunggu verifikasi');
      bindRowActions(content.querySelector('#queue'), render);
      content.querySelector('#count').textContent = pengajuan.length;
    };

    content.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Antrean Verifikasi Administratif</h2><span class="badge badge-warning" id="count">0</span></div>
        <p class="text-muted text-sm">Verifikasi memeriksa kelengkapan dan konsistensi data. Bila data perlu diperbaiki, minta revisi dengan alasan yang jelas.</p>
        <div id="queue"><div class="loading"><span class="spinner"></span> Memuat…</div></div>
      </div>`;
    await render();
  });

  // ------------------------------------------------------------------ menunggu pejabat
  App.registerPage('staf-proses', async (content) => {
    const render = async () => {
      const { pengajuan } = await App.get('/api/staf/proses');
      content.querySelector('#queue').innerHTML = queueTable(pengajuan, 'Tidak ada pengajuan yang menunggu pejabat');
      bindRowActions(content.querySelector('#queue'), render);
    };
    content.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Pengajuan Menunggu Keputusan Pejabat</h2></div>
        <p class="text-muted text-sm">Staf memantau proses; keputusan persetujuan tetap menjadi kewenangan pejabat yang ditugaskan.
        Bila pembuatan PDF gagal, gunakan tombol <em>Buat Ulang PDF</em> — tidak perlu mengulang persetujuan.</p>
        <div id="queue"><div class="loading"><span class="spinner"></span> Memuat…</div></div>
      </div>`;
    await render();
  });

  // ------------------------------------------------------------------ semua pengajuan
  App.registerPage('staf-pengajuan', async (content) => {
    const statuses = ['', 'MENUNGGU_VERIFIKASI_STAF', 'MENUNGGU_PERSETUJUAN', 'PERLU_REVISI', 'SELESAI', 'DITOLAK', 'KEDALUWARSA', 'DIBATALKAN'];
    content.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Semua Pengajuan</h2><div class="spacer"></div>
          <input type="search" id="search" placeholder="Cari referensi / nama / NIM" style="max-width:260px">
        </div>
        <div class="pill-nav" id="filters">
          ${statuses.map((s) => `<button class="pill${s === '' ? ' active' : ''}" data-status="${s}">${s === '' ? 'Semua' : App.statusLabel(s)}</button>`).join('')}
        </div>
        <div id="table-area"><div class="loading"><span class="spinner"></span> Memuat…</div></div>
      </div>`;

    const load = async () => {
      const status = content.querySelector('.pill.active')?.dataset.status || '';
      const q = content.querySelector('#search').value.trim();
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      const { pengajuan } = await App.get(`/api/staf/pengajuan?${params.toString()}`);
      const area = content.querySelector('#table-area');
      area.innerHTML = queueTable(pengajuan, 'Tidak ada pengajuan sesuai filter');
      bindRowActions(area, load);
    };

    content.querySelectorAll('[data-status]').forEach((btn) =>
      btn.addEventListener('click', () => {
        content.querySelectorAll('[data-status]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        load();
      })
    );
    let timer = null;
    content.querySelector('#search').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(load, 350);
    });
    await load();
  });

  // ------------------------------------------------------------------ detail
  App.registerPage('staf-detail', async (content) => {
    const id = window.location.pathname.split('/').pop();

    const render = async () => {
      const detail = await App.get(`/api/staf/pengajuan/${id}/detail`);
      const p = detail.pengajuan;
      const schema = detail.template?.form_schema || [];
      const payloadRows = schema
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((f) => ({ label: f.label, value: (p.payload_isian || {})[f.name] }));

      const staffRow = detail.approvals.find((a) => a.urutan_hierarki === 0 && a.round_number === p.version_number);

      content.innerHTML = `
        <div class="card">
          <div class="card-head">
            <h2>${App.escapeHtml(p.nama_surat)}</h2>${App.statusBadge(p.status_pengajuan)}
            <span class="badge badge-neutral">${App.escapeHtml(p.public_reference)}</span>
            <span class="badge badge-navy">versi ${p.version_number}</span>
            <div class="spacer"></div>
            <a class="btn btn-secondary btn-sm" href="/staf/pengajuan">Kembali</a>
          </div>
          <dl class="kv">
            <dt>Mahasiswa</dt><dd>${App.escapeHtml(p.student_name)} (${App.escapeHtml(p.student_nim)})</dd>
            <dt>Program Studi</dt><dd>${App.escapeHtml(p.study_program || '-')}</dd>
            <dt>Template</dt><dd>${App.escapeHtml(p.template_kode)}</dd>
            <dt>Diajukan</dt><dd>${App.formatDateTime(p.submitted_at)}</dd>
            ${p.surat_number ? `<dt>Nomor Surat</dt><dd><strong>${App.escapeHtml(p.surat_number)}</strong></dd>` : ''}
            ${p.pdf_status ? `<dt>Status Dokumen</dt><dd>${App.statusBadge(p.pdf_status)} ${p.pdf_last_error ? App.escapeHtml(p.pdf_last_error) : ''}</dd>` : ''}
          </dl>
          <div class="btn-row mt-2">
            ${p.status_pengajuan === 'MENUNGGU_VERIFIKASI_STAF' ? '<button class="btn" id="btn-verify">Verifikasi Pengajuan</button>' : ''}
            ${p.status_pengajuan === 'MENUNGGU_PERSETUJUAN' ? '<button class="btn btn-warning" id="btn-retry">Buat Ulang Dokumen Final</button>' : ''}
            ${p.status_pengajuan === 'SELESAI' ? `<a class="btn btn-success" href="/api/surat/${p.id}/pdf">Unduh PDF Final</a>` : ''}
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-head"><h3>Data Isian Mahasiswa</h3></div>
            <div class="table-wrap"><table><thead><tr><th>Data</th><th>Isi</th></tr></thead><tbody>
              ${payloadRows.map((r) => `<tr><td>${App.escapeHtml(r.label)}</td><td>${App.escapeHtml(r.value ?? '-')}</td></tr>`).join('')}
            </tbody></table></div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Rute Persetujuan (snapshot)</h3></div>
            <ul class="timeline">
              <li class="${staffRow ? 'is-done' : 'is-wait'}">
                <div class="tl-title">Verifikasi Staf Administrasi</div>
                <div class="tl-meta">${staffRow ? `${App.statusBadge(staffRow.status_persetujuan)} ${App.escapeHtml(staffRow.employee_name || '')} · ${App.formatDateTime(staffRow.waktu_diproses)}` : 'Menunggu verifikasi'}</div>
                ${staffRow && staffRow.catatan ? `<div class="tl-meta">Catatan: ${App.escapeHtml(staffRow.catatan)}</div>` : ''}
              </li>
              ${detail.snapshot
                .map((step) => {
                  const decision = detail.approvals
                    .filter((a) => a.urutan_hierarki === step.urutan_ke && a.round_number === p.version_number)
                    .sort((a, b) => b.id - a.id)[0];
                  const cls = !decision || decision.status_persetujuan === 'MENUNGGU' ? 'is-wait' : decision.status_persetujuan === 'DISETUJUI' ? 'is-done' : decision.status_persetujuan === 'DITOLAK' ? 'is-reject' : '';
                  return `<li class="${cls}">
                    <div class="tl-title">${step.urutan_ke}. ${App.escapeHtml(step.position_name)}</div>
                    <div class="tl-meta">Penugasan: ${App.escapeHtml(step.assigned_employee_name || 'belum ditugaskan')}</div>
                    ${decision ? `<div class="tl-meta">${App.statusBadge(decision.status_persetujuan)} ${decision.waktu_diproses ? App.formatDateTime(decision.waktu_diproses) : ''}</div>${decision.catatan ? `<div class="tl-meta">Catatan: ${App.escapeHtml(decision.catatan)}</div>` : ''}` : ''}
                  </li>`;
                })
                .join('')}
            </ul>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Riwayat Versi & Revisi</h3></div>
          ${detail.revisions.length
            ? `<ul class="list-plain">${detail.revisions
                .map(
                  (r) => `<li><div class="li-main"><div class="li-title">Versi ${r.version_number} — ${App.statusBadge('REVISI')}</div>
                    <div>Alasan: ${App.escapeHtml(r.revision_reason)}</div>
                    <div class="li-meta">Diminta oleh ${App.escapeHtml(r.requested_by_name || '-')} (${App.escapeHtml(r.requested_by_role || '-')}) pada ${App.formatDateTime(r.created_at)} · dikirim ulang: ${r.resubmitted_at ? App.formatDateTime(r.resubmitted_at) : 'belum'}</div>
                  </div></li>`
                )
                .join('')}</ul>`
            : '<p class="text-muted text-sm">Belum ada revisi pada pengajuan ini.</p>'}
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-head"><h3>Audit Log</h3></div>
            <ul class="list-plain">
              ${detail.audit
                .slice()
                .reverse()
                .map((a) => `<li><div class="li-main"><div class="li-title">${App.escapeHtml(a.action)}</div>
                  <div class="li-meta">${App.formatDateTime(a.created_at)} · ${App.escapeHtml(a.actor_name || 'sistem')}</div></div></li>`)
                .join('') || '<li>Belum ada catatan audit.</li>'}
            </ul>
          </div>
          <div class="card">
            <div class="card-head"><h3>Peristiwa Dokumen</h3></div>
            <ul class="tl-list timeline">
              ${detail.events.map((e) => `<li><div class="tl-title">${App.escapeHtml(e.event_type)}</div><div class="tl-meta">${App.formatDateTime(e.created_at)}${e.actor_name ? ` · ${App.escapeHtml(e.actor_name)}` : ''}</div></li>`).join('')}
            </ul>
          </div>
        </div>`;

      const verifyBtn = content.querySelector('#btn-verify');
      if (verifyBtn) verifyBtn.addEventListener('click', () => verifySubmission(content, id, render));

      const retry = content.querySelector('#btn-retry');
      if (retry) {
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          try {
            const res = await App.post(`/api/staf/pengajuan/${id}/retry-pdf`);
            App.success('Dokumen final dibuat', `Nomor surat: ${res.surat_number}`);
          } catch (err) {
            App.error('Finalisasi gagal', err.message);
          }
          await render();
        });
      }
    };

    await render();
  });

  // ------------------------------------------------------------------ template
  App.registerPage('staf-template', async (content) => {
    const TYPES = ['text', 'textarea', 'date', 'email', 'tel', 'number', 'select'];

    const schemaEditor = (fields) => `
      <div class="table-wrap"><table id="schema-table" style="min-width:760px">
        <thead><tr><th>Nama field</th><th>Label</th><th>Tipe</th><th>Wajib</th><th>Opsi (pisahkan koma, untuk select)</th><th></th></tr></thead>
        <tbody>
          ${fields
            .map(
              (f, i) => `<tr data-row="${i}">
                <td><input data-k="name" value="${App.escapeHtml(f.name || '')}" placeholder="judul_penelitian"></td>
                <td><input data-k="label" value="${App.escapeHtml(f.label || '')}" placeholder="Judul Penelitian"></td>
                <td><select data-k="type">${TYPES.map((t) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
                <td><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''}></td>
                <td><input data-k="options" value="${App.escapeHtml((f.options || []).map((o) => (typeof o === 'object' ? o.value : o)).join(', '))}"></td>
                <td><button type="button" class="btn btn-danger btn-sm" data-remove="${i}">Hapus</button></td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table></div>
      <button type="button" class="btn btn-secondary btn-sm mt-1" id="add-field">Tambah Field</button>`;

    const collectSchema = (root) =>
      [...root.querySelectorAll('#schema-table tbody tr')]
        .map((tr) => {
          const name = tr.querySelector('[data-k="name"]').value.trim();
          const label = tr.querySelector('[data-k="label"]').value.trim();
          const type = tr.querySelector('[data-k="type"]').value;
          const required = tr.querySelector('[data-k="required"]').checked;
          const optionsRaw = tr.querySelector('[data-k="options"]').value.trim();
          if (!name) return null;
          const field = { name, label: label || name, type, required };
          if (type === 'select' && optionsRaw) {
            field.options = optionsRaw.split(',').map((v) => ({ value: v.trim(), label: v.trim() })).filter((o) => o.value);
          }
          return field;
        })
        .filter(Boolean);

    const bindEditor = (root) => {
      root.querySelector('#add-field')?.addEventListener('click', () => {
        const tbody = root.querySelector('#schema-table tbody');
        const index = tbody.querySelectorAll('tr').length;
        tbody.insertAdjacentHTML(
          'beforeend',
          `<tr data-row="${index}"><td><input data-k="name" placeholder="nama_field"></td><td><input data-k="label" placeholder="Label"></td>
           <td><select data-k="type">${TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select></td>
           <td><input type="checkbox" data-k="required"></td><td><input data-k="options"></td>
           <td><button type="button" class="btn btn-danger btn-sm" data-remove="${index}">Hapus</button></td></tr>`
        );
        bindEditor(root);
      });
      root.querySelectorAll('[data-remove]').forEach((btn) =>
        btn.addEventListener('click', () => {
          btn.closest('tr').remove();
          bindEditor(root);
        })
      );
    };

    const openForm = (template) => {
      const isNew = !template;
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" style="width:min(960px,100%)">
          <h3>${isNew ? 'Template Surat Baru' : `Edit ${App.escapeHtml(template.nama_surat)}`}</h3>
          <div id="tpl-alert"></div>
          <div class="form-group mb-2"><label>Kode Template ${isNew ? '<span class="req">*</span>' : ''}</label>
            <input id="tpl-kode" value="${App.escapeHtml(template?.kode || '')}" ${isNew ? '' : 'disabled'} placeholder="SIP"></div>
          <div class="form-group mb-2"><label>Nama Surat <span class="req">*</span></label><input id="tpl-nama" value="${App.escapeHtml(template?.nama_surat || '')}"></div>
          <div class="form-group mb-2"><label>Deskripsi</label><textarea id="tpl-deskripsi">${App.escapeHtml(template?.deskripsi || '')}</textarea></div>
          <div class="form-group mb-2"><label>Persyaratan (satu per baris)</label><textarea id="tpl-persyaratan">${App.escapeHtml(template?.persyaratan || '')}</textarea></div>
          <div class="checkbox-row mb-2"><input type="checkbox" id="tpl-active" ${template && !template.is_active ? '' : 'checked'}> <span>Aktif (dapat diajukan mahasiswa)</span></div>
          <h4>Skema Form Dinamis</h4>
          ${schemaEditor(template?.form_schema || [{ name: '', label: '', type: 'text', required: true }])}
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">Batal</button>
            <button class="btn" data-act="save">Simpan</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      bindEditor(backdrop);

      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => backdrop.remove());
      backdrop.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const body = {
          nama_surat: backdrop.querySelector('#tpl-nama').value.trim(),
          deskripsi: backdrop.querySelector('#tpl-deskripsi').value.trim(),
          persyaratan: backdrop.querySelector('#tpl-persyaratan').value.trim(),
          is_active: backdrop.querySelector('#tpl-active').checked,
          form_schema: collectSchema(backdrop),
        };
        try {
          if (isNew) {
            body.kode = backdrop.querySelector('#tpl-kode').value.trim();
            await App.post('/api/staf/templates', body);
          } else {
            await App.put(`/api/staf/templates/${template.id}`, body);
          }
          App.success('Tersimpan', 'Template surat berhasil disimpan.');
          backdrop.remove();
          load();
        } catch (err) {
          const details = err.details ? `<ul>${Object.values(err.details).map((m) => `<li>${App.escapeHtml(m)}</li>`).join('')}</ul>` : '';
          backdrop.querySelector('#tpl-alert').innerHTML = `<div class="alert alert-danger">${App.escapeHtml(err.message)}${details}</div>`;
        }
      });
    };

    const load = async () => {
      const { templates } = await App.get('/api/staf/templates');
      content.querySelector('#list').innerHTML = templates.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Kode</th><th>Nama Surat</th><th>Field</th><th>Tahap</th><th>Status</th><th>Aksi</th></tr></thead>
            <tbody>${templates
              .map(
                (t) => `<tr>
                  <td><span class="badge badge-navy">${App.escapeHtml(t.kode)}</span></td>
                  <td>${App.escapeHtml(t.nama_surat)}<div class="li-meta">${App.escapeHtml((t.deskripsi || '').slice(0, 90))}</div></td>
                  <td>${t.form_schema.length}</td>
                  <td>${t.rute.length ? t.rute.map((r) => App.escapeHtml(r.position_name)).join(' → ') : '<span class="badge badge-danger">belum ada rute</span>'}</td>
                  <td>${t.is_active ? '<span class="badge badge-success">Aktif</span>' : '<span class="badge badge-neutral">Nonaktif</span>'}</td>
                  <td class="actions">
                    <button class="btn btn-secondary btn-sm" data-edit="${t.id}">Edit</button>
                    <a class="btn btn-ghost btn-sm" href="/staf/rute?template=${t.id}">Atur Rute</a>
                  </td>
                </tr>`
              )
              .join('')}</tbody></table></div>`
        : App.emptyState('Belum ada template', 'Tambahkan template surat pertama.');

      content.querySelectorAll('[data-edit]').forEach((btn) =>
        btn.addEventListener('click', () => openForm(templates.find((t) => String(t.id) === btn.dataset.edit)))
      );
    };

    content.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Katalog Template Surat</h2><div class="spacer"></div>
          <button class="btn" id="new-template">Template Baru</button></div>
        <p class="text-muted text-sm">Perubahan skema form dan rute hanya memengaruhi pengajuan baru. Pengajuan yang sedang berjalan
        tetap memakai snapshot rute saat pengajuan dibuat. Field wajib yang sudah dipakai tidak dapat dihapus.</p>
        <div id="list"><div class="loading"><span class="spinner"></span> Memuat…</div></div>
      </div>`;

    content.querySelector('#new-template').addEventListener('click', () => openForm(null));
    await load();
  });

  // ------------------------------------------------------------------ rute
  App.registerPage('staf-rute', async (content) => {
    const [{ templates }, { positions }] = await Promise.all([App.get('/api/staf/templates'), App.get('/api/staf/positions')]);
    const selectedId = App.query('template') || (templates[0] && String(templates[0].id));

    let steps = [];

    content.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Rute Persetujuan</h2></div>
        <div class="form-group mb-2" style="max-width:420px">
          <label for="template-select">Pilih Template Surat</label>
          <select id="template-select">${templates.map((t) => `<option value="${t.id}" ${String(t.id) === String(selectedId) ? 'selected' : ''}>${App.escapeHtml(t.kode)} — ${App.escapeHtml(t.nama_surat)}</option>`).join('')}</select>
        </div>
        <div id="route-alert"></div>
        <div id="route-area"></div>
      </div>`;

    const renderSteps = () => {
      content.querySelector('#route-area').innerHTML = `
        <div class="table-wrap"><table style="min-width:760px">
          <thead><tr><th>#</th><th>Jabatan</th><th>Pejabat Ditugaskan</th><th>Wajib</th><th>Aksi</th></tr></thead>
          <tbody>
            ${steps
              .map((s, i) => {
                const position = positions.find((p) => String(p.id) === String(s.position_id));
                const officials = position ? position.pejabat : [];
                return `<tr>
                  <td>${i + 1}</td>
                  <td><select data-step="${i}" data-k="position_id">
                    <option value="">-- pilih jabatan --</option>
                    ${positions.map((p) => `<option value="${p.id}" ${String(p.id) === String(s.position_id) ? 'selected' : ''}>${App.escapeHtml(p.position_name)}</option>`).join('')}
                  </select></td>
                  <td><select data-step="${i}" data-k="assigned_employee_id">
                    <option value="">Otomatis (pejabat aktif pertama)</option>
                    ${officials.map((o) => `<option value="${o.id}" ${String(o.id) === String(s.assigned_employee_id) ? 'selected' : ''}>${App.escapeHtml(o.full_name)}</option>`).join('')}
                  </select></td>
                  <td><input type="checkbox" data-step="${i}" data-k="is_required" ${s.is_required === 0 || s.is_required === false ? '' : 'checked'}></td>
                  <td class="actions">
                    <button class="btn btn-secondary btn-sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
                    <button class="btn btn-secondary btn-sm" data-down="${i}" ${i === steps.length - 1 ? 'disabled' : ''}>↓</button>
                    <button class="btn btn-danger btn-sm" data-del="${i}">Hapus</button>
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table></div>
        <div class="btn-row mt-2">
          <button class="btn btn-secondary" id="add-step">Tambah Tahap</button>
          <button class="btn" id="save-routes">Simpan Rute</button>
        </div>
        <p class="hint mt-1">Urutan tahap menentukan alur persetujuan berjenjang. Pejabat yang tidak ditugaskan pada sebuah tahap
        tidak dapat memproses surat tersebut — divalidasi di backend.</p>`;

      content.querySelectorAll('[data-k]').forEach((input) => {
        input.addEventListener('change', () => {
          const index = Number(input.dataset.step);
          const key = input.dataset.k;
          steps[index][key] = key === 'is_required' ? input.checked : input.value;
          if (key === 'position_id') steps[index].assigned_employee_id = '';
          renderSteps();
        });
      });
      content.querySelectorAll('[data-up]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.up);
          [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
          renderSteps();
        })
      );
      content.querySelectorAll('[data-down]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.down);
          [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
          renderSteps();
        })
      );
      content.querySelectorAll('[data-del]').forEach((btn) =>
        btn.addEventListener('click', () => {
          steps.splice(Number(btn.dataset.del), 1);
          renderSteps();
        })
      );
      content.querySelector('#add-step').addEventListener('click', () => {
        steps.push({ position_id: '', assigned_employee_id: '', is_required: 1 });
        renderSteps();
      });
      content.querySelector('#save-routes').addEventListener('click', async () => {
        const payload = steps
          .filter((s) => s.position_id)
          .map((s) => ({ position_id: Number(s.position_id), assigned_employee_id: s.assigned_employee_id ? Number(s.assigned_employee_id) : null, is_required: s.is_required ? 1 : 0 }));
        try {
          await App.put(`/api/staf/templates/${content.querySelector('#template-select').value}`, { routes: payload });
          App.success('Rute disimpan', 'Rute baru berlaku untuk pengajuan berikutnya. Pengajuan berjalan tetap memakai snapshot lamanya.');
          loadTemplate(content.querySelector('#template-select').value);
        } catch (err) {
          const details = err.details ? `<ul>${Object.values(err.details).map((m) => `<li>${App.escapeHtml(m)}</li>`).join('')}</ul>` : '';
          content.querySelector('#route-alert').innerHTML = `<div class="alert alert-danger">${App.escapeHtml(err.message)}${details}</div>`;
        }
      });
    };

    const loadTemplate = (id) => {
      const template = templates.find((t) => String(t.id) === String(id));
      steps = template.rute.map((r) => ({ position_id: r.position_id, assigned_employee_id: r.assigned_employee_id || '', is_required: r.is_required }));
      content.querySelector('#route-alert').innerHTML = '';
      App.setQuery({ template: id });
      renderSteps();
    };

    content.querySelector('#template-select').addEventListener('change', (e) => loadTemplate(e.target.value));
    loadTemplate(selectedId);
  });

  // ------------------------------------------------------------------ laporan
  App.registerPage('staf-laporan', async (content) => {
    const data = await App.get('/api/staf/laporan');
    const ring = data.ringkasan;
    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat is-info"><div class="stat-label">Total Pengajuan</div><div class="stat-value">${ring.total}</div></div>
        <div class="stat is-ok"><div class="stat-label">Selesai</div><div class="stat-value">${ring.total_selesai}</div></div>
        <div class="stat is-warn"><div class="stat-label">Antrean Pejabat</div><div class="stat-value">${ring.antrean_pejabat_aktif}</div></div>
        <div class="stat is-info"><div class="stat-label">Rata-rata Penyelesaian</div><div class="stat-value">${ring.rata_rata_hari_penyelesaian}</div><div class="stat-note">hari kalender</div></div>
        <div class="stat"><div class="stat-label">Staf</div><div class="stat-value">${ring.jumlah_staf}</div></div>
        <div class="stat"><div class="stat-label">Pejabat</div><div class="stat-value">${ring.jumlah_pejabat}</div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>Jumlah per Status</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Status</th><th>Jumlah</th></tr></thead><tbody>
            ${Object.entries(ring.per_status).map(([s, n]) => `<tr><td>${App.statusBadge(s)}</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="2">Belum ada data</td></tr>'}
          </tbody></table></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Jumlah per Jenis Surat</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Jenis Surat</th><th>Total</th><th>Selesai</th></tr></thead><tbody>
            ${data.per_template.map((t) => `<tr><td>${App.escapeHtml(t.nama_surat)}</td><td>${t.total}</td><td>${t.selesai}</td></tr>`).join('') || '<tr><td colspan="3">Belum ada data</td></tr>'}
          </tbody></table></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Dokumen Selesai Terbaru</h3></div>
        ${data.dokumen_terbaru.length
          ? `<div class="table-wrap"><table><thead><tr><th>Nomor Surat</th><th>Jenis</th><th>Mahasiswa</th><th>Selesai</th></tr></thead><tbody>
            ${data.dokumen_terbaru.map((d) => `<tr><td>${App.escapeHtml(d.surat_number || '-')}</td><td>${App.escapeHtml(d.nama_surat)}</td><td>${App.escapeHtml(d.student_name)}</td><td>${App.formatDateTime(d.completed_at)}</td></tr>`).join('')}
          </tbody></table></div>`
          : '<p class="text-muted text-sm">Belum ada dokumen final.</p>'}
      </div>
      <div class="card">
        <div class="card-head"><h3>Audit Log Terbaru</h3></div>
        <div id="audit"><div class="loading"><span class="spinner"></span> Memuat…</div></div>
      </div>`;

    const { audit } = await App.get('/api/staf/audit');
    content.querySelector('#audit').innerHTML = audit.length
      ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Aktor</th><th>Tindakan</th><th>Pengajuan</th></tr></thead><tbody>
        ${audit
          .slice(0, 60)
          .map((a) => `<tr><td>${App.formatDateTime(a.created_at)}</td><td>${App.escapeHtml(a.actor_name || 'sistem')} <span class="li-meta">${App.escapeHtml(a.actor_role || '')}</span></td><td>${App.escapeHtml(a.action)}</td><td>${a.submission_id ? `<a href="/staf/pengajuan/${a.submission_id}">#${a.submission_id}</a>` : '-'}</td></tr>`)
          .join('')}
      </tbody></table></div>`
      : '<p class="text-muted text-sm">Belum ada catatan audit.</p>';
  });

  // ------------------------------------------------------------------ akun pegawai
  App.registerPage('staf-akun', async (content) => {
    content.innerHTML = `
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Buat Akun Pegawai</h2></div>
          <p class="text-muted text-sm">Akun staf dan pejabat tidak dapat dibuat melalui registrasi publik.</p>
          <div id="acc-alert"></div>
          <form id="account-form">
            <div class="form-group mb-2"><label>Nama Lengkap</label><input id="full_name" required></div>
            <div class="form-group mb-2"><label>NIP / NIDN</label><input id="employee_id" required></div>
            <div class="form-group mb-2"><label>Email</label><input id="email" type="email" required></div>
            <div class="form-group mb-2"><label>Password</label><input id="password" type="password" placeholder="Minimal 8 karakter" required></div>
            <div class="form-group mb-2"><label>Role</label><select id="role"><option value="STAF">Staf Administrasi</option><option value="PEJABAT">Pejabat Pemaraf</option></select></div>
            <div class="form-group mb-2 hidden" id="position-wrap"><label>Jabatan</label><select id="position_id"></select></div>
            <button class="btn" type="submit">Buat Akun</button>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><h2>Daftar Akun</h2><div class="spacer"></div>
            <select id="role-filter" style="max-width:200px">
              <option value="">Semua role</option><option value="STAF">Staf</option><option value="PEJABAT">Pejabat</option><option value="MAHASISWA">Mahasiswa</option>
            </select></div>
          <div id="user-list"><div class="loading"><span class="spinner"></span> Memuat…</div></div>
        </div>
      </div>`;

    const { positions } = await App.get('/api/staf/positions');
    const positionSelect = content.querySelector('#position_id');
    positionSelect.innerHTML = positions.map((p) => `<option value="${p.id}">${App.escapeHtml(p.position_name)}</option>`).join('');

    content.querySelector('#role').addEventListener('change', (e) => {
      content.querySelector('#position-wrap').classList.toggle('hidden', e.target.value !== 'PEJABAT');
    });

    const loadUsers = async () => {
      const role = content.querySelector('#role-filter').value;
      const { users } = await App.get(`/api/admin/users${role ? `?role=${role}` : ''}`);
      content.querySelector('#user-list').innerHTML = users.length
        ? `<div class="table-wrap"><table><thead><tr><th>Nama</th><th>Role</th><th>Identitas</th><th>Status</th><th>Aksi</th></tr></thead><tbody>
            ${users
              .map(
                (u) => `<tr>
                  <td>${App.escapeHtml(u.full_name)}<div class="li-meta">${App.escapeHtml(u.email)}</div></td>
                  <td>${App.escapeHtml(u.role)}${u.position_name ? `<div class="li-meta">${App.escapeHtml(u.position_name)}</div>` : ''}</td>
                  <td>${App.escapeHtml(u.nim || u.employee_id || '-')}</td>
                  <td>${u.is_active ? '<span class="badge badge-success">Aktif</span>' : '<span class="badge badge-neutral">Nonaktif</span>'}</td>
                  <td class="actions"><button class="btn btn-secondary btn-sm" data-toggle="${u.id}" data-active="${u.is_active ? '1' : '0'}">${u.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button></td>
                </tr>`
              )
              .join('')}</tbody></table></div>`
        : App.emptyState('Tidak ada akun', 'Belum ada akun untuk filter ini.');

      content.querySelectorAll('[data-toggle]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          await App.patch(`/api/admin/users/${btn.dataset.toggle}/status`, { is_active: btn.dataset.active !== '1' });
          App.success('Status diubah', 'Perubahan status akun tersimpan.');
          loadUsers();
        })
      );
    };

    content.querySelector('#role-filter').addEventListener('change', loadUsers);

    content.querySelector('#account-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      try {
        await App.post('/api/admin/users', {
          full_name: form.full_name.value.trim(),
          employee_id: form.employee_id.value.trim(),
          email: form.email.value.trim(),
          password: form.password.value,
          role: form.role.value,
          position_id: form.role.value === 'PEJABAT' ? Number(form.position_id.value) : undefined,
        });
        App.success('Akun dibuat', 'Akun pegawai berhasil ditambahkan.');
        form.reset();
        loadUsers();
      } catch (err) {
        const details = err.details ? `<ul>${Object.values(err.details).map((m) => `<li>${App.escapeHtml(m)}</li>`).join('')}</ul>` : '';
        content.querySelector('#acc-alert').innerHTML = `<div class="alert alert-danger">${App.escapeHtml(err.message)}${details}</div>`;
      }
    });

    await loadUsers();
  });
})();
