#!/usr/bin/env node
/* Builds the installable (home-screen) version of Cheetah and Bear Trail.
   Source of truth: games/little-fox-trail.html (the page published in Claude).
   Output: games/app/  — a static folder any HTTPS host can serve.
   Run:  node games/build-app.js   after every change to the game file. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const src = fs.readFileSync(path.join(__dirname, 'little-fox-trail.html'), 'utf8');
const out = path.join(__dirname, 'app');
fs.mkdirSync(out, { recursive: true });

const cut = src.indexOf('<section');
if (cut < 0) throw new Error('Could not find the start of the page body');
const head = src.slice(0, cut), body = src.slice(cut);
const version = crypto.createHash('sha256').update(src).digest('hex').slice(0, 10);

const updater = `
<script>
/* Home-screen app: stay installed offline, and look for a newer game every time the app is opened. */
(function(){
  if(!('serviceWorker' in navigator)||!/^https?:/.test(location.protocol))return;
  navigator.serviceWorker.register('sw.js').catch(function(){});
  var MINE='${version}',last=0;
  function check(){
    if(Date.now()-last<60000)return;last=Date.now();
    fetch('version.json?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
      var v=j&&j.version,tried='';
      try{tried=sessionStorage.getItem('cbt-tried')||''}catch(e){}
      if(!v||v===MINE||tried===v)return;
      (function go(){ /* only swap versions on the home screen, never in the middle of a game */
        if(document.getElementById('home').hidden){setTimeout(go,3000);return}
        try{sessionStorage.setItem('cbt-tried',v)}catch(e){}
        location.reload();
      })();
    }).catch(function(){});
  }
  check();
  document.addEventListener('visibilitychange',function(){if(!document.hidden)check()});
})();
</script>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Cheetah &amp; Bear">
<meta name="theme-color" content="#DDF1F5">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" href="icon-192.png">
<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
${head}</head>
<body>
${body}${updater}
</body>
</html>
`;

const manifest = {
  name: 'Cheetah and Bear Trail', short_name: 'Cheetah & Bear',
  description: 'Climb the trail and play a game at every stop.',
  start_url: './', scope: './', display: 'standalone', orientation: 'any',
  background_color: '#DDF1F5', theme_color: '#DDF1F5',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const sw = `/* Cheetah and Bear Trail offline support. Game files: newest from the internet first, saved copy when offline. */
const CACHE='cbt-cache-v1';
const SHELL=['./','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}))});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
const keep=(req,res)=>{if(res&&(res.ok||res.type==='opaque')){const cp=res.clone();caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{})}return res};
const saved=req=>caches.match(req,{ignoreSearch:true}).then(m=>m||(req.mode==='navigate'?caches.match('./'):undefined));
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const u=new URL(req.url);
  if(u.pathname.endsWith('version.json'))return;               /* the update check always goes to the internet */
  if(u.origin===location.origin){
    const fresh=fetch(u.href,{cache:'no-cache'}).then(res=>keep(req,res));
    const slow=new Promise((_,no)=>setTimeout(no,4000));
    e.respondWith(Promise.race([fresh,slow]).catch(()=>saved(req).then(m=>m||fresh)));
  }else if(/fonts\\.(googleapis|gstatic)\\.com$/.test(u.hostname)){
    e.respondWith(caches.match(req).then(m=>m||fetch(req).then(res=>keep(req,res))));
  }
});
`;

fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'sw.js'), sw);
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version }) + '\n');
console.log('Built games/app  version ' + version);
