/* Lewisis' Music (web version) — the visitor's library, kept in their own
 * browser (IndexedDB). Shared by the service worker (which answers the
 * interface's /api/... requests), the page and the separation worker.
 *
 *   tracks     id → song record (the same fields as the desktop library.json)
 *   files      id → the song itself (a Blob)
 *   covers     "track:<id>" / "playlist:<id>" → picture (Blob)
 *   playlists  id → playlist record
 *   lyrics     id → saved lyrics { source, text, instrumental }
 *   stems      "<id>/vocals" / "<id>/instrumental" → separated audio (FLAC Blob)
 *   jobs       id → separation status { state, progress, stage, error, urgent, queuedAt }
 *   settings   "settings" → { autoPrepare }
 */
(function () {
     "use strict";
     const NAME = "lewisis-music";
     const STORES = ["tracks", "files", "covers", "playlists", "lyrics", "stems", "jobs", "settings"];
     let opening = null;

     function open() {
          opening ||= new Promise((resolve, reject) => {
               const request = indexedDB.open(NAME, 1);
               request.onupgradeneeded = () => {
                    for (const name of STORES)
                         if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
               };
               request.onsuccess = () => {
                    const db = request.result;
                    db.onversionchange = () => db.close();
                    resolve(db);
               };
               request.onerror = () => reject(request.error);
               request.onblocked = () => reject(new Error("The music library is open in an older version of this page; close other tabs of it and try again."));
          }).catch(error => {
               opening = null;
               throw error;
          });
          return opening;
     }

     // One request in its own transaction.
     async function run(store, mode, action) {
          const db = await open();
          return new Promise((resolve, reject) => {
               const transaction = db.transaction(store, mode);
               const request = action(transaction.objectStore(store));
               transaction.oncomplete = () => resolve(request?.result);
               transaction.onerror = () => reject(transaction.error);
               transaction.onabort = () => reject(transaction.error || new Error("Saving was cancelled (is the browser out of space?)."));
          });
     }

     const get = (store, key) => run(store, "readonly", s => s.get(key));
     const put = (store, key, value) => run(store, "readwrite", s => s.put(value, key));
     const remove = (store, key) => run(store, "readwrite", s => s.delete(key));
     const keys = store => run(store, "readonly", s => s.getAllKeys());

     // Every record in a store, as [key, value] pairs.
     async function entries(store) {
          const db = await open();
          return new Promise((resolve, reject) => {
               const transaction = db.transaction(store, "readonly");
               const found = [];
               const cursor = transaction.objectStore(store).openCursor();
               cursor.onsuccess = () => {
                    const at = cursor.result;
                    if (!at) return;
                    found.push([at.key, at.value]);
                    at.continue();
               };
               transaction.oncomplete = () => resolve(found);
               transaction.onerror = () => reject(transaction.error);
          });
     }
     // Records that keep their order (songs, playlists) carry a `seq` number.
     const ordered = async store => (await entries(store)).map(([, value]) => value).sort((a, b) => (a.seq || 0) - (b.seq || 0));

     // Tells every open page and worker that separation jobs changed.
     const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("lewisis-separation") : null;
     const announce = message => channel?.postMessage(message);

     self.LewisisStore = { open, get, put, remove, keys, entries, ordered, channel, announce };
})();
