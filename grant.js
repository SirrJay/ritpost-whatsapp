const btn = document.getElementById('allow');
const status = document.getElementById('status');

function done(ok) {
  status.className = ok ? 'ok' : 'bad';
  status.textContent = ok
    ? 'Done. RitPost will now click Post by itself. This window closes in a moment.'
    : 'Not allowed. Click Post yourself on Facebook, or try again.';
  btn.disabled = ok;
  if (ok) setTimeout(() => window.close(), 1800);
}

chrome.permissions.contains({ permissions: ['debugger'] }).then((has) => has && done(true));

btn.addEventListener('click', () => {
  chrome.permissions
    .request({ permissions: ['debugger'] })
    .then(done)
    .catch((e) => {
      done(false);
      status.textContent += ' (' + (e?.message || e) + ') Reload RitPost at chrome://extensions to turn real clicks on.';
    });
});
