import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// This task-only read-only preflight never generates speech, transcribes or
// compiles. Keys exist only in this process and authorized HTTPS headers.
async function getJson(url: string, headers: Record<string, string>) {
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return { ok: false as const, status: response.status };
    const body = await response.text();
    if (body.length > 2_000_000) return { ok: false as const, status: response.status, code: 'RESPONSE_TOO_LARGE' };
    return { ok: true as const, data: JSON.parse(body) as any };
  } catch { return { ok: false as const, code: 'NETWORK_OR_RESPONSE_ERROR' }; }
}

async function main() {
  const report: Record<string, unknown> = { at: new Date().toISOString(), syntheticOnly: true, generationCalls: 0, multimodalCalls: 0, keyValuesRecorded: false };
  const openaiFile = process.env.LECTURE_ACCESS_OPENAI_KEY_FILE;
  if (openaiFile) {
    try {
      const key = (await readFile(openaiFile, 'utf8')).trim();
      const model = process.env.LECTURE_ACCESS_OPENAI_MODEL || 'gpt-4.1';
      const response = await getJson(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { Authorization: `Bearer ${key}` });
      report.openai = response.ok ? { available: true, model: response.data.id, note: 'Model read access verified; paid request credit is not proven by this endpoint.' } : { available: false, ...response };
    } catch { report.openai = { available: false, code: 'REPLACEMENT_KEY_FILE_UNREADABLE' }; }
  } else report.openai = { available: false, code: 'REPLACEMENT_KEY_FILE_NOT_CONFIGURED' };

  try {
    const keyFile = process.env.LECTURE_ACCESS_ELEVENLABS_KEY_FILE;
    if (!keyFile) throw new Error('ElevenLabs key file not configured');
    const key = (await readFile(keyFile, 'utf8')).trim();
    if (!key) throw new Error('Empty authorized file');
    process.env.ELEVENLABS_API_KEY = key;
    const headers = { 'xi-api-key': process.env.ELEVENLABS_API_KEY };
    const subscription = await getJson('https://api.elevenlabs.io/v1/user/subscription', headers);
    const voices = await getJson('https://api.elevenlabs.io/v2/voices?category=premade&page_size=100', headers);
    const models = await getJson('https://api.elevenlabs.io/v1/models', headers);
    const candidates = voices.ok && Array.isArray(voices.data.voices) ? voices.data.voices.filter((voice: any) => voice.category === 'premade' && typeof voice.voice_id === 'string') : [];
    const selected = candidates.find((voice: any) => voice.name === 'George') || candidates.find((voice: any) => /english/i.test(voice.labels?.language || '')) || candidates[0];
    const ttsModels = models.ok && Array.isArray(models.data) ? models.data.filter((model: any) => model.can_do_text_to_speech).map((model: any) => ({ id: model.model_id, name: model.name })) : [];
    report.elevenlabs = {
      available: subscription.ok && Boolean(selected) && ttsModels.length > 0,
      subscription: subscription.ok ? { status: subscription.data.status, quotaAvailable: subscription.data.character_limit > subscription.data.character_count, note: 'Read-only quota snapshot; actual synthesis may consume model-dependent credits.' } : subscription,
      stockVoice: selected ? { id: selected.voice_id, name: selected.name, category: selected.category, source: 'Authenticated GET /v2/voices?category=premade' } : { available: false, response: voices.ok ? 'NO_PREMADE_VOICE_RETURNED' : voices },
      ttsModels,
      modelListStatus: models.ok ? 'verified' : models,
      stt: 'Not yet verified; model list is not an STT availability proof.',
    };
  } catch { report.elevenlabs = { available: false, code: 'AUTHORIZED_KEY_FILE_UNREADABLE_OR_EMPTY' }; }
  await mkdir(resolve('verification'), { recursive: true });
  await writeFile(resolve('verification/provider-preflight.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
void main();
