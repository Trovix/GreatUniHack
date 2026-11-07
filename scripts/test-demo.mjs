import {mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH??=resolve('.cache/playwright');
const {chromium}=await import('@playwright/test');
await mkdir('.tmp',{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto('http://127.0.0.1:4320');
 if(await page.locator('.welcome').count())throw new Error('The request should stay closed initially.');
 await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');
 await page.getByRole('textbox',{name:'Your lecture request'}).waitFor();
 await page.waitForTimeout(700);
 const orb=await page.getByRole('button',{name:'Focus your lecture request'}).boundingBox();
 const workspace=await page.locator('.content-viewport').boundingBox();
 if(!orb||!workspace||Math.abs(orb.x+orb.width/2-(workspace.x+workspace.width/2))>3)throw new Error('The bubble did not centre in the workspace.');
 await page.keyboard.press('Escape');
 if(await page.getByRole('textbox').count())throw new Error('Escape should close the input.');
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});
 await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');
 await page.getByRole('textbox').waitFor();
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile layout overflows horizontally.');
 console.log('Passed: closed request, shortcut, centred bubble, Escape, mobile layout and reduced motion.');
 if(process.argv.includes('--stage')){
  const stage=await browser.newPage({viewport:{width:1440,height:900}});
  const forbidden=[];
  stage.on('request',request=>{if(request.method()!=='GET'||!request.url().startsWith('http://127.0.0.1:4320/')||request.resourceType()==='eventsource')forbidden.push(request.url());});
  await stage.goto('http://127.0.0.1:4320/stage');
  if(await stage.locator('.welcome').count())throw new Error('The stage request should also start closed.');
  await stage.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');
  const input=stage.getByRole('textbox',{name:'Your lecture request'});
  await input.waitFor();
  if(await input.inputValue()!==''||await input.getAttribute('readonly')!==null)throw new Error('Stage request must start empty and editable.');
  if(await input.getAttribute('placeholder'))throw new Error('Stage request should have no prefilled-looking example.');
  if(/A lecture, on your terms/i.test(await stage.locator('body').innerText()))throw new Error('Removed tagline is still visible.');
  const firstRequest='Teach me today’s lecture';
  await input.fill(firstRequest);
  await stage.getByRole('button',{name:'Start learning',exact:true}).waitFor();
  await stage.waitForFunction(()=>document.querySelector('audio')?.readyState>=2);
  const started=Date.now();
  if(await input.inputValue()!==firstRequest)throw new Error('Loading the prepared lesson overwrote the typed request.');
  await input.press('Enter');
  await stage.waitForFunction(()=>document.querySelectorAll('.activity li').length>=2);
  if(await stage.locator('.phase-step').count()!==5)throw new Error('Preparation should show five readable steps.');
  await assertFrame(stage);
  await stage.locator('.experience').evaluate(async element=>{await Promise.all(element.getAnimations().map(animation=>animation.finished.catch(()=>{})));});
  await stage.screenshot({path:'.tmp/earshot-preparation.png'});
  await assertStableTrace(stage,started);
  if(await stage.getByRole('button',{name:'Play lecture',exact:true}).count())throw new Error('Replay skipped the recorded activity.');
  await stage.getByRole('button',{name:'Play lecture',exact:true}).waitFor({timeout:45_000});
  const elapsed=Date.now()-started;
  await assertFrame(stage);
  if(elapsed<39_000||elapsed>=45_000)throw new Error('Stage demo did not follow the forty-second timeline.');
  const playBox=await stage.getByRole('button',{name:'Play lecture',exact:true}).boundingBox();
  if(!playBox||playBox.y+playBox.height>866)throw new Error('The stage player is below the presentation viewport.');
  const firstActions=await stage.locator('.activity li').evaluateAll(rows=>rows.map(row=>({text:row.textContent,status:row.className})));
  const firstTitle=await stage.locator('.lesson h1').innerText(),firstAudio=await stage.locator('audio').getAttribute('src');
  if(await stage.locator('.submitted').innerText()!==firstRequest)throw new Error('Submitted request was replaced with the recorded request.');
  await stage.getByRole('button',{name:'Play lecture',exact:true}).click();
  await stage.waitForFunction(()=>document.querySelector('audio')?.currentTime>.25);
  await stage.getByRole('button',{name:'Pause lecture',exact:true}).click();
  await stage.getByRole('button',{name:'Back to request',exact:true}).scrollIntoViewIfNeeded();
  const footer=await stage.getByRole('button',{name:'Back to request',exact:true}).boundingBox();
  const frame=await stage.locator('.frame').boundingBox();
  if(!footer||!frame||footer.y+footer.height>frame.y+frame.height-12)throw new Error('The footer crosses the frame.');
  const pinned=JSON.parse(await readFile('.data/demo-stage/run.json','utf8'));
  await verifyCaptions(stage,pinned.words,'stage');
  await stage.getByRole('button',{name:'Back to request',exact:true}).click();
  if(await input.inputValue()!=='')throw new Error('Returning to the request should clear the input.');
  const secondRequest='Explain a different lecture please';
  await input.fill(secondRequest);
  await input.press('Enter');
  await stage.getByRole('button',{name:'Play lecture',exact:true}).waitFor({timeout:45_000});
  const repeatedActions=await stage.locator('.activity li').evaluateAll(rows=>rows.map(row=>({text:row.textContent,status:row.className})));
  if(JSON.stringify(firstActions)!==JSON.stringify(repeatedActions))throw new Error('Stage replay changed between runs.');
  if(await stage.locator('.lesson h1').innerText()!==firstTitle||await stage.locator('audio').getAttribute('src')!==firstAudio)throw new Error('Different stage requests must produce the same lesson and audio.');
  if(await stage.locator('.submitted').innerText()!==secondRequest)throw new Error('The second typed request was not preserved.');
  if(await stage.getByRole('button',{name:/Refresh from/}).count())throw new Error('Stage mode exposes live refresh.');
  if(forbidden.length)throw new Error('Stage demo made a live or external request: '+forbidden.join(', '));
  await stage.locator('.content-viewport').evaluate(element=>{element.scrollTop=0;});
  await stage.screenshot({path:'.tmp/demo-stage-ready.png',fullPage:true});
  console.log(`Passed: stage replay ready in ${(elapsed/1000).toFixed(2)}s, empty editable request, two different Enter submissions with identical lesson/audio, real audio playback and no live/external requests.`);
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
  await openFullTrace(page);
  await page.getByRole('log',{name:'Lecture activity'}).waitFor({state:'visible'});
  if(await page.locator('.activity li').count()<5)throw new Error('Agent activity is missing.');
  const sourceActions=prepared.events.filter(event=>event.stage==='action');
  if(sourceActions.length&&await page.locator('.activity-line time').count()!==prepared.events.length)throw new Error('Some action timestamps were omitted.');
  if(/\b(?:aside|claude|elevenlabs|openai|codex|echo360|panopto)\b/i.test(await page.locator('.work').innerText()))throw new Error('Internal vendor names appear in the demo.');
  const logos=page.locator('.activity img[alt="Moodle"]');
  if(!await logos.count())throw new Error('Inline Moodle logos are missing.');
  if(!await logos.evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0)))throw new Error('A Moodle logo failed to load.');
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Prepared lesson overflows on mobile.');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.content-viewport').evaluate(element=>{element.scrollTop=0;});
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
 await assertFrame(page);
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

async function openFullTrace(page){
 if(!await page.locator('.trace-overview').isVisible())await page.locator('.trace-summary').click();
 if(!await page.getByRole('log',{name:'Lecture activity'}).isVisible())await page.locator('.trace-details>summary').click();
}

async function assertFrame(page){
 const geometry=await page.evaluate(()=>{const frame=document.querySelector('.frame').getBoundingClientRect(),viewport=document.querySelector('.content-viewport').getBoundingClientRect();return{frame:{top:frame.top,bottom:frame.bottom,left:frame.left,right:frame.right},viewport:{top:viewport.top,bottom:viewport.bottom,left:viewport.left,right:viewport.right},pageHeight:document.documentElement.scrollHeight,height:innerHeight,text:document.body.innerText,title:document.title};});
 if(geometry.viewport.bottom>geometry.frame.bottom-10||geometry.viewport.top<geometry.frame.top||geometry.viewport.left<geometry.frame.left||geometry.viewport.right>geometry.frame.right)throw new Error('Content is not contained inside the frame.');
 if(geometry.pageHeight>geometry.height+1)throw new Error('The document scrolls behind the fixed frame.');
 if(/\b(stage demo|live demo|prepared run|replay of recorded)\b/i.test(geometry.text))throw new Error('A demo mode is visible in the product UI.');
 if(geometry.title!=='Earshot')throw new Error('The product name changed.');
}

async function assertStableTrace(page,started){
 let baseline;const headings=new Set();let samples=0;
 while(Date.now()-started<13_000){
  const sample=await page.evaluate(()=>({rows:Array.from(document.querySelectorAll('.phase-step p'),element=>{const text=element.cloneNode(true);text.querySelectorAll('.sr-only').forEach(node=>node.remove());const rect=element.getBoundingClientRect();return{text:text.textContent,y:Math.round(rect.y),height:Math.round(rect.height)};}),heading:document.querySelector('.work-heading p')?.textContent}));
  if(!baseline)baseline=sample.rows;
  if(JSON.stringify(sample.rows)!==JSON.stringify(baseline))throw new Error('The visible preparation text or row positions changed during the run.');
  headings.add(sample.heading);samples++;
  await page.waitForTimeout(150);
 }
 if(headings.size>4)throw new Error('The preparation heading changes too frequently.');
 console.log(`Passed: stable milestone text and positions across ${samples} replay frames.`);
}
