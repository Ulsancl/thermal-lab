import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { ThermalRun } from '../src/experiment.js';
import { DEFAULT_CONFIG } from '../src/model.js';
import { createProject, serializeProject } from '../src/project.js';
import { temperatureColor } from '../src/geometry.js';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/browser-integration');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5231, strictPort: true, hmr: false } }); await server.listen();
const hardware = process.env.THERMAL_BROWSER_HARDWARE === '1';
const browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true }), page = await context.newPage();
page.setDefaultTimeout(20000);
const checks = [], errors = [], externalRequests = []; let gpu, failure;
function watch(p) { p.on('pageerror', error => errors.push(error.message)); p.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); p.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); }); } watch(page);
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const state = () => page.evaluate(() => window.thermalLab.getState());
const project = () => page.evaluate(() => window.thermalLab.project());
const guide = () => page.evaluate(() => window.thermalLab.guide());
const debug = () => page.evaluate(() => window.thermalLab.sceneDebug());
const chart = () => page.evaluate(() => window.thermalLab.chartDebug());
const load = value => page.evaluate(raw => window.thermalLab.loadProject(raw), serializeProject(value));
const advance = seconds => page.evaluate(seconds => window.thermalLab.step(seconds), seconds);
const select = async (id, value) => { const input = page.locator(`#${id}`); await input.scrollIntoViewIfNeeded(); return input.selectOption(String(value)); };
const choose = id => page.locator(`[data-lesson="${id}"]`).click();
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function numericEqual(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { near(a, b); return; }
  if (a && b && typeof a === 'object' && typeof b === 'object') { assert.deepEqual(Object.keys(a), Object.keys(b)); for (const key of Object.keys(a)) numericEqual(a[key], b[key]); return; }
  assert.deepEqual(a, b);
}
async function parity() {
  const actual = await state(), model = new ThermalRun(actual.experiment), scene = await debug();
  numericEqual(actual.snapshot, model.getSnapshot()); assert.equal(scene.module, actual.snapshot.config.module);
  assert.deepEqual(scene.temperatures, { heaterC: actual.snapshot.heaterC, sinkC: actual.snapshot.sinkC });
  near(scene.heatFlow.contactHeatW, actual.snapshot.contactHeatW); near(scene.heatFlow.airHeatW, actual.snapshot.airHeatW);
  if (actual.view.temperature) { assert.deepEqual(scene.materialColors.heater, [temperatureColor(actual.snapshot.heaterC)]); assert.deepEqual(scene.materialColors.sink, [temperatureColor(actual.snapshot.sinkC)]); }
}
try {
  await page.goto('http://127.0.0.1:5231/'); await page.waitForFunction(() => window.thermalLab?.sceneDebug()?.ready);
  await check('offline bench starts paused at ambient with sixteen physical parts and on-demand WebGL', async () => {
    const initial = await state(); assert.equal(initial.running, false); assert.deepEqual(initial.snapshot.config, DEFAULT_CONFIG); assert.equal(initial.snapshot.heaterC, 25); assert.equal(initial.snapshot.timeS, 0); assert.equal((await debug()).componentCount, 16);
    gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: !!gl, renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }; });
    if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
    await paint(); const before = await debug(); await page.waitForTimeout(150); assert.equal((await debug()).renderFrame, before.renderFrame); await parity();
  });
  await check('step buttons advance actual model time and power-off preserves continuous temperatures', async () => {
    await page.locator('#step').click(); assert.equal((await state()).snapshot.timeS, 60); await page.locator('#step-large').click(); assert.equal((await state()).snapshot.timeS, 360); await parity();
    const before = (await state()).snapshot; await select('power', 0); const off = (await state()).snapshot;
    assert.equal(off.heaterC, before.heaterC); assert.equal(off.sinkC, before.sinkC); assert.deepEqual((await state()).experiment.events, [{ timeS: 360, powerW: 0, fan: false }]);
    await page.locator('#step').click(); assert.ok((await state()).snapshot.storedEnergyJ < off.storedEnergyJ); await parity();
  });
  await check('module and contact replacement restart at ambient and undo restores complete histories', async () => {
    const before = await project(); await select('module', 'fins'); assert.equal((await state()).snapshot.timeS, 0); assert.equal((await state()).snapshot.heaterC, 25); assert.equal((await state()).running, false);
    await page.locator('#undo-new').click(); assert.deepEqual(await project(), before);
    await select('module', 'fins'); await page.locator('#fan').check(); await select('power', 12); await advance(1800); const good = await project();
    await select('contact', 'poor'); assert.equal((await state()).snapshot.heaterC, 25); await page.locator('#undo-new').click(); assert.deepEqual(await project(), good); await parity();
  });
  await check('playback uses full elapsed time, pauses without drift and resumes with a fresh clock', async () => {
    await page.locator('#new-project').click(); await select('playback-rate', 10);
    const measured = await page.evaluate(async () => {
      const start = performance.now(); document.querySelector('#play').click();
      // A blocked frame must not silently discard elapsed simulation time.
      const until = performance.now() + 220; while (performance.now() < until) { /* intentional test stall */ }
      document.querySelector('#play').click(); return { wallS: (performance.now() - start) / 1000, state: window.thermalLab.getState() };
    });
    assert.ok(measured.state.snapshot.timeS >= 2.2); assert.ok(measured.state.snapshot.timeS <= measured.wallS * 10 + .05); assert.equal(measured.state.running, false);
    const paused = (await state()).experiment; await page.waitForTimeout(150); assert.deepEqual((await state()).experiment, paused);
    await page.locator('#play').click(); await page.waitForTimeout(180); await page.locator('#play').click(); assert.ok((await state()).snapshot.timeS > paused.elapsedS); await parity();
  });
  await check('power and fan changes while running retain chronological replay, and hidden documents pause', async () => {
    await select('module', 'fins'); await page.locator('#play').click(); await page.waitForTimeout(130); await select('power', 8); await page.waitForTimeout(90); await page.locator('#fan').check(); await page.waitForTimeout(100); await page.locator('#play').click();
    const current = await state(); assert.equal(current.experiment.events.length, 2); assert.ok(current.experiment.events[1].timeS > current.experiment.events[0].timeS); await parity();
    await page.locator('#play').click(); await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; });
    assert.equal((await state()).running, false); const stopped = (await state()).experiment; await page.waitForTimeout(100); assert.deepEqual((await state()).experiment, stopped);
  });
  await check('storage lesson verifies actual heating and delayed shutdown, then freezes its evidence', async () => {
    await choose('storage'); assert.equal(await page.locator('#guide-next').isEnabled(), false); await page.locator('#step').click(); await page.locator('#step').click(); await page.locator('#guide-next').click();
    await advance(1200); await select('power', 0); const off = (await state()).snapshot; await advance(120); await page.locator('#guide-next').click();
    const evidence = await guide(); assert.equal(evidence.status, 'completed'); assert.equal(evidence.powerOff.storedEnergyJ, off.storedEnergyJ);
    const result = await page.locator('#guide-result').textContent(); assert.ok(result.includes(off.storedEnergyJ.toFixed(1))); await select('power', 4); await advance(60); assert.deepEqual((await guide()).evidence, evidence.evidence); assert.equal(await page.locator('#guide-result').textContent(), result);
  });
  await check('cooling lesson requires plate, fins and fan observations with private evidence independent of comparison', async () => {
    await choose('cooling'); for (let i = 0; i < 6; i++) await page.locator('#step-large').click(); await page.locator('#guide-next').click(); assert.equal((await guide()).stage, 1);
    await select('module', 'fins'); assert.equal((await guide()).status, 'active'); assert.equal((await state()).snapshot.timeS, 0); await advance(1800); await page.locator('#guide-next').click(); assert.equal((await guide()).stage, 2);
    const old = (await state()).snapshot; await page.locator('#fan').check(); near((await state()).snapshot.heaterC, old.heaterC); assert.equal(await page.locator('#guide-next').isEnabled(), false);
    await advance(1800); await page.locator('#pin-comparison').click(); await page.locator('#clear-comparison').click(); await page.locator('#guide-next').click();
    const evidence = await guide(); assert.equal(evidence.status, 'completed'); assert.equal(evidence.evidence.length, 3); const temperatures = evidence.evidence.map(item => item.snapshot.heaterC); assert.ok(temperatures[0] > temperatures[1] && temperatures[1] > temperatures[2]); near(temperatures[2], 43, 1);
  });
  await check('contact lesson compares actual good and poor contact, while incompatible edits interrupt and undo restores', async () => {
    await choose('contact'); await advance(1800); await page.locator('#guide-next').click(); await select('contact', 'poor'); assert.equal((await guide()).status, 'active'); await advance(1800); await page.locator('#guide-next').click();
    assert.equal((await guide()).status, 'completed'); const observations = (await guide()).evidence; near(observations[0].snapshot.heaterC, 43, 1); near(observations[1].snapshot.heaterC, 61, 1);
    await choose('cooling'); await select('power', 4); assert.equal((await guide()).status, 'interrupted'); const before = await project(), oldGuide = await guide(); await page.locator('#new-project').click(); await page.locator('#undo-new').click(); assert.deepEqual(await project(), before); assert.deepEqual(await guide(), oldGuide);
  });
  await check('saved comparison curves share exact time and temperature axes and remain frozen after edits', async () => {
    await page.locator('#guide-exit').click(); await advance(123.25); await page.locator('#pin-comparison').click(); const saved = (await state()).comparison;
    await advance(200); await select('power', 8); const plot = await chart(); assert.deepEqual(plot.temperatureRange, [25, 110]); assert.deepEqual(plot.timeRange, [0, (await state()).snapshot.timeS]);
    assert.equal(plot.savedEnd.timeS, saved.experiment.elapsedS); assert.deepEqual((await state()).comparison, saved);
    const pixels = await page.locator('#temperature-chart').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)); assert.ok(pixels.filter((value, i) => i % 4 === 3 && value > 0).length > 1000);
    await page.screenshot({ path: path.join(output, 'comparison.png'), fullPage: true });
  });
  await check('selection and view layers preserve physics and camera, while explicit focus changes the viewpoint', async () => {
    const before = await project(); await select('part-select', 'contact-pad'); assert.deepEqual((await project()).observation.camera, before.observation.camera);
    await page.setViewportSize({ width: 1280, height: 720 }); await paint(); assert.deepEqual((await project()).observation.camera, before.observation.camera);
    for (const key of ['temperature', 'flows', 'exploded', 'labels']) { const checkbox = page.locator(`[data-view="${key}"]`), value = await checkbox.isChecked(); await checkbox.setChecked(!value); await checkbox.setChecked(value); }
    assert.deepEqual((await state()).experiment, before.experiment); await page.locator('#focus-part').click(); assert.notDeepEqual((await project()).observation.camera, before.observation.camera); await parity();
    await page.locator('#focus').click(); assert.equal(await page.locator('.controls').isVisible(), false); await page.locator('#focus').click(); assert.equal(await page.locator('.controls').isVisible(), true);
  });
  await check('download, file import and restart reproduce timeline, comparison, speed and camera while paused', async () => {
    const saved = await project(), pending = page.waitForEvent('download'); await page.locator('#save-project').click(); const download = await pending, file = path.join(output, 'saved.thermal.json'); await download.saveAs(file); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
    await page.locator('#new-project').click(); await page.locator('#project-file').setInputFiles(file); await page.waitForFunction(experiment => JSON.stringify(window.thermalLab.getState().experiment) === JSON.stringify(experiment), saved.experiment); assert.deepEqual(await project(), saved);
    await page.reload(); await page.waitForFunction(() => window.thermalLab?.sceneDebug()?.ready); assert.deepEqual(await project(), saved); assert.equal((await state()).running, false); assert.equal(await guide(), null); await parity();
    for (const raw of ['{bad JSON', JSON.stringify({ ...saved, schemaVersion: 99 })]) { const before = await project(); const message = await page.evaluate(raw => { try { window.thermalLab.loadProject(raw); return ''; } catch (error) { return error.message; } }, raw); assert.match(message, /원본/); assert.deepEqual(await project(), before); }
  });
  await check('two-hour time limit stops playback without discarding history or inventing extra time', async () => {
    await load(createProject({ experiment: { config: DEFAULT_CONFIG, elapsedS: 7199, events: [] }, playbackRate: 60 })); await page.locator('#play').click(); await page.waitForFunction(() => window.thermalLab.getState().snapshot.atLimit);
    assert.equal((await state()).running, false); assert.equal((await state()).snapshot.timeS, 7200); assert.equal(await page.locator('#time-limit').isVisible(), true); assert.equal(await page.locator('#step').isEnabled(), false); await parity();
    await select('power', 0); assert.equal((await state()).experiment.events.at(-1).timeS, 7200); await advance(300); assert.equal((await state()).snapshot.timeS, 7200);
  });
  await check('maximum event history rejects a new event atomically and explains the limit', async () => {
    const events = Array.from({ length: 256 }, (_, i) => ({ timeS: i, powerW: i % 2 ? 12 : 4, fan: false }));
    await load(createProject({ experiment: { config: DEFAULT_CONFIG, elapsedS: 300, events } })); const before = await project(); await select('power', 8); assert.deepEqual(await project(), before); assert.match(await page.locator('#toast').textContent(), /조건을 바꾸지 못했습니다/); assert.equal(await page.locator('#power').inputValue(), '12');
  });
  await check('future automatic-save data remains byte-for-byte protected and exportable', async () => {
    const isolated = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true }), other = await isolated.newPage(); watch(other);
    const raw = '\ufeff{"type":"thermal-lab-project","schemaVersion":99,"untouched":"한글 원문"}';
    await other.addInitScript(raw => { if (location.hostname === '127.0.0.1') localStorage.setItem('thermal-lab-project-v1', raw); }, raw); await other.goto('http://127.0.0.1:5231/'); await other.waitForFunction(() => window.thermalLab?.sceneDebug()?.ready && !document.querySelector('#storage-recovery').hidden);
    await other.locator('#step').click(); assert.equal(await other.evaluate(() => localStorage.getItem('thermal-lab-project-v1')), raw);
    const pending = other.waitForEvent('download'); await other.locator('#recover-original').click(); const file = path.join(output, 'protected-original.txt'); await (await pending).saveAs(file); assert.equal(await fs.readFile(file, 'utf8'), raw); await isolated.close();
  });
  await check('desktop and narrow layouts expose live readings, controls and scene without horizontal overflow', async () => {
    await page.locator('#new-project').click(); if (await page.locator('#toast').isVisible()) await page.getByRole('button', { name: '알림 닫기' }).click();
    for (const [width, height] of [[1600, 1000], [1280, 720], [390, 844]]) {
      await page.setViewportSize({ width, height }); await page.locator('#reset-camera').click(); await paint(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, `overflow at ${width}`);
      for (const id of ['module', 'contact', 'power', 'fan', 'play', 'step', 'save-project', 'part-select']) assert.equal(await page.locator(`#${id}`).isVisible(), true);
      await page.screenshot({ path: path.join(output, `thermal-${width}.png`), fullPage: true });
    }
    await select('module', 'fins'); await select('power', 8); const live = await page.locator('.compact-readings').boundingBox(); assert.ok(live.y >= 0 && live.y + live.height <= 844, 'live temperatures remain beside narrow controls');
    await select('part-select', 'heat-sink'); await page.locator('#focus-part').click(); await page.waitForFunction(() => { const box = document.querySelector('#scene').getBoundingClientRect(); return box.top >= -1 && box.bottom <= innerHeight + 1; });
  });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} catch (error) { failure = error; console.error(error.stack); await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', failure: failure?.stack, checks, gpu, errors, externalRequests }, null, 2)); await context.close(); await browser.close(); await server.close(); }
if (failure) process.exitCode = 1;
