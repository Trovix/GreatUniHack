import { z } from 'zod';
import { captureOperation, type CaptureOperation } from './capture';

const Message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('BIND_ACTIVE_TAB') }).strict(),
  z.object({ type: z.literal('LIST_SECTIONS') }).strict(),
  z.object({ type: z.literal('CAPTURE_SECTION'), sectionId: z.string().regex(/^section-[a-f0-9-]{36}$/) }).strict(),
  z.object({ type: z.literal('IMPORT_RESOURCE'), resourceId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('OPEN_ACTIVITY'), resourceId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('OPEN_WORKSPACE') }).strict(),
]);
type Resource = { id: string; title: string; type: string; url: string; allowed: boolean; reason?: string; privateUrl: string; canOpen: boolean };
type Binding = { tabId: number; origin: string; pageIdentity: string; actionId: string; sections: {id: string; title: string}[]; resources: Resource[]; importedBytes: number; importedHashes: Record<string, number> };
const key = 'captureBinding';
const trusted = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let operationQueue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation);
  operationQueue = result.catch(() => undefined);
  return result;
}
async function assertCurrent(binding: Binding): Promise<void> {
  const current = await readBinding();
  if (current.actionId !== binding.actionId) throw new Error('Capture action changed. Retry explicitly from the current preview.');
}

function classify(raw: { title: string; url: string }, origin: string): Omit<Resource, 'id'> {
  let url: URL;
  try { url = new URL(raw.url); } catch { return { title: raw.title, type: 'excluded', url: '', allowed: false, reason: 'Invalid resource address', privateUrl: '', canOpen: false }; }
  const identity = url.origin + url.pathname;
  let pathname = url.pathname;
  try {
    // Classify the path the server can decode, not its escaped spelling. Reject
    // malformed or excessively nested escapes rather than guessing their meaning.
    for (let depth = 0; depth < 4 && pathname.includes('%'); depth++) pathname = decodeURIComponent(pathname);
    if (pathname.includes('%') || /[\x00-\x1f\x7f\\]/.test(pathname)) throw new Error('Invalid path encoding');
    pathname = new URL(pathname, url.origin).pathname;
  } catch { return { title: raw.title, type: 'excluded', url: identity, allowed: false, reason: 'Malformed or unsupported resource path encoding', privateUrl: '', canOpen: false }; }
  const querySafe = Array.from(url.searchParams.entries()).every(([name, value]) => name === 'forcedownload' && /^[01]$/.test(value));
  const dangerous = /(?:logout|logoff|delete|reset|enrol|unenrol|submit|submission|grade|participants|user\/|profile|feedback|sesskey|token|launch)/i.test(pathname + ' ' + raw.title) || !/^https?:$/.test(url.protocol) || Boolean(url.username || url.password) || !querySafe;
  if (dangerous) return { title: raw.title, type: 'excluded', url: identity, allowed: false, reason: 'Action, personal data, credential-bearing or unsupported link; not imported', privateUrl: '', canOpen: false };
  if (url.origin !== origin) return { title: raw.title, type: 'external activity', url: identity, allowed: false, reason: 'External recording: open the original activity or manually import permitted files', privateUrl: url.href, canOpen: true };
  const ext = pathname.toLowerCase();
  const type = /\.pdf$/.test(ext) ? 'application/pdf' : /\.(png|jpe?g)$/.test(ext) ? 'image' : /\.(vtt|txt)$/.test(ext) ? 'transcript' : 'activity reference';
  if (type === 'activity reference') return { title: raw.title, type, url: identity, allowed: false, reason: 'Activity/redirect endpoint is not a direct supported file. Open original or import manually.', privateUrl: url.href, canOpen: true };
  return { title: raw.title, type, url: identity, allowed: true, privateUrl: url.href, canOpen: true };
}

async function readBinding(): Promise<Binding> {
  await trusted;
  const value = (await chrome.storage.session.get(key))[key] as Binding | undefined;
  if (!value) throw new Error('Source access is not bound or was revoked. Return to the source tab and invoke the extension action again.');
  const tab = await chrome.tabs.get(value.tabId).catch(() => undefined);
  let identity = '';
  try { const url = new URL(tab?.url || ''); identity = url.origin + url.pathname; } catch { /* Closed or inaccessible source tab. */ }
  if (!tab || identity !== value.pageIdentity) {
    await chrome.storage.session.remove(key);
    throw new Error('The original source tab navigated or closed. Invoke the extension again on the selected course page.');
  }
  return value;
}
async function execute(binding: Binding, operation: CaptureOperation): Promise<any> {
  await assertCurrent(binding);
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: binding.tabId, frameIds: [0] }, world: 'ISOLATED', func: captureOperation, args: [operation] });
    await assertCurrent(binding);
    if (!results[0] || results[0].result === undefined) throw new Error('Capture did not finish. Retry from the source tab.');
    return results[0].result;
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Capture failed';
    if (/permission|cannot access|removed|No tab|not allowed/i.test(text)) throw new Error('activeTab access was revoked. Invoke the extension action again on the original course tab; no replacement tab was read.');
    throw error;
  }
}
async function bindTab(tab: chrome.tabs.Tab): Promise<any> {
  if (!tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) throw new Error('Invoke Lecture Access on the course page, not an extension or browser settings tab.');
  const url = new URL(tab.url);
  const binding: Binding = { tabId: tab.id, origin: url.origin, pageIdentity: url.origin + url.pathname, actionId: crypto.randomUUID(), sections: [], resources: [], importedBytes: 0, importedHashes: {} };
  await trusted;
  await chrome.storage.session.set({ [key]: binding });
  const data = await execute(binding, { type: 'sections' });
  binding.sections = data.sections;
  await chrome.storage.session.set({ [key]: binding });
  return data;
}
async function previewSections(binding: Binding): Promise<any> {
  const data = await execute(binding, { type: 'sections' });
  binding.sections = data.sections;
  binding.resources = [];
  await chrome.storage.session.set({ [key]: binding });
  return data;
}
async function handle(input: unknown): Promise<any> {
  const message = Message.parse(input);
  if (message.type === 'OPEN_WORKSPACE') { await chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html') }); return {}; }
  if (message.type === 'BIND_ACTIVE_TAB') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith(chrome.runtime.getURL(''))) {
      const binding = await readBinding();
      return previewSections(binding);
    }
    if (!tab) throw new Error('No selected source tab.');
    return bindTab(tab);
  }
  const binding = await readBinding();
  if (message.type === 'LIST_SECTIONS') return previewSections(binding);
  if (message.type === 'CAPTURE_SECTION') {
    if (!binding.sections.some((section) => section.id === message.sectionId)) throw new Error('Choose a previously previewed section.');
    const data = await execute(binding, { type: 'section', sectionId: message.sectionId });
    binding.actionId = crypto.randomUUID();
    binding.importedBytes = 0;
    binding.importedHashes = {};
    binding.resources = data.resources.map((raw: {title: string; url: string}) => ({ id: crypto.randomUUID(), ...classify(raw, binding.origin) }));
    await chrome.storage.session.set({ [key]: binding });
    return { ...data, resources: binding.resources.map(({ privateUrl: _privateUrl, canOpen, ...resource }) => ({ ...resource, canOpen })) };
  }
  const resource = binding.resources.find((entry) => entry.id === message.resourceId);
  if (!resource) throw new Error('Resource is not part of the current capture action. Capture the section again.');
  if (message.type === 'OPEN_ACTIVITY') {
    if (!resource.canOpen) throw new Error('This action or credential-bearing link cannot be opened through capture. Use the original course page.');
    await chrome.tabs.create({ url: resource.privateUrl });
    return { opened: true };
  }
  if (!resource.allowed) throw new Error(resource.reason || 'This resource is not supported for automatic import.');
  const maxBytes = resource.type === 'transcript' ? 1024 * 1024 : 5 * 1024 * 1024;
  const result = await execute(binding, { type: 'resource', url: resource.privateUrl, expectedMime: resource.type, maxBytes });
  binding.importedHashes ||= {};
  const additionalBytes = binding.importedHashes[result.sha256] === undefined ? result.byteLength : 0;
  if (binding.importedBytes + additionalBytes > 50 * 1024 * 1024) throw new Error('Captured source bundle exceeds 50 MB. Begin a smaller capture.');
  binding.importedBytes += additionalBytes;
  binding.importedHashes[result.sha256] = result.byteLength;
  await chrome.storage.session.set({ [key]: binding });
  const name = decodeURIComponent(new URL(resource.privateUrl).pathname.split('/').pop() || 'selected-resource').replace(/[^\w. -]/g, '_').slice(0, 160);
  return { id: crypto.randomUUID(), name, mime: result.mime, base64: result.base64, sha256: result.sha256, acquisition: 'browser_capture' };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const allowedPages = [chrome.runtime.getURL('workspace.html'), chrome.runtime.getURL('sidepanel.html')];
  if (sender.id !== chrome.runtime.id || !sender.url || !allowedPages.some((page) => sender.url === page || sender.url?.startsWith(page + '?'))) {
    sendResponse({ ok: false, error: 'Only the trusted Lecture Access workspace can request capture.' });
    return false;
  }
  void serial(() => handle(message)).then((data) => sendResponse({ ok: true, data })).catch((error: unknown) => sendResponse({ ok: false, error: error instanceof z.ZodError ? 'Unsupported or malformed capture request.' : error instanceof Error ? error.message : 'Capture failed. Retry explicitly.' }));
  return true;
});
chrome.action.onClicked.addListener((tab) => {
  // Keep side-panel opening in the original user gesture, before any asynchronous work.
  if (tab.id) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  void serial(() => bindTab(tab)).catch(() => chrome.storage.session.remove(key));
});
chrome.tabs.onRemoved.addListener((tabId) => { void chrome.storage.session.get(key).then((state) => { if (state[key]?.tabId === tabId) return chrome.storage.session.remove(key); }); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== 'loading') return;
  void chrome.storage.session.get(key).then((state) => {
    const binding = state[key] as Binding | undefined;
    if (binding?.tabId === tabId) return chrome.storage.session.remove(key);
  });
});
