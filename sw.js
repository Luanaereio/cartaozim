/* Cartaozim, service worker: guarda a casca do app para abrir rapido e sem rede. A API nunca e cacheada. */
var VERSAO = 'cartaozim-v1';
var CASCA = ['./', './index.html', './estilo.css', './app.js', './manifest.webmanifest', './icones/icone.svg', './icones/icone-192.png', './icones/icone-512.png'];

self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(VERSAO).then(function (c) { return c.addAll(CASCA); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (chaves) {
    return Promise.all(chaves.filter(function (k) { return k !== VERSAO; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (ev) {
  var url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.pathname.indexOf('/api/') !== -1 || url.origin !== location.origin) return;
  // rede primeiro (para pegar versao nova), cache se a rede falhar
  ev.respondWith(fetch(ev.request).then(function (resp) {
    var copia = resp.clone();
    caches.open(VERSAO).then(function (c) { c.put(ev.request, copia); });
    return resp;
  }).catch(function () { return caches.match(ev.request).then(function (r) { return r || caches.match('./index.html'); }); }));
});
