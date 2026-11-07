import {mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH??=resolve('.cache/playwright');
const {chromium}=await import('@playwright/test');
await mkdir('.tmp',{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto('http://127.0.0.1:4320');
 if((await page.locator('body').innerText()).trim())throw new Error('Initial demo screen should be blank.');
 await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');
 await page.getByRole('textbox',{name:'Your lecture request'}).waitFor();
 await page.waitForTimeout(700);
 const orb=await page.getByRole('button',{name:'Focus your lecture request'}).boundingBox();
 if(!orb||Math.abs(orb.x+orb.width/2-720)>3)throw new Error('The bubble did not centre.');
 await page.keyboard.press('Escape');
 if(await page.getByRole('textbox').count())throw new Error('Escape should close the input.');
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});
 await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');
 await page.getByRole('textbox').waitFor();
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile layout overflows horizontally.');
 console.log('Passed: blank screen, shortcut, centred bubble, Escape, mobile layout and reduced motion.');
 if(process.argv.includes('--prepared')){
  const root=resolve('.data/demo');let prepared;
  for(const id of await readdir(root)){
   if(!/^[a-f0-9-]{36}$/.test(id))continue;
   try{const value=JSON.parse(await readFile(join(root,id,'run.json'),'utf8'));if(value.status==='ready')prepared=value;}catch{}
  }
  if(!prepared)throw new Error('No real prepared lesson exists. Make a request in the demo first.');
  await page.goto('http://127.0.0.1:4320/?run='+prepared.id);
  await page.getByRole('button',{name:'Play lecture',exact:true}).waitFor();
  await page.getByRole('button',{name:'Play lecture',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('audio')?.currentTime>.25);
  await page.getByRole('button',{name:'Pause lecture',exact:true}).click();
  await page.getByRole('button',{name:'Play lecture',exact:true}).waitFor();
  await page.getByRole('button',{name:/Read transcript/}).click();
  if((await page.locator('.script').innerText()).length<300)throw new Error('Adapted transcript is missing.');
  await page.getByRole('button',{name:/Hide transcript/}).click();
  await page.getByText('View agent activity').click();
  if(await page.locator('.activity li').count()<5)throw new Error('Agent activity is missing.');
  console.log('Passed: actual saved lesson, live event connection, ElevenLabs playback/pause, adapted transcript and activity. No new provider calls.');
 }
}finally{await browser.close();}
