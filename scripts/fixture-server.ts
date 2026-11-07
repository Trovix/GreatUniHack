import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
const cookieName = 'lecture_access_synthetic_session';
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const page = (title: string, content: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — synthetic fixture</title><style>body{font:18px/1.65 system-ui,sans-serif;max-width:920px;margin:32px auto;padding:0 24px;color:#171717;background:#fff}h1{line-height:1.1}section{border:2px solid #171717;padding:24px;margin:24px 0}button,a{min-height:44px}button{padding:12px 20px;background:#171717;color:white;border:2px solid #171717;font:inherit;cursor:pointer}a{color:#174b91;text-underline-offset:4px}li{margin:12px 0}:focus-visible{outline:3px solid #a54200;outline-offset:4px}.notice{border-left:5px solid #171717;padding:12px 20px;background:#f5f5f5}label{display:block}input{font:inherit}</style></head><body>${content}</body></html>`;

export function createFixtureServer() {
  const sessions = new Map<string, number>();
  const requests: { method: string; pathname: string; authenticated: boolean }[] = [];
  const server = http.createServer(async (request, response) => {
    const host = `127.0.0.1:${(request.socket.address() as {port: number}).port}`;
    if (request.headers.host !== host) { response.writeHead(403).end('Unexpected fixture Host'); return; }
    const target = request.url || '/';
    let url: URL;
    try {
      if (!target.startsWith('/') || target.startsWith('//') || target.length > 4096) throw new Error('Invalid request target');
      url = new URL(target, `http://${host}`);
      if (url.origin !== `http://${host}`) throw new Error('Invalid request origin');
    } catch { response.writeHead(400).end('Malformed fixture request target'); return; }
    const now = Date.now();
    for (const [value, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(value);
    const session = (request.headers.cookie || '').split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const authenticated = Boolean(session && sessions.has(session));
    if (requests.length === 1024) requests.shift();
    requests.push({ method: request.method || 'GET', pathname: url.pathname, authenticated });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    if (request.method === 'POST' && url.pathname === '/enter') {
      if (request.headers.origin !== `http://${host}` || request.headers['sec-fetch-site'] === 'cross-site') { response.writeHead(403).end('Use the Enter demo course button on this local page.'); return; }
      const value = randomBytes(24).toString('hex');
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
      sessions.set(value, now + 14_400_000);
      response.setHeader('Set-Cookie', `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`);
      response.writeHead(303, { Location: '/course/view.php' }).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD, POST' }).end(); return; }
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Enter demo course', '<h1>Lecture Access synthetic course</h1><p class="notice">Session-protected Moodle-like fixture. This is not Moodle, a university account, or real student material. No credentials are needed.</p><form method="post" action="/enter"><button type="submit">Enter demo course</button></form><p>Opening this course explicitly establishes a local HttpOnly demo session. The extension must retrieve selected resources in this browser session; Node does not inherit it.</p>'));
      return;
    }
    if (!authenticated) {
      response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Demo session required', '<h1>Demo session required</h1><p>Resources are protected by the local browser session.</p><a href="/">Enter the synthetic course</a>'));
      return;
    }
    if (url.pathname === '/course/view.php') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Synthetic economics course', `<nav aria-label="Course navigation"><a href="/user/index.php">Participants — irrelevant</a> · <a href="/grade/report.php">Private grades — excluded</a></nav><main><h1>Synthetic economics: visual reasoning</h1><p class="notice">Authored demo material only. This fixture exercises one Moodle-like layout, not real Moodle compatibility.</p><section class="course-section" data-sectionid="1" aria-labelledby="week-one"><h2 id="week-one">Week 1 — demand, supply and grouped notation</h2><p>This selected teaching section compares an initial equilibrium with a demand change. A later equation needs its numerator and denominator explained. The lecture returns to its earlier diagram for reference.</p><ul><li><a href="/pluginfile.php/1/F1/slides.pdf">Lecture slide PDF — direct same-origin file</a></li><li><a href="/pluginfile.php/1/F1/captions.vtt">Supplied timestamped captions — VTT</a></li><li><a href="/pluginfile.php/1/F1/V1.png">Initial equilibrium image — PNG</a></li><li><a href="/mod/resource/view.php">Redirecting slide activity — open original/manual import</a></li><li><a href="https://example.invalid/synthetic-recording">External recording — not automatically imported</a></li><li><a href="/user/index.php">Student list — not teaching material</a></li><li><a href="/login/logout.php?sesskey=SYNTHETIC_NOT_A_REAL_SECRET">Logout action — must never be followed</a></li></ul><form><label>Excluded demonstration form value<input name="private" value="DO_NOT_CAPTURE_FORM_VALUE"></label><input type="hidden" value="DO_NOT_CAPTURE_HIDDEN_TOKEN"></form><div hidden>DO_NOT_CAPTURE_HIDDEN_TEXT</div><script type="application/json">{"private":"DO_NOT_CAPTURE_PAGE_SCRIPT"}</script></section><section class="course-section" data-sectionid="2"><h2>Week 2 — unselected material</h2><p>UNSELECTED_WEEK_TWO_TEXT must not appear when only Week 1 is captured.</p><a href="/pluginfile.php/2/F2/captions.vtt">Demand-decrease captions</a></section></main><aside><h2>Private profile</h2><p>DO_NOT_CAPTURE_PROFILE</p></aside>`));
      return;
    }
    if (url.pathname === '/mod/resource/view.php') { response.writeHead(302, { Location: '/pluginfile.php/1/F1/slides.pdf' }).end(); return; }
    const match = /^\/pluginfile\.php\/(?:1|2)\/(F1|F2|F3|F4a|F4b)\/(slides\.pdf|captions\.vtt|V[1-4]\.png|source\.wav)$/.exec(url.pathname);
    if (match) {
      try {
        const bytes = await readFile(resolve(fixtureRoot, match[1], match[2]));
        const mime = match[2].endsWith('.pdf') ? 'application/pdf' : match[2].endsWith('.vtt') ? 'text/vtt' : match[2].endsWith('.png') ? 'image/png' : 'audio/wav';
        response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.byteLength, 'Content-Disposition': `inline; filename="${match[2]}"` });
        response.end(request.method === 'HEAD' ? undefined : bytes);
      } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Synthetic asset not generated yet. Run npm run fixtures.'); }
      return;
    }
    if (/logout|user\/|grade\//.test(url.pathname)) { response.writeHead(403).end('This fixture action/personal-data endpoint must not be imported.'); return; }
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not a synthetic fixture resource.');
  });
  return { server, requests, close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { server } = createFixtureServer();
  server.listen(4318, '127.0.0.1', () => console.log('Synthetic session fixture: http://127.0.0.1:4318 (not Moodle)'));
}
