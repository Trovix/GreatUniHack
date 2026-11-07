import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';

export async function main(): Promise<void> {
  const origin = process.env.LECTURE_ACCESS_EXTENSION_ORIGIN;
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new Error('Set LECTURE_ACCESS_EXTENSION_ORIGIN to the exact chrome-extension://<id> shown by your installed unpacked extension.');
  const port = Number(process.env.LECTURE_ACCESS_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LECTURE_ACCESS_PORT must be an unprivileged TCP port.');
  const dataDir = path.resolve(process.env.LECTURE_ACCESS_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.data'));
  const app = await createServer({ dataDir, allowedOrigins: [origin] });
  await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', () => { app.server.off('error', reject); resolve(); }); });
  // Never print a token, key, source URL, or provider request body.
  console.info(`Lecture Access API listening at http://127.0.0.1:${port}`);
  console.info(`Pair once using the private token file at ${path.join(dataDir, 'pairing-token')}. Provider consent is separate for analysis, speech, and transcription.`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error('Lecture Access API could not start. Check the exact extension origin, loopback port, private data directory, and provider configuration.'); process.exitCode = 1; });
}
