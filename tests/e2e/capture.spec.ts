import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createFixtureServer } from '../../scripts/fixture-server';

let context: BrowserContext;
let profile: string;
let workspace: Page;
let source: Page;
let fixture: ReturnType<typeof createFixtureServer>;
let origin: string;
let sectionIds: string[];

test.beforeAll(async () => {
  await mkdir(resolve('.tmp'), { recursive: true });
  await mkdir(resolve('verification/screenshots'), { recursive: true });
  profile = await mkdtemp(resolve('.tmp/capture-profile-'));
  const extension = resolve('dist/extension');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--enable-unsafe-extension-debugging"],
    viewport: { width: 1440, height: 1000 },
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  fixture = createFixtureServer();
  await new Promise<void>((done) => fixture.server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(fixture.server.address() as AddressInfo).port}`;
  workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${id}/workspace.html`);
  source = await context.newPage();
});
test.afterAll(async () => {
  await context?.close();
  await fixture?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});
async function message(payload: unknown) {
  return workspace.evaluate((request) => chrome.runtime.sendMessage(request), payload);
}

test('installed extension captures only the chosen section using the actual authenticated browser session', async () => {
  const unauthenticated = await fetch(origin + '/pluginfile.php/1/F1/slides.pdf');
  expect(unauthenticated.status).toBe(401);
  await source.goto(origin);
  await source.getByRole('button', { name: 'Enter demo course' }).click();
  await expect(source.getByRole('heading', { name: 'Synthetic economics: visual reasoning' })).toBeVisible();
  await source.bringToFront();
  const browserSession = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{type:'tab'}, {exclude:true}] });
  const tabTarget = targetInfos.find(target => target.url === source.url());
  expect(tabTarget, JSON.stringify(targetInfos)).toBeTruthy();
  await browserSession.send('Extensions.triggerAction' as any, { id: new URL(workspace.url()).host, targetId: tabTarget!.targetId });
  const bound = await message({type:'LIST_SECTIONS'});
  expect(bound.ok, JSON.stringify(bound)).toBe(true);
  expect(bound.data.sections).toHaveLength(2);
  sectionIds = bound.data.sections.map((section: any) => section.id);
  const capture = await message({type:'CAPTURE_SECTION',sectionId:bound.data.sections[0].id});
  expect(capture.ok,JSON.stringify(capture)).toBe(true);
  expect(capture.data.text).toContain('initial equilibrium');
  for (const forbidden of ['UNSELECTED_WEEK_TWO_TEXT','DO_NOT_CAPTURE_FORM_VALUE','DO_NOT_CAPTURE_HIDDEN_TOKEN','DO_NOT_CAPTURE_HIDDEN_TEXT','DO_NOT_CAPTURE_PAGE_SCRIPT','DO_NOT_CAPTURE_PROFILE']) expect(capture.data.text).not.toContain(forbidden);
  const direct = capture.data.resources.find((resource: any) => resource.title.includes('slide PDF'));
  const imported = await message({type:'IMPORT_RESOURCE',resourceId:direct.id});
  expect(imported.ok,JSON.stringify(imported)).toBe(true);
  expect(imported.data.acquisition).toBe('browser_capture');
  expect(Buffer.from(imported.data.base64,'base64').subarray(0,5).toString()).toBe('%PDF-');
  expect(imported.data.sha256).toMatch(/^[a-f0-9]{64}$/);
  // A fresh server-side client still has no browser session after successful extension capture.
  expect((await fetch(origin+'/pluginfile.php/1/F1/slides.pdf')).status).toBe(401);
  await source.screenshot({path:'verification/screenshots/session-protected-course.png',fullPage:true});
});

test('installed bridge refuses external/activity/action retrieval, arbitrary URLs and stale capture IDs', async () => {
  await source.bringToFront();
  const capture = await message({type:'CAPTURE_SECTION',sectionId:sectionIds[0]});
  expect(capture.ok).toBe(true);
  for (const resource of capture.data.resources.filter((resource: any) => !resource.allowed)) {
    expect((await message({type:'IMPORT_RESOURCE',resourceId:resource.id})).ok).toBe(false);
  }
  expect((await message({type:'IMPORT_RESOURCE',resourceId:crypto.randomUUID(),url:'https://example.invalid/fetch'})).ok).toBe(false);
  expect(fixture.requests.filter((request) => /mod\/resource|logout|user\/index/.test(request.pathname))).toHaveLength(0);
  const resourceId = capture.data.resources.find((resource: any) => resource.allowed).id;
  await message({type:'CAPTURE_SECTION',sectionId:sectionIds[1]});
  expect((await message({type:'IMPORT_RESOURCE',resourceId})).ok).toBe(false);
  await source.goto(origin+'/');
  const revoked = await message({type:'LIST_SECTIONS'});
  expect(revoked.ok).toBe(false);
  expect(revoked.error).toMatch(/revoked|bound|source|again/i);
});

test('normal website cannot invoke the extension bridge or read trusted session storage', async () => {
  const extensionId = new URL(workspace.url()).host;
  const attempt = await source.evaluate(async (id) => {
    try {
      const runtime = (globalThis as any).chrome?.runtime;
      if (!runtime?.sendMessage) return 'no-external-runtime';
      return await runtime.sendMessage(id,{type:'LIST_SECTIONS'});
    } catch { return 'rejected'; }
  },extensionId);
  expect(['no-external-runtime','rejected',undefined]).toContain(attempt);
});
