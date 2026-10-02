import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { ThermalRun } from '../src/experiment.js';
import { createProject } from '../src/project.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const packaged = !!process.env.THERMAL_DESKTOP_EXE;
const executablePath = packaged ? process.env.THERMAL_DESKTOP_EXE : require('electron');
assert.ok(path.isAbsolute(executablePath), 'The tested executable must be an absolute path');
const output = path.join(root, 'output', `${packaged ? 'desktop-packaged' : 'desktop'}-v${expectedVersion}`);
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(output, 'profile-'));
const evidence = path.join(profile, 'test-artifacts');
await fs.mkdir(evidence);
const env = { ...process.env, THERMAL_LAB_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const projectPath = path.join(evidence, '열 관찰.thermal.json');
const checks = [], errors = [], remoteRequests = [], processes = [];
let app, page, saved, windowRestoration, gpu, failure;
const state = () => page.evaluate(() => window.thermalLab.getState());
const project = () => page.evaluate(() => window.thermalLab.project());

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
function sameProject(actual, expected) {
  assert.equal(actual.type, expected.type); assert.equal(actual.schemaVersion, expected.schemaVersion);
  assert.equal(actual.modelVersion, expected.modelVersion); assert.deepEqual(actual.experiment, expected.experiment);
  assert.equal(actual.playbackRate, expected.playbackRate);
  assert.deepEqual(actual.comparison, expected.comparison);
  assert.deepEqual(actual.observation.view, expected.observation.view);
  const a = actual.observation.camera, b = expected.observation.camera;
  if (b === null) assert.equal(a, null);
  else {
    assert.ok(a);
    for (const key of ['position', 'target']) for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(a[key][i] - b[key][i]) < 1e-9, `Camera ${key}[${i}] changed`);
    }
    assert.equal(a.zoom ?? 1, b.zoom ?? 1);
  }
}
function sameSnapshot(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const key of ['config', 'parameters', 'steady', 'timeS', 'atLimit', 'inputEnergyJ']) assert.deepEqual(actual[key], expected[key], key);
  // Node and Chromium may differ by a few ULPs in Math.exp. Keep the
  // serialized experiment exact and tolerate only derived thermal values.
  for (const key of ['heaterC', 'sinkC', 'contactHeatW', 'airHeatW', 'heaterRateKPerS', 'sinkRateKPerS', 'storedEnergyJ', 'releasedEnergyJ']) {
    assert.ok(Number.isFinite(actual[key]) && Math.abs(actual[key] - expected[key]) <= 1e-8, `${key}: ${actual[key]} differs from ${expected[key]}`);
  }
}
async function launch() {
  app = await electron.launch({ executablePath, args: packaged ? [] : [root], env, timeout: 45000 });
  const child = app.process(), processRecord = { pid: child.pid, exited: false };
  processes.push(processRecord);
  child.once('exit', (code, signal) => Object.assign(processRecord, { exited: true, code, signal }));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await page.waitForFunction(() => window.thermalLab?.project && document.querySelector('#scene canvas'));
  assert.equal((await state()).running, false, 'Each launch restores a paused experiment');
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setTitle('Thermal Lab · 자동 검사'); window.focus(); });
}
async function closeNormally() {
  await app.close(); app = null; page = null;
  await waitFor(() => processes.at(-1).exited, 'normal native process exit');
  assert.equal(processes.at(-1).code, 0); assert.equal(processes.at(-1).signal, null);
}
async function menu(group, label) {
  await app.evaluate(({ Menu }, names) => {
    const item = Menu.getApplicationMenu().items.find(value => value.label === names[0])?.submenu?.items.find(value => value.label === names[1]);
    if (!item || typeof item.click !== 'function') throw new Error(`Missing native menu: ${names.join(' > ')}`);
    item.click();
  }, [group, label]);
}
async function saveDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => {
    globalThis.thermalSaveCalls = 0;
    dialog.showSaveDialog = async () => { globalThis.thermalSaveCalls++; return { canceled: payload.canceled, filePath: payload.filePath }; };
  }, { filePath, canceled });
}
async function openDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => {
    globalThis.thermalOpenCalls = 0;
    dialog.showOpenDialog = async () => { globalThis.thermalOpenCalls++; return { canceled: payload.canceled, filePaths: payload.canceled ? [] : [payload.filePath] }; };
  }, { filePath, canceled });
}
async function freshToast(action, pattern) {
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
  await action();
  await page.waitForFunction(pattern => {
    const node = document.querySelector('#toast'); return !node.hidden && new RegExp(pattern).test(node.textContent);
  }, pattern);
}
async function stableBounds(label) {
  let actual, previous, stable = 0;
  await waitFor(async () => {
    actual = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
    stable = JSON.stringify(actual) === JSON.stringify(previous) ? stable + 1 : 0; previous = actual;
    return stable >= 2;
  }, label);
  return actual;
}

try {
  await launch();
  await check('isolated Thermal Lab identity, offline bundle, sandbox and native bridge', async () => {
    assert.equal(page.url(), 'app://thermal/');
    const identity = await app.evaluate(({ app, BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { name: app.name, version: app.getVersion(), userData: app.getPath('userData'), sandbox: p.sandbox,
        contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
    });
    assert.deepEqual(identity, { name: 'Thermal Lab', version: expectedVersion, userData: profile,
      sandbox: true, contextIsolation: true, nodeIntegration: false });
    const bridge = await page.evaluate(() => ({ keys: Object.keys(window.thermalDesktop).sort(), native: window.thermalDesktop.isDesktop,
      node: typeof window.require, process: typeof window.process, others: [typeof window.lensDesktop, typeof window.motorDesktop, typeof window.hydraulicDesktop, typeof window.engineDesktop, typeof window.brakeDesktop] }));
    assert.deepEqual(bridge, { keys: ['isDesktop', 'onCommand', 'openProject', 'saveProject', 'setBusy'],
      native: true, node: 'undefined', process: 'undefined', others: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'] });
    assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
    const access = await page.evaluate(async () => ({
      local: await fetch('app://thermal/index.html').then(response => response.ok),
      remote: await fetch('https://example.com/').then(() => true).catch(() => false),
      popup: window.open('https://example.com/') === null,
    }));
    assert.equal(access.local, true); assert.equal(access.remote, false);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    // Ignore the intentionally denied fetch's CSP message, not application errors.
    assert.ok(errors.every(message => /Content Security Policy|Refused to connect|fetch/i.test(message)), errors.join('\n'));
    errors.length = 0; remoteRequests.length = 0;
    gpu = await app.evaluate(async ({ app }) => ({ info: await app.getGPUInfo('basic'), features: app.getGPUFeatureStatus() }));
    gpu.sceneContext = await page.evaluate(() => {
      const gl = document.querySelector('#scene canvas').getContext('webgl2');
      if (!gl) return { webgl2: false, unmaskedRenderer: null };
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl2: true, renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
        unmaskedRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
        unmaskedVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null };
    });
  });
  await check('native import replays a fractional thermal event timeline and restores paused comparison and observation', async () => {
    saved = createProject({ experiment: { config: { module: 'fins', contact: 'good', fan: false, powerW: 8 }, elapsedS: 300.75,
      events: [{ timeS: 120.5, powerW: 12, fan: true }] },
      comparison: { label: '판형 12 W 기준', experiment: { config: { module: 'plate', contact: 'good', fan: false, powerW: 12 }, elapsedS: 1800, events: [] } },
      playbackRate: 10, view: { temperature: false, flows: false, exploded: true, labels: false, selectedPart: 'contact-pad' },
      camera: { position: [1, .8, 1.3], target: [.1, .1, -.2], zoom: 1.4 } });
    await fs.writeFile(projectPath, JSON.stringify(saved));
    await openDialog(projectPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.elapsedS === 300.75, 'native timeline import');
    sameProject(await project(), saved);
    sameSnapshot((await state()).snapshot, new ThermalRun(saved.experiment).getSnapshot());
    assert.equal((await state()).running, false);
  });
  await check('native component details read the replayed state and leave original experiment and comparison untouched', async () => {
    const before = await project(), snapshot = (await state()).snapshot;
    const detail = await page.evaluate(() => window.thermalLab.getDetail());
    const expected = {
      'power.inputW': snapshot.config.powerW,
      'power.contactW': (snapshot.heaterC - snapshot.sinkC) / snapshot.parameters.contactResistanceKPerW,
      'power.airW': snapshot.parameters.airConductanceWPerK * (snapshot.sinkC - snapshot.parameters.ambientC),
      'energy.heaterJ': snapshot.parameters.heaterCapacityJPerK * (snapshot.heaterC - snapshot.parameters.ambientC),
      'energy.sinkJ': snapshot.parameters.sinkCapacityJPerK * (snapshot.sinkC - snapshot.parameters.ambientC),
    };
    for (const [key, value] of Object.entries(expected)) {
      const actual = Number(await page.locator(`#thermal-details [data-value="${key}"]`).first().getAttribute('data-raw'));
      assert.ok(Math.abs(actual - value) < 1e-8, `${key}: ${actual} != ${value}`);
    }
    assert.ok(Math.abs(detail.power.inputW - detail.power.airW - detail.power.totalStorageW) < 1e-10);
    await page.locator('#part-select').selectOption('probe-heater');
    const facts = await page.locator('#part-facts > div').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').dataset.raw])));
    assert.equal(Number(facts['블록 평균온도']), snapshot.heaterC);
    assert.equal(Number(facts['블록 변화율']), snapshot.heaterRateKPerS);
    assert.match(await page.locator('#thermal-rate-note').textContent(), /일시정지/);
    await delay(100); assert.deepEqual((await state()).snapshot, snapshot);
    await page.locator('#part-select').selectOption(before.observation.view.selectedPart);
    sameProject(await project(), before);
  });
  await check('native inspection save records the original camera and opening that file restores full structure', async () => {
    await page.locator('#part-select').selectOption('heater-block');
    const original = await project(); await page.locator('#inspect-part').click();
    const scene = await page.evaluate(() => window.thermalLab.sceneDebug());
    assert.equal(scene.inspection.kind, 'heater');
    assert.deepEqual(scene.mechanical.visibleParts, ['heater-block', 'probe-heater']);
    assert.equal(scene.mechanical.sectionIsCapped, true);
    assert.notDeepEqual(scene.camera, original.observation.camera);
    assert.deepEqual(scene.projectCamera, original.observation.camera);
    await page.locator('#exploded').uncheck(); await page.locator('#temperature').check();
    const savedInspection = await project();
    assert.deepEqual(savedInspection.observation.camera, original.observation.camera);
    assert.deepEqual(savedInspection.experiment, original.experiment);
    assert.deepEqual(savedInspection.comparison, original.comparison);
    const file = path.join(evidence, '내부 관찰 원래 시점.thermal.json');
    await saveDialog(file); await freshToast(() => page.locator('#save-project').click(), '저장했습니다');
    assert.equal(await app.evaluate(() => globalThis.thermalSaveCalls), 1);
    sameProject(JSON.parse(await fs.readFile(file, 'utf8')), savedInspection);
    assert.equal((await page.evaluate(() => window.thermalLab.getInspection())).kind, 'heater');
    await openDialog(file, true); await freshToast(() => page.locator('#open-project').click(), '열기를 취소');
    assert.equal((await page.evaluate(() => window.thermalLab.getInspection())).kind, 'heater');
    sameProject(await project(), savedInspection);
    await page.screenshot({ path: path.join(evidence, 'native-inspection.png') });
    await openDialog(file); await freshToast(() => page.locator('#open-project').click(), '복원했습니다');
    assert.equal(await page.evaluate(() => window.thermalLab.getInspection()), null);
    assert.equal(await page.locator('#inspection-strip').isVisible(), false);
    const restored = await page.evaluate(() => window.thermalLab.sceneDebug());
    assert.equal(restored.mechanical.visibleParts.length, 16);
    assert.equal(restored.mechanical.sectionIsCapped, false);
    sameProject(await project(), savedInspection);
    assert.deepEqual(restored.camera, savedInspection.observation.camera);
    // Keep the existing remainder of the native suite on its original imported fixture.
    await openDialog(projectPath); await freshToast(() => page.locator('#open-project').click(), '복원했습니다');
    sameProject(await project(), saved);
  });
  await check('step advances exactly 60 model seconds and native play/pause preserves event history', async () => {
    const before = await state(), replay = new ThermalRun(before.experiment);
    replay.advance(60); await page.locator('#step').click();
    const stepped = await state();
    assert.deepEqual(stepped.experiment, replay.exportExperiment()); sameSnapshot(stepped.snapshot, replay.getSnapshot());
    assert.equal(stepped.running, false); assert.deepEqual(stepped.comparison, before.comparison);
    await menu('실험', '재생 / 일시정지');
    await waitFor(async () => { const value = await state(); return value.running && value.experiment.elapsedS > stepped.experiment.elapsedS; }, 'native timed heating');
    await menu('실험', '재생 / 일시정지'); await waitFor(async () => !(await state()).running, 'native pause');
    const paused = await state(); await delay(100); assert.deepEqual(await state(), paused);
    assert.deepEqual(paused.experiment.events, before.experiment.events);
    assert.deepEqual(paused.snapshot.config, { module: 'fins', contact: 'good', fan: true, powerW: 12 });
    saved = await project();
  });
  await check('native save replaces only a complete file; BOM import retains every state field and original bytes', async () => {
    await fs.writeFile(projectPath, 'previous destination remains until complete replacement');
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
    await saveDialog(projectPath); await page.locator('#save-project').click();
    // Wait for the resolved native IPC result before opening its destination.
    // Repeated reads while Windows replaces that file can disturb the operation
    // being tested, and would hide a rejected save behind a generic timeout.
    await waitFor(async () => {
      const completion = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent,
        busy: document.querySelector('#save-project').disabled }));
      if (/저장하지 못했습니다|저장을 취소했습니다/.test(completion.toast)) throw new Error(completion.toast);
      return !completion.busy && /저장했습니다/.test(completion.toast);
    }, 'native atomic file save completion');
    assert.equal(await app.evaluate(() => globalThis.thermalSaveCalls), 1);
    const raw = await fs.readFile(projectPath, 'utf8'); sameProject(JSON.parse(raw), saved);
    assert.equal((await fs.readdir(evidence)).some(name => name.endsWith('.tmp')), false);
    await menu('파일', '새 실험'); await waitFor(async () => (await state()).experiment.elapsedS === 0, 'new experiment');
    await openDialog(projectPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.elapsedS === saved.experiment.elapsedS, 'native saved experiment restore');
    assert.equal((await state()).running, false);
    sameProject(await project(), saved); assert.equal(await fs.readFile(projectPath, 'utf8'), raw);
    const bomPath = path.join(evidence, 'Windows-UTF8.thermal.json'), bomRaw = '\ufeff' + raw;
    await fs.writeFile(bomPath, bomRaw);
    await menu('파일', '새 실험'); await waitFor(async () => (await state()).experiment.elapsedS === 0, 'new before BOM import');
    await openDialog(bomPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.elapsedS === saved.experiment.elapsedS, 'native BOM restore');
    assert.equal((await state()).running, false);
    sameProject(await project(), saved); assert.equal(await fs.readFile(bomPath, 'utf8'), bomRaw);
  });
  await check('cancel, malformed/future/oversized files and directory/link targets preserve current and original records', async () => {
    const before = await project(), original = await fs.readFile(projectPath, 'utf8');
    await saveDialog(projectPath, true); await page.locator('#save-project').click();
    await waitFor(() => app.evaluate(() => globalThis.thermalSaveCalls === 1), 'save cancellation'); await delay(60);
    await openDialog(projectPath, true); await page.locator('#open-project').click();
    await waitFor(() => app.evaluate(() => globalThis.thermalOpenCalls === 1), 'open cancellation'); await delay(60);
    sameProject(await project(), before); assert.equal(await fs.readFile(projectPath, 'utf8'), original);
    for (const [name, raw] of [
      ['broken.json', '{synthetic invalid JSON\r\n원문'],
      ['future.json', JSON.stringify({ ...saved, schemaVersion: 2 })],
      ['future-model.json', JSON.stringify({ ...saved, modelVersion: 'thermal-two-node-2' })],
      ['too-large.json', ' '.repeat(10 * 1024 * 1024 + 1)],
    ]) {
      const file = path.join(evidence, name); await fs.writeFile(file, raw);
      await openDialog(file); await freshToast(() => page.locator('#open-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before); assert.equal(await fs.readFile(file, 'utf8'), raw);
    }
    const linked = path.join(evidence, 'linked-directory'), originalDirectory = path.join(evidence, 'real-directory');
    await fs.mkdir(originalDirectory); await fs.writeFile(path.join(originalDirectory, 'observation.json'), original);
    await fs.symlink(originalDirectory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of [originalDirectory, path.join(linked, 'observation.json')]) {
      await openDialog(file); await freshToast(() => page.locator('#open-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before);
      await saveDialog(file); await freshToast(() => page.locator('#save-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before);
    }
    assert.equal(await fs.readFile(path.join(originalDirectory, 'observation.json'), 'utf8'), original);
    assert.equal(await fs.readFile(projectPath, 'utf8'), original);
  });
  await check('About version and model scope are accurate and help/view menus are reversible', async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.thermalAbout = null;
      dialog.showMessageBox = async (_window, options) => { globalThis.thermalAbout = options; return { response: 0 }; };
    });
    await menu('도움말', '프로그램 정보');
    const about = await app.evaluate(() => globalThis.thermalAbout);
    assert.equal(about.message, 'Thermal Lab ' + expectedVersion);
    assert.match(about.detail, /히터와 방열 모듈/); assert.match(about.detail, /평균 온도 모형/); assert.match(about.detail, /안전성을 계산하지 않습니다/);
    await menu('도움말', '사용 안내'); await waitFor(() => page.locator('#help-dialog').evaluate(node => node.open), 'help dialog');
    assert.match(await page.locator('#help-dialog').textContent(), /히터|열|온도/); await page.locator('#close-help').click();
    await menu('보기', '3D 크게 보기'); await waitFor(() => page.locator('body').evaluate(node => node.classList.contains('focus-mode')), 'large view');
    await menu('보기', '3D 크게 보기'); await waitFor(() => page.locator('body').evaluate(node => !node.classList.contains('focus-mode')), 'normal view');
    sameProject(await project(), saved);
  });
  await check('an outstanding native file dialog prevents close and cancel leaves the original file intact', async () => {
    const before = await project(), original = await fs.readFile(projectPath, 'utf8');
    await app.evaluate(({ dialog }) => {
      globalThis.thermalPendingSave = false; globalThis.thermalClosePrompts = 0;
      dialog.showSaveDialog = () => new Promise(resolve => { globalThis.thermalResolveSave = resolve; globalThis.thermalPendingSave = true; });
      dialog.showMessageBox = async () => { globalThis.thermalClosePrompts++; return { response: 0 }; };
    });
    await page.locator('#save-project').click();
    await waitFor(() => app.evaluate(() => globalThis.thermalPendingSave), 'pending native save dialog');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await waitFor(() => app.evaluate(() => globalThis.thermalClosePrompts === 1), 'busy close prompt');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    sameProject(await project(), before);
    await app.evaluate(() => { globalThis.thermalResolveSave({ canceled: true }); globalThis.thermalPendingSave = false; });
    await delay(60);
    assert.equal(await fs.readFile(projectPath, 'utf8'), original); sameProject(await project(), before);
  });
  await check('reload and repeated full relaunch preserve observations and arbitrary-position window dimensions', async () => {
    saved = await project();
    const display = await app.evaluate(({ screen, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; if (window.isMaximized()) window.unmaximize();
      const current = window.getNormalBounds(), display = screen.getDisplayMatching(current);
      return { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor, minimumSize: window.getMinimumSize() };
    });
    const area = display.workArea, [minWidth, minHeight] = display.minimumSize;
    const gridStep = Array.from({ length: 100 }, (_, index) => index + 1)
      .find(step => Math.abs(step * display.scaleFactor - Math.round(step * display.scaleFactor)) < 1e-7);
    assert.ok(gridStep);
    const sizeOnGrid = (desired, minimum, available) => Math.max(Math.ceil(minimum / gridStep), Math.floor(Math.min(desired, available - 32) / gridStep)) * gridStep;
    const requested = { width: sizeOnGrid(1050, minWidth, area.width), height: sizeOnGrid(780, minHeight, area.height) };
    const centered = (origin, start, available, size) => origin + Math.floor((start + (available - size) / 2 - origin) / gridStep) * gridStep;
    requested.x = centered(display.bounds.x, area.x, area.width, requested.width);
    requested.y = centered(display.bounds.y, area.y, area.height, requested.height);
    windowRestoration = { display, gridStep, requested };
    await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), requested);
    const aligned = await stableBounds('aligned native rectangle'); windowRestoration.aligned = aligned;
    assert.deepEqual(aligned, requested);
    await page.reload(); await page.waitForFunction(() => window.thermalLab?.project && document.querySelector('#scene canvas'));
    sameProject(await project(), saved); assert.deepEqual(await stableBounds('reloaded native rectangle'), aligned);
    await closeNormally();
    const savedWindow = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8'));
    assert.deepEqual(savedWindow, { ...aligned, maximized: false });
    await launch(); sameProject(await project(), saved);
    assert.deepEqual(await stableBounds('restarted aligned rectangle'), aligned);
    const offset = (coordinate, start, available, size) => coordinate + size + 2 <= start + available ? coordinate + 1 : coordinate - 1 >= start ? coordinate - 1 : coordinate;
    const arbitrary = { ...requested, x: offset(requested.x, area.x, area.width, requested.width), y: offset(requested.y, area.y, area.height, requested.height) };
    await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), arbitrary);
    const initialActual = await stableBounds('arbitrary native rectangle');
    assert.ok(Math.abs(initialActual.width - arbitrary.width) <= 1 && Math.abs(initialActual.height - arbitrary.height) <= 1);
    windowRestoration.arbitraryPosition = { requested: arbitrary, initialActual, cycles: [] };
    for (let restart = 1; restart <= 2; restart++) {
      await closeNormally();
      const recorded = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8'));
      assert.deepEqual(recorded, { ...initialActual, maximized: false });
      await launch(); sameProject(await project(), saved);
      const restored = await stableBounds(`arbitrary rectangle after restart ${restart}`);
      assert.deepEqual(restored, initialActual);
      windowRestoration.arbitraryPosition.cycles.push({ restart, saved: recorded, restored });
    }
    await page.screenshot({ path: path.join(evidence, 'native-app-restarted.png') });
  });
  await check('corrupt automatic-save original can be exported verbatim from its native recovery control', async () => {
    const raw = '{synthetic Thermal Lab original\r\n원문 보존';
    // Seed the synthetic original before the new renderer reads storage. The
    // existing renderer legitimately saves its current observation on unload.
    await page.addInitScript(value => {
      if (location.protocol === 'app:' && location.hostname === 'thermal') localStorage.setItem('thermal-lab-project-v1', value);
    }, raw);
    await page.reload();
    await page.waitForFunction(() => window.thermalLab?.project && !document.querySelector('#storage-recovery').hidden);
    const target = path.join(evidence, 'recovered-original.txt');
    await app.evaluate(({ session }, filename) => {
      globalThis.thermalDownload = null;
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(filename); item.once('done', (_event, status) => { globalThis.thermalDownload = status; });
      });
    }, target);
    await page.locator('#recover-original').click();
    await waitFor(() => app.evaluate(() => globalThis.thermalDownload === 'completed'), 'native original download');
    assert.equal(await fs.readFile(target, 'utf8'), raw);
    assert.ok(await page.evaluate(value => Object.keys(localStorage).some(key => key.startsWith('thermal-lab-project-v1-original-') && localStorage.getItem(key) === value), raw));
  });
  assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
} catch (error) {
  failure = error; process.exitCode = 1;
  const diagnostic = page ? await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, state: window.thermalLab?.getState() })).catch(() => null) : null;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors, remoteRequests, windowRestoration, diagnostic }, null, 2));
  console.error(error.stack);
} finally {
  if (app) {
    await app.evaluate(() => { globalThis.thermalResolveSave?.({ canceled: true }); }).catch(() => {});
    await page?.evaluate(() => window.thermalDesktop?.setBusy(false)).catch(() => {});
    await closeNormally().catch(error => { failure ??= error; process.exitCode = 1; });
  }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', version: expectedVersion,
    packaged, executablePath, profile, evidence, checks, errors, remoteRequests, processes, windowRestoration, gpu,
    ...(failure ? { failure: failure.message } : {}) }, null, 2));
  console.log(`Desktop validation: ${checks.length} checks ${failure ? 'completed before failure' : 'passed'}.`);
}
