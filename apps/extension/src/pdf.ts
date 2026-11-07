import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Asset } from '../../../packages/core/index';
import { base64Bytes, bytesToBase64, LIMITS } from './ingest';

GlobalWorkerOptions.workerSrc = workerUrl;
export function selectedPages(text: string, pageCount: number): number[] {
  if (!/^\s*\d+(\s*,\s*\d+)*\s*$/.test(text)) throw new Error('Enter page numbers separated by commas, for example 1, 3, 5.');
  const pages = text.split(',').map(s => Number(s.trim()));
  if (pages.length < 1 || pages.length > 6 || new Set(pages).size !== pages.length || pages.some(p => !Number.isInteger(p) || p < 1 || p > pageCount)) throw new Error(`Select one to six different pages, between 1 and ${pageCount}.`);
  return pages;
}
export type OpenPdf = {pageCount: number; render: (pages: number[]) => Promise<{images: Asset[]; context: {id: string; text: string}[]}>; close: () => Promise<void>};
/** PDF parsing is isolated in the locally bundled PDF.js worker; deadline destroys that worker. */
export async function openPdf(asset: Asset): Promise<OpenPdf> {
  if (asset.mime !== 'application/pdf') throw new Error('Select a PDF first.');
  const loading = getDocument({data: base64Bytes(asset.base64), isEvalSupported: false, enableXfa: false,
    disableFontFace: true, useSystemFonts: false, useWasm: false, maxImageSize: LIMITS.pixels,
    stopAtErrors: true, disableAutoFetch: true, disableStream: true, disableRange: true});
  let document: PDFDocumentProxy;
  let parseTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    document = await Promise.race([loading.promise, new Promise<never>((_, reject) => {
      parseTimer = setTimeout(() => { void loading.destroy(); reject(new Error('PDF parsing exceeded 10 seconds. Use selected PNG/JPEG page images instead.')); }, 10_000);
    })]);
  } catch (error) {
    await loading.destroy();
    throw new Error((error as Error).message?.includes('10 seconds') ? (error as Error).message : 'This PDF is unreadable or encrypted. Import selected PNG/JPEG pages instead.');
  } finally { clearTimeout(parseTimer); }
  if (document.numPages > 50 || document.numPages < 1) { await loading.destroy(); throw new Error('This PDF exceeds the 50-page parse limit. Split it locally before importing.'); }
  let closed = false;
  return {
    pageCount: document.numPages,
    close: async () => { closed = true; await loading.destroy(); },
    render: async pages => {
      selectedPages(pages.join(','), document.numPages);
      if (closed) throw new Error('PDF reader closed. Select the PDF again.');
      const images: Asset[] = [], context: {id: string; text: string}[] = [];
      let renderTask: RenderTask | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const canvases: HTMLCanvasElement[] = [];
      const work = async () => {
        for (const pageNumber of pages) {
          const page = await document.getPage(pageNumber);
          const natural = page.getViewport({scale: 1});
          if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0) throw new Error('Invalid PDF page dimensions.');
          const scale = Math.min(2, 1800 / Math.max(natural.width, natural.height), Math.sqrt(4_000_000 / (natural.width * natural.height)));
          const viewport = page.getViewport({scale});
          const canvas = documentGlobal().createElement('canvas'); canvases.push(canvas);
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          const context2d = canvas.getContext('2d', {alpha: false});
          if (!context2d) throw new Error('Page image rendering is unavailable in this browser.');
          renderTask = page.render({canvasContext: context2d, canvas, viewport, background: 'rgb(255,255,255)'});
          await renderTask.promise;
          if (closed) throw new Error('PDF rendering was cancelled.');
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PDF page image could not be encoded.')), 'image/png'));
          if (blob.size > LIMITS.visual) throw new Error('Rendered PDF page exceeds 5 MB. Import a smaller image.');
          const id = `page-${crypto.randomUUID()}`;
          images.push({id, name: `${asset.name} — page ${pageNumber}`, mime: 'image/png', base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), acquisition: asset.acquisition, width: canvas.width, height: canvas.height});
          const textContent = await page.getTextContent();
          const text = textContent.items.map(item => 'str' in item ? item.str : '').join(' ');
          if (text.length > 50_000) throw new Error('PDF page text exceeds the bounded text limit. Use a page image instead.');
          if (text.trim()) context.push({id: `pdf-text-${id}`, text: `Independently extracted PDF text, ${asset.name}, page ${pageNumber}. This channel may disagree with the visible image and is not authoritative.\n${text}`});
          page.cleanup(); canvas.width = canvas.height = 0;
        }
        return {images, context};
      };
      try {
        return await Promise.race([work(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { closed = true; renderTask?.cancel(); void loading.destroy(); reject(new Error('PDF rendering exceeded the 10-second asset limit. Use PNG/JPEG page images instead.')); }, 10_000);
        })]);
      } finally { clearTimeout(timer); for (const canvas of canvases) canvas.width = canvas.height = 0; }
    },
  };
}
// Avoid shadowing the browser document with PDFDocumentProxy above.
function documentGlobal(): Document { return globalThis.document; }
