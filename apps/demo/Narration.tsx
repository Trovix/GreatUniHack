import {useEffect,useLayoutEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {captionLines,lineForWord,wordAtTime,type TimedWord} from './captions';

export function Narration({words,audio,playing}:{words:TimedWord[];audio:RefObject<HTMLAudioElement|null>;playing:boolean}){
 const readerWindow=useRef<HTMLDivElement>(null);
 const[metrics,setMetrics]=useState({width:600,font:'450 27px Inter'});
 const[playhead,setPlayhead]=useState({word:-1,speaking:-1});

 useEffect(()=>{
  const element=readerWindow.current;if(!element)return;
  let disposed=false;
  const measure=()=>{if(disposed)return;const style=getComputedStyle(element);const width=element.clientWidth-8,font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;setMetrics(previous=>previous.width===width&&previous.font===font?previous:{width,font});};
  const observer=new ResizeObserver(measure);observer.observe(element);measure();
  void document.fonts.ready.then(()=>{if(!disposed){measure();setMetrics(previous=>({...previous}));}});
  return()=>{disposed=true;observer.disconnect();};
 },[]);

 const lines=useMemo(()=>{
  const context=document.createElement('canvas').getContext('2d');
  if(!context)return captionLines(words,metrics.width,text=>text.length*14);
  context.font=metrics.font;
  return captionLines(words,metrics.width,text=>context.measureText(text).width);
 },[words,metrics]);

 useLayoutEffect(()=>{
  const element=readerWindow.current;if(!element)return;let second=0;
  element.classList.add('is-reflowing');
  const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>element.classList.remove('is-reflowing'));});
  return()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);element.classList.remove('is-reflowing');};
 },[lines]);

 useEffect(()=>{
  if(!playing)return;let second=0;
  const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{
   const element=readerWindow.current;if(!element)return;
   const overflow=element.getBoundingClientRect().bottom-(window.innerHeight-64);
   if(overflow>0)window.scrollBy({top:overflow,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  });});
  return()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);};
 },[playing,metrics.width]);

 useEffect(()=>{
  const element=audio.current;if(!element)return;let frame=0;
  const sync=()=>{
   const word=element.paused&&element.currentTime===0?-1:wordAtTime(words,element.currentTime),speaking=!element.ended&&word>=0&&element.currentTime<words[word].end?word:-1;
   setPlayhead(previous=>previous.word===word&&previous.speaking===speaking?previous:{word,speaking});
  };
  const tick=()=>{sync();frame=!element.paused&&!element.ended?requestAnimationFrame(tick):0;};
  const update=()=>{sync();if(element.paused||element.ended){cancelAnimationFrame(frame);frame=0;}else if(!frame)frame=requestAnimationFrame(tick);};
  const events=['play','pause','timeupdate','seeking','seeked','ratechange','ended'];
  for(const event of events)element.addEventListener(event,update);
  update();
  return()=>{cancelAnimationFrame(frame);for(const event of events)element.removeEventListener(event,update);};
 },[words,audio]);

 const current=lineForWord(lines,playhead.word),first=Math.max(0,current-1);
 return <section className={`narration ${playing?'is-speaking':''}`} aria-label="Synchronized transcript">
  <div className="narration-heading"><span><i aria-hidden="true"/>Follow along</span><span>{playing?'Listening':playhead.word<0?'Ready to listen':playhead.word===words.length-1&&playhead.speaking<0?'Finished':'Paused'}</span></div>
  <div className="narration-window" ref={readerWindow}>
   {lines.slice(first,current+3).map((line,offset)=>{
    const index=first+offset;
    return <p key={line.from} className={`narration-line ${index<current?'is-past':index===current?'is-current':'is-upcoming'}`} style={{transform:`translateY(${(index-current+1)*100}%)`}} aria-current={index===current?'true':undefined}>
     {words.slice(line.from,line.to).map((word,offset)=>{
      const index=line.from+offset;
      return <span key={index}><span className={`narration-word ${index<=playhead.word?'is-spoken':''} ${index===playhead.speaking?'is-active':''}`} data-word-index={index}>{word.text}</span>{index<line.to-1?' ':''}</span>;
     })}
    </p>;
   })}
  </div>
 </section>;
}
