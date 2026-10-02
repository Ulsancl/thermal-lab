import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { ThermalRun } from '../src/experiment.js';
import { DEFAULT_CONFIG } from '../src/model.js';
import { COMPONENTS } from '../src/geometry.js';
import { createProject, serializeProject } from '../src/project.js';
import { thermalDetail, describeThermalDetail } from '../src/detail-model.js';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/detail-browser');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5236, strictPort: true, hmr: false } });
await server.listen();
const hardware = process.env.THERMAL_BROWSER_HARDWARE === '1';
const browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], errors = [], externalRequests = []; let failure, gpu;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const state = () => page.evaluate(() => window.thermalLab.getState());
const project = () => page.evaluate(() => window.thermalLab.project());
const detail = () => page.evaluate(() => window.thermalLab.getDetail());
const debug = () => page.evaluate(() => window.thermalLab.sceneDebug());
const inspection = () => page.evaluate(() => window.thermalLab.getInspection());
const load = value => page.evaluate(raw => window.thermalLab.loadProject(raw), serializeProject(value));
const select = (id, value) => page.locator(`#${id}`).selectOption(String(value));
const near = (a, b, tolerance = 1e-8) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function sameNumbers(actual, expected) {
  if (typeof expected === 'number') { near(actual, expected); return; }
  if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    for (const key of Object.keys(expected)) sameNumbers(actual[key], expected[key]);
  } else assert.deepEqual(actual, expected);
}
async function parity() {
  const current = await state(), d = await detail(), expected = thermalDetail(new ThermalRun(current.experiment).getSnapshot());
  sameNumbers(d, expected);
  const p = current.snapshot.parameters, s = current.snapshot;
  near(d.power.heaterStorageW, s.config.powerW - (s.heaterC - s.sinkC) / p.contactResistanceKPerW);
  near(d.power.sinkStorageW, (s.heaterC - s.sinkC) / p.contactResistanceKPerW - p.airConductanceWPerK * (s.sinkC - p.ambientC));
  near(d.energy.heaterJ, p.heaterCapacityJPerK * (s.heaterC - p.ambientC));
  near(d.energy.sinkJ, p.sinkCapacityJPerK * (s.sinkC - p.ambientC));
  const values = await page.locator('#thermal-details [data-value]').evaluateAll(elements => elements.map(e => ({ path: e.dataset.value, raw: Number(e.dataset.raw), text: e.textContent })));
  for (const value of values) {
    const [group, key] = value.path.split('.'); near(value.raw, d[group][key]);
    const unit = key.endsWith('KPerW') ? 'K/W' : key.endsWith('W') ? 'W' : key.endsWith('J') ? 'J' : key.endsWith('TauS') ? 's' : 'K';
    assert.ok(value.text.endsWith(` ${unit}`), value.text);
    assert.doesNotMatch(value.text, /NaN|Infinity|undefined/);
  }
  return current;
}
async function factParity(partId) {
  const current = await state(), expected = describeThermalDetail(partId, current.snapshot);
  const facts = await page.locator('#part-facts > div').evaluateAll(rows => rows.map(row => ({ label: row.querySelector('dt').textContent,
    raw: row.querySelector('dd').dataset.raw, text: row.querySelector('dd').textContent })));
  assert.equal(facts.length, expected.facts.length); assert.ok(facts.length <= 6);
  facts.forEach((actual, i) => {
    const fact = expected.facts[i]; assert.equal(actual.label, fact.label);
    if (typeof fact.value === 'number') near(Number(actual.raw), fact.value); else assert.equal(actual.raw, fact.value);
    if (fact.unit) assert.ok(actual.text.endsWith(` ${fact.unit}`), actual.text);
  });
  assert.equal(await page.locator('#part-detail-note').textContent(), expected.note);
}
function probePresentation(scene, activeId = null) {
  for (const probe of scene.mechanical.probes) {
    const withdrawal = probe.id === activeId ? .012 : 0;
    // Mesh vertices use Float32; permit 10 nm without masking a seating error.
    near(probe.assembledBottomClearanceM, .0005, 1e-8);
    near(probe.displayWithdrawalM, withdrawal, 1e-12);
    near(probe.bottomClearanceM, .0005 + withdrawal, 1e-8);
    near(probe.tipWorld[0], probe.assembledTipWorld[0], 1e-12);
    near(probe.tipWorld[1], probe.assembledTipWorld[1], 1e-12);
    near(probe.tipWorld[2] - probe.assembledTipWorld[2], withdrawal, 1e-12);
  }
}
async function orbit() {
  const canvas = page.locator('#scene canvas'); await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox(); assert.ok(box);
  const x = box.x + box.width * .8, y = box.y + box.height * .25;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 45, y + 28, { steps: 5 }); await page.mouse.up(); await paint();
}
async function capture(name, selector) {
  if (selector) { await page.locator(selector).scrollIntoViewIfNeeded(); await paint(); await page.locator(selector).screenshot({ path: path.join(output, name), timeout: 15000 }); }
  else await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 15000 });
}
const fixture = () => createProject({ experiment: { config: { ...DEFAULT_CONFIG, module: 'fins' }, elapsedS: 180.25,
  events: [{ timeS: 120.125, powerW: 8, fan: true }] }, playbackRate: 10,
  comparison: { label: '기존 평판 기준', experiment: { config: DEFAULT_CONFIG, elapsedS: 300, events: [] } },
  view: { temperature: false, flows: false, exploded: false, labels: false, selectedPart: 'heater-block' },
  camera: { position: [.58, .44, .70], target: [-.02, .065, 0], zoom: 1.2 } });

try {
  await page.goto('http://127.0.0.1:5236/'); await page.waitForFunction(() => window.thermalLab?.sceneDebug()?.ready);
  await check('new detailed thermal circuit shows startup storage without claiming steady heat transfer', async () => {
    const current = await parity(), d = await detail();
    assert.equal(current.running, false); assert.equal(current.snapshot.timeS, 0);
    assert.deepEqual([d.power.inputW, d.power.contactW, d.power.airW, d.power.heaterStorageW, d.power.sinkStorageW], [12, 0, 0, 12, 0]);
    assert.equal(d.path.contactDeltaK, 0); assert.equal(d.path.steadyContactDeltaK, 6);
    gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: !!gl, renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }; });
    if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
    assert.equal(await inspection(), null); assert.equal(await page.locator('#inspection-strip').isVisible(), false);
  });
  await check('actual step and power controls expose sink warming during power-off while total stored heat falls', async () => {
    await page.locator('#step').click(); await page.locator('#step').click();
    assert.equal((await state()).snapshot.timeS, 120);
    const before = await state(); await select('power', 0); const off = await parity(), d = await detail();
    assert.equal(off.snapshot.heaterC, before.snapshot.heaterC); assert.equal(off.snapshot.sinkC, before.snapshot.sinkC);
    assert.ok(d.power.heaterStorageW < 0 && d.power.sinkStorageW > 0 && d.power.totalStorageW < 0);
    assert.match(await page.locator('#thermal-rate-note').textContent(), /일시정지/);
    await page.waitForTimeout(150); assert.deepEqual(await state(), off);
    await page.evaluate(() => window.advanceTime(1000)); const after = await parity();
    assert.equal(after.snapshot.timeS, 121); assert.ok(after.snapshot.sinkC > off.snapshot.sinkC);
    assert.ok(after.snapshot.storedEnergyJ < off.snapshot.storedEnergyJ);
    await capture('thermal-detail-overview.png');
  });
  await check('fan changes update actual thermal resistance and response modes while retaining both node energies', async () => {
    await select('module', 'fins'); await select('power', 12); await page.locator('#step').click();
    const old = await detail(), before = await state(); await page.locator('#fan').check(); const next = await detail(); await parity();
    assert.equal(next.nodes.heater.temperatureC, old.nodes.heater.temperatureC); assert.equal(next.nodes.sink.temperatureC, old.nodes.sink.temperatureC);
    assert.equal(next.energy.storedJ, old.energy.storedJ); assert.equal(next.energy.inputJ, old.energy.inputJ);
    assert.equal(next.path.airResistanceKPerW, 1); assert.equal(next.power.airW, 2 * old.power.airW);
    assert.ok(next.modes.slowTauS < old.modes.slowTauS);
    assert.equal((await state()).experiment.events.at(-1).timeS, before.snapshot.timeS);
    await page.locator('.thermal-resistance summary').click(); await page.locator('.thermal-modes summary').click();
    const share = await page.locator('#contact-resistance-share').evaluate(e => parseFloat(e.style.width));
    // CSSOM serializes percentage widths to fewer decimal places than the model.
    near(share, .5 / 1.5 * 100, 1e-4);
    assert.match(await page.locator('.thermal-modes').textContent(), /36.8%/);
    assert.match(await page.locator('.thermal-modes').textContent(), /도달하는 시각이 아닙니다/);
  });
  await check('all sixteen selectable parts show live facts without changing the experiment, comparison or camera', async () => {
    await page.locator('#pin-comparison').click(); const before = await project();
    for (const { id } of COMPONENTS) {
      await select('part-select', id); await factParity(id);
      const current = await project(); assert.deepEqual(current.experiment, before.experiment); assert.deepEqual(current.comparison, before.comparison);
      assert.deepEqual(current.observation.camera, before.observation.camera);
    }
    await page.locator('#thermal-details [data-part="heater-block"]').click();
    assert.equal((await state()).view.selectedPart, 'heater-block'); await factParity('heater-block');
    await select('playback-rate', 1); const physical = await detail(); await select('playback-rate', 60);
    assert.deepEqual(await detail(), physical); assert.deepEqual((await state()).comparison, before.comparison);
  });
  await check('heater section isolates actual parts and temporary orbit preserves the original saved camera', async () => {
    await load(fixture()); const before = await project(); await page.locator('#inspect-part').click(); await paint();
    const scene = await debug(); assert.equal((await inspection()).kind, 'heater');
    assert.deepEqual(scene.mechanical.visibleParts, ['heater-block', 'probe-heater']);
    assert.equal(scene.mechanical.groundVisible, false); assert.equal(scene.mechanical.sectionIsCapped, true);
    probePresentation(scene, 'probe-heater');
    assert.match(await page.locator('#inspection-note').textContent(), /12 mm.*계산은 조립 상태/);
    assert.equal(await page.locator('.thermal-scene-note').isVisible(), false);
    assert.notDeepEqual(scene.camera, before.observation.camera); assert.deepEqual(scene.projectCamera, before.observation.camera);
    const inspecting = scene.camera; await orbit(); assert.notDeepEqual((await debug()).camera, inspecting);
    assert.deepEqual(await project(), before); await factParity('heater-block');
    await capture('heater-section.png', '.workbench');
  });
  await check('view toggles and inspection switches preserve physics and restore the original camera with current layer preferences', async () => {
    const before = await project();
    await page.locator('#exploded').check(); await page.locator('#temperature').check();
    await select('part-select', 'probe-sink');
    const scene = await debug(); assert.equal((await inspection()).kind, 'sink'); assert.equal(scene.module, 'fins');
    assert.deepEqual(scene.mechanical.visibleParts, ['heat-sink', 'probe-sink']);
    assert.equal(scene.mechanical.sectionIsCapped, true);
    probePresentation(scene, 'probe-sink');
    assert.deepEqual((await project()).observation.camera, before.observation.camera);
    assert.deepEqual((await state()).experiment, before.experiment); assert.deepEqual((await state()).comparison, before.comparison);
    await select('part-select', 'cartridge-handle');
    assert.deepEqual((await debug()).mechanical.visibleParts, ['heat-sink', 'cartridge-handle', 'probe-sink']);
    probePresentation(await debug(), 'probe-sink');
    await page.locator('#end-inspection').click();
    assert.equal(await inspection(), null); assert.equal(await page.locator('#inspection-strip').isVisible(), false);
    assert.deepEqual((await debug()).camera, before.observation.camera);
    assert.equal((await state()).view.exploded, true); assert.equal((await state()).view.temperature, true);
    assert.equal((await state()).view.flows, false); assert.equal((await state()).view.labels, false);
    assert.equal((await debug()).mechanical.visibleParts.length, 16);
    probePresentation(await debug());
  });
  await check('inspection download and import store original observation rather than a temporary cutaway camera', async () => {
    await load(fixture()); await select('part-select', 'heat-sink'); const before = await project();
    await page.locator('#inspect-part').click(); await orbit();
    const pending = page.waitForEvent('download'); await page.locator('#save-project').click(); const download = await pending;
    const filename = path.join(output, 'inspection-original.thermal.json'); await download.saveAs(filename);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), before);
    assert.equal((await inspection()).kind, 'sink'); await capture('sink-section.png', '.workbench');
    await page.locator('#project-file').setInputFiles(filename);
    await page.waitForFunction(() => window.thermalLab.getInspection() === null && !document.querySelector('#save-project').disabled);
    assert.deepEqual(await project(), before); assert.equal((await state()).running, false);
    await page.locator('#inspect-part').click(); await page.reload(); await page.waitForFunction(() => window.thermalLab?.sceneDebug()?.ready);
    assert.equal(await inspection(), null); assert.deepEqual(await project(), before); await parity();
  });
  await check('fan and clamp views expose supported groups and leaving by focus or camera clears inspection UI', async () => {
    await select('part-select', 'fan-rotor'); const original = (await project()).observation.camera;
    await page.locator('#inspect-part').click(); assert.equal((await inspection()).kind, 'fan');
    assert.deepEqual((await debug()).mechanical.visibleParts, ['fan-rotor']);
    assert.equal((await debug()).mechanical.sectionIsCapped, false); await factParity('fan-rotor');
    await capture('fan-detail.png', '.workbench');
    assert.equal(await page.locator('#inspect-part').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#inspect-part').textContent(), /마치기/);
    await page.locator('#inspect-part').click();
    assert.equal(await inspection(), null); assert.equal(await page.locator('#inspection-strip').isVisible(), false);
    assert.equal(await page.locator('#inspect-part').getAttribute('aria-pressed'), 'false');
    assert.deepEqual((await debug()).camera, original);
    await page.locator('#inspect-part').click(); assert.equal((await inspection()).kind, 'fan');
    await page.locator('#focus-part').click();
    assert.equal(await inspection(), null); assert.equal(await page.locator('#inspection-strip').isVisible(), false);
    assert.equal(await page.locator('#inspect-part').getAttribute('aria-pressed'), 'false');
    assert.notDeepEqual((await project()).observation.camera, original);
    await select('part-select', 'clamp-screws'); await page.locator('#inspect-part').click();
    assert.deepEqual((await debug()).mechanical.visibleParts, ['clamp-screws']);
    await page.locator('[data-camera="side"]').click();
    assert.equal(await inspection(), null); assert.equal(await page.locator('#inspection-strip').isVisible(), false);
    assert.deepEqual((await debug()).camera, (await project()).observation.camera);
    await page.locator('#inspect-part').click(); await select('part-select', 'contact-pad');
    assert.equal(await inspection(), null); assert.equal(await page.locator('#inspect-part').isEnabled(), false);
  });
  await check('new experiment and module replacement leave inspection and undo restores the saved original project', async () => {
    await load(fixture()); const before = await project(); await page.locator('#inspect-part').click();
    await page.locator('#new-project').click(); assert.equal(await inspection(), null); assert.equal((await state()).snapshot.timeS, 0);
    await page.locator('#undo-new').click(); assert.deepEqual(await project(), before); assert.equal(await inspection(), null);
    await page.locator('#inspect-part').click(); await select('module', 'plate');
    assert.equal(await inspection(), null); assert.equal((await state()).snapshot.heaterC, 25);
    await page.locator('#undo-new').click(); assert.deepEqual(await project(), before); await parity();
  });
  await check('time-limit and paused rates retain the physical slope while no recorded time advances', async () => {
    await load(createProject({ experiment: { config: DEFAULT_CONFIG, elapsedS: 7200, events: [] } }));
    await select('power', 0); const before = await state(), d = await detail();
    assert.equal(before.snapshot.atLimit, true); assert.equal(before.running, false); assert.ok(d.nodes.heater.rateKPerS < 0);
    assert.ok(d.power.heaterStorageW < 0); assert.equal(await page.locator('#step').isEnabled(), false);
    await page.waitForTimeout(150); assert.deepEqual(await state(), before); await parity();
    const text = await page.evaluate(() => JSON.parse(window.render_game_to_text()));
    assert.equal(text.mode, 'paused'); assert.equal(text.snapshot.timeS, 7200); assert.match(text.coordinateSystem, /two lumped/);
  });
  await check('390-pixel layout keeps facts and inspection controls reachable without horizontal overflow', async () => {
    await load(fixture()); await page.setViewportSize({ width: 390, height: 844 }); await paint();
    await page.locator('#thermal-details').scrollIntoViewIfNeeded(); await parity();
    await select('part-select', 'probe-sink'); await factParity('probe-sink'); await page.locator('#inspect-part').click();
    assert.equal(await page.locator('#end-inspection').isVisible(), true);
    assert.equal((await inspection()).kind, 'sink');
    const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
      clipped: [...document.querySelectorAll('#thermal-details [data-value], #part-facts dd, #inspection-strip button')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent) }));
    assert.ok(overflow.document <= overflow.width + 1, JSON.stringify(overflow)); assert.deepEqual(overflow.clipped, []);
    await capture('thermal-detail-mobile.png');
    await page.locator('#end-inspection').click(); assert.equal(await inspection(), null);
    assert.deepEqual((await project()).observation.camera, fixture().observation.camera);
  });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failure = error; process.exitCode = 1; console.error(error.stack);
  const diagnostic = await page.evaluate(() => ({ state: window.thermalLab?.getState(), inspection: window.thermalLab?.getInspection(), scene: window.thermalLab?.sceneDebug(), toast: document.querySelector('#toast')?.textContent })).catch(() => null);
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 3000 }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, stack: error.stack, checks, errors, externalRequests, diagnostic }, null, 2));
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', checks, errors, externalRequests, hardware, gpu, ...(failure ? { failure: failure.message } : {}) }, null, 2));
  await browser.close(); await server.close();
  console.log(`Detail browser: ${checks.length} checks ${failure ? 'completed before failure' : 'passed'}.`);
}
