export type CaptureOperation =
  | { type: 'sections' }
  | { type: 'section'; sectionId: string }
  | { type: 'resource'; url: string; expectedMime: string; maxBytes: number };

/** Runs only through scripting.executeScript in the explicitly bound source tab. */
export async function captureOperation(operation: CaptureOperation): Promise<unknown> {
  const visible = (element: Element): boolean => {
    if (!element.getClientRects().length) {
      if (getComputedStyle(element).display !== 'contents') return false;
      const range = document.createRange();
      range.selectNodeContents(element);
      if (!Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) return false;
    }
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.matches('[hidden],[aria-hidden="true"],[inert]') || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
      if (current instanceof HTMLDetailsElement && !current.open && current !== element) {
        const summary = Array.from(current.children).find((child) => child.tagName === 'SUMMARY');
        if (!summary?.contains(element)) return false;
      }
      const box = current.getBoundingClientRect();
      const target = element.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflowX) && (box.width <= 0 || target.right <= box.left || target.left >= box.right)) return false;
      if (/(hidden|clip|scroll|auto)/.test(style.overflowY) && (box.height <= 0 || target.bottom <= box.top || target.top >= box.bottom)) return false;
      if (/^rect\(\s*0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?\s*\)$/.test(style.clip) || /inset\(\s*50%/.test(style.clipPath)) return false;
    }
    return true;
  };
  const excluded = 'script,style,noscript,template,form,input,textarea,select,button,nav,aside,header,footer,[hidden],[aria-hidden="true"],.participants,.grades,.userprofile';
  const renderedText = (root: Element): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let textLength = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (parent && !parent.closest(excluded) && visible(parent)) { const text = node.textContent || ''; parts.push(text); textLength += text.length + 1; }
      if (textLength > 100_000) throw new Error('Selected section exceeds the 100,000 character capture limit. Choose a smaller section.');
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const courseTitle = (): string => {
    const heading = Array.from(document.querySelectorAll('main h1,[role="main"] h1,h1')).find((element) => visible(element) && !element.closest(excluded));
    return (heading ? renderedText(heading) : document.title).slice(0, 200);
  };
  const captureState = globalThis as unknown as { __lectureAccessSections?: Map<string, Element> };
  const sectionElements = (): Element[] => {
    const known = Array.from(document.querySelectorAll('.course-section,li.section,section[data-sectionid],section[aria-label]')).filter(visible);
    if (known.length) return known.filter((element) => !known.some((other) => other !== element && other.contains(element)));
    return Array.from(document.querySelectorAll('main section,[role="main"] section')).filter(visible).filter((element) => !element.parentElement?.closest('section'));
  };
  if (operation.type === 'sections') {
    const elements = sectionElements();
    if (elements.length > 60) throw new Error('More than 60 visible sections. Open a smaller course/week page or import selected files manually.');
    // Keep the actual nodes in this extension's isolated world. Re-indexing a later
    // visible-node list could silently select a different week after a DOM change.
    const sections = elements.map((element) => ({ id: `section-${crypto.randomUUID()}`, element }));
    captureState.__lectureAccessSections = new Map(sections.map(({ id, element }) => [id, element]));
    return {
      courseTitle: courseTitle(),
      pageIdentity: location.origin + location.pathname,
      recognised: Boolean(document.querySelector('.course-section,li.section,section[data-sectionid]')),
      sections: sections.map(({ id, element }, index) => {
        const heading = Array.from(element.querySelectorAll('h2,h3,h4')).find((node) => visible(node) && !node.closest(excluded));
        return { id, title: (heading ? renderedText(heading) : element.getAttribute('aria-label') || `Visible section ${index + 1}`).trim().slice(0, 200) };
      }),
    };
  }
  if (operation.type === 'section') {
    const element = /^section-[a-f0-9-]{36}$/.test(operation.sectionId) ? captureState.__lectureAccessSections?.get(operation.sectionId) : undefined;
    if (!element?.isConnected || !visible(element)) throw new Error('The selected visible section changed or no longer exists. Preview the course sections again.');
    const links = Array.from(element.querySelectorAll('a[href]')).filter((link) => visible(link) && !link.closest(excluded));
    if (links.length > 60) throw new Error('Selected section has more than 60 resource links. Choose a smaller visible section or import selected files manually.');
    const resources = links.map((link) => ({ title: (renderedText(link) || 'Untitled resource').slice(0, 200), url: (link as HTMLAnchorElement).href }));
    return { courseTitle: courseTitle(), pageIdentity: location.origin + location.pathname, capturedAt: new Date().toISOString(), text: renderedText(element), acquisition: 'browser_capture', resources };
  }
  const url = new URL(operation.url);
  if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) throw new Error('Only a selected same-origin resource can be imported.');
  // manual prevents login/activity redirects from being followed, including cross-origin hops.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('Resource read timed out')), 10_000);
  try {
  const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw new Error('This resource redirects. Open the original activity and use manual file import.');
  if (!response.ok) throw new Error(`Resource unavailable (${response.status}). Check the source-tab session or use manual import.`);
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') throw new Error('The resource returned an HTML/login page, not lecture material.');
  const expected = operation.expectedMime;
  const allowed = expected === 'image' ? ['image/png', 'image/jpeg'] : expected === 'transcript' ? ['text/vtt', 'text/plain', 'application/octet-stream'] : ['application/pdf'];
  if (!allowed.includes(mime)) throw new Error(`Unsupported resource type: ${mime || 'missing MIME'}. Use manual import.`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > operation.maxBytes) throw new Error('Resource exceeds the supported size limit.');
  if (!response.body) throw new Error('Resource has no readable body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel('Resource read timed out'); }, 10_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > operation.maxBytes) { await reader.cancel(); throw new Error('Resource exceeds the supported size limit.'); }
      chunks.push(value);
    }
  } finally { clearTimeout(timeout); }
  if (timedOut) throw new Error('Resource read timed out. No partial asset was imported; retry explicitly.');
  if (!length) throw new Error('Resource is empty.');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const isPng = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const text = new TextDecoder('utf-8', { fatal: expected === 'transcript' }).decode(expected === 'transcript' ? bytes : bytes.subarray(0, Math.min(length, 4096)));
  if (expected === 'application/pdf' && !text.startsWith('%PDF-')) throw new Error('PDF signature does not match the resource type.');
  if (expected === 'image' && ((mime === 'image/png' && !isPng) || (mime === 'image/jpeg' && !isJpeg))) throw new Error('Image signature does not match the resource MIME type.');
  if (expected === 'transcript' && /<\s*(?:!doctype|html|script|body|iframe)\b/i.test(text)) throw new Error('Executable markup is not a transcript.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((v) => v.toString(16).padStart(2, '0')).join('');
  // Bound binary-string construction avoids argument spreading and JSON's Blob/ArrayBuffer loss.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16_384) {
    for (const byte of bytes.subarray(i, i + 16_384)) binary += String.fromCharCode(byte);
  }
  return { base64: btoa(binary), mime: expected === 'transcript' ? (text.startsWith('WEBVTT') ? 'text/vtt' : 'text/plain') : mime, sha256: hash, byteLength: length };
  } finally {
    clearTimeout(deadline);
    // Aborting also closes a response rejected before reader acquisition (MIME,
    // redirect, status or declared length), rather than downloading it in background.
    controller.abort();
  }
}
