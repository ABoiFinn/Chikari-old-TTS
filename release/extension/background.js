// Generic same-extension CORS proxy: the content script (bound by normal
// page CORS rules) asks the background service worker (which is exempt,
// thanks to host_permissions) to make requests to the local TTS server.

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== "proxyFetch") return false;

  (async () => {
    try {
      const opts = { method: msg.method || "GET" };
      if (msg.body !== undefined) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(msg.body);
      }
      const res = await fetch(msg.url, opts);
      if (msg.binary) {
        const buf = await res.arrayBuffer();
        sendResponse({ ok: res.ok, status: res.status, base64: arrayBufferToBase64(buf) });
      } else {
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, text });
      }
    } catch (e) {
      const friendly = /failed to fetch/i.test(e.message)
        ? "Can't reach the local server on 127.0.0.1:8790 - is server.py (Start Server.bat) running?"
        : e.message;
      sendResponse({ ok: false, status: 0, error: friendly });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});
