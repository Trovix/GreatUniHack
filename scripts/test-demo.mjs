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
 if(process.argv.includes('--stage')){
  const stage=await browser.newPage({viewport:{width:1440,height:900}});
  const forbidden=[];
  stage.on('request',request=>{if(request.method()!=='GET'||!request.url().startsWith('http://127.0.0.1:4320/')||request.resourceType()==='eventsource')forbidden.push(request.url());});
  await stage.goto('http://127.0.0.1:4320/stage');
  if((await stage.locator('body').innerText()).trim())throw new Error('Stage demo must also start blank.');
  await stage.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');
  const input=stage.getByRole('textbox',{name:'Your lecture request'});
  await input.waitFor();
  if(await input.getAttribute('readonly')===null)throw new Error('Stage request must be fixed.');
  await stage.getByRole('button',{name:'Start stage demo',exact:true}).waitFor();
  await stage.waitForFunction(()=>document.querySelector('audio')?.readyState>=2);
  const started=Date.now();
  await stage.getByRole('button',{name:'Start stage demo',exact:true}).click();
  await stage.waitForFunction(()=>document.querySelectorAll('.activity li').length>=2);
  if(await stage.getByRole('button',{name:'Play lecture',exact:true}).count())throw new Error('Replay skipped the recorded activity.');
  await stage.getByRole('button',{name:'Play lecture',exact:true}).waitFor({timeout:20_000});
  const elapsed=Date.now()-started;
  if(elapsed>=20_000)throw new Error('Stage demo took more than twenty seconds.');
  const playBox=await stage.getByRole('button',{name:'Play lecture',exact:true}).boundingBox();
  if(!playBox||playBox.y+playBox.height>866)throw new Error('The stage player is below the presentation viewport.');
  const firstActions=await stage.locator('.activity li').evaluateAll(rows=>rows.map(row=>({text:row.textContent,status:row.className})));
  await stage.getByRole('button',{name:'Play lecture',exact:true}).click();
  await stage.waitForFunction(()=>document.querySelector('audio')?.currentTime>.25);
  await stage.getByRole('button',{name:'Pause lecture',exact:true}).click();
  const pinned=JSON.parse(await readFile('.data/demo-stage/run.json','utf8'));
  await verifyCaptions(stage,pinned.words,'stage');
  await stage.getByRole('button',{name:/Replay stage demo/}).click();
  await stage.getByRole('button',{name:'Play lecture',exact:true}).waitFor({timeout:20_000});
  const repeatedActions=await stage.locator('.activity li').evaluateAll(rows=>rows.map(row=>({text:row.textContent,status:row.className})));
  if(JSON.stringify(firstActions)!==JSON.stringify(repeatedActions))throw new Error('Stage replay changed between runs.');
  if(await stage.getByRole('button',{name:/Refresh from/}).count())throw new Error('Stage mode exposes live refresh.');
  if(forbidden.length)throw new Error('Stage demo made a live or external request: '+forbidden.join(', '));
  await stage.evaluate(()=>window.scrollTo(0,0));
  await stage.screenshot({path:'.tmp/demo-stage-ready.png',fullPage:true});
  console.log(`Passed: stage replay ready in ${(elapsed/1000).toFixed(2)}s, identical repeat, real audio playback, fixed request and no live/external requests.`);
  await stage.close();
 }
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
  if(!await page.getByRole('log',{name:'Lecture activity'}).isVisible())await page.locator('.completed-work summary').click();
  await page.getByRole('log',{name:'Lecture activity'}).waitFor({state:'visible'});
  if(await page.locator('.activity li').count()<5)throw new Error('Agent activity is missing.');
  const sourceActions=prepared.events.filter(event=>event.stage==='action');
  if(sourceActions.length&&await page.locator('.activity-context time').count()!==prepared.events.length)throw new Error('Some action timestamps were omitted.');
  if(/\b(?:aside|claude|elevenlabs|openai|codex|echo360|panopto)\b/i.test(await page.locator('.work').innerText()))throw new Error('Internal vendor names appear in the demo.');
  const logos=page.locator('.activity img[alt="Moodle"]');
  if(!await logos.count())throw new Error('Inline Moodle logos are missing.');
  if(!await logos.evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0)))throw new Error('A Moodle logo failed to load.');
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Prepared lesson overflows on mobile.');
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:'.tmp/demo-activity-desktop.png',fullPage:true});
  await page.locator('.activity').evaluate(list=>{list.scrollTop=0;});
  await page.screenshot({path:'.tmp/demo-activity-start.png',fullPage:true});
  console.log('Passed: actual saved lesson, event connection, playback/pause, transcript, complete action feed, inline Moodle logos and product copy. No new provider calls.');
  await verifyCaptions(page,prepared.words,'live');
 }
}catch(error){
 for(const [index,page]of browser.contexts().flatMap(context=>context.pages()).entries()){
  await page.screenshot({path:'.tmp/demo-failure-'+index+'.png',fullPage:true}).catch(()=>{});
  console.log('Failure state: '+JSON.stringify(await page.evaluate(()=>({url:location.pathname,heading:document.querySelector('.work-heading p')?.textContent,steps:document.querySelectorAll('.activity li').length,audio:document.querySelector('audio')?{paused:document.querySelector('audio').paused,time:document.querySelector('audio').currentTime}:null,buttons:Array.from(document.querySelectorAll('button'),button=>button.getAttribute('aria-label')||button.textContent)}))));
 }
 throw error;
}finally{await browser.close();}

async function verifyCaptions(page,words,mode){
 if(!words?.length)throw new Error('The prepared narration has no real word timings.');
 await page.locator('.narration').waitFor();
 await page.emulateMedia({reducedMotion:'no-preference'});
 const viewport=page.viewportSize();
 const seek=async index=>{
  const word=words[index],time=word.start+Math.max(0,(word.end-word.start)/2);
  await page.evaluate(time=>{const audio=document.querySelector('audio');audio.pause();audio.currentTime=time;},time);
  await page.waitForFunction(index=>Math.max(-1,...Array.from(document.querySelectorAll('.narration-word.is-spoken'),word=>Number(word.dataset.wordIndex)))===index,index);
 };
 await seek(Math.floor(words.length/2));
 if(await page.locator('.narration-line.is-upcoming').count()!==2)throw new Error('The reader should show two upcoming lines.');
 const colors=await page.locator('.narration').evaluate(reader=>({spoken:getComputedStyle(reader.querySelector('.narration-word.is-spoken')).color,upcoming:getComputedStyle(reader.querySelector('.narration-line.is-upcoming .narration-word')).color}));
 if(colors.spoken===colors.upcoming)throw new Error('Upcoming text is not greyed out.');
 const paused=await page.locator('.narration').innerText();await page.waitForTimeout(300);
 if(paused!==await page.locator('.narration').innerText())throw new Error('The paused transcript advanced.');
 await seek(5);
 const started=await page.evaluate(async()=>{const audio=document.querySelector('audio');audio.playbackRate=2;await audio.play();return audio.currentTime;});
 await page.waitForFunction(start=>document.querySelector('audio').currentTime>start+.6,started);
 await page.waitForFunction(starts=>{
  const time=document.querySelector('audio').currentTime;
  let expected=-1;for(let index=0;index<starts.length&&starts[index]<=time;index++)expected=index;
  const actual=Math.max(-1,...Array.from(document.querySelectorAll('.narration-word.is-spoken'),word=>Number(word.dataset.wordIndex)));
  return expected===actual;
 },words.map(word=>word.start));
 await page.locator('.narration').screenshot({path:'.tmp/captions-'+mode+'.png'});
 await page.evaluate(()=>document.querySelector('audio').pause());
 await seek(35);
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('.narration-line')).every(line=>line.scrollWidth<=line.clientWidth+2));
  await page.locator('.narration').evaluate(async reader=>{await Promise.all(reader.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));});
  await page.locator('.narration').evaluate(reader=>reader.scrollIntoView({block:'center'}));
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('The mobile transcript overflows horizontally.');
 await page.locator('.narration').screenshot({path:'.tmp/captions-'+mode+'-mobile.png'});
 await page.emulateMedia({reducedMotion:'reduce'});
 if(await page.locator('.narration-line').first().evaluate(line=>getComputedStyle(line).transitionDuration)!=='0s')throw new Error('The reader ignores reduced motion.');
 await page.setViewportSize(viewport);
 await page.evaluate(()=>{const audio=document.querySelector('audio');audio.currentTime=0;audio.playbackRate=1;});
 await page.waitForFunction(()=>document.querySelectorAll('.narration-word.is-spoken').length===0);
 console.log('Passed: '+mode+' word synchronization, two grey preview lines, pause, backward/forward seek, 2× speed, mobile reader and reduced motion.');
}
