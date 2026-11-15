// Optional offline shell for the local-first risk calculator.
// NEVER caches transaction data, FX API responses or private JSON imports.
const CACHE = 'swing-risk-desk-shell-v1.7';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/lib/risk.mjs', '/lib/calendar.mjs', '/lib/ibkr.mjs', '/lib/ledger.mjs', '/lib/planner.mjs', '/lib/cloud.mjs', '/manifest.webmanifest', '/icons/icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  const req=event.request;
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // API is always live; when offline the UI keeps the last manually entered FX.
  if(new URL(req.url).pathname.startsWith('/api/')) return;
  if(req.mode === 'navigate') {
    event.respondWith(fetch(req).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put('/index.html',copy));}
      return response;
    }).catch(()=>caches.match('/index.html')));
    return;
  }
  event.respondWith(fetch(req).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(req,copy));}
    return response;
  }).catch(()=>caches.match(req)));
});