/* Halaman login & registrasi */
(function () {
  'use strict';

  const alertBox = (id, kind, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="alert alert-${kind}">${html}</div>`;
  };

  App.registerPage('login', async () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sesi') === 'berakhir') {
      alertBox('login-alert', 'warning', 'Sesi Anda telah berakhir. Silakan masuk kembali.');
    } else if (params.get('next')) {
      alertBox('login-alert', 'info', 'Silakan masuk untuk melanjutkan ke halaman yang Anda tuju.');
    }

    const form = document.getElementById('login-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('login-submit');
      button.disabled = true;
      button.textContent = 'Memproses…';
      try {
        const data = await App.post('/api/auth/login', {
          email: form.email.value.trim(),
          password: form.password.value,
        });
        App.success('Berhasil masuk', `Selamat datang, ${data.user.full_name}`);
        const next = params.get('next');
        const home = App.homeFor(data.user.role);
        setTimeout(() => { window.location.href = next && next.startsWith('/') ? next : home; }, 400);
      } catch (err) {
        alertBox('login-alert', 'danger', App.escapeHtml(err.message));
        button.disabled = false;
        button.textContent = 'Masuk';
      }
    });
  });

  App.registerPage('register', async () => {
    const form = document.getElementById('register-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('register-submit');
      const payload = {
        fullName: form.fullName.value.trim(),
        nim: form.nim.value.trim(),
        studyProgram: form.studyProgram.value.trim(),
        email: form.email.value.trim(),
        password: form.password.value,
      };

      if (payload.password.length < 8) {
        alertBox('register-alert', 'danger', 'Password minimal 8 karakter.');
        return;
      }

      button.disabled = true;
      button.textContent = 'Mendaftarkan…';
      try {
        await App.post('/api/auth/register', payload);
        alertBox('register-alert', 'success', 'Registrasi berhasil. Silakan masuk dengan akun Anda.');
        App.success('Registrasi berhasil', 'Akun mahasiswa Anda sudah aktif.');
        setTimeout(() => { window.location.href = '/login'; }, 1200);
      } catch (err) {
        const details = err.details ? `<ul>${Object.values(err.details).map((m) => `<li>${App.escapeHtml(m)}</li>`).join('')}</ul>` : '';
        alertBox('register-alert', 'danger', `${App.escapeHtml(err.message)}${details}`);
        button.disabled = false;
        button.textContent = 'Daftar';
      }
    });
  });
})();
