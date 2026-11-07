/** Spoken feedback and voice commands shared by the demo page and its local server. */

/**
 * Fixed phrases, voiced once with ElevenLabs and cached on disk, so replays make no speech calls.
 * They are written for someone who is only listening: each says where things stand and what to say next.
 */
export const cueText={
 transcript:'Step 2 of 5. Found it. Reading the lecture transcript.',
 materials:'Step 3 of 5. Matching the transcript with your notes and slides.',
 rewrite:'Step 4 of 5. Rewriting it so it makes sense without the slides.',
 speech:'Step 5 of 5. Recording your narrated lesson.',
 stillFind:'Still looking for your lecture on Moodle.',
 stillTranscript:'Still reading the lecture transcript.',
 stillMaterials:'Still matching it with your notes and slides.',
 stillRewrite:'Still rewriting the lecture. This part takes a minute or two.',
 stillSpeech:'Still recording your lesson. Almost there.',
 find:'Step 1 of 5. Finding your lecture on Moodle.',
 end:"That's the end of the lesson. Say start over to hear it again, or ask for another lecture.",
 help:'You can say play, pause, go back, skip ahead, slower, faster, or where am I. You can also ask what lectures you have, or ask for a new lecture at any time.',
 unknown:"Sorry, I didn't catch that. Say help to hear what you can ask.",
 silence:"I didn't hear anything. Tap the bubble, or hold the space bar, and try again.",
 stopped:'Okay. I stopped preparing that lecture.',
 noLectures:"You don't have any prepared lectures yet. Ask me for one, like: teach me my latest lecture.",
 voiceError:"Sorry, I couldn't understand that recording. Please try again.",
}as const;
export type CueName=keyof typeof cueText;

/** The milestone a listener hears as each preparation step begins, and the reminder while it continues. */
export const stepCues={find:'find',transcript:'transcript',materials:'materials',rewrite:'rewrite',speech:'speech'}as const satisfies Record<string,CueName>;
export const stillCues={find:'stillFind',transcript:'stillTranscript',materials:'stillMaterials',rewrite:'stillRewrite',speech:'stillSpeech'}as const satisfies Record<string,CueName>;

export type Command=
 |{kind:'play'|'pause'|'slower'|'faster'|'normal'|'restart'|'transcript'|'save'|'new'|'cancel'|'request'|'help'|'where'|'library'|'unknown'}
 |{kind:'back'|'forward';seconds:number}
 |{kind:'open';index:number};

const numbers:Record<string,number>={a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,fifteen:15,twenty:20,thirty:30,forty:40,sixty:60};
const ordinals:Record<string,number>={latest:0,last:0,newest:0,recent:0,first:0,one:0,1:0,second:1,two:1,2:1,third:2,three:2,3:2,fourth:3,four:3,4:3,fifth:4,five:4,5:4};

/** Map a transcribed utterance to a command. Anything that reads like a lecture request becomes a new request. */
export function parseCommand(raw:string):Command{
 const text=` ${raw.toLowerCase().replace(/[’']/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim()} `;
 if(!text.trim())return{kind:'unknown'};
 const has=(pattern:RegExp)=>pattern.test(text);
 const amount=()=>{
  const match=text.match(/ (\d+|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|sixty) (seconds?|secs?|minutes?|mins?) /);
  if(!match)return 10;
  const value=/^\d+$/.test(match[1])?Number(match[1]):numbers[match[1]];
  return Math.min(600,match[2].startsWith('min')?value*60:value);
 };
 if(has(/ (help|what can i (say|do|ask)|commands|options) /))return{kind:'help'};
 if(has(/ (what|which) (lectures|lessons)| (my|past|previous|saved|old) (lectures|lessons)| list (my |the )?(lectures|lessons)/)&&!has(/ (teach|explain) /))return{kind:'library'};
 const open=text.match(/ (?:open|load|play|go to) (?:the |my )?(?:most )?(latest|last|newest|recent|first|second|third|fourth|fifth|number (?:one|two|three|four|five|[1-5]))(?: one| lecture| lesson)? /);
 if(open){const key=open[1].replace('number ','');return{kind:'open',index:ordinals[key]??0};}
 if(text.trim().split(' ').length>=4&&has(/ (teach|lecture|lesson|explain|prepare|summari[sz]e) /)&&!has(/ (again|back|transcript|new lecture|another lecture|different lecture) /))return{kind:'request'};
 if(has(/ (where am i|how (long|much)|time left|whats left|remaining) /))return{kind:'where'};
 if(has(/ (cancel|never mind|nevermind) /))return{kind:'cancel'};
 if(has(/ (new lecture|another lecture|different lecture|something else|new request|back to (the )?(request|start|home)|go home) /))return{kind:'new'};
 if(has(/ (start over|from the (beginning|start|top)|restart|beginning) /))return{kind:'restart'};
 if(has(/ (go back|rewind|back up|repeat|say that again|again|back \S+ (seconds?|secs?|minutes?|mins?)) /))return{kind:'back',seconds:amount()};
 if(has(/ (skip|forward|ahead) /))return{kind:'forward',seconds:amount()};
 if(has(/ (slower|slow down|too fast) /))return{kind:'slower'};
 if(has(/ (faster|speed up|too slow|quicker) /))return{kind:'faster'};
 if(has(/ (normal|regular) speed | normal /))return{kind:'normal'};
 if(has(/ (pause|wait|hold on|stop|quiet|shush) /))return{kind:'pause'};
 if(has(/ (play|resume|continue|go on|start|carry on|keep going|listen) /))return{kind:'play'};
 if(has(/ (transcript|read it|show me the text|show the text) /))return{kind:'transcript'};
 if(has(/ (save|download) /))return{kind:'save'};
 return{kind:'unknown'};
}

export const speeds=[.75,1,1.25,1.5,2];
/** Step through the player's own speed options. */
export function nextSpeed(current:number,direction:1|-1){
 const index=speeds.reduce((best,value,i)=>Math.abs(value-current)<Math.abs(speeds[best]-current)?i:best,0);
 return speeds[Math.max(0,Math.min(speeds.length-1,index+direction))];
}

/** Durations as a listener would say them: "1 minute 5 seconds". */
export function spokenDuration(seconds:number){
 const total=Math.max(0,Math.round(seconds)),minutes=Math.floor(total/60),rest=total%60;
 const part=(n:number,unit:string)=>`${n} ${unit}${n===1?'':'s'}`;
 if(!minutes)return part(rest,'second');
 return rest?`${part(minutes,'minute')} ${part(rest,'second')}`:part(minutes,'minute');
}
/** "EC2A3 - Microeconomics II 2026/27 (Moodle)" reads aloud as "Microeconomics II". */
export function spokenCourse(course?:string){
 return (course||'').replace(/\s*\([^)]*\)/g,'').replace(/^[A-Z]{2,}[\w.]*\s*[-–:]\s*/,'').replace(/\s*\d{4}\s*[/-]\s*\d{2,4}\s*$/,'').trim();
}
type Lecture={title?:string;course?:string;duration?:number;at?:string};
const when=(at?:string)=>{
 const date=at?new Date(at):undefined;if(!date||Number.isNaN(date.getTime()))return'';
 const time=date.toLocaleTimeString('en-GB',{hour:'numeric',minute:'2-digit'});
 const today=new Date().toDateString()===date.toDateString();
 return today?`today at ${time}`:`on ${date.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}`;
};

export const speak={
 confirm:(heard:string)=>`Got it: ${heard.replace(/[.!?]+$/,'')}. Finding it on Moodle now.`,
 ready:(run:Lecture)=>{
  const course=spokenCourse(run.course);
  return `Your lecture is ready: ${run.title||'your lesson'}${course?`, from ${course}`:''}.${run.duration?` It's ${spokenDuration(run.duration)} long.`:''} Say play to start. You can ask me to pause, go back, or slow down at any time.`;
 },
 opening:(run:Lecture)=>`Opening ${run.title||'your lecture'}${run.at?`, prepared ${when(run.at)}`:''}. Say play to start.`,
 error:(message:string)=>`I couldn't finish preparing that lecture. ${message}`.slice(0,380),
 speed:(rate:number)=>rate===1?'Normal speed.':`Playing at ${rate} times speed.`,
 where:(time:number,duration:number)=>`You're ${spokenDuration(time)} in, with ${spokenDuration(Math.max(0,duration-time))} left.`,
 library:(lectures:Lecture[])=>{
  const items=lectures.slice(0,3).map((lecture,i)=>`${i+1}: ${lecture.title||'Untitled lecture'}${lecture.at?`, prepared ${when(lecture.at)}`:''}.`);
  return `You have ${lectures.length} prepared lecture${lectures.length===1?'':'s'}. ${items.join(' ')} Say open the latest, or open number two.`.slice(0,380);
 },
};
