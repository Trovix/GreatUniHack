import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createFixtureServer } from '../../scripts/fixture-server';

describe('session-protected synthetic course fixture', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
  async function setup() {
    const fixture = createFixtureServer();
    await new Promise<void>((resolve) => fixture.server.listen(0,'127.0.0.1',resolve));
    cleanup.push(fixture.close);
    return { ...fixture, origin:`http://127.0.0.1:${(fixture.server.address() as AddressInfo).port}` };
  }
  it('never serves course resources to a fresh unauthenticated Node client', async () => {
    const fixture = await setup();
    const response = await fetch(fixture.origin + '/pluginfile.php/1/F1/slides.pdf');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('text/html');
    const entry = await fetch(fixture.origin);
    expect(await entry.text()).toContain('Enter demo course');
  });
  it('requires explicit same-origin entry and issues an HttpOnly scoped session', async () => {
    const fixture = await setup();
    const refused = await fetch(fixture.origin+'/enter',{method:'POST',headers:{Origin:'https://evil.invalid'},redirect:'manual'});
    expect(refused.status).toBe(403);
    const entry = await fetch(fixture.origin+'/enter',{method:'POST',headers:{Origin:fixture.origin},redirect:'manual'});
    expect(entry.status).toBe(303);
    const cookie = entry.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
    const course = await fetch(fixture.origin+'/course/view.php',{headers:{Cookie:cookie.split(';')[0]}});
    expect(course.status).toBe(200);
    expect(await course.text()).toContain('Week 1 — demand, supply and grouped notation');
    expect((await fetch(fixture.origin+'/course/view.php')).status).toBe(401);
  });
  it('keeps activity redirects explicit and refuses actions', async () => {
    const fixture = await setup();
    const entry = await fetch(fixture.origin+'/enter',{method:'POST',headers:{Origin:fixture.origin},redirect:'manual'});
    const headers = {Cookie:entry.headers.get('set-cookie')!.split(';')[0]};
    const activity = await fetch(fixture.origin+'/mod/resource/view.php',{headers,redirect:'manual'});
    expect(activity.status).toBe(302);
    expect(activity.headers.get('location')).toBe('/pluginfile.php/1/F1/slides.pdf');
    expect((await fetch(fixture.origin+'/login/logout.php',{headers})).status).toBe(403);
    expect((await fetch(fixture.origin+'/user/index.php',{headers})).status).toBe(403);
  });
});
