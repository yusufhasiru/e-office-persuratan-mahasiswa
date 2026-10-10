/* Halaman verifikasi publik: hanya menampilkan data yang aman dipublikasikan */
(function () {
  'use strict';

  App.registerPage('verify', async () => {
    const container = document.getElementById('verify-result');
    const token = window.location.pathname.split('/').filter(Boolean).pop();

    if (!token) {
      container.innerHTML = '<div class="alert alert-danger">Token verifikasi tidak ditemukan pada tautan.</div>';
      return;
    }

    try {
      const data = await App.get(`/api/verify/${encodeURIComponent(token)}`);
      container.innerHTML = data.valid ? renderValid(data) : renderInvalid(data);
    } catch (err) {
      container.innerHTML = `<div class="alert alert-danger">Gagal memeriksa dokumen: ${App.escapeHtml(err.message)}</div>`;
    }
  });

  function renderInvalid(data) {
    return `
      <div class="alert alert-danger">
        <strong>Dokumen TIDAK dapat dinyatakan sah.</strong>
        <div>${App.escapeHtml(data.message || 'Dokumen tidak terverifikasi.')}</div>
      </div>
      ${data.surat_number ? `<dl class="kv">
        <dt>Nomor Surat</dt><dd>${App.escapeHtml(data.surat_number)}</dd>
        <dt>Jenis Surat</dt><dd>${App.escapeHtml(data.jenis_surat || '-')}</dd>
        <dt>Status Pengajuan</dt><dd>${App.escapeHtml(data.status_label || data.status || '-')}</dd>
      </dl>` : ''}
      <p class="text-muted text-sm">Bila Anda menerima berkas ini dalam bentuk cetak, hubungi jurusan untuk memastikan keabsahannya.</p>`;
  }

  function renderValid(data) {
    const integritas =
      data.integritas_berkas && data.integritas_berkas.status === 'COCOK'
        ? '<span class="badge badge-success">Checksum cocok</span>'
        : data.integritas_berkas && data.integritas_berkas.status === 'TIDAK_COCOK'
          ? '<span class="badge badge-danger">Checksum tidak cocok</span>'
          : '<span class="badge badge-neutral">Tidak diperiksa</span>';

    return `
      <div class="alert alert-success">
        <strong>Dokumen SAH dan terdaftar pada sistem e-Office.</strong>
        <div>${App.escapeHtml(data.message)}</div>
      </div>

      <dl class="kv mb-2">
        <dt>Nomor Surat</dt><dd><strong>${App.escapeHtml(data.surat_number)}</strong></dd>
        <dt>Jenis Surat</dt><dd>${App.escapeHtml(data.jenis_surat)} (${App.escapeHtml(data.kode_template)})</dd>
        <dt>Tanggal Penerbitan</dt><dd>${App.escapeHtml(data.tanggal_penerbitan)}</dd>
        <dt>Nama Mahasiswa</dt><dd>${App.escapeHtml(data.mahasiswa.nama)}</dd>
        <dt>NIM</dt><dd>${App.escapeHtml(data.mahasiswa.nim)}</dd>
        <dt>Program Studi</dt><dd>${App.escapeHtml(data.mahasiswa.program_studi || '-')}</dd>
        ${data.diverifikasi_oleh ? `<dt>Diverifikasi oleh</dt><dd>${App.escapeHtml(data.diverifikasi_oleh.nama)} — ${App.escapeHtml(data.diverifikasi_oleh.waktu)}</dd>` : ''}
      </dl>

      <h3>Pejabat yang menyetujui</h3>
      <ul class="list-plain mb-2">
        ${data.pejabat_menyetujui
          .map(
            (p) => `<li><div class="li-main">
              <div class="li-title">${p.urutan_ke}. ${App.escapeHtml(p.nama)}</div>
              <div class="li-meta">${App.escapeHtml(p.jabatan)} · ${App.escapeHtml(p.waktu)}</div>
            </div></li>`
          )
          .join('') || '<li><div class="li-main">Tidak ada catatan persetujuan.</div></li>'}
      </ul>

      <h3>Integritas berkas</h3>
      <p class="text-sm">${integritas}</p>
      <dl class="kv">
        <dt>Identitas dokumen (SHA-256)</dt><dd style="font-family:monospace;font-size:.78rem;word-break:break-all">${App.escapeHtml(data.identitas_dokumen_sha256 || '-')}</dd>
      </dl>

      <div class="alert alert-info mt-2 text-sm">${App.escapeHtml(data.catatan)}</div>`;
  }
})();
