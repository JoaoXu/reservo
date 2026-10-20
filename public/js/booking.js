// Booking flow: treatment → therapist → day and time → details → payment.
// Plain DOM APIs only; user text is always set with textContent.
(function () {
  'use strict';
  var root = document.getElementById('booking-app');
  var dataEl = document.getElementById('booking-data');
  if (!root || !dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  var T = D.text;
  var intlLocale = D.locale === 'en' ? 'en-GB' : 'pt-PT';

  var state = {
    step: 0, service: null, staff: null, staffChosen: false, date: null, slot: null,
    days: {}, slots: null, loading: false,
    details: { name: '', phone: '', email: '', note: '', privacy: false, marketing: false },
    payment: null, mbwayPhone: '', errors: {}, formError: '', submitting: false,
  };

  // ---------- helpers ----------
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    (children || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function svc() { return D.services.find(function (s) { return s.id === state.service; }) || null; }
  function staffName(id) { var s = D.staff.find(function (x) { return x.id === id; }); return s ? s.name : ''; }
  function money(c) { return new Intl.NumberFormat(intlLocale, { style: 'currency', currency: 'EUR', minimumFractionDigits: c % 100 ? 2 : 0 }).format(c / 100); }
  function addDays(d, n) { var p = d.split('-').map(Number); var t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return t.toISOString().slice(0, 10); }
  function dayParts(d) {
    var p = d.split('-').map(Number); var t = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    return {
      name: new Intl.DateTimeFormat(intlLocale, { weekday: 'short', timeZone: 'UTC' }).format(t).replace('.', ''),
      num: p[2],
      long: new Intl.DateTimeFormat(intlLocale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(t),
    };
  }
  function dayLabel(d) {
    if (d === D.today) return T['hero.today'];
    if (d === addDays(D.today, 1)) return T['hero.tomorrow'];
    return dayParts(d).long;
  }
  function getJSON(url) {
    return fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function staffForSlot() { return state.staff ? '&staff=' + encodeURIComponent(state.staff) : ''; }

  // ---------- data loading ----------
  function loadDays(from) {
    if (!state.service) return;
    var key = state.service + '|' + (state.staff || '') + '|' + from;
    if (state.days[key]) return;
    state.days[key] = 'loading';
    getJSON('/api/days?service=' + state.service + staffForSlot() + '&from=' + from).then(function (r) {
      var set = {}; r.days.forEach(function (d) { set[d] = true; });
      state.days[key] = set; render();
    }).catch(function () { state.days[key] = {}; });
  }
  function daysOpen(from) { return state.days[state.service + '|' + (state.staff || '') + '|' + from]; }

  function loadSlots(presetIso) {
    state.slots = null; state.loading = true; state.slot = null; render();
    var req = state.date;
    getJSON('/api/slots?service=' + state.service + staffForSlot() + '&date=' + req).then(function (r) {
      if (state.date !== req) return;
      state.slots = r.slots; state.loading = false;
      if (presetIso) {
        var t = new Date(presetIso).getTime();
        var found = r.slots.find(function (s) { return new Date(s.start).getTime() === t; });
        if (found) { state.slot = found; state.step = 3; }
      }
      render();
    }).catch(function () { state.loading = false; state.slots = []; render(); });
  }

  // ---------- actions ----------
  function chooseService(id) {
    state.service = id; state.slot = null; state.slots = null; state.days = {};
    var s = svc();
    if (state.staff && s.staff.indexOf(state.staff) < 0) state.staff = null;
    state.staffChosen = s.staff.length <= 1; // nothing to choose
    state.step = state.staffChosen ? 2 : 1;
    if (state.step === 2) startDays();
    render();
  }
  function chooseStaff(id) {
    state.staff = id; state.staffChosen = true; state.slot = null; state.slots = null; state.step = 2;
    startDays(); render();
  }
  function startDays() {
    if (!state.date || state.date < D.today) state.date = D.today;
    loadDays(D.today);
    loadSlots();
  }
  function chooseDate(d) {
    if (d < D.today || d > D.lastDay) return;
    state.date = d; loadSlots(); loadDays(d);
  }
  function chooseSlot(s) { state.slot = s; state.step = 3; state.formError = ''; render(); focusStep(3); }
  function goTo(step) { state.step = step; state.formError = ''; render(); focusStep(step); }
  function focusStep(i) {
    var h = root.querySelector('[data-step="' + i + '"] h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: false }); }
  }

  function needsPayment() {
    var s = svc();
    return D.paymentMode !== 'none' && s && s.due > 0 && state.slot && (state.slot.methods.length > 0);
  }
  function paymentChoices() {
    var list = state.slot ? state.slot.methods.slice() : [];
    if (D.payAtStudio || !list.length) list.push('studio');
    return list;
  }

  function validateDetails() {
    var e = {}; var d = state.details;
    if (d.name.trim().length < 2) e.name = T['field.required'];
    var digits = d.phone.replace(/[^\d+]/g, '');
    if (digits.replace(/\D/g, '').length < 9) e.phone = T['field.invalid'];
    if (d.email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(d.email)) e.email = T['field.invalid'];
    if (!d.privacy) e.privacy = T['field.required'];
    state.errors = e;
    return Object.keys(e).length === 0;
  }

  function submit() {
    if (state.submitting) return;
    if (!validateDetails()) { state.step = 3; render(); return; }
    var pay = needsPayment() ? state.payment : 'none';
    if (needsPayment() && !pay) { state.formError = T['book.err.payment_required']; render(); return; }
    state.submitting = true; state.formError = ''; render();
    var body = {
      locale: D.locale, service: state.service, staff: state.staff || '', start: state.slot.start,
      name: state.details.name, phone: state.details.phone, email: state.details.email, note: state.details.note,
      privacy: state.details.privacy, marketing: state.details.marketing, payment: pay,
      mbway_phone: pay === 'mbway' ? (state.mbwayPhone || state.details.phone) : '',
      website: (root.querySelector('input[name="website"]') || {}).value || '',
    };
    fetch('/api/bookings', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.status === 201) {
          window.location.assign(res.body.paymentUrl || res.body.next);
          return;
        }
        state.submitting = false;
        var b = res.body || {};
        if (b.error === 'fields') { state.errors = b.fields || {}; state.step = 3; render(); return; }
        if (b.error === 'slot_unavailable') {
          state.formError = b.message; state.step = 2; loadSlots(); return;
        }
        state.formError = b.message || T['book.err.generic']; render();
      })
      .catch(function () { state.submitting = false; state.formError = T['book.err.generic']; render(); });
  }

  // ---------- rendering ----------
  function stepShell(i, title, summary, body) {
    var st = state.step === i ? 'open' : (i < state.step || (summary && state.step > i)) ? 'done' : 'locked';
    var head = el('div', { class: 'step-head' }, [
      el('h2', { text: title }),
      st === 'done' && summary ? el('p', { class: 'step-summary' }, [summary, el('button', { type: 'button', class: 'linklike', text: T['book.change'], onclick: function () { goTo(i); } })]) : null,
    ]);
    return el('li', { class: 'step', 'data-step': String(i), 'data-state': st }, [head, st === 'open' ? el('div', { class: 'step-body' }, body()) : null]);
  }

  function serviceStep() {
    var groups = [];
    D.services.forEach(function (s) {
      var g = groups.find(function (x) { return x.name === s.category; });
      if (g) g.items.push(s); else groups.push({ name: s.category, items: [s] });
    });
    var out = [];
    groups.forEach(function (g) {
      if (g.name) out.push(el('p', { class: 'option-group-title', text: g.name }));
      out.push(el('div', { class: 'options', role: 'radiogroup' }, g.items.map(function (s) {
        return el('label', { class: 'option' }, [
          el('input', { type: 'radio', name: 'service', value: s.id, checked: state.service === s.id, onchange: function () { chooseService(s.id); } }),
          el('span', { class: 'option-name', text: s.name }),
          el('span', { class: 'option-meta' }, [s.duration + ' ' + T['services.min'], el('strong', { text: s.priceLabel })]),
          s.description ? el('span', { class: 'option-desc', text: s.description }) : null,
        ]);
      })));
    });
    return out;
  }

  function staffStep() {
    var s = svc();
    var people = s ? s.staff : [];
    var chips = [el('button', { type: 'button', class: 'chip', 'aria-pressed': state.staffChosen && !state.staff ? 'true' : 'false', onclick: function () { chooseStaff(null); } },
      [el('span', { text: T['book.any_staff'] }), el('small', { text: T['book.any_staff_hint'] })])];
    people.forEach(function (id) {
      var p = D.staff.find(function (x) { return x.id === id; });
      if (!p) return;
      chips.push(el('button', { type: 'button', class: 'chip', 'aria-pressed': state.staff === id ? 'true' : 'false', onclick: function () { chooseStaff(id); } },
        [el('span', { text: p.name }), p.title ? el('small', { text: p.title }) : null]));
    });
    return [el('div', { class: 'chips' }, chips)];
  }

  function timeStep() {
    var out = [];
    if (state.formError && state.step === 2) out.push(el('p', { class: 'form-error', role: 'alert', text: state.formError }));
    var start = state.date && state.date > addDays(D.today, 10) ? addDays(state.date, -3) : D.today;
    var open = daysOpen(start === D.today ? D.today : start);
    if (start !== D.today) loadDays(start);
    var strip = [];
    for (var i = 0; i < 14; i++) {
      var d = addDays(start, i);
      if (d > D.lastDay) break;
      var p = dayParts(d);
      var isOpen = open && open !== 'loading' ? !!open[d] : null;
      strip.push(el('button', {
        type: 'button', class: 'day', 'aria-pressed': state.date === d ? 'true' : 'false',
        'data-open': isOpen === null ? null : String(isOpen), 'aria-label': p.long,
        onclick: (function (dd) { return function () { chooseDate(dd); }; })(d),
      }, [el('span', { class: 'day-name', text: d === D.today ? T['hero.today'] : p.name }), el('span', { class: 'day-num', text: String(p.num) }), el('span', { class: 'day-dot' })]));
    }
    out.push(el('div', { class: 'days' }, strip));
    out.push(el('label', { class: 'day-more' }, [
      D.locale === 'en' ? 'Another date' : 'Outra data',
      el('input', { type: 'date', min: D.today, max: D.lastDay, value: state.date || '', onchange: function (e) { if (e.target.value) chooseDate(e.target.value); } }),
    ]));
    if (state.loading) out.push(el('p', { class: 'slots-empty' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', T['book.loading']]));
    else if (state.slots && !state.slots.length) out.push(el('p', { class: 'slots-empty', text: T['book.no_slots'] }));
    else if (state.slots) out.push(el('div', { class: 'slots', role: 'group', 'aria-label': dayLabel(state.date) }, state.slots.map(function (s) {
      return el('button', { type: 'button', class: 'slot', 'aria-pressed': state.slot && state.slot.start === s.start ? 'true' : 'false', onclick: function () { chooseSlot(s); }, text: s.label });
    })));
    return out;
  }

  function field(name, label, opts) {
    opts = opts || {};
    var err = state.errors[name];
    var input = el(opts.multiline ? 'textarea' : 'input', {
      id: 'f-' + name, name: name, type: opts.multiline ? null : (opts.type || 'text'), autocomplete: opts.autocomplete || null,
      inputmode: opts.inputmode || null, rows: opts.multiline ? '3' : null, maxlength: opts.max || null,
      'aria-invalid': err ? 'true' : null, 'aria-describedby': (opts.hint || err) ? 'h-' + name : null,
      oninput: function (e) { (opts.target || state.details)[opts.key || name] = e.target.value; },
    });
    input.value = (opts.target || state.details)[opts.key || name] || '';
    return el('div', { class: 'field', 'data-invalid': err ? 'true' : null }, [
      el('label', { for: 'f-' + name, text: label }), input,
      err ? el('span', { class: 'error', id: 'h-' + name, role: 'alert', text: err }) : opts.hint ? el('span', { class: 'hint', id: 'h-' + name, text: opts.hint }) : null,
    ]);
  }

  function detailsStep() {
    var d = state.details;
    var out = [
      field('name', T['book.name'], { autocomplete: 'name', max: '80' }),
      field('phone', T['book.phone'], { type: 'tel', autocomplete: 'tel', inputmode: 'tel', hint: T['book.phone_hint'], max: '30' }),
      field('email', T['book.email'], { type: 'email', autocomplete: 'email', max: '254' }),
      field('note', T['book.note'], { multiline: true, hint: T['book.note_hint'], max: '600' }),
      el('div', { class: 'hp', 'aria-hidden': 'true' }, [el('label', {}, ['Website', el('input', { name: 'website', tabindex: '-1', autocomplete: 'off' })])]),
      el('label', { class: 'check-row' }, [
        el('input', { type: 'checkbox', checked: d.privacy, 'aria-invalid': state.errors.privacy ? 'true' : null, onchange: function (e) { d.privacy = e.target.checked; } }),
        el('span', {}, [T['book.privacy'] + ' ', el('a', { href: '/privacidade', target: '_blank', text: '↗' })]),
      ]),
      state.errors.privacy ? el('p', { class: 'field' }, [el('span', { class: 'error', role: 'alert', text: state.errors.privacy })]) : null,
      el('label', { class: 'check-row' }, [
        el('input', { type: 'checkbox', checked: d.marketing, onchange: function (e) { d.marketing = e.target.checked; } }),
        el('span', { text: T['book.marketing'] }),
      ]),
    ];
    if (state.formError && state.step === 3) out.unshift(el('p', { class: 'form-error', role: 'alert', text: state.formError }));
    if (needsPayment()) {
      out.push(el('button', { type: 'button', class: 'btn', text: T['book.continue'], onclick: function () { if (validateDetails()) goTo(4); else render(); } }));
    } else {
      out.push(el('button', { type: 'button', class: 'btn', disabled: state.submitting, text: T['book.confirm'], onclick: submit }));
    }
    return out;
  }

  function paymentStep() {
    var s = svc();
    var labels = {
      mbway: [T['book.pay_mbway'], T['book.pay_mbway_hint']], multibanco: [T['book.pay_multibanco'], T['book.pay_multibanco_hint']],
      card: [T['book.pay_card'], T['book.pay_card_hint']], studio: [T['book.pay_studio'], T['book.pay_studio_hint']],
    };
    var choices = paymentChoices();
    if (!state.payment || choices.indexOf(state.payment) < 0) state.payment = choices[0];
    var out = [];
    if (state.formError) out.push(el('p', { class: 'form-error', role: 'alert', text: state.formError }));
    out.push(el('div', { class: 'options', role: 'radiogroup' }, choices.map(function (m) {
      return el('label', { class: 'option' }, [
        el('input', { type: 'radio', name: 'payment', value: m, checked: state.payment === m, onchange: function () { state.payment = m; render(); } }),
        el('span', { class: 'option-name', text: labels[m][0] }),
        el('span', { class: 'option-meta', text: m === 'studio' ? '' : s.dueLabel }),
        el('span', { class: 'option-desc', text: labels[m][1] }),
      ]);
    })));
    if (state.payment === 'mbway') {
      if (!state.mbwayPhone) state.mbwayPhone = state.details.phone;
      out.push(el('div', { style: null }, [field('mbway', T['book.mbway_phone'], { type: 'tel', inputmode: 'tel', target: state, key: 'mbwayPhone', max: '30' })]));
    }
    if (D.paymentMode === 'deposit' && state.payment !== 'studio') out.push(el('p', { class: 'muted', text: T['book.deposit_why'] }));
    out.push(el('button', { type: 'button', class: 'btn', disabled: state.submitting, onclick: submit },
      state.submitting ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', T['book.confirm']] : [T['book.confirm']]));
    return out;
  }

  function summary() {
    var s = svc();
    var rows = [];
    if (s) rows.push([T['book.step_service'], s.name + ', ' + s.duration + ' ' + T['services.min']]);
    if (s && state.staffChosen && s.staff.length > 1) rows.push([T['book.step_staff'], state.staff ? staffName(state.staff) : T['book.any_staff']]);
    if (state.slot) rows.push([T['book.step_time'], dayLabel(state.date) + ', ' + state.slot.label]);
    if (s) rows.push([T['book.total'], s.priceLabel]);
    var children = [el('h2', { text: T['book.summary'] })];
    children.push(el('dl', {}, rows.map(function (r) { return el('div', {}, [el('dt', { text: r[0] }), el('dd', { text: r[1] })]); })));
    if (s && needsPayment() && state.payment !== 'studio') {
      children.push(el('dl', {}, [el('div', {}, [el('dt', { text: D.paymentMode === 'full' ? T['book.full_now'] : T['book.deposit_now'] }), el('dd', { class: 'due', text: s.dueLabel })])]));
      if (D.paymentMode === 'deposit') children.push(el('p', { class: 'summary-note', text: T['book.rest_at_studio'] }));
    }
    children.push(el('p', { class: 'summary-note', text: T['book.policy_short'] }));
    if (!s) children.push(el('p', { class: 'summary-note muted', text: '—' }));
    return el('aside', { class: 'summary', 'aria-label': T['book.summary'] }, children);
  }

  function render() {
    var s = svc();
    var active = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
    var steps = [
      stepShell(0, T['book.step_service'], s ? s.name : '', serviceStep),
    ];
    if (s && s.staff.length > 1) steps.push(stepShell(1, T['book.step_staff'], state.staffChosen ? (state.staff ? staffName(state.staff) : T['book.any_staff']) : '', staffStep));
    steps.push(stepShell(2, T['book.step_time'], state.slot ? dayLabel(state.date) + ', ' + state.slot.label : '', timeStep));
    steps.push(stepShell(3, T['book.step_details'], state.step > 3 ? state.details.name : '', detailsStep));
    if (needsPayment()) steps.push(stepShell(4, T['book.step_pay'], '', paymentStep));
    root.replaceChildren(el('ol', { class: 'steps' }, steps), summary());
    if (active) { var again = document.getElementById(active); if (again) again.focus(); }
  }

  // ---------- presets from links on the home page ----------
  var P = D.preset || {};
  if (P.service && D.services.some(function (s) { return s.id === P.service; })) {
    state.service = P.service;
    var s0 = svc();
    if (P.staff && s0.staff.indexOf(P.staff) >= 0) state.staff = P.staff;
    state.staffChosen = true;
    state.step = 2;
    state.date = P.date && P.date >= D.today ? P.date : D.today;
    loadDays(D.today);
    loadSlots(P.time);
  } else if (D.services.length === 1) {
    chooseService(D.services[0].id);
  }
  render();
})();
