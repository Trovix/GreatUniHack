import { test,expect,chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from '../../apps/api/server';
import {createProviders} from '../../apps/api/providers';

test('manual import, explicit timeline review, mock compilation and native local speech work in the installed UI',async()=>{
  await mkdir(resolve('.tmp'),{recursive:true});const temp=await mkdtemp(resolve('.tmp/manual-demo-'));
  const extension=resolve('dist/extension');
  const context=await chromium.launchPersistentContext(join(temp,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1440,height:1000}});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const origin='chrome-extension://'+new URL(worker.url()).host;
  const providers=createProviders({mode:'mock',openaiApiKey:'',elevenLabsApiKey:'',fetch:async()=>{throw new Error('No network providers in the demo test');}});
  const app=await createServer({dataDir:join(temp,'data'),allowedOrigins:[origin],providers});
  await new Promise<void>(done=>app.server.listen(4317,'127.0.0.1',done));
  try{
    const page=await context.newPage();await page.goto(origin+'/workspace.html');
    const activate=async(name:string|RegExp)=>{const button=page.getByRole('button',{name,exact:typeof name==='string'});await expect(button).toBeEnabled();await button.press('Enter');};
    await page.getByLabel('Local service pairing token').fill(app.token);await activate('Pair local service');
    await page.getByLabel('New lecture title').fill('Manual source demo');await activate('Create lecture');
    await page.locator('input[type=file]').setInputFiles(['source.wav','captions.vtt','V1.png'].map(f=>resolve('fixtures/F3',f)));
    await activate(/Review & prepare/);
    await activate('Add visual interval');
    await page.getByRole('checkbox',{name:/I checked the images and source-time intervals/}).check();
    await activate('Save reviewed source revision');
    await expect(page.locator('.lecture-heading')).toContainText('input revision 1');
    await expect(page.getByText('Loading this revision’s original source bytes before editing…',{exact:true})).toHaveCount(0);
    const consent=page.getByRole('checkbox',{name:/I permit the selected captions/});await consent.check();
    await activate('Prepare labelled mock transcript');
    await expect(page.getByRole('heading',{name:'Descriptive transcript',exact:true})).toBeVisible();
    await expect(page.getByText(/not analysed in offline mock/).first()).toBeVisible();
    const violations=(await new AxeBuilder({page}).analyze()).violations;
    expect(violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.getByRole('checkbox',{name:/I reviewed this revision/}).check();
    await activate('Generate reviewed speech');
    await expect(page.getByRole('button',{name:'Check / reuse current speech',exact:true})).toBeVisible({timeout:20000});
    await page.getByRole('checkbox',{name:/I reviewed this revision/}).check();
    await activate('Check / reuse current speech');
    await activate(/03.*Listen/);
    await expect(page.getByText(/Cached audio · native-say-mock/)).toBeVisible();
    await activate('Play explanation');
    await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Play explanation',exact:true})).toBeVisible();
    await page.screenshot({path:'verification/screenshots/offline-manual-demo.png',fullPage:true});
  }finally{await context.close();await app.close();await rm(temp,{recursive:true,force:true});}
});
