// Small dashboard helpers: confirm dangerous forms, auto-submit the day
// picker, copy callback URLs, and the demo "simulate payment" button.
(function () {
  'use strict';
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
    });
  });
  document.querySelectorAll('.js-autosubmit').forEach(function (i) {
    i.addEventListener('change', function () { if (i.form) i.form.submit(); });
  });
  document.querySelectorAll('pre.copy').forEach(function (p) {
    p.setAttribute('tabindex', '0');
    p.title = 'Copy';
    p.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(p.textContent.trim()).then(function () { p.classList.add('copied'); setTimeout(function () { p.classList.remove('copied'); }, 1200); });
    });
  });
  document.querySelectorAll('.js-mock-pay').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch(b.getAttribute('data-url'), { method: 'POST', credentials: 'same-origin' }).then(function () { window.location.reload(); });
    });
  });
})();
