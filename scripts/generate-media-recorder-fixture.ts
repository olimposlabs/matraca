import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    const context = canvas.getContext('2d')!;
    let tick = 0;
    const draw = setInterval(() => { context.fillStyle = tick++ % 2 ? '#ff784f' : '#242731'; context.fillRect(0, 0, 160, 120); }, 40);
    const stream = canvas.captureStream(25);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.start(100);
    await new Promise(resolve => setTimeout(resolve, 1100));
    recorder.stop(); await finished;
    clearInterval(draw); stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
  });
  await mkdir('tests/fixtures/media', { recursive: true });
  await writeFile('tests/fixtures/media/media-recorder.webm', new Uint8Array(bytes));
  process.stdout.write(`Fixture sintética MediaRecorder gerada, ${bytes.length} bytes.\n`);
} finally { await browser.close(); }
