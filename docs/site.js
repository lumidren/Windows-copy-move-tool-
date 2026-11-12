// Point the main button at the right download for the visitor's device.
(function () {
  var ua = navigator.userAgent || '';
  var os = /Android/i.test(ua) ? 'android' : /Windows/i.test(ua) ? 'windows' : /Linux|X11/i.test(ua) ? 'linux' : null;
  if (!os) return;
  var card = document.querySelector('.downloads article[data-os="' + os + '"]');
  var main = document.getElementById('main-download');
  var note = document.getElementById('detected');
  if (!card || !main) return;
  card.classList.add('you');
  var label = { android: 'Android', windows: 'Windows', linux: 'Linux' }[os];
  main.textContent = 'Download for ' + label;
  main.href = card.querySelector('a.btn.primary').href;
  var other = os === 'android' ? 'Then install it on your computer too.' : 'Then install the Android app on your phone.';
  note.textContent = 'Free and open source. ' + other;
})();
