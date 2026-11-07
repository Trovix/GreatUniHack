export type TimedWord={text:string;start:number;end:number};
export type CaptionLine={from:number;to:number;text:string};

export function validateWords(words:TimedWord[],duration:number){
 if(!Array.isArray(words)||!words.length||words.length>20_000||!Number.isFinite(duration)||duration<=0)throw new Error('Narration timing is unavailable.');
 for(let index=0;index<words.length;index++){
  const word=words[index];
  if(!word||typeof word.text!=='string'||!word.text.trim()||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<word.start||word.end>duration+.25||(index>0&&word.start<words[index-1].start))throw new Error('Narration timing does not match the recording.');
 }
}

/** Convert the original character timestamps into words without estimating their timing. */
export function wordsFromAlignment(value:unknown,duration:number):TimedWord[]{
 const envelope=value as {alignment?:unknown;normalized_alignment?:unknown};
 const alignment=(envelope?.alignment??envelope?.normalized_alignment??value)as {characters?:string[];character_start_times_seconds?:number[];character_end_times_seconds?:number[]};
 const characters=alignment?.characters,starts=alignment?.character_start_times_seconds,ends=alignment?.character_end_times_seconds;
 if(!Array.isArray(characters)||!Array.isArray(starts)||!Array.isArray(ends)||characters.length!==starts.length||characters.length!==ends.length)throw new Error('Narration timing is unavailable.');
 const words:TimedWord[]=[];let word:TimedWord|undefined;
 const flush=()=>{if(word){words.push(word);word=undefined;}};
 characters.forEach((fragment,index)=>{
  if(typeof fragment!=='string'||!Number.isFinite(starts[index])||!Number.isFinite(ends[index])||starts[index]<0||ends[index]<starts[index]||ends[index]>duration+.25||(index>0&&starts[index]<starts[index-1]))throw new Error('Narration timing does not match the recording.');
  for(const character of fragment){
   if(/\s/u.test(character)){flush();continue;}
   if(!word)word={text:'',start:starts[index],end:ends[index]};
   word.text+=character;word.end=ends[index];
  }
 });
 flush();validateWords(words,duration);return words;
}

/** Match the font's measured width so each phrase occupies one visible line. */
export function captionLines(words:TimedWord[],width:number,measure:(text:string)=>number):CaptionLine[]{
 const lines:CaptionLine[]=[];let from=0,text='';
 for(let index=0;index<words.length;index++){
  const candidate=text?text+' '+words[index].text:words[index].text;
  if(text&&measure(candidate)>width){lines.push({from,to:index,text});from=index;text=words[index].text;}
  else text=candidate;
  if(/[.!?;:]$/.test(words[index].text)&&measure(text)>width*.6){lines.push({from,to:index+1,text});from=index+1;text='';}
 }
 if(text)lines.push({from,to:words.length,text});
 return lines;
}

export function wordAtTime(words:TimedWord[],time:number):number{
 let low=0,high=words.length-1,result=-1;
 while(low<=high){const mid=(low+high)>>>1;if(words[mid].start<=time){result=mid;low=mid+1;}else high=mid-1;}
 return result;
}

export function lineForWord(lines:CaptionLine[],word:number):number{
 let low=0,high=lines.length-1,result=0;
 while(low<=high){const mid=(low+high)>>>1;if(lines[mid].from<=word){result=mid;low=mid+1;}else high=mid-1;}
 return result;
}
