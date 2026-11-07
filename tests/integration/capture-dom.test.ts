import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFixtureServer } from '../../scripts/fixture-server';
import { captureOperation } from '../../apps/extension/src/capture';

// Real Chromium DOM execution; this suite does not claim installed-extension
// activeTab permission verification (the separate E2E suite covers that boundary).
describe('rendered selected-section capture in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let fixture: ReturnType<typeof createFixtureServer>;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    fixture = createFixtureServer();
    await new Promise<void>((done) => fixture.server.listen(0, '127.0.0.1', done));
    await page.goto(`http://127.0.0.1:${(fixture.server.address() as AddressInfo).port}`);
  });
  afterAll(async () => { await browser?.close(); await fixture?.close(); });
  async function preview() { return page.evaluate(captureOperation, { type: 'sections' } as const) as Promise<any>; }
  async function capture(sectionId: string) { return page.evaluate(captureOperation, { type: 'section', sectionId } as const) as Promise<any>; }

  it('retains the selected node after DOM reorder and rejects a replaced/hidden node', async () => {
    await page.setContent('<main><h1>Course</h1><section class="course-section" id="one"><h2>Week 1</h2><p>FIRST_TEACHING</p></section><section class="course-section" id="two"><h2>Week 2</h2><p>SECOND_TEACHING</p></section></main>');
    const before = await preview();
    await page.evaluate(() => document.querySelector('main')!.prepend(document.querySelector('#two')!));
    expect((await capture(before.sections[0].id)).text).toContain('FIRST_TEACHING');
    expect((await capture(before.sections[0].id)).text).not.toContain('SECOND_TEACHING');
    await page.evaluate(() => (document.querySelector('#one') as HTMLElement).hidden = true);
    await expect(capture(before.sections[0].id)).rejects.toThrow(/changed|no longer/);
  });
  it('invalidates previous UUID selections after a new preview rather than reusing ordinal IDs', async () => {
    await page.setContent('<main><h1>Course</h1><section class="course-section"><h2>Week 1</h2><p>Teaching</p></section></main>');
    const first = await preview(), second = await preview();
    expect(first.sections[0].id).not.toBe(second.sections[0].id);
    await expect(capture(first.sections[0].id)).rejects.toThrow(/changed|no longer/);
    expect((await capture(second.sections[0].id)).text).toContain('Teaching');
  });
  it('aborts a declared-oversize response before it continues downloading in the background', async () => {
    let sent = 0, closed = false;
    const server = http.createServer((request, response) => {
      if (request.url !== '/huge.pdf') { response.end('<h1>Local resource test</h1>'); return; }
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 100 * 1024 * 1024 });
      const timer = setInterval(() => { sent += 16 * 1024; response.write(Buffer.alloc(16 * 1024)); }, 2);
      response.on('close', () => { closed = true; clearInterval(timer); });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await page.goto(origin);
      await expect(page.evaluate(captureOperation, { type: 'resource', url: origin + '/huge.pdf', expectedMime: 'application/pdf', maxBytes: 5 * 1024 * 1024 } as const)).rejects.toThrow(/size limit/);
      await expect.poll(() => closed).toBe(true);
      expect(sent).toBeLessThan(2 * 1024 * 1024);
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it('excludes hidden/personal/form/script metadata and resource anchors using the same rules', async () => {
    await page.setContent(`<main><h1>Visible course<span hidden>HIDDEN_COURSE</span></h1><section class="course-section"><h2>Week 1<span hidden>HIDDEN_HEADING</span></h2><p>VISIBLE_TEACHING</p><p style="display:contents">VISIBLE_CONTENTS</p><a href="/slides.pdf">Visible slides<span hidden>HIDDEN_LINK</span><script type="application/json">SCRIPT_SECRET</script></a><aside><a href="/private.pdf">Individual feedback</a><p>ASIDE_SECRET</p></aside><nav><a href="/nav.pdf">Nav resource</a></nav><form><a href="/form.pdf">Form resource</a><input value="FORM_SECRET"></form><div class="participants"><a href="/students.pdf">Student resource</a></div><div style="opacity:0"><a href="/opacity.pdf">Opacity resource</a><p>OPACITY_SECRET</p></div><details><summary>Closed disclosure</summary><p>CLOSED_SECRET</p><a href="/closed.pdf">Closed file</a></details><div style="height:0;width:0;overflow:hidden"><p>CLIPPED_SECRET</p><a href="/clip.pdf">Clipped resource</a></div></section></main>`);
    const sections = await preview(), result = await capture(sections.sections[0].id);
    expect(result.courseTitle).toBe('Visible course');
    expect(sections.sections[0].title).toBe('Week 1');
    expect(result.text).toContain('VISIBLE_TEACHING'); expect(result.text).toContain('VISIBLE_CONTENTS');
    for (const value of ['HIDDEN_', 'SCRIPT_SECRET', 'ASIDE_SECRET', 'FORM_SECRET', 'OPACITY_SECRET', 'CLOSED_SECRET', 'CLIPPED_SECRET']) expect(JSON.stringify(result)).not.toContain(value);
    expect(result.resources.map((resource: any) => resource.title)).toEqual(['Visible slides']);
    expect(result.resources[0].url).toMatch(/\/slides\.pdf$/);
  });
});
