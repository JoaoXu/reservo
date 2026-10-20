// New-booking form: shows free times for the chosen treatment, therapist
// and day; tapping one fills in the time field.
(function () {
  'use strict';
  var form = document.querySelector('.js-new-booking');
  if (!form) return;
  var box = form.querySelector('.slot-suggest');
  var timeInput = form.querySelector('input[name="time"]');
  var seq = 0;

  function load() {
    var service = form.service.value, date = form.date.value, staff = form.staff.value;
    if (!service || !date) { box.replaceChildren(); return; }
    var mine = ++seq;
    fetch('/admin/api/slots?service=' + encodeURIComponent(service) + '&date=' + encodeURIComponent(date) + (staff ? '&staff=' + encodeURIComponent(staff) : ''), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (mine !== seq) return;
        if (!j.slots.length) { box.textContent = box.getAttribute('data-empty'); return; }
        var label = document.createElement('span');
        label.textContent = box.getAttribute('data-label') + ' ';
        var items = j.slots.map(function (s) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'btn btn-small btn-quiet'; b.textContent = s.time;
          b.addEventListener('click', function () { timeInput.value = s.time; });
          return b;
        });
        box.replaceChildren.apply(box, [label].concat(items));
      })
      .catch(function () { box.replaceChildren(); });
  }
  form.querySelectorAll('.js-slot-input').forEach(function (i) { i.addEventListener('change', load); });
  load();
})();
