/**
 * W3 骨架 Service Worker：只缓存应用外壳（app shell），**绝不缓存会话数据**。
 * 事件与会话列表永远是网络优先——离线时看到旧会话流比看到空页面更容易误判，
 * 所以数据请求直接放行网络，失败就让它失败（UI 有错误提示）。
 */
const SHELL_CACHE = 'wbsync-shell-v2'
const SHELL_ASSETS = ['./index.html', './manifest.webmanifest', './icon.svg', '../src/client.js', '../src/pairing.js']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // /api/* 与 /d/* 是业务通道：网络直连，不读缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/')) return
  if (event.request.method !== 'GET') return
  event.respondWith(
    caches.match(event.request).then((hit) => hit ?? fetch(event.request)),
  )
})
