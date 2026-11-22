/* Baby Cheetah offline support. Game files: newest from the internet first, saved copy when offline. */
const CACHE='cbt-cache-v1';
const SHELL=['./','voice.json','states.json','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png'];
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
  }else if(/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)){
    e.respondWith(caches.match(req).then(m=>m||fetch(req).then(res=>keep(req,res))));
  }
});
