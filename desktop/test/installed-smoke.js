// Run by CI against the installed program, started with --remote-debugging-port=<port>:
//   node test/installed-smoke.js <port>
// The receiver answering is not enough: a build can serve files and still show a blank
// window. This checks that the window drew Flingo's page with its sections and its API, and
// that the arrival screen is there too. Exits with 1 and says why if anything is missing.
const port = Number(process.argv[2] || 9222);

async function pages() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
      const main = list.find((t) => t.type === 'page' && t.url.endsWith('/index.html'));
      if (main) return list;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The window never appeared.');
}

async function evaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Could not attach to the window.')); });
  const answer = new Promise((resolve) => { ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id === 1) resolve(msg.result); }; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  const result = await answer;
  ws.close();
  return result.result.value;
}

(async () => {
  const list = await pages();
  const main = list.find((t) => t.type === 'page' && t.url.endsWith('/index.html'));
  // The page may still be starting: give it a few seconds to draw.
  let seen;
  for (let i = 0; i < 20; i++) {
    seen = await evaluate(main, `(async () => ({
      href: location.href.split('/').pop(),
      tabs: document.querySelectorAll('.tab').length,
      api: typeof window.flingo === 'object' && typeof window.flingo.getState === 'function',
      node: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
      version: window.flingo ? (await window.flingo.getState()).version : '',
    }))()`);
    if (seen && seen.tabs >= 4 && seen.api) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('main window:', JSON.stringify(seen));
  const overlay = list.find((t) => t.type === 'page' && t.url.endsWith('/overlay.html'));
  const problems = [];
  if (!seen || seen.href !== 'index.html') problems.push('the window is not showing index.html');
  if (!seen || seen.tabs < 4) problems.push('the sections were not drawn');
  if (!seen || !seen.api) problems.push("the window has no Flingo API (preload did not run)");
  if (seen && seen.node) problems.push('the page can reach Node');
  if (!overlay) problems.push('there is no arrival screen');
  if (problems.length) { console.error(`::error::${problems.join('; ')}`); process.exit(1); }
  console.log(`Flingo ${seen.version} drew its window and its arrival screen.`);
})().catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
