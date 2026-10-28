// Photo uploads: each image is decoded in the browser (which applies the
// phone's rotation), scaled to at most 2000px and re-encoded through a canvas.
// That keeps uploads small and drops all metadata, GPS position included.
// PNGs stay PNG (logos with transparency); everything else becomes JPEG.
(function () {
  'use strict';
  var input = document.getElementById('media-files');
  if (!input) return;
  var status = document.getElementById('media-status');
  var MAX_SIDE = 2000;
  var msg = input.dataset;

  function line(text) {
    var li = document.createElement('li');
    li.textContent = text;
    status.appendChild(li);
    return li;
  }

  function reencode(file) {
    return createImageBitmap(file).then(function (bmp) {
      var scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      var type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('encode')); }, type, 0.85);
      });
    });
  }

  function upload(file) {
    var li = line(file.name + ': ' + msg.msgWorking + '…');
    return reencode(file).catch(function () { throw new Error(msg.msgUnreadable); }).then(function (blob) {
      return fetch('/admin/media/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': blob.type, 'x-csrf-token': msg.csrf, 'x-file-name': encodeURIComponent(file.name) },
        body: blob,
      });
    }).then(function (r) {
      if (r.ok) { li.textContent = file.name + ': ' + msg.msgDone; return true; }
      return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
    }).catch(function (e) {
      li.textContent = file.name + ': ' + msg.msgFailed + '. ' + e.message;
      li.className = 'field-error';
      return false;
    });
  }

  input.addEventListener('change', function () {
    var files = Array.prototype.slice.call(input.files);
    input.value = '';
    status.textContent = '';
    // One at a time: phones run out of memory decoding several big photos at once.
    files.reduce(function (p, f) { return p.then(function (ok) { return upload(f).then(function (r) { return ok && r; }); }); }, Promise.resolve(true))
      .then(function (allOk) { if (allOk) window.location.reload(); });
  });
})();
