'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { env } = require('../config/env');
const { sha256 } = require('../utils/crypto');
const { formatTanggalId, formatTanggalWaktuId } = require('../utils/date');

const MARGIN = 56;

/** Digest konten dokumen (dipakai di dalam PDF sebagai identitas dokumen). */
function contentDigest(data) {
  const canonical = JSON.stringify({
    nomor: data.surat_number,
    template: data.template_kode,
    student: data.student_nim,
    payload: data.payload,
    approvals: (data.approvers || []).map((a) => `${a.urutan_ke}:${a.employee_name}:${a.waktu_diproses}`),
  });
  return sha256(canonical);
}

/**
 * Membuat buffer PDF final.
 * Tidak ada gambar tanda tangan palsu: hanya daftar pejabat yang menyetujui
 * (diambil dari catatan persetujuan sah di database) + QR verifikasi.
 */
async function buildPdfBuffer({ pengajuan, template, snapshot, approvers, verificationUrl }) {
  const qrPng = await QRCode.toBuffer(verificationUrl, { type: 'png', width: 300, margin: 1 });
  const digest = contentDigest({
    surat_number: pengajuan.surat_number,
    template_kode: template.kode,
    student_nim: pengajuan.student_nim,
    payload: pengajuan.payload_isian,
    approvers,
  });

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: MARGIN, bottom: 70, left: MARGIN, right: MARGIN },
        info: {
          Title: `${template.nama_surat} - ${pengajuan.surat_number}`,
          Author: env.institution.name,
          Subject: template.nama_surat,
          Creator: 'e-Office Sistem Informasi Layanan Persuratan Mahasiswa',
        },
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - MARGIN * 2;

      // ---------------- Kop surat ----------------
      doc.font('Helvetica-Bold').fontSize(14).text(env.institution.name.toUpperCase(), { align: 'center' });
      doc.font('Helvetica').fontSize(11).text(env.institution.faculty, { align: 'center' });
      doc.font('Helvetica-Bold').fontSize(12).text(env.institution.department, { align: 'center' });
      doc.font('Helvetica').fontSize(9).fillColor('#444444').text(env.institution.address, { align: 'center' });
      doc.fillColor('#000000');
      doc.moveDown(0.4);
      const lineY = doc.y;
      doc.moveTo(MARGIN, lineY).lineTo(pageWidth - MARGIN, lineY).lineWidth(1.5).strokeColor('#152352').stroke();
      doc.moveTo(MARGIN, lineY + 3).lineTo(pageWidth - MARGIN, lineY + 3).lineWidth(0.7).strokeColor('#152352').stroke();
      doc.moveDown(1.4);

      // ---------------- Judul ----------------
      doc.font('Helvetica-Bold').fontSize(12).text(template.nama_surat.toUpperCase(), { align: 'center', underline: false });
      doc.font('Helvetica').fontSize(10).text(`Nomor: ${pengajuan.surat_number}`, { align: 'center' });
      doc.moveDown(1);

      // ---------------- Identitas pemohon ----------------
      doc.font('Helvetica-Bold').fontSize(10).text('IDENTITAS PEMOHON');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10);
      const identity = [
        ['Nama', pengajuan.student_name],
        ['NIM', pengajuan.student_nim],
        ['Program Studi', pengajuan.study_program || '-'],
        ['Referensi Pengajuan', pengajuan.public_reference],
        ['Tanggal Pengajuan', formatTanggalId(pengajuan.submitted_at)],
      ];
      for (const [label, value] of identity) {
        const y = doc.y;
        doc.font('Helvetica').text(label, MARGIN, y, { width: 130, continued: false });
        doc.font('Helvetica-Bold').text(`: ${value ?? '-'}`, MARGIN + 130, y, { width: contentWidth - 130 });
      }
      doc.moveDown(0.8);

      // ---------------- Isi surat (data pengajuan) ----------------
      doc.font('Helvetica-Bold').fontSize(10).text('DATA PENGAJUAN');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10);
      for (const row of template.summaryRows || []) {
        const y = doc.y;
        doc.font('Helvetica').text(row.label, MARGIN, y, { width: 180 });
        doc.font('Helvetica-Bold').text(`: ${row.display ?? '-'}`, MARGIN + 180, y, { width: contentWidth - 180 });
      }
      doc.moveDown(1);

      doc.font('Helvetica').fontSize(10).text(
        `Surat ini diterbitkan berdasarkan pengajuan ${pengajuan.public_reference} yang telah disetujui melalui alur persetujuan berjenjang pada sistem e-Office ${env.institution.department}.`,
        { align: 'justify' }
      );
      doc.moveDown(1);

      // ---------------- Daftar pejabat yang menyetujui ----------------
      doc.font('Helvetica-Bold').fontSize(10).text('DAFTAR PEJABAT YANG MENYETUJUI');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9.5);
      approvers.forEach((a, index) => {
        doc.font('Helvetica').text(`${index + 1}. ${a.employee_name}`, { continued: false });
        doc.font('Helvetica').fillColor('#444444').text(
          `    ${a.position_name || '-'} — disetujui pada ${formatTanggalWaktuId(a.waktu_diproses)}`,
          { indent: 8 }
        );
        doc.fillColor('#000000');
      });

      if (snapshot?.length) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#555555').text(
          `Urutan rute persetujuan pada saat pengajuan dibuat: ${snapshot.map((s) => `${s.urutan_ke}. ${s.position_name}`).join(' → ')}`
        );
        doc.fillColor('#000000');
      }

      doc.moveDown(1.2);

      // ---------------- Blok QR ----------------
      const qrY = doc.y;
      doc.image(qrPng, MARGIN, qrY, { width: 96 });
      const textX = MARGIN + 112;
      doc.font('Helvetica-Bold').fontSize(9.5).text('VERIFIKASI DOKUMEN DIGITAL', textX, qrY + 4, { width: contentWidth - 112 });
      doc.font('Helvetica').fontSize(8.5).fillColor('#333333').text(
        'Pindai QR Code untuk memeriksa keabsahan dokumen ini pada server e-Office.',
        textX,
        doc.y + 2,
        { width: contentWidth - 112 }
      );
      doc.font('Helvetica').fontSize(7.8).fillColor('#333333').text(`URL: ${verificationUrl}`, textX, doc.y + 2, {
        width: contentWidth - 112,
      });
      doc.font('Helvetica').fontSize(7.8).text(`Identitas dokumen (SHA-256): ${digest}`, textX, doc.y + 3, {
        width: contentWidth - 112,
      });
      doc.fillColor('#000000');

      // ---------------- Footer ----------------
      const footerY = doc.page.height - 62;
      doc.font('Helvetica').fontSize(7.5).fillColor('#555555');
      doc.moveTo(MARGIN, footerY - 8).lineTo(pageWidth - MARGIN, footerY - 8).lineWidth(0.5).strokeColor('#BBBBBB').stroke();
      doc.text(
        `Dokumen ini diterbitkan secara elektronik oleh Sistem Informasi Layanan Persuratan Mahasiswa (e-Office) ${env.institution.department}. ` +
          `Keabsahan dokumen diverifikasi melalui server pada ${verificationUrl}. ` +
          'QR Code ini bukan sertifikat tanda tangan elektronik tersertifikasi.',
        MARGIN,
        footerY,
        { width: contentWidth, align: 'justify' }
      );
      doc.text(`Dicetak: ${formatTanggalWaktuId(new Date().toISOString())}`, MARGIN, footerY + 22, { width: contentWidth });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Menyimpan buffer PDF ke storage privat dan mengembalikan path relatif + checksum. */
function storePdf(pengajuan, buffer) {
  const dir = path.join(env.storagePath, String(pengajuan.student_id));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${pengajuan.public_reference}-v${pengajuan.version_number}.pdf`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);
  return {
    absolutePath: fullPath,
    relativePath: path.relative(path.resolve(__dirname, '..', '..'), fullPath),
    checksum: sha256(buffer),
    size: buffer.length,
  };
}

function readPdf(relativePath) {
  const fullPath = path.resolve(__dirname, '..', '..', relativePath);
  const storageRoot = path.resolve(env.storagePath);
  if (!fullPath.startsWith(storageRoot)) return null;
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath);
}

module.exports = { buildPdfBuffer, storePdf, readPdf, contentDigest, MARGIN };
