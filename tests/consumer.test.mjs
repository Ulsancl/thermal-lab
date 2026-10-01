import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { ThermalRun, createExperiment } from '../src/experiment.js';
import { DEFAULT_CONFIG } from '../src/model.js';
import { createProject, serializeProject } from '../src/project.js';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/consumer');
const hardware = process.env.THERMAL_BROWSER_HARDWARE === '1';
const checks = [], errors = [], externalRequests = [], evidence = [];
let server, browser, page, gpu, failure;
const state = () => page.evaluate(() => window.thermalLab.getState());
const project = () => page.evaluate(() => window.thermalLab.project());
const debug = () => page.evaluate(() => window.thermalLab.sceneDebug());
const chart = () => page.evaluate(() => window.thermalLab.chartDebug());
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const load = value => page.evaluate(raw => window.thermalLab.loadProject(raw), serializeProject(value));
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
function experiment(config, seconds) { const run = new ThermalRun(createExperiment(config)); run.advance(seconds); return run.exportExperiment(); }
async function capture(name, selector) {
  await paint(); if (selector) await page.locator(selector).screenshot({ path: path.join(output, `${name}.png`) });
  else await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  evidence.push({ name, chart: await chart(), state: await state() });
}
async function select(id, value) { const control = page.locator(`#${id}`); await control.scrollIntoViewIfNeeded(); await control.selectOption(String(value)); await paint(); }
function sameSnapshotValues(actual, expected) {
  assert.equal(actual.timeS, expected.timeS); near(actual.heaterC, expected.heaterC); near(actual.sinkC, expected.sinkC);
}

const UI = {
  comparisonNote: '#comparison-overlap',
  savedValues: '#comparison-endpoint',
  modes: ['both', 'current', 'saved'],
};

async function readableValues(snapshot, saved = false) {
  if (saved) {
    const content = await page.locator(UI.savedValues).innerText();
    assert.ok(content.includes(snapshot.heaterC.toFixed(1)), 'saved endpoint: missing heater temperature');
    assert.ok(content.includes(snapshot.sinkC.toFixed(1)), 'saved endpoint: missing sink temperature');
    assert.match(content, /발열체/); assert.match(content, /방열판/); assert.match(content, /보관 끝점/);
  } else {
    assert.ok((await page.locator('#heater-temperature').innerText()).includes(snapshot.heaterC.toFixed(1)));
    assert.ok((await page.locator('#sink-temperature').innerText()).includes(snapshot.sinkC.toFixed(1)));
    assert.match(await page.locator('.temperature-card.heater').innerText(), /발열체 평균온도/);
    assert.match(await page.locator('.temperature-card.sink').innerText(), /방열판 평균온도/);
  }
}
const chartPixels = () => page.locator('#temperature-chart').evaluate(canvas => {
  const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261; for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
  return (hash >>> 0).toString(16);
});

await fs.mkdir(output, { recursive: true });
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5232, strictPort: true, hmr: false } }); await server.listen();
  browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
  await page.goto('http://127.0.0.1:5232/'); await page.waitForFunction(() => window.thermalLab?.sceneDebug()?.ready);
  gpu = await page.locator('#scene canvas').evaluate(canvas => { const gl = canvas.getContext('webgl2'), extension = gl?.getExtension('WEBGL_debug_renderer_info'); return { webgl2: !!gl, renderer: gl?.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }; });
  assert.equal(gpu.webgl2, true); if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
  await capture('thermal-default-1600');

  await check('paused rates describe model-time expectations while actual temperatures remain frozen', async () => {
    const initial = await state(); assert.equal(initial.running, false); assert.equal(initial.snapshot.timeS, 0);
    const heater = await page.locator('#heater-trend').innerText(), sink = await page.locator('#sink-trend').innerText();
    assert.match(heater, /예상|현재 조건/); assert.match(heater, /36\.00/); assert.match(heater, /모의/); assert.doesNotMatch(heater, /상승 중|하강 중/);
    assert.doesNotMatch(sink, /상승 중|하강 중/);
    await paint(); const frame = (await debug()).renderFrame; await page.waitForTimeout(180);
    assert.deepEqual((await state()).experiment, initial.experiment); sameSnapshotValues((await state()).snapshot, initial.snapshot); assert.equal((await debug()).renderFrame, frame);
    await select('playback-rate', 1); await page.locator('#play').click(); await page.waitForTimeout(150); assert.equal((await state()).running, true);
    assert.match(await page.locator('#heater-trend').innerText(), /모의/); await page.locator('#play').click();
    assert.match(await page.locator('#heater-trend').innerText(), /예상|현재 조건/); assert.doesNotMatch(await page.locator('#heater-trend').innerText(), /상승 중|하강 중/);
  });

  const baseline = experiment(DEFAULT_CONFIG, 300);
  await check('identical histories expose both saved and current temperatures with an overlap explanation', async () => {
    await load(createProject({ experiment: baseline, comparison: { label: '동일한 300초 기준', experiment: baseline } })); await paint();
    const expected = new ThermalRun(baseline).getSnapshot(), actual = await chart();
    sameSnapshotValues(actual.currentEnd, expected); sameSnapshotValues(actual.savedEnd, expected);
    assert.deepEqual(actual.timeRange, [0, 300]); assert.deepEqual(actual.temperatureRange, [25, 110]);
    await readableValues(expected); await readableValues(expected, true);
    assert.deepEqual(actual.endpointMarkers, { current: 'filled-circle', saved: 'hollow-diamond' });
    assert.match(await page.locator(UI.comparisonNote).innerText(), /겹/); await capture('comparison-identical', '.chart-panel');
  });

  await check('curve visibility changes neither shared axes nor saved project data', async () => {
    const before = await project(), axes = await chart(), pixels = {};
    for (const mode of UI.modes) {
      await page.locator(`#chart-${mode}`).click(); await paint();
      const actual = await chart();
      assert.equal(await page.locator(`#chart-${mode}`).getAttribute('aria-pressed'), 'true'); assert.deepEqual(await project(), before);
      assert.equal(actual.display, mode); assert.equal(actual.renderedCurrent, mode !== 'saved'); assert.equal(actual.renderedSaved, mode !== 'current');
      assert.deepEqual(actual.endpointMarkers, { current: mode !== 'saved' ? 'filled-circle' : null, saved: mode !== 'current' ? 'hollow-diamond' : null });
      assert.deepEqual(actual.timeRange, axes.timeRange); assert.deepEqual(actual.temperatureRange, axes.temperatureRange);
      pixels[mode] = await chartPixels();
    }
    assert.equal(new Set(Object.values(pixels)).size, 3, 'all three display modes must really change canvas pixels');
    evidence.push({ name: 'identical-history-canvas-pixels', pixels });
    await page.locator('#chart-both').click();
    await capture('comparison-identified', '.chart-panel');
  });

  const savedRun = experiment(DEFAULT_CONFIG, 1800), differentRun = experiment({ module: 'fins', contact: 'good', fan: true, powerW: 12 }, 900);
  await check('different conditions retain actual recorded ends on exactly the same time and temperature axes', async () => {
    await load(createProject({ experiment: differentRun, comparison: { label: '평판 1800초 기록', experiment: savedRun } })); await paint();
    const actual = await chart(), current = new ThermalRun(differentRun).getSnapshot(), saved = new ThermalRun(savedRun).getSnapshot();
    assert.deepEqual(actual.timeRange, [0, 1800]); assert.deepEqual(actual.temperatureRange, [25, 110]);
    sameSnapshotValues(actual.currentEnd, current); sameSnapshotValues(actual.savedEnd, saved);
    assert.equal(actual.currentEnd.timeS, 900); assert.equal(actual.savedEnd.timeS, 1800); assert.ok(saved.heaterC > current.heaterC + 30);
    assert.equal(actual.display, 'both');
    await readableValues(current); await readableValues(saved, true); await capture('comparison-different', '.chart-panel');
    const beforeSaved = (await state()).comparison; await select('power', 0); await page.evaluate(() => window.thermalLab.step(60));
    assert.deepEqual((await state()).comparison, beforeSaved); assert.equal((await chart()).savedEnd.timeS, 1800); assert.equal((await chart()).currentEnd.timeS, 960);
  });

  await check('selecting parts preserves the experiment and camera, and only explicit focus changes the viewpoint', async () => {
    const before = (await state()).experiment, camera = (await debug()).camera;
    await select('part-select', 'probe-heater'); assert.deepEqual((await state()).experiment, before); assert.deepEqual((await debug()).camera, camera);
    await page.locator('#focus-part').click(); await paint(); assert.notDeepEqual((await debug()).camera, camera); assert.deepEqual((await state()).experiment, before);
    assert.ok((await debug()).labels.some(label => label.id === 'probe-heater'));
    await capture('probe-focus', '#scene'); await page.locator('#reset-camera').click();
  });

  await check('1280 and narrow layouts retain both comparison readings and real controls without horizontal overflow', async () => {
    for (const width of [1280, 390]) {
      const camera = (await debug()).camera, before = await project(); await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 }); await paint();
      assert.deepEqual((await debug()).camera, camera); assert.deepEqual(await project(), before);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('.chart-panel').scrollIntoViewIfNeeded();
      await readableValues((await state()).snapshot); await readableValues(new ThermalRun(savedRun).getSnapshot(), true);
      for (const mode of UI.modes) { const button = page.locator(`#chart-${mode}`); await button.scrollIntoViewIfNeeded(); assert.equal(await button.isVisible(), true); }
      await capture(`comparison-${width}`, '.chart-panel');
      await page.locator('#power').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#power').isVisible(), true); await capture(`thermal-${width}`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  });
} catch (error) {
  failure = { message: error.message, stack: error.stack }; console.error(error.stack);
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); await server?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', hardware, gpu, checks, errors, externalRequests, evidence, failure }, null, 2));
}
console.log(JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', checks, gpu, errors }));
if (failure) process.exitCode = 1;
