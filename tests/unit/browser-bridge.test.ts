import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

describe('trusted extension capture bridge', () => {
  let listener: any;
  let updated: any;
  let action: any;
  let state: Record<string, any>;
  let sourceUrl: string;
  let api: any;
  let sectionId: string;
  const ownUrl = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/workspace.html';
  beforeEach(async () => {
    vi.resetModules();
    state = {}; sourceUrl = 'http://127.0.0.1:4318/course/view.php';
    api = {
      storage: { session: { setAccessLevel: vi.fn(async () => {}), get: vi.fn(async () => state), set: vi.fn(async (value) => Object.assign(state, value)), remove: vi.fn(async (key) => { delete state[key]; }) } },
      runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: (path: string) => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/' + path, onMessage: {addListener: (fn: any) => { listener = fn; }} },
      tabs: {get: vi.fn(async () => ({id: 7, url: sourceUrl})), query: vi.fn(async () => [{id: 7,url: sourceUrl}]), create: vi.fn(async () => ({})), onRemoved: {addListener: vi.fn()}, onUpdated: {addListener: (fn: any) => { updated = fn; }}},
      scripting: { executeScript: vi.fn(async ({args}: any) => {
        const op = args[0];
        if (op.type === 'sections') { sectionId = `section-${crypto.randomUUID()}`; return [{result: {courseTitle:'Synthetic course',pageIdentity:sourceUrl,sections:[{id:sectionId,title:'Week 1'}]}}]; }
        if (op.type === 'section') return [{result: {text:'Selected lecture text',resources:[
          {title:'Slides',url:'http://127.0.0.1:4318/pluginfile.php/1/F1/slides.pdf'},
          {title:'Redirecting activity',url:'http://127.0.0.1:4318/mod/resource/view.php'},
          {title:'External recording',url:'https://example.invalid/recording'},
          {title:'Logout',url:'http://127.0.0.1:4318/login/logout.php?sesskey=PRIVATE'},
        ]}}];
        return [{result:{base64:'JVBERi0=',mime:'application/pdf',sha256:'a'.repeat(64),byteLength:5}}];
      }) },
      sidePanel:{open:vi.fn(async () => {})}, action:{onClicked:{addListener:(fn: any) => { action = fn; }}},
    };
    vi.stubGlobal('chrome', api);
    await import('../../apps/extension/src/worker');
  });
  afterEach(() => vi.unstubAllGlobals());
  const send = (message: unknown, url = ownUrl) => new Promise<any>((resolve) => listener(message,{id:'abcdefghijklmnopabcdefghijklmnop',url},resolve));
  it('keeps storage trusted-only and rejects website/content-script messages', async () => {
    expect(api.storage.session.setAccessLevel).toHaveBeenCalledWith({accessLevel:'TRUSTED_CONTEXTS'});
    expect((await send({type:'BIND_ACTIVE_TAB'},'http://127.0.0.1:4318/course/view.php')).ok).toBe(false);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
  it('accepts only opaque discovered resource IDs, not caller URLs or tab IDs', async () => {
    await send({type:'BIND_ACTIVE_TAB'});
    expect((await send({type:'IMPORT_RESOURCE',url:'https://evil.invalid',resourceId:crypto.randomUUID()})).ok).toBe(false);
    expect((await send({type:'CAPTURE_SECTION',sectionId,tabId:10})).ok).toBe(false);
    expect((await send({type:'IMPORT_RESOURCE',resourceId:crypto.randomUUID()})).ok).toBe(false);
  });
  it('imports only the selected direct resource and redacts sensitive navigation queries', async () => {
    await send({type:'BIND_ACTIVE_TAB'});
    const result = await send({type:'CAPTURE_SECTION',sectionId});
    expect(result.ok).toBe(true);
    const resources = result.data.resources;
    expect(resources.filter((r: any) => r.allowed)).toHaveLength(1);
    expect(JSON.stringify(resources)).not.toContain('PRIVATE');
    expect(JSON.stringify(resources)).not.toContain('privateUrl');
    for (const resource of resources.slice(1)) expect((await send({type:'IMPORT_RESOURCE',resourceId:resource.id})).ok).toBe(false);
    const imported = await send({type:'IMPORT_RESOURCE',resourceId:resources[0].id});
    expect(imported.data.acquisition).toBe('browser_capture');
    expect(api.scripting.executeScript.mock.calls.at(-1)[0].target).toEqual({tabId:7,frameIds:[0]});
  });
  it('does not switch to a newly focused tab and invalidates navigation', async () => {
    await send({type:'BIND_ACTIVE_TAB'});
    api.tabs.query.mockResolvedValue([{id:99,url:'http://127.0.0.1:4318/unrelated'}]);
    await send({type:'LIST_SECTIONS'});
    expect(api.scripting.executeScript.mock.calls.at(-1)[0].target.tabId).toBe(7);
    sourceUrl = 'https://unrelated.invalid/course';
    expect((await send({type:'LIST_SECTIONS'})).ok).toBe(false);
    expect(state.captureBinding).toBeUndefined();
  });
  it('opens side panel synchronously before the first awaited binding operation', async () => {
    action({id:7,url:sourceUrl});
    expect(api.sidePanel.open).toHaveBeenCalledWith({tabId:7});
    await new Promise((resolve) => setTimeout(resolve,0));
  });
  it('rejects encoded action paths and malformed path escapes before any resource fetch', async () => {
    const resources = [
      '/%64elete.pdf', '/%2564elete.pdf', '/safe/%73ubmit.png', '/%75ser/private.pdf',
      '/slides%ZZ.pdf', '/safe%5cdelete.pdf', '/feedback/result.pdf',
    ].map((path) => ({ title: 'Selected file', url: 'http://127.0.0.1:4318' + path }));
    const original = api.scripting.executeScript.getMockImplementation();
    api.scripting.executeScript.mockImplementation(async (options: any) => options.args[0].type === 'section' ? [{ result: { text: 'Selected text', resources } }] : original(options));
    await send({ type: 'BIND_ACTIVE_TAB' });
    const capture = await send({ type: 'CAPTURE_SECTION', sectionId });
    expect(capture.ok).toBe(true);
    expect(capture.data.resources.every((resource: any) => !resource.allowed && !resource.canOpen)).toBe(true);
    for (const resource of capture.data.resources) expect((await send({ type: 'IMPORT_RESOURCE', resourceId: resource.id })).ok).toBe(false);
    expect(api.scripting.executeScript.mock.calls.some(([options]: any[]) => options.args[0].type === 'resource')).toBe(false);
  });
  it('rejects earlier preview IDs after another action binds a different source tab', async () => {
    await send({ type: 'BIND_ACTIVE_TAB' });
    const oldSection = sectionId;
    sourceUrl = 'http://127.0.0.1:4318/other-course';
    action({ id: 8, url: sourceUrl });
    const result = await send({ type: 'CAPTURE_SECTION', sectionId: oldSection });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/previewed section/);
    expect(api.scripting.executeScript.mock.calls.some(([options]: any[]) => options.args[0].type === 'section')).toBe(false);
  });
  it('counts identical source hashes once and resets a new section capture', async () => {
    const original = api.scripting.executeScript.getMockImplementation();
    api.scripting.executeScript.mockImplementation(async (options: any) => options.args[0].type === 'resource' ? [{ result: { base64: 'JVBERi0=', mime: 'application/pdf', sha256: 'a'.repeat(64), byteLength: 5 * 1024 * 1024 } }] : original(options));
    await send({ type: 'BIND_ACTIVE_TAB' });
    const capture = await send({ type: 'CAPTURE_SECTION', sectionId });
    for (let attempt = 0; attempt < 12; attempt++) expect((await send({ type: 'IMPORT_RESOURCE', resourceId: capture.data.resources[0].id })).ok).toBe(true);
    expect(state.captureBinding.importedBytes).toBe(5 * 1024 * 1024);
    await send({ type: 'CAPTURE_SECTION', sectionId });
    expect(state.captureBinding.importedBytes).toBe(0);
  });
  it('revokes a binding when the original tab navigates', async () => {
    await send({type:'BIND_ACTIVE_TAB'});
    updated(7,{url:'http://127.0.0.1:4318/other'});
    await new Promise((resolve) => setTimeout(resolve,0));
    expect((await send({type:'LIST_SECTIONS'})).ok).toBe(false);
  });
});
