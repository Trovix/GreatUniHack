/** Node-only bounded media inspection. Never re-export this module from browser-shared index.ts. */
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AssetSchema, LIMITS, type Asset, type Bundle } from './schemas';
import { InputValidationError, decodeBase64, inspectAssetHeader, validateBundle, type BundleValidationOptions } from './input';

export interface AssetInspection { sha256: string; width?: number; height?: number; durationMs?: number; pageCount?: number }
export interface AssetInspectionOptions { timeoutMs?: number }
const inspected = new Map<string, AssetInspection>();

// This worker has no source URL, filesystem path, provider credential, or application token.
// Parsers/decoders are interruptible even when their work blocks the worker event loop.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const bytes = new Uint8Array(workerData.bytes);
const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const limits = workerData.limits;
function bad(message) { throw new Error(message); }
function dimensions(w,h) {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w<1 || h<1 || w>limits.maxImageDimension || h>limits.maxImageDimension || w*h>limits.maxImagePixels) bad('Decoded image dimensions exceed prototype limits');
}
function wav() {
  const end = b.readUInt32LE(4)+8;
  if (end>b.length || end<44) bad('Truncated or malformed WAV container');
  let fmt, data=0, pos=12;
  while(pos+8<=end) {
    const id=b.toString('ascii',pos,pos+4), length=b.readUInt32LE(pos+4), start=pos+8;
    if(start+length>end) bad('Truncated WAV chunk');
    if(id==='fmt ') {
      if(fmt || length<16) bad('Malformed WAV format');
      let format=b.readUInt16LE(start);
      const channels=b.readUInt16LE(start+2), rate=b.readUInt32LE(start+4), byteRate=b.readUInt32LE(start+8), align=b.readUInt16LE(start+12), bits=b.readUInt16LE(start+14);
      if(format===65534) {
        if(length<40 || b.readUInt16LE(start+16)<22) bad('Malformed extensible WAV format');
        format=b.readUInt16LE(start+24);
        if(b.readUInt16LE(start+26)!==0 || b.toString('hex',start+28,start+40)!=='00001000800000aa00389b71') bad('Unsupported extensible WAV codec');
      }
      if(![1,3].includes(format) || channels<1 || channels>8 || rate<8000 || rate>192000 || ![8,16,24,32,64].includes(bits) || format===3 && ![32,64].includes(bits) || format===1 && bits===64 || align!==channels*bits/8 || byteRate!==rate*align) bad('Unsupported or inconsistent WAV audio format');
      fmt={rate,align,byteRate};
    } else if(id==='data') { if(!length) bad('WAV contains no samples'); data+=length; }
    pos=start+length+(length%2);
  }
  if(!fmt || !data || data%fmt.align || pos!==end) bad('WAV has no complete playable sample data');
  return {durationMs:data/fmt.byteRate*1000};
}
function mp3() {
  let pos=0;
  if(b.toString('ascii',0,3)==='ID3') {
    if(b.length<10 || ![2,3,4].includes(b[3]) || [b[6],b[7],b[8],b[9]].some(x=>x&128)) bad('Malformed MP3 ID3 header');
    const size=(b[6]<<21)|(b[7]<<14)|(b[8]<<7)|b[9];
    pos=10+size+(b[3]===4 && (b[5]&16) ? 10:0);
    if(pos>=b.length) bad('MP3 contains metadata but no audio');
  }
  let frames=0, duration=0, initialRate;
  while(pos<b.length) {
    const remaining=b.length-pos;
    if(remaining===128 && b.toString('ascii',pos,pos+3)==='TAG') break;
    if(remaining<=4096 && b.subarray(pos).every(x=>x===0)) break;
    if(remaining<4) bad('Truncated MP3 frame');
    const h=b.readUInt32BE(pos), version=(h>>>19)&3, layer=(h>>>17)&3, bi=(h>>>12)&15, si=(h>>>10)&3;
    if((h>>>21)!==2047 || version===1 || layer!==1 || bi===0 || bi===15 || si===3) bad('Invalid or unsupported MP3 frame');
    const rate=[44100,48000,32000][si]/(version===3?1:version===2?2:4);
    if(initialRate && initialRate!==rate) bad('MP3 changes sample rate');
    initialRate=rate;
    const bitrate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bi]*1000;
    const length=Math.floor((version===3?144:72)*bitrate/rate)+((h>>>9)&1);
    if(length<4 || pos+length>b.length) bad('Truncated MP3 audio frame');
    duration+=(version===3?1152:576)/rate*1000;
    pos+=length;
    if(++frames>50000 || duration>limits.maxAudioDurationMs+1) bad('Source audio exceeds duration limit');
  }
  if(frames<2) bad('MP3 has insufficient complete audio frames');
  return {durationMs:duration};
}
(async()=>{
 const mime=workerData.mime;
 let result={};
 if(mime.startsWith('image/')) {
   const {default:sharp}=await import(workerData.sharp);
   const input=sharp(b,{limitInputPixels:limits.maxImagePixels,failOn:'error',sequentialRead:true,animated:false});
   const meta=await input.metadata();
   if(meta.format!==(mime==='image/png'?'png':'jpeg') || (meta.pages||1)>1) bad('MIME mismatch or animated/multipage image is unsupported');
   dimensions(meta.width,meta.height);
   // Decode the actual compressed pixel stream, not only its metadata header.
   const decoded=await input.raw().toBuffer({resolveWithObject:true});
   dimensions(decoded.info.width,decoded.info.height);
   if(decoded.data.length>limits.maxImagePixels*4) bad('Decoded image byte limit exceeded');
   result={width:meta.width,height:meta.height};
 } else if(mime==='application/pdf') {
   const pdf=await import(workerData.pdfjs);
   const task=pdf.getDocument({data:bytes,isEvalSupported:false,stopAtErrors:true,disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,enableXfa:false,maxImageSize:limits.maxImagePixels,useWasm:false,verbosity:0});
   const doc=await task.promise;
   try {
     if(doc.numPages<1 || doc.numPages>limits.maxPdfPages) bad('PDF exceeds 50-page limit or has no pages');
     for(let n=1;n<=doc.numPages;n++) {
       const page=await doc.getPage(n), viewport=page.getViewport({scale:1});
       if(!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width<=0 || viewport.height<=0 || viewport.width>1000000 || viewport.height>1000000) bad('Malformed PDF page geometry');
       const operators=await page.getOperatorList();
       if(operators.fnArray.length>100000) bad('PDF page content exceeds bounded parser complexity');
       page.cleanup();
     }
     result={pageCount:doc.numPages};
   } finally { await doc.destroy(); }
 } else if(mime.startsWith('audio/')) {
   result=mime==='audio/wav'||mime==='audio/x-wav'?wav():mp3();
   if(!Number.isFinite(result.durationMs) || result.durationMs<=0 || result.durationMs>limits.maxAudioDurationMs) bad('Source audio duration exceeds prototype limit');
   const mm=await import(workerData.musicMetadata);
   const metadata=await mm.parseBuffer(b,{mimeType:mime==='audio/mp3'?'audio/mpeg':mime,size:b.length},{duration:true,skipCovers:true});
   if(!metadata.format.sampleRate || !metadata.format.numberOfChannels) bad('Audio metadata does not describe playable samples');
   if(metadata.format.duration && Math.abs(metadata.format.duration*1000-result.durationMs)>1500) bad('Audio duration metadata conflicts with its sample/frame data');
 }
 parentPort.postMessage({ok:true,result});
})().catch(()=>parentPort.postMessage({ok:false,error:'Asset could not be fully decoded or parsed within the supported media limits'}));
`;

export async function inspectAssetBytes(bytes: Uint8Array, mime: Asset['mime'], options: AssetInspectionOptions = {}): Promise<AssetInspection> {
  const header = inspectAssetHeader(bytes, mime);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = `${mime}:${sha256}`;
  const cached = inspected.get(key);
  if (cached) return { ...cached };
  if (mime.startsWith('text/')) return { sha256 };
  const timeoutMs = Math.min(options.timeoutMs ?? LIMITS.assetTimeoutMs, LIMITS.assetTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new InputValidationError('Invalid asset parse timeout');
  // Buffer.slice() aliases its backing store. Transfer only an owned copy to
  // the parser worker so validation cannot detach provider/source audio bytes.
  const data = Uint8Array.from(bytes);
  const metadata = await new Promise<Omit<AssetInspection, 'sha256'>>((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true, workerData: { bytes: data.buffer, mime, limits: LIMITS,
        sharp: import.meta.resolve('sharp'), pdfjs: import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'), musicMetadata: import.meta.resolve('music-metadata') },
      transferList: [data.buffer], resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
      stdout: true, stderr: true,
    });
    // Consume bounded library diagnostics without forwarding source text or noisy parser errors to logs.
    worker.stdout?.resume(); worker.stderr?.resume();
    let finished = false;
    const finish = (error?: Error, result?: Omit<AssetInspection, 'sha256'>) => {
      if (finished) return;
      finished = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolve(result ?? {});
    };
    const timer = setTimeout(() => finish(new InputValidationError('Asset parse/decode exceeded the 10-second prototype timeout', 'ASSET_TIMEOUT')), timeoutMs);
    worker.once('message', message => message?.ok ? finish(undefined, message.result) : finish(new InputValidationError('Unreadable or unsupported asset; full media decoding/parsing failed', 'INVALID_ASSET')));
    worker.once('error', () => finish(new InputValidationError('Asset parser failed its bounded worker limits', 'INVALID_ASSET')));
    worker.once('exit', () => { if (!finished) finish(new InputValidationError('Asset parser exited before verification', 'INVALID_ASSET')); });
  });
  const result = { sha256, ...header, ...metadata };
  if (inspected.size >= 64) inspected.delete(inspected.keys().next().value!);
  inspected.set(key, result);
  return { ...result };
}

/** Replaces ALL claimed digest/dimension/duration metadata with values from the actual decoded bytes. */
export async function verifyAsset(asset: Asset, options?: AssetInspectionOptions): Promise<Asset> {
  const parsed = AssetSchema.safeParse(asset);
  if (!parsed.success) throw new InputValidationError('Invalid or oversized asset metadata/base64');
  const metadata = await inspectAssetBytes(decodeBase64(parsed.data.base64), parsed.data.mime, options);
  const { sha256: _hash, durationMs: _duration, width: _width, height: _height, ...source } = parsed.data;
  return AssetSchema.parse({ ...source, sha256: metadata.sha256,
    ...(metadata.width ? { width: metadata.width, height: metadata.height } : {}),
    ...(metadata.durationMs ? { durationMs: metadata.durationMs } : {}) });
}

export async function verifyBundleAssets(bundle: Bundle, options: BundleValidationOptions = {}): Promise<Bundle> {
  // Sequential inspection avoids unbounded simultaneous decoded pixel/temp allocations.
  const assets: Asset[] = [];
  const pageCounts = new Map<string, number>();
  let aggregateBytes = 0;
  for (const asset of bundle.assets) {
    aggregateBytes += asset.base64.length / 4 * 3;
    if (aggregateBytes > LIMITS.maxBundleBytes + bundle.assets.length * 2) throw new InputValidationError('Source bundle exceeds aggregate byte limit');
    const verified = await verifyAsset(asset);
    assets.push(verified);
    if (verified.mime === 'application/pdf') pageCounts.set(verified.id, (await inspectAssetBytes(decodeBase64(verified.base64), verified.mime)).pageCount!);
  }
  const verified = { ...bundle, assets };
  const errors = validateBundle(verified, options);
  for (const entry of verified.timeline) if (entry.page && pageCounts.has(entry.assetId) && entry.page > pageCounts.get(entry.assetId)!) errors.push(`Timeline ${entry.id} selects a nonexistent PDF page`);
  if (errors.length) throw new InputValidationError(errors.join('; '));
  return verified;
}
