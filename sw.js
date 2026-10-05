/* Service worker: lets the app open instantly and offline once installed.
   - Your own files: always re-checked with the server (so updates show up right away), falling back to the cached copy offline.
   - Fonts and libraries from CDNs: served from cache, refreshed in the background.
   - Supabase (your data) is never cached here; it always goes to the network. */
const CACHE = 'kaban-v4';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'js/theme.js', 'js/config.js', 'js/app.js', 'js/cloud.js',
  'vendor/chart.umd.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', (event)=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', (event)=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', (event)=>{
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.hostname.endsWith('supabase.co')) return;
  if(url.origin === self.location.origin){
    event.respondWith(
      // 'no-cache' makes the browser re-check with GitHub every time instead of reusing a copy for up to 10 minutes.
      fetch(new Request(req.url, {cache:'no-cache', credentials:'same-origin'})).then(res=>{
        if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c=>c.put(req, copy)); }
        return res;
      }).catch(()=> caches.match(req).then(hit=> hit || (req.mode==='navigate' ? caches.match('index.html') : undefined)))
    );
    return;
  }
  if(/(^|\.)(jsdelivr\.net|googleapis\.com|gstatic\.com)$/.test(url.hostname)){
    event.respondWith(
      caches.open(CACHE).then(cache=> cache.match(req).then(hit=>{
        const network = fetch(req).then(res=>{ if(res.ok || res.type==='opaque') cache.put(req, res.clone()); return res; }).catch(()=>hit);
        return hit || network;
      }))
    );
  }
});
