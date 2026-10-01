import './style.css';
import { DEFAULT_CONFIG, normalizeConfig } from './model.js';
import { ThermalRun, createExperiment } from './experiment.js';
import { createProject, parseProject, serializeProject, normalizeView, DEFAULT_VIEW } from './project.js';
import { COMPONENTS, temperatureColor } from './geometry.js';
import { ThermalScene } from './scene.js';
import { LESSONS, createGuide, guideControlChange, lessonReady, confirmObservation, guideText } from './lessons.js';
import { TemperatureChart } from './chart.js';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const text = (selector, value) => { $(selector).textContent = value; };
const copy = value => structuredClone(value), number = (value, digits = 1) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const time = seconds => { const tenths = Math.round(seconds * 10); return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`; };
const moduleName = value => value === 'fins' ? '핀' : '평판';
const configName = config => `${moduleName(config.module)} · ${config.contact === 'good' ? '좋은' : '나쁜'} 접촉 · ${config.powerW} W${config.fan ? ' · 팬 켜짐' : ''}`;
const same = (a, b) => Object.keys(DEFAULT_CONFIG).every(key => a[key] === b[key]);
const STORAGE_KEY = 'thermal-lab-project-v1', desktop = window.thermalDesktop;
let run = new ThermalRun(), snapshot = run.getSnapshot(), view = normalizeView(DEFAULT_VIEW), comparison = null, playbackRate = 60;
let scene, initialCamera = null, guide = null, previous = null, busy = false, restoring = false, focused = false;
let chartDisplay = 'both';
let storageBlocked = false, recoveredRaw = null, saveTimer, toastTimer;
let running = false, frameId = null, lastTick = 0, lastPaint = 0, lastSave = 0, animationTimeS = 0;
const chart = new TemperatureChart($('#temperature-chart'));

function dismissToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }
function toast(message) {
  const close = Object.assign(document.createElement('button'), { textContent: '닫기', type: 'button' });
  close.setAttribute('aria-label', '알림 닫기'); close.addEventListener('click', dismissToast);
  $('#toast').replaceChildren(Object.assign(document.createElement('span'), { textContent: message }), close);
  $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(dismissToast, 6000);
}
function returnToScene() { dismissToast(); requestAnimationFrame(() => $('#scene').scrollIntoView({ block: 'nearest', inline: 'nearest' })); }
function capture() { return createProject({ experiment: run.exportExperiment(), comparison, playbackRate, view, camera: scene?.getCameraState() ?? initialCamera }); }
function saveLocal() {
  clearTimeout(saveTimer); if (storageBlocked || restoring) return;
  try { localStorage.setItem(STORAGE_KEY, serializeProject(capture())); text('#save-status', '이 기기에 자동 저장됨'); }
  catch { text('#save-status', '자동 저장을 완료하지 못했습니다 · 파일로 보관하세요'); }
}
function scheduleSave() { if (!restoring && !storageBlocked) { clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 230); } }
function protectOriginal(raw, future) {
  recoveredRaw = raw; storageBlocked = true;
  try { localStorage.setItem(`${STORAGE_KEY}-original-${Date.now()}`, raw); } catch { /* Keep the in-memory original available for download. */ }
  $('#storage-recovery').hidden = false;
  if (future) text('#storage-recovery strong', '더 새로운 버전의 실험입니다. 기존 원문을 보존합니다.');
  text('#save-status', '자동 저장 원문 보호 중 · 현재 실험은 파일로 보관하세요');
}
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) try {
    const saved = parseProject(raw); run = new ThermalRun(saved.experiment); snapshot = run.getSnapshot();
    ({ comparison, playbackRate } = saved); ({ view, camera: initialCamera } = saved.observation);
  } catch (error) { protectOriginal(raw, error.futureVersion); }
} catch { storageBlocked = true; text('#save-status', '자동 저장을 사용할 수 없습니다 · 파일로 보관하세요'); }

// Account for the full elapsed interval under the old controls before any change.
function syncTime(now = performance.now()) {
  if (!running || now <= lastTick) return;
  const elapsed = (now - lastTick) / 1000; lastTick = now;
  const before = snapshot.timeS; snapshot = run.advance(elapsed * playbackRate);
  animationTimeS += (snapshot.timeS - before) / playbackRate;
  if (snapshot.atLimit) { running = false; if (frameId !== null) cancelAnimationFrame(frameId); frameId = null; saveLocal(); }
}
function paintScene() { scene?.update(snapshot, view, { animationTimeS, running }); }
function frame(now) {
  frameId = null; syncTime(now); paintScene();
  if (now - lastPaint >= 100 || !running) { refresh(false); lastPaint = now; }
  if (now - lastSave >= 1000) { saveLocal(); lastSave = now; }
  if (running) frameId = requestAnimationFrame(frame);
}
function pause() {
  syncTime(); running = false; if (frameId !== null) cancelAnimationFrame(frameId); frameId = null;
  refresh(); saveLocal();
}
function togglePlay() {
  if (busy) return;
  if (running) { pause(); return; }
  if (snapshot.atLimit) { toast('2시간 기록을 마쳤습니다. 25 °C에서 다시 시작하세요.'); return; }
  running = true; lastTick = performance.now(); lastSave = lastTick; refresh(); frameId = requestAnimationFrame(frame);
}
function step(seconds) {
  if (busy) return copy(snapshot);
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('진행 시간은 0 이상의 유한한 수여야 합니다.');
  pause(); snapshot = run.advance(seconds); refresh(); saveLocal(); return copy(snapshot);
}
function setBusy(value) {
  if (value) pause(); busy = value; $('#save-project').disabled = value; $('#open-project').disabled = value;
  if (desktop?.setBusy) Promise.resolve(desktop.setBusy(value)).catch(() => {});
}
function remember() { syncTime(); previous = { project: capture(), guide: copy(guide) }; $('#undo-new').hidden = false; }
function readProject(project, restoredGuide = null) {
  const saved = parseProject(serializeProject(project)), nextRun = new ThermalRun(saved.experiment);
  pause(); restoring = true;
  try {
    run = nextRun; snapshot = run.getSnapshot(); ({ comparison, playbackRate } = saved);
    ({ view, camera: initialCamera } = saved.observation); guide = restoredGuide; animationTimeS = 0; chartDisplay = 'both';
    syncControls(); refresh(); if (initialCamera) scene?.setCameraState(initialCamera); else scene?.resetCamera();
  } finally { restoring = false; }
  saveLocal();
}
function resetRun(config, { defaults = false } = {}) {
  pause(); remember(); run = new ThermalRun(createExperiment(config)); snapshot = run.getSnapshot(); guide = null; animationTimeS = 0; chartDisplay = 'both';
  if (defaults) { comparison = null; view = normalizeView(DEFAULT_VIEW); playbackRate = 60; }
  syncControls(); refresh(); if (defaults) scene?.resetCamera(); saveLocal();
  toast('25 °C에서 새 실험을 시작했습니다. 직전 실험은 되돌릴 수 있습니다.');
}
function newExperiment() { if (!busy) resetRun(DEFAULT_CONFIG, { defaults: true }); }
function changeConfig(patch) {
  if (busy) return;
  syncTime(); const next = normalizeConfig({ ...snapshot.config, ...patch });
  if (same(next, snapshot.config)) { syncControls(); return; }
  const replacement = next.module !== snapshot.config.module || next.contact !== snapshot.config.contact;
  const nextGuide = copy(guide); guideControlChange(nextGuide, next, snapshot);
  try {
    if (replacement) {
      pause(); remember(); guide = nextGuide; run = new ThermalRun(createExperiment(next)); snapshot = run.getSnapshot(); animationTimeS = 0;
      toast('부품을 교체해 25 °C에서 다시 시작했습니다. 직전 실험은 되돌릴 수 있습니다.');
    } else { snapshot = run.changeControl({ powerW: next.powerW, fan: next.fan }); guide = nextGuide; }
  } catch (error) { toast(`조건을 바꾸지 못했습니다. ${error.message}`); }
  syncControls(); refresh(); scheduleSave();
}
function syncControls() {
  const config = snapshot.config; $('#module').value = config.module; $('#contact').value = config.contact;
  $('#power').value = String(config.powerW); $('#fan').checked = config.fan; $('#fan').disabled = config.module !== 'fins';
  text('#fan-availability', config.module === 'fins' ? '핀 사이로 공기를 보냅니다' : '핀 모듈에서 사용');
  $('#playback-rate').value = String(playbackRate);
  for (const input of $$('[data-view]')) input.checked = view[input.dataset.view];
  $('#part-select').value = view.selectedPart;
  for (const button of $$('[data-lesson]')) button.setAttribute('aria-pressed', String(button.dataset.lesson === guide?.id));
}
function startLesson(id) {
  if (busy || !LESSONS[id]) return;
  pause(); remember(); guide = createGuide(id); run = new ThermalRun(createExperiment(LESSONS[id].config)); snapshot = run.getSnapshot();
  comparison = null; view = normalizeView(DEFAULT_VIEW); playbackRate = 60; animationTimeS = 0; chartDisplay = 'both';
  syncControls(); refresh(); scene?.resetCamera(); saveLocal();
}
function pinComparison() {
  syncTime(); comparison = { label: `${configName(snapshot.config)} · ${time(snapshot.timeS)}`, experiment: run.exportExperiment() }; chartDisplay = 'both';
  refresh(false); scheduleSave();
}
function guideNext() {
  if (busy) return; syncTime();
  if (confirmObservation(guide, snapshot, run.exportExperiment())) {
    pause(); if (guide.status === 'active' && guide.id !== 'storage') pinComparison(); refresh(false);
  }
}
function renderGuide() {
  $('#lesson-guide').hidden = !guide; $('#guide-next').hidden = !guide || guide.status !== 'active'; if (!guide) return;
  const { action, result } = guideText(guide);
  text('#guide-title', LESSONS[guide.id].title);
  text('#guide-progress', guide.status === 'completed' ? '관찰 완료' : guide.status === 'interrupted' ? '직접 조절 중' : `관찰 ${guide.stage + 1} / ${LESSONS[guide.id].steps}`);
  text('#guide-action', action); text('#guide-result', result);
  $('#guide-next').disabled = !lessonReady(guide, snapshot);
  text('#guide-next', lessonReady(guide, snapshot) ? '관찰 확인 · 다음으로' : '조건을 맞춘 뒤 관찰 확인');
}
const trend = rate => {
  if (Math.abs(rate) < .0005) return '현재 조건에서 온도 변화가 작습니다';
  const direction = rate > 0 ? '상승' : '하강';
  const label = running ? `${direction} 중` : snapshot.atLimit ? `현재 조건의 ${direction} 변화율` : `재생 시 ${direction} 예상`;
  return `${label} · ${number(Math.abs(rate) * 60, 2)} °C/모의 분`;
};
function refresh(renderScene = true) {
  if (renderScene) paintScene();
  $('#heater-temperature').replaceChildren(document.createTextNode(number(snapshot.heaterC)), Object.assign(document.createElement('small'), { textContent: ' °C' }));
  $('#sink-temperature').replaceChildren(document.createTextNode(number(snapshot.sinkC)), Object.assign(document.createElement('small'), { textContent: ' °C' }));
  text('#compact-heater', `${number(snapshot.heaterC)} °C`); text('#compact-sink', `${number(snapshot.sinkC)} °C`);
  text('#heater-trend', trend(snapshot.heaterRateKPerS)); text('#sink-trend', trend(snapshot.sinkRateKPerS));
  text('#steady-temperatures', `발열체 ${number(snapshot.steady.heaterC)} / 방열판 ${number(snapshot.steady.sinkC)} °C`);
  text('#contact-heat', `${number(snapshot.contactHeatW, 2)} W`); text('#air-heat', `${number(snapshot.airHeatW, 2)} W`);
  text('#stored-energy', `${number(snapshot.storedEnergyJ, 0)} J`); text('#time', time(snapshot.timeS));
  text('#run-status', running ? `${playbackRate}× 재생 중` : snapshot.atLimit ? '기록 완료' : '일시정지');
  text('#play', running ? '일시정지' : snapshot.timeS ? '계속 관찰' : snapshot.config.powerW ? '가열 시작' : '관찰 시작');
  $('#play').setAttribute('aria-pressed', String(running)); $('#time-limit').hidden = !snapshot.atLimit;
  $('#step').disabled = snapshot.atLimit; $('#step-large').disabled = snapshot.atLimit;
  const p = snapshot.parameters;
  text('#parameter-summary', `발열체 열용량 ${p.heaterCapacityJPerK} J/K · 방열판 ${p.sinkCapacityJPerK} J/K. 접촉저항 ${p.contactResistanceKPerW} K/W · 공기로의 방열 계수 ${p.airConductanceWPerK} W/K. 전력 ${snapshot.config.powerW} W.`);
  const part = COMPONENTS.find(item => item.id === view.selectedPart);
  if (part) { text('#part-name', part.name); text('#part-material', part.material); text('#part-description', part.description); }
  const fanPart = view.selectedPart.startsWith('fan-'), sinkPart = ['heat-sink', 'cartridge-handle'].includes(view.selectedPart), contactPart = view.selectedPart === 'contact-pad';
  $('#part-action').hidden = !(fanPart || sinkPart || contactPart);
  $('#part-action').disabled = fanPart && snapshot.config.module !== 'fins';
  text('#part-action', sinkPart ? `모듈을 ${snapshot.config.module === 'plate' ? '핀' : '평판'}으로 교체` : contactPart ? `접촉을 ${snapshot.config.contact === 'good' ? '나쁘게' : '좋게'} 변경` : snapshot.config.fan ? '팬 끄기' : '팬 켜기');
  text('#part-state', fanPart ? (snapshot.config.module !== 'fins' ? '핀 모듈을 장착하면 팬을 켤 수 있습니다.' : snapshot.config.fan ? '팬 켜짐 · 회전은 작동 상태를 설명합니다.' : '팬 꺼짐') : contactPart ? `${snapshot.config.contact === 'good' ? '좋은' : '나쁜'} 접촉 · 온도 차이 ${number(snapshot.heaterC - snapshot.sinkC)} °C` : sinkPart ? `${moduleName(snapshot.config.module)} · 평균 ${number(snapshot.sinkC)} °C` : view.selectedPart === 'heater-block' ? `입력 ${snapshot.config.powerW} W · 평균 ${number(snapshot.heaterC)} °C` : '부품을 선택해도 실험 조건은 유지됩니다.');
  $('#comparison').hidden = !comparison; $('#comparison-key').hidden = !comparison; $('#comparison-display').hidden = !comparison;
  if (comparison) text('#comparison-summary', comparison.label);
  const events = run.exportExperiment().events;
  text('#event-summary', events.length ? `조건 변경 ${events.length}회 · 최근 ${events.slice(-3).map(event => `${time(event.timeS)} / ${event.powerW} W / 팬 ${event.fan ? '켜짐' : '꺼짐'}`).join(' → ')}` : '아직 조건 변경이 없습니다. 전력·팬을 바꾸면 같은 온도 이력 위에 기록됩니다.');
  drawChart();
  if (comparison && chart.debug?.savedEnd) { const saved = chart.debug.savedEnd; text('#comparison-endpoint', `보관 끝점 ${time(saved.timeS)}\n발열체 ${number(saved.heaterC)} °C · 방열판 ${number(saved.sinkC)} °C`); }
  for (const button of $$('[data-chart-mode]')) button.setAttribute('aria-pressed', String(button.dataset.chartMode === chartDisplay));
  renderGuide(); renderSamples();
}
function drawChart() { chart.draw(run.getSamples(), comparison, { display: chartDisplay, events: run.exportExperiment().events }); }
function renderSamples() {
  if (!$('#sample-details').open) return;
  $('#sample-rows').replaceChildren(...run.getSamples().slice(-10).map(sample => {
    const row = document.createElement('tr'); row.replaceChildren(...[time(sample.timeS), number(sample.heaterC, 3), number(sample.sinkC, 3)].map(value => Object.assign(document.createElement('td'), { textContent: value }))); return row;
  }));
}
function browserDownload(contents, name, mime = 'application/json;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveFile() {
  if (busy) return; setBusy(true);
  try {
    const contents = serializeProject(capture()), name = `thermal-lab-${new Date().toISOString().slice(0, 10)}.json`;
    if (desktop) { const result = await desktop.saveProject({ contents, name }); if (result.canceled) { toast('저장을 취소했습니다. 현재 실험은 유지합니다.'); return; } }
    else browserDownload(contents, name);
    saveLocal(); toast('실험 이력·비교 기준·관찰 시점을 저장했습니다.');
  } catch (error) { toast(`저장하지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
async function openFile() {
  if (busy) return; pause();
  if (!desktop) { $('#project-file').click(); return; }
  setBusy(true);
  try { const result = await desktop.openProject(); if (result.canceled) { toast('열기를 취소했습니다. 현재 실험은 유지합니다.'); return; } const saved = parseProject(result.content); remember(); readProject(saved); toast('저장한 열 실험을 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
function toggleFocus() { focused = !focused; document.body.classList.toggle('focus-mode', focused); text('#focus', focused ? '실험 화면으로' : '3D 크게 보기'); returnToScene(); }

$('#part-select').replaceChildren(...COMPONENTS.map(part => Object.assign(document.createElement('option'), { value: part.id, textContent: part.name })));
$('#temperature-gradient').style.background = `linear-gradient(90deg,${temperatureColor(25)},${temperatureColor(65)} 47%,${temperatureColor(110)})`;
try {
  scene = new ThermalScene($('#scene'), { onSelect: id => { view.selectedPart = id; syncControls(); refresh(); scheduleSave(); }, onCameraChange: scheduleSave });
  if (initialCamera) scene.setCameraState(initialCamera);
} catch (error) { $('#scene-error').hidden = false; text('#scene-error', `3D 화면을 시작하지 못했습니다. ${error.message}`); }
syncControls(); refresh(); if (!initialCamera) scene?.resetCamera();
for (const key of ['module', 'contact', 'power', 'fan']) $(`#${key}`).addEventListener('change', event => changeConfig({ [key === 'power' ? 'powerW' : key]: key === 'fan' ? event.target.checked : key === 'power' ? Number(event.target.value) : event.target.value }));
$('#play').addEventListener('click', togglePlay); $('#step').addEventListener('click', () => step(60)); $('#step-large').addEventListener('click', () => step(300));
$('#reset').addEventListener('click', () => { if (!busy) resetRun(snapshot.config); });
$('#playback-rate').addEventListener('change', event => { syncTime(); playbackRate = Number(event.target.value); refresh(); scheduleSave(); });
for (const input of $$('[data-view]')) input.addEventListener('change', () => { view[input.dataset.view] = input.checked; refresh(); scheduleSave(); });
for (const button of $$('[data-camera]')) button.addEventListener('click', () => { scene?.resetCamera(button.dataset.camera); returnToScene(); });
$('#part-select').addEventListener('change', event => { view.selectedPart = event.target.value; refresh(); scheduleSave(); });
$('#focus-part').addEventListener('click', () => { scene?.focusPart(view.selectedPart); returnToScene(); }); $('#focus').addEventListener('click', toggleFocus);
$('#part-action').addEventListener('click', () => { if (['heat-sink', 'cartridge-handle'].includes(view.selectedPart)) changeConfig({ module: snapshot.config.module === 'plate' ? 'fins' : 'plate' }); else if (view.selectedPart === 'contact-pad') changeConfig({ contact: snapshot.config.contact === 'good' ? 'poor' : 'good' }); else if (view.selectedPart.startsWith('fan-')) changeConfig({ fan: !snapshot.config.fan }); });
for (const button of $$('[data-lesson]')) button.addEventListener('click', () => startLesson(button.dataset.lesson));
$('#guide-next').addEventListener('click', guideNext); $('#guide-restart').addEventListener('click', () => { if (guide) startLesson(guide.id); });
$('#guide-exit').addEventListener('click', () => { guide = null; syncControls(); refresh(false); });
$('#pin-comparison').addEventListener('click', pinComparison); $('#clear-comparison').addEventListener('click', () => { comparison = null; chartDisplay = 'both'; refresh(false); scheduleSave(); });
for (const button of $$('[data-chart-mode]')) button.addEventListener('click', () => { chartDisplay = button.dataset.chartMode; refresh(false); });
$('#new-project').addEventListener('click', newExperiment);
$('#undo-new').addEventListener('click', () => { if (!previous || busy) return; const saved = previous; previous = null; readProject(saved.project, saved.guide); $('#undo-new').hidden = true; toast('직전 실험과 안내를 복원했습니다.'); });
$('#save-project').addEventListener('click', saveFile); $('#open-project').addEventListener('click', openFile);
$('#project-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file || busy) return; setBusy(true);
  try { if (file.size > 10 * 1024 * 1024) throw new Error('실험 파일은 10 MiB 이하여야 합니다.'); const saved = parseProject(await file.text()); remember(); readProject(saved); toast('저장한 열 실험을 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { event.target.value = ''; setBusy(false); }
});
$('#recover-original').addEventListener('click', () => { if (recoveredRaw !== null) browserDownload(recoveredRaw, 'thermal-lab-original.txt', 'text/plain;charset=utf-8'); });
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
desktop?.onCommand(command => { if (busy) return; if (command === 'new-project') newExperiment(); else if (command === 'open-project') openFile(); else if (command === 'save-project') saveFile(); else if (command === 'toggle-play') togglePlay(); else if (command === 'focus') toggleFocus(); else if (command === 'help') { pause(); $('#help-dialog').showModal(); } });
window.addEventListener('beforeunload', () => { syncTime(); saveLocal(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
$('#sample-details').addEventListener('toggle', renderSamples);
new ResizeObserver(drawChart).observe($('#temperature-chart'));
window.thermalLab = {
  getState: () => copy({ experiment: run.exportExperiment(), snapshot, view, comparison, playbackRate, running }),
  project: () => { syncTime(); return copy(capture()); },
  loadProject: raw => { const saved = parseProject(raw); remember(); readProject(saved); return copy(capture()); },
  step, sceneDebug: () => scene?.getDebug() ?? null, guide: () => copy(guide), chartDebug: () => copy(chart.debug),
};
