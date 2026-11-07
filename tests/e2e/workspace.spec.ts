import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createServer } from '../../apps/api/server';
import { normalizeBundle } from '../../apps/api/input';
import { pcm16Wav } from '../../apps/api/providers/audio';
import type { ProviderAdapters } from '../../apps/api/providers';
import type { Bundle, Compilation } from '../../packages/core';

// Deterministic mock data and local PCM exercise software behavior only.
// They are not semantic source review, live providers or an accessibility study.
let context: BrowserContext, page: Page, app: Awaited<ReturnType<typeof createServer>>;
let temp: string, extensionOrigin: string;
const token = randomBytes(32).toString('hex');
const lectureIds: string[] = [];
test.describe.configure({mode:'serial',timeout:30000});
function wav(seconds: number) { return pcm16Wav(new Uint8Array(22050 * 2 * seconds)); }
const providers: ProviderAdapters = {
  capabilities: () => ({ mode: 'mock', multimodal: false, tts: true, stt: false, provider: 'test-only-mock', model: 'test-only-mock', speechProvider:'test-only-mock',ttsModel:'test-only-mock',sttModel:'none',verification:'explicit_offline_mock',unavailable:[],limits:{durationMs:180000,visualStates:6,maxConcurrentRequests:2,repairPasses:0} }),
  compile: async (b, revision) => ({ compilation: {
    inputRevision: revision, providerMode: 'mock', sourceReview: 'not_reviewed',
    evidence: [{ id:'E', kind:'speech', cueId:'C', quote:b.cues[0].text, sourceStartMs:0, sourceEndMs:30000 }], dependencies: [],
    claims: [{id:'K',kind:'lecturer_claim',meaning:b.cues[0].text,evidenceIds:['E'],dependencyIds:[]}],
    segments:[{id:'S',text:b.cues[0].text,claimIds:['K'],dependencyIds:[],sourceRanges:[{startMs:0,endMs:30000}],stateIds:['V'],status:'supported'}],unresolvedEssentialIds:[]
  } satisfies Compilation, audit:{mode:'mock'}, metadata:{provider:'test-only-mock',model:'test-only-mock',requests:0,durationMs:0,cacheHit:false} }),
  synthesise: async () => ({bytes:wav(6),mime:'audio/wav',durationMs:6000,provider:'test-only-mock',mode:'mock',model:'test-only-mock'}),
  transcribe: async () => { throw new Error('Not enabled in offline UI tests'); },
};
async function request(path: string, method = 'GET', value?: unknown) {
  const response = await fetch('http://127.0.0.1:4317'+path,{method,headers:{Origin:extensionOrigin,Authorization:`Bearer ${token}`,...(value?{'Content-Type':'application/json'}:{})},body:value?JSON.stringify(value):undefined});
  const result = await response.json(); expect(response.ok,JSON.stringify(result)).toBe(true); return result;
}
async function sound() { return page.evaluate(() => { const a=(window as any).__testAudio as HTMLAudioElement|undefined; return {paused:a?.paused??true,time:a?.currentTime??0,duration:a?.duration??0,src:a?.src??''}; }); }
async function pair() {
  await page.getByLabel('Local service pairing token').fill(token);
  await page.getByRole('button',{name:'Pair local service',exact:true}).click();
  await expect(page.getByRole('button',{name:'Unpair',exact:true})).toBeVisible();
}
test.beforeAll(async () => {
  await mkdir(resolve('.tmp'),{recursive:true}); await mkdir(resolve('verification/screenshots'),{recursive:true});
  temp=await mkdtemp(resolve('.tmp/workspace-'));
  const extension=resolve('dist/extension');
  context=await chromium.launchPersistentContext(join(temp,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1440,height:1000}});
  await context.addInitScript(() => {
    const Original=window.Audio;
    (window as any).Audio=function(src?:string){const audio=new Original(src);(window as any).__testAudio=audio;return audio;};
    (window as any).Audio.prototype=Original.prototype;
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  extensionOrigin=new URL(worker.url()).origin;
  // Chromium URL.origin for extension schemes is "null" in some Node versions.
  extensionOrigin='chrome-extension://'+new URL(worker.url()).host;
  app=await createServer({dataDir:join(temp,'data'),allowedOrigins:[extensionOrigin],token,providers});
  await new Promise<void>(done=>app.server.listen(4317,'127.0.0.1',done));
  const png=await readFile(resolve('fixtures/F1/V1.png'));
  for (let index=0;index<2;index++) {
    const b:Bundle={title:index?'Second source':'First source',audioAssetId:'A',assets:[{id:'A',name:'source.wav',mime:'audio/wav',acquisition:'synthetic_demo',base64:Buffer.from(wav(index?32:30)).toString('base64')},{id:'I',name:'slide.png',mime:'image/png',acquisition:'synthetic_demo',base64:png.toString('base64')}],cues:[{id:'C',startMs:0,endMs:30000,text:'The rate is five units.'}],timeline:[{id:'T',stateId:'V',assetId:'I',startMs:0,endMs:index?32000:30000,alignment:'user_confirmed'}]};
    const lecture=await app.store.create(b.title); lectureIds.push(lecture.id);
    await app.store.replaceInput(lecture.id,0,await normalizeBundle(b));
    await request(`/lectures/${lecture.id}/compile`,'POST',{expectedRevision:1,consent:true,idempotencyKey:'compile'}); await app.waitForIdle();
    const compiled = await app.store.get(lecture.id); expect(compiled.status, JSON.stringify({error:compiled.error,code:compiled.errorCode})).toBe('review_ready');
    await request(`/lectures/${lecture.id}/synthesise`,'POST',{expectedRevision:1,consent:true,idempotencyKey:'speech'}); await app.waitForIdle();
    const prepared = await app.store.get(lecture.id); expect(prepared.status, JSON.stringify({error:prepared.error,code:prepared.errorCode})).toBe('ready');
  }
  page=await context.newPage(); await page.goto(extensionOrigin+'/workspace.html');
});
test.afterAll(async()=>{await context?.close();await app?.close();if(temp)await rm(temp,{recursive:true,force:true});});

test('responsive installed workspace, pairing, keyboard controls, question and exact resume',async()=>{
  await expect(page.getByRole('heading',{name:/Make the meaning/})).toBeVisible();
  await page.screenshot({path:'verification/screenshots/workspace-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.screenshot({path:'verification/screenshots/workspace-narrow.png',fullPage:true});
  await pair();
  await page.getByRole('button',{name:'First source',exact:true}).click();
  await expect(page.getByRole('button',{name:'Play explanation',exact:true})).toBeVisible();
  expect((await sound()).paused).toBe(true);
  await page.getByRole('button',{name:'Play explanation',exact:true}).click();
  await expect.poll(async()=>(await sound()).time).toBeGreaterThan(.25);
  await page.getByRole('button',{name:'Ask about this segment',exact:true}).click();
  const paused=await sound(); expect(paused.paused).toBe(true);
  const question=page.getByRole('textbox', {name:/^Ask the selected lecture/});
  await question.fill('What is'); await question.press('Space'); await question.type('the rate?');
  await expect(question).toHaveValue('What is the rate?');
  await page.getByRole('checkbox',{name:/Answer this typed question/}).check();
  await page.getByRole('button',{name:'Ask & pause explanation',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Grounded answer',exact:true})).toBeVisible();
  expect((await sound()).paused).toBe(true);
  await page.getByRole('button',{name:'Play answer',exact:true}).click();
  await expect.poll(async()=>(await sound()).time).toBeGreaterThan(.1);
  await page.keyboard.press('Escape'); expect((await sound()).paused).toBe(true);
  await page.getByRole('button',{name:'Resume explanation',exact:true}).click();
  await expect.poll(async()=>(await sound()).paused).toBe(false);
  expect((await sound()).time).toBeGreaterThanOrEqual(paused.time-.15);
  await page.keyboard.press('Escape');
  await page.screenshot({path:'verification/screenshots/player-narrow.png',fullPage:true});
  const violations=(await new AxeBuilder({page}).analyze()).violations;
  expect(violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length}))).toEqual([]);
  await page.reload();
  await expect(page.getByRole('button',{name:'Play explanation',exact:true})).toBeVisible();
  expect((await sound()).paused).toBe(true);
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:'verification/screenshots/player-desktop.png',fullPage:true});
});

test('an explicitly started ready batch changes lectures without cancelling its new audio load',async()=>{
  await page.getByRole('button',{name:'Second source',exact:true}).click();
  await page.getByRole('button',{name:/Play ready lectures/}).click();
  await expect(page.locator('.queue-title[aria-current=true]')).toHaveText('First source');
  await expect.poll(async()=>(await sound()).time).toBeGreaterThan(.2);
  await page.evaluate(()=>{((window as any).__testAudio as HTMLAudioElement).currentTime=5.95;});
  await expect(page.locator('.queue-title[aria-current=true]')).toHaveText('Second source');
  await expect.poll(async()=>(await sound()).time).toBeGreaterThan(.2);
  await page.keyboard.press('Escape');
});

test('same asset ID in different lectures plays the correct original bytes; source edit archives prior output',async()=>{
  for (const [title,duration] of [['First source',30],['Second source',32]] as const) {
    await page.getByRole('button',{name:title,exact:true}).click();
    await page.getByRole('button',{name:/1.*Find/}).click();
    await page.getByRole('button',{name:'Play original audio',exact:true}).click();
    await expect.poll(async()=>(await sound()).duration).toBe(duration);
    await page.keyboard.press('Escape');
  }
  const lecture=await app.store.get(lectureIds[1]);
  await app.store.replaceInput(lecture.id,1,{...lecture.bundle!,title:'Revised second source'});
  await expect(page.getByText('Sources changed — regenerate',{exact:false}).first()).toBeVisible();
  await expect(page.getByText('Archived prior source revisions — not current or playable')).toBeVisible();
  await page.getByText('Archived prior source revisions — not current or playable').click();
  await expect(page.getByText('Archived revision 1 — not current / not playable')).toBeVisible();
  expect((await sound()).paused).toBe(true);
});
