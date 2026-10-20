// Payment page: polls the booking until it's paid, and offers a retry or
// another method if MB WAY is declined or times out.
(function () {
  'use strict';
  var dataEl = document.getElementById('pay-data');
  if (!dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  var T = D.text;
  var actions = document.getElementById('pay-actions');
  var statusEl = document.getElementById('pay-status');
  var stopped = false;
  var started = Date.now();

  function button(label, quiet, onclick) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'btn' + (quiet ? ' btn-quiet' : ''); b.textContent = label;
    b.addEventListener('click', onclick);
    return b;
  }

  function retry(method) {
    actions.replaceChildren();
    fetch(D.payUrl, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ method: method }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.status === 201) { window.location.assign(res.body.paymentUrl || res.body.next); return; }
        showFailed(res.body.message || T.generic);
      })
      .catch(function () { showFailed(T.generic); });
  }

  function showFailed(message) {
    stopped = true;
    if (statusEl) statusEl.textContent = message;
    var list = [];
    if (D.methods.indexOf('mbway') >= 0) list.push(button(T.retry, false, function () { retry('mbway'); }));
    D.methods.filter(function (m) { return m !== 'mbway'; }).forEach(function (m) {
      list.push(button(T[m], true, function () { retry(m); }));
    });
    actions.replaceChildren.apply(actions, list);
  }

  function poll() {
    if (stopped) return;
    fetch(D.statusUrl, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) return schedule();
        if (s.booking === 'confirmed' || s.booking === 'completed') { window.location.assign(D.doneUrl); return; }
        if (s.booking === 'cancelled') { stopped = true; window.location.reload(); return; }
        if (s.payment && s.payment.id === D.paymentId && (s.payment.status === 'failed' || s.payment.status === 'expired')) {
          showFailed(T.failed); return;
        }
        // MB WAY gives 4 minutes; after 5 we offer alternatives but keep listening.
        if (D.method === 'mbway' && Date.now() - started > 5 * 60_000 && !actions.childElementCount) showFailed(T.failed);
        schedule();
      })
      .catch(schedule);
  }

  function schedule() {
    if (stopped) return;
    // Fast while waiting for MB WAY, slower for Multibanco references.
    var wait = D.method === 'multibanco' ? 15000 : 3000;
    setTimeout(poll, document.hidden ? wait * 3 : wait);
  }

  if (D.paymentId) schedule();
})();
