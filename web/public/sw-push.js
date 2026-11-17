// Se importa dentro del service worker generado por vite-plugin-pwa (workbox.importScripts).
// Muestra los avisos push y abre la app al tocarlos.
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch (e) { d = { titulo: 'Contador de cajas', cuerpo: event.data && event.data.text() } }
  const titulo = d.titulo || 'Contador de cajas'
  event.waitUntil(self.registration.showNotification(titulo, {
    body: d.cuerpo || '',
    icon: '/icono-192.png',
    badge: '/icono-192.png',
    tag: d.etiqueta || d.tipo || 'aviso',
    renotify: true,
    requireInteraction: d.tipo === 'atasco',
    data: { url: d.url || '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const v of ventanas) {
      if ('focus' in v) { await v.focus(); if ('navigate' in v) v.navigate(url); return }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url)
  })())
})
