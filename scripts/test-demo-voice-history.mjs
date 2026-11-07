import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
process.env.PLAYWRIGHT_BROWSERS_PATH??=resolve('.cache/playwright');
const {chromium}=await import('@playwright/test');
const voice=process.argv.includes('--live-dictation');
const args=voice?['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+resolve('.data/presentation/narration/cue-01.wav')]:[];
const browser=await chromium.launch({headless:true,args});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},permissions:voice?['microphone']:[]});
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:4320/');
 await page.locator('.chat-entry').first().waitFor();
 const liveLinks=await page.locator('.chat-entry').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
 if(liveLinks.some(link=>!link.startsWith('/?run=')))throw new Error('Live history crosses into the deterministic site');
 const saved=page.locator('.chat-entry').filter({hasText:'Ready to listen'}).first(),savedTitle=await saved.locator('strong').innerText();await saved.click();
 await page.getByRole('button',{name:'Play lecture',exact:true}).waitFor();
 if(savedTitle!==await page.locator('.lesson h1').innerText())throw new Error('Saved chat did not reopen the real lesson');
 await page.locator('.new-chat').click();
 const input=page.getByRole('textbox',{name:'Your lecture request'});await input.waitFor();
 if(voice){
  await page.getByRole('button',{name:'Dictate lecture request',exact:true}).click();
  await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();await page.waitForTimeout(4000);
  const reply=page.waitForResponse(response=>response.url().endsWith('/demo-api/dictate'));
  await page.getByRole('button',{name:'Stop dictation',exact:true}).click();
  const response=await reply;if(response.status()!==200)throw new Error('Real dictation failed: '+await response.text());
  await page.waitForFunction(()=>!document.querySelector('#request').disabled);
  const text=await input.inputValue();if(!/latest lecture/i.test(text))throw new Error('Dictated request was not recognized: '+text);
  console.log('Passed: actual microphone recording → ElevenLabs Scribe → editable request: '+text);
 }else{
  await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Permission denied','NotAllowedError');};});
  await page.getByRole('button',{name:'Dictate lecture request',exact:true}).click();await page.getByRole('alert').filter({hasText:'Microphone access was denied'}).waitFor();
  if(await input.isDisabled())throw new Error('Permission denial left typing disabled');
  await page.keyboard.press('Escape');await page.keyboard.press('Meta+k');if(await input.isDisabled())throw new Error('Closing/reopening the input left dictation busy');
 }
 await page.screenshot({path:'.tmp/earshot-sidebar-desktop.png'});
 await page.goto('http://127.0.0.1:4320/stage');await page.locator('.chat-entry').first().waitFor();
 const stageLinks=await page.locator('.chat-entry').evaluateAll(links=>links.map(link=>({href:link.getAttribute('href'),title:link.querySelector('strong').textContent})));
 if(stageLinks.length!==1||stageLinks[0].href!=='/stage?lesson=1'||/stage demo/i.test(stageLinks[0].title))throw new Error('Deterministic history is not separate and lecture-named');
 await page.locator('.chat-entry').click();await page.getByRole('button',{name:'Play lecture',exact:true}).waitFor();
 const prepared=JSON.parse(await readFile('.data/demo-stage/run.json','utf8'));
 if(await page.locator('.lesson h1').innerText()!==prepared.title)throw new Error('Preloaded chat did not open the economics lesson');
 await page.locator('.experience').evaluate(async element=>{await Promise.all(element.getAnimations().map(animation=>animation.finished.catch(()=>{})));});
 await page.screenshot({path:'.tmp/earshot-sidebar-economics.png'});
 await page.getByRole('button',{name:/Prepare again/}).click();await page.getByRole('button',{name:'Stop',exact:true}).waitFor();await page.getByRole('button',{name:'Stop',exact:true}).click();
 await page.locator('.new-chat').click();if(new URL(page.url()).pathname!=='/stage')throw new Error('New chat switched demo modes');
 await page.getByRole('textbox').waitFor();if(await page.getByRole('textbox').inputValue()!=='')throw new Error('The deterministic request is prefilled');
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Hide chat history'}).click();await page.getByRole('button',{name:'Show chat history'}).click();const backdrop=page.getByRole('button',{name:'Close chat history'}),box=await backdrop.boundingBox();await backdrop.click({position:{x:box.width-8,y:24}});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile sidebar or dictation controls overflow');
 await page.locator('.experience').evaluate(async element=>{await Promise.all(element.getAnimations().map(animation=>animation.finished.catch(()=>{})));});
 await page.screenshot({path:'.tmp/earshot-sidebar-mobile.png'});
 if(errors.length)throw new Error(errors.join('\n'));console.log('Passed: saved chats, course-named preloaded lesson, route separation, empty stage input, mobile drawer, microphone controls and no page errors.');
}finally{await browser.close();}
