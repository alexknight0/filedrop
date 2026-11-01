// Service worker: only receives files shared to File drop from other apps (Android share
// sheet, via "share_target" in manifest.webmanifest). GitHub Pages can't accept the POST, so the
// worker answers it: it stores the files in Cache Storage and redirects to the page, which
// uploads them once signed in (see takeShared in app.js). Every other request goes to the network
// untouched; this worker caches nothing else, so it can't serve stale app files.
const SHARE_CACHE = "filedrop-share"; // origin is shared with Alex's other sites; keep the prefix

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(receiveShare(event.request));
  }
});

async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll("files").filter((f) => f instanceof File);
  const cache = await caches.open(SHARE_CACHE);
  const stamp = Date.now();
  await Promise.all(files.map((f, i) => cache.put(`share/${stamp}-${i}`, new Response(f, {
    headers: {
      "Content-Type": f.type || "application/octet-stream",
      "X-Name": encodeURIComponent(f.name || "shared file"),
    },
  }))));
  return Response.redirect(new URL(`./?shared=${files.length}`, self.registration.scope).href, 303);
}
