/* ==========================================================================
   Halaman pejabat pemaraf (dosen pembimbing, ketua jurusan, wakil dekan)
   ========================================================================== */
(function () {
  'use strict';

  function decisionDialog({ title, message, options, reasonLabel, confirmLabel, preset = null }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${App.escapeHtml(title)}</h3>
          <p class="text-muted">${App.escapeHtml(message || '')}</p>
          <div class="form-group mb-2">
            ${options
              .map((o, i) => {
                const checked = preset ? o.value === preset : i === 0;
                return `<label class="checkbox-row"><input type="radio" name="keputusan" value="${o.value}" ${checked ? 'checked' : ''} data-reason="${o.requireReason ? '1' : '0'}">
                  <span>${App.escapeHtml(o.label)}</span></label>`;
              })
              .join('')}
          </div>
          <div class="form-group hidden" id="reason-wrap">
            <label for="decision-reason">${App.escapeHtml(reasonLabel)} <span class="req">*</span></label>
            <textarea id="decision-reason" placeholder="Tulis alasan yang akan dilihat mahasiswa (minimal 5 karakter)"></textarea>
            <div class="field-error hidden" id="reason-error">Alasan wajib diisi minimal 5 karakter.</div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">Batal</button>
            <button class="btn" data-act="confirm">${App.escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const reasonWrap = backdrop.querySelector('#reason-wrap');
      const radios = [...backdrop.querySelectorAll('input[name="keputusan"]')];
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
        if (!selected) return;
        if (selected.dataset.reason === '1') {
          const reason = backdrop.querySelector('#decision-reason').value.trim();
          if (reason.length < 5) {
            backdrop.querySelector('#reason-error').classList.remove('hidden');
            return;
          }
          return close({ confirmed: true, value: selected.value, reason });
        }
        return close({ confirmed: true, value: selected.value, reason: null });
      });
    });
  }

  function queueTable(rows, emptyTitle) {
    if (!rows.length) return App.emptyState(emptyTitle, 'Tidak ada surat yang menunggu keputusan Anda saat ini.');
    return `<div class="table-wrap"><table>
      <thead><tr><th>Referensi</th><th>Mahasiswa</th><th>Jenis Surat</th><th>Diajukan</th><th>Aksi</th></tr></thead>
      <tbody>${rows
        .map(
          (p) => `<tr>
            <td><strong>${App.escapeHtml(p.public_reference)}</strong><div class="li-meta">versi ${p.version_number}</div></td>
            <td>${App.escapeHtml(p.student_name)}<div class="li-meta">${App.escapeHtml(p.student_nim || '')} · ${App.escapeHtml(p.study_program || '')}</div></td>
            <td>${App.escapeHtml(p.nama_surat)}</td>
            <td>${App.formatDateTime(p.submitted_at)}</td>
            <td class="actions">
              <a class="btn btn-secondary btn-sm" href="/pejabat/pengajuan/${p.id}">Buka</a>
              <button class="btn btn-sm" data-decide="${p.id}">Beri Keputusan</button>
            </td>
          </tr>`
        )
        .join('')}</tbody></table></div>`;
  }

  async function decide(id, { after }) {
    const detail = await App.get(`/api/surat/${id}`);
    const p = detail.pengajuan;
    const answer = await decisionDialog({
      title: `Keputusan untuk ${p.public_reference}`,
      message: `${p.nama_surat} — ${p.student_name} (${p.student_nim}). Keputusan Anda menjadi bagian dari alur persetujuan berjenjang yang sah.`,
      options: [
        { value: 'SETUJU', label: 'Setujui dan teruskan ke tahap berikutnya' },
        { value: 'REVISI', label: 'Minta revisi kepada mahasiswa', requireReason: true },
        { value: 'TOLAK', label: 'Tolak pengajuan secara permanen', requireReason: true },
      ],
      reasonLabel: 'Alasan (wajib, terlihat oleh mahasiswa)',
      confirmLabel: 'Kirim Keputusan',
    });
    if (!answer.confirmed) return;

    try {
      const res = await App.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: answer.value, catatan: answer.reason || '' });
      App.success('Keputusan tersimpan', res.message);
      if (after) after();
      else window.location.reload();
    } catch (err) {
      App.error('Keputusan gagal disimpan', err.message);
    }
  }

  // ------------------------------------------------------------------ dashboard
  App.registerPage('pejabat-dashboard', async (content) => {
    const data = await App.get('/api/pejabat/dashboard');
    const r = data.ringkasan;
    content.innerHTML = `
      ${data.jabatan ? `<div class="alert alert-info">Anda bertindak sebagai <strong>${App.escapeHtml(data.jabatan)}</strong>. Anda hanya dapat memproses surat yang menunggu keputusan pada tahap ini.</div>` : ''}
      <div class="stat-grid">
        <div class="stat is-warn"><div class="stat-label">Menunggu Keputusan Saya</div><div class="stat-value">${r.menunggu_persetujuan_saya}</div></div>
        <div class="stat is-ok"><div class="stat-label">Disetujui</div><div class="stat-value">${r.disetujui}</div></div>
        <div class="stat is-bad"><div class="stat-label">Ditolak</div><div class="stat-value">${r.ditolak}</div></div>
        <div class="stat is-info"><div class="stat-label">Perlu Revisi</div><div class="stat-value">${r.perlu_revisi}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Antrean Persetujuan</h2><div class="spacer"></div><a class="btn btn-sm" href="/pejabat/antrean">Lihat Semua</a></div>
        <div id="queue">${queueTable(data.antrean, 'Tidak ada antrean')}</div>
      </div>`;
    content.querySelectorAll('[data-decide]').forEach((btn) => btn.addEventListener('click', () => decide(btn.dataset.decide, { after: () => window.location.reload() })));
  });

  // ------------------------------------------------------------------ antrean
  App.registerPage('pejabat-antrean', async (content) => {
    const render = async () => {
      const { pengajuan } = await App.get('/api/pejabat/antrean');
      content.querySelector('#queue').innerHTML = queueTable(pengajuan, 'Tidak ada antrean persetujuan');
      content.querySelector('#count').textContent = pengajuan.length;
      content.querySelectorAll('[data-decide]').forEach((btn) => btn.addEventListener('click', () => decide(btn.dataset.decide, { after: render })));
    };

    content.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Surat Menunggu Keputusan Anda</h2><span class="badge badge-warning" id="count">0</span></div>
        <p class="text-muted text-sm">Daftar ini hanya memuat surat yang memang menunggu keputusan pada tahap kewenangan Anda.
        Backend menolak keputusan untuk tahap yang belum aktif atau pejabat yang tidak ditugaskan.</p>
        <div id="queue"><div class="loading"><span class="spinner"></span> Memuat…</div></div>
      </div>`;
    await render();
  });

  // ------------------------------------------------------------------ detail
  App.registerPage('pejabat-detail', async (content) => {
    const id = window.location.pathname.split('/').pop();

    const render = async () => {
      let detail;
      try {
        detail = await App.get(`/api/surat/${id}`);
      } catch (err) {
        if (err.status === 403) {
          content.innerHTML = `<div class="card"><div class="card-head"><h2>Akses Tidak Berwenang</h2></div>
            <div class="alert alert-warning">Pengajuan ini belum atau tidak menjadi kewenangan Anda, sehingga Anda tidak dapat memproses surat ini.</div>
            <a class="btn btn-secondary" href="/pejabat/antrean">Kembali ke Antrean Persetujuan</a></div>`;
          return;
        }
        throw err;
      }
      const p = detail.pengajuan;
      const payloadRows = (detail.template.form_schema || [])
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((f) => ({ label: f.label, value: (p.payload_isian || {})[f.name] }));

      const myPending = detail.approvals.find(
        (a) => a.urutan_hierarki === p.current_step && a.round_number === p.version_number && a.status_persetujuan === 'MENUNGGU'
      );
      const canDecide = p.status_pengajuan === 'MENUNGGU_PERSETUJUAN' && myPending && myPending.employee_id === App.State.user.id;

      content.innerHTML = `
        <div class="card">
          <div class="card-head">
            <h2>${App.escapeHtml(p.nama_surat)}</h2>${App.statusBadge(p.status_pengajuan)}
            <span class="badge badge-neutral">${App.escapeHtml(p.public_reference)}</span>
            <div class="spacer"></div>
            <a class="btn btn-secondary btn-sm" href="/pejabat/antrean">Kembali</a>
          </div>
          <dl class="kv">
            <dt>Mahasiswa</dt><dd>${App.escapeHtml(p.student_name)} (${App.escapeHtml(p.student_nim)})</dd>
            <dt>Program Studi</dt><dd>${App.escapeHtml(p.study_program || '-')}</dd>
            <dt>Diajukan</dt><dd>${App.formatDateTime(p.submitted_at)}</dd>
            <dt>Tahap Aktif</dt><dd>${p.current_step ? `Tahap ${p.current_step}` : (p.status_pengajuan === 'SELESAI' ? 'Selesai' : 'Menunggu finalisasi')}</dd>
            ${p.surat_number ? `<dt>Nomor Surat</dt><dd><strong>${App.escapeHtml(p.surat_number)}</strong></dd>` : ''}
          </dl>
          ${canDecide
            ? `<div class="btn-row mt-2">
                <button class="btn btn-success" data-decision="SETUJU">Setujui</button>
                <button class="btn btn-warning" data-decision="REVISI">Minta Revisi</button>
                <button class="btn btn-danger" data-decision="TOLAK">Tolak</button>
              </div>`
            : `<div class="alert alert-info mt-2">Anda tidak dapat memproses surat ini saat ini. Kemungkinan: surat belum mencapai tahap kewenangan Anda, sudah diproses, atau bukan penugasan Anda.</div>`}
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-head"><h3>Rangkuman Data Pengajuan</h3></div>
            <div class="table-wrap"><table><thead><tr><th>Data</th><th>Isi</th></tr></thead><tbody>
              ${payloadRows.map((r) => `<tr><td>${App.escapeHtml(r.label)}</td><td>${App.escapeHtml(r.value ?? '-')}</td></tr>`).join('')}
            </tbody></table></div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Riwayat Persetujuan</h3></div>
            <ul class="timeline">
              ${detail.approvals
                .filter((a) => a.round_number === p.version_number)
                .sort((a, b) => a.urutan_hierarki - b.urutan_hierarki)
                .map((a) => {
                  const cls = a.status_persetujuan === 'DISETUJUI' || a.status_persetujuan === 'DILANJUTKAN' ? 'is-done' : a.status_persetujuan === 'MENUNGGU' ? 'is-wait' : 'is-reject';
                  const title = a.urutan_hierarki === 0 ? 'Verifikasi Staf Administrasi' : `${a.urutan_hierarki}. ${a.employee_position || 'Pejabat'}`;
                  return `<li class="${cls}">
                    <div class="tl-title">${App.escapeHtml(title)}</div>
                    <div class="tl-meta">${App.statusBadge(a.status_persetujuan)} ${App.escapeHtml(a.employee_name || '')} ${a.waktu_diproses ? '· ' + App.formatDateTime(a.waktu_diproses) : ''}</div>
                    ${a.catatan ? `<div class="tl-meta">Catatan: ${App.escapeHtml(a.catatan)}</div>` : ''}
                  </li>`;
                })
                .join('')}
            </ul>
            <h3 class="mt-2">Rute Snapshot Pengajuan Ini</h3>
            <ol class="text-sm" style="padding-left:1.1rem">
              ${detail.snapshot.map((s) => `<li>${App.escapeHtml(s.position_name)} ${s.is_required ? '' : '<span class="badge badge-neutral">opsional</span>'}</li>`).join('')}
            </ol>
          </div>
        </div>`;

      content.querySelectorAll('[data-decision]').forEach((btn) =>
        btn.addEventListener('click', () => openDecision(btn.dataset.decision))
      );

      async function openDecision(preset) {
        const answer = await decisionDialog({
          title: `Keputusan untuk ${p.public_reference}`,
          message: `${p.nama_surat} — ${p.student_name} (${p.student_nim}).`,
          options: [
            { value: 'SETUJU', label: 'Setujui dan teruskan ke tahap berikutnya' },
            { value: 'REVISI', label: 'Minta revisi kepada mahasiswa', requireReason: true },
            { value: 'TOLAK', label: 'Tolak pengajuan secara permanen', requireReason: true },
          ],
          preset,
          reasonLabel: 'Alasan (wajib, terlihat oleh mahasiswa)',
          confirmLabel: 'Kirim Keputusan',
        });
        if (!answer.confirmed) return;
        try {
          const res = await App.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: answer.value, catatan: answer.reason || '' });
          App.success('Keputusan tersimpan', res.message);
          await render();
          App.refreshNotificationCount();
        } catch (err) {
          App.error('Keputusan gagal disimpan', err.message);
        }
      }
    };

    await render();
  });

  // ------------------------------------------------------------------ riwayat
  App.registerPage('pejabat-riwayat', async (content) => {
    const { riwayat } = await App.get('/api/pejabat/riwayat');
    content.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Riwayat Persetujuan Saya</h2><span class="badge badge-neutral">${riwayat.length} data</span></div>
        <p class="text-muted text-sm">Seluruh keputusan tersimpan permanen sebagai histori. Keputusan lama tidak dihapus meskipun pengajuan direvisi.</p>
        ${riwayat.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Waktu</th><th>Referensi</th><th>Jenis Surat</th><th>Mahasiswa</th><th>Tahap</th><th>Keputusan</th><th>Catatan</th><th></th></tr></thead>
              <tbody>${riwayat
                .map(
                  (r) => `<tr>
                    <td>${App.formatDateTime(r.waktu_diproses)}</td>
                    <td><strong>${App.escapeHtml(r.public_reference)}</strong><div class="li-meta">versi ${r.versi_pengajuan}</div></td>
                    <td>${App.escapeHtml(r.nama_surat)}</td>
                    <td>${App.escapeHtml(r.student_name)}<div class="li-meta">${App.escapeHtml(r.student_nim || '')}</div></td>
                    <td>${r.urutan_hierarki >= 1 ? `Tahap ${r.urutan_hierarki}` : 'Verifikasi'}</td>
                    <td>${App.statusBadge(r.status_persetujuan)}</td>
                    <td>${App.escapeHtml((r.catatan || '-').slice(0, 80))}</td>
                    <td><a class="btn btn-secondary btn-sm" href="/pejabat/pengajuan/${r.pengajuan_id}">Lihat</a></td>
                  </tr>`
                )
                .join('')}</tbody></table></div>`
          : App.emptyState('Belum ada riwayat', 'Keputusan yang Anda berikan akan tercatat di sini.')}
      </div>`;
  });
})();
