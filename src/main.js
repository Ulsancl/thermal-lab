import './style.css';
import './conditions.css';
import { AMBIENT_C, DEFAULT_CONFIG, FAN_SPEED_PCT, fanSpeedPercent, normalizeConfig } from './model.js';
import { ThermalRun, createExperiment } from './experiment.js';
import { createProject, parseProject, serializeProject, normalizeView, DEFAULT_VIEW, MAX_PROJECT_BYTES } from './project.js';
import { createBrowserAutosave, supportsAutosaveLock, withAutosaveLock, writeIfUnchanged, readTabDraft, writeTabDraft, clearTabDraft } from './browser-autosave.js';
import { COMPONENTS, temperatureColor } from './geometry.js';
import { ThermalScene } from './scene.js';
import { LESSONS, createGuide, guideControlChange, lessonReady, confirmObservation, guideText } from './lessons.js';
import { TemperatureChart } from './chart.js';
import { thermalDetail } from './detail-model.js';
import { ThermalDetailPanel } from './detail-panel.js';
import './detail-panel.css';
import { version } from '../package.json';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const text = (selector, value) => { $(selector).textContent = value; };
const copy = value => structuredClone(value), number = (value, digits = 1) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const time = seconds => { const tenths = Math.round(seconds * 10); return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`; };
const moduleName = value => value === 'fins' ? '핀' : '평판';
const conditionNumber = value => value > 0 && value < .01 ? value.toExponential(1) : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const fanLabel = config => `${conditionNumber(fanSpeedPercent(config))}%`;
const configName = config => `${moduleName(config.module)} · ${config.contact === 'good' ? '좋은' : '나쁜'} 접촉 · ${config.powerW} W · 주위 ${conditionNumber(config.ambientC ?? AMBIENT_C.default)} °C${config.module === 'fins' ? ` · 팬 ${fanLabel(config)}` : ''}`;
const same = (a, b) => Object.keys(DEFAULT_CONFIG).every(key => a[key] === b[key]);
const STORAGE_KEY = 'thermal-lab-project-v1', desktop = window.thermalDesktop;
let run = new ThermalRun(), snapshot = run.getSnapshot(), view = normalizeView(DEFAULT_VIEW), comparison = null, playbackRate = 60;
let scene, initialCamera = null, guide = null, previous = null, busy = false, restoring = false, focused = false;
let chartDisplay = 'both';
let storageBlocked = false, recoveredRaw = null, saveTimer, toastTimer;
let running = false, frameId = null, lastTick = 0, lastPaint = 0, lastSave = 0, animationTimeS = 0;
const chart = new TemperatureChart($('#temperature-chart'));
const inspectionParts = new Set(['heater-block', 'probe-heater', 'heat-sink', 'probe-sink', 'cartridge-handle', 'fan-rotor', 'fan-frame', 'fan-guard', 'clamp-screws']);
const detailPanel = new ThermalDetailPanel($('#thermal-details'), $('#part-facts'), $('#part-detail-note'), id => { selectPart(id); $('#part-name').scrollIntoView({ block: 'nearest' }); });

function dismissToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }
function toast(message) {
  const close = Object.assign(document.createElement('button'), { textContent: '닫기', type: 'button' });
  close.setAttribute('aria-label', '알림 닫기'); close.addEventListener('click', dismissToast);
  $('#toast').replaceChildren(Object.assign(document.createElement('span'), { textContent: message }), close);
  $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(dismissToast, 6000);
}
function returnToScene() { dismissToast(); requestAnimationFrame(() => $('#scene').scrollIntoView({ block: 'nearest', inline: 'nearest' })); }
function selectPart(id) {
  if (!COMPONENTS.some(part => part.id === id)) throw new RangeError('Unknown thermal component');
  view.selectedPart = id;
  if (scene?.getInspection?.()) { if (inspectionParts.has(id)) scene.beginInspection(id); else scene.endInspection(); }
  syncControls(); refresh(); scheduleSave();
}
function beginInspection(id = view.selectedPart) {
  if (busy || !inspectionParts.has(id) || !scene?.beginInspection?.(id)) return false;
  view.selectedPart = id; syncControls(); refresh(); returnToScene(); scheduleSave(); return true;
}
function endInspection() { scene?.endInspection?.(); refresh(); scheduleSave(); }
function capture() { return createProject({ experiment: run.exportExperiment(), comparison, playbackRate, view, camera: scene?.getProjectCameraState?.() ?? scene?.getCameraState() ?? initialCamera }); }
let lastStoredRaw = null, browserAutosave = null, guardArmed = false;
let resumedTabDraft = false, interruptedTabDraft = null, tabDraftProtected = false;
let offeredProject = null;
const draftStorage = () => sessionStorage;
const getBrowserLocks = () => { try { return navigator.locks; } catch { return undefined; } };
const currentProjectText = () => serializeProject(capture());
const autosaveIssues = {
  conflict: ['다른 탭에서 저장한 실험을 보호했어요.', '이 탭의 변경은 자동 저장하지 않습니다. 아래에서 이 탭의 실험을 내려받고, 최신에 저장된 실험을 보려면 새로고침하세요.', '다른 탭에서 자동 저장이 변경됨 · 이 탭의 실험은 파일로 보관하세요'],
  unavailable: ['이 환경에서는 안전한 자동 저장을 사용할 수 없어요.', '기존 자동 저장 기록을 덮어쓰지 않습니다. 변경한 실험은 아래에서 파일로 내려받으세요.', '안전한 자동 저장을 사용할 수 없음 · 파일로 보관하세요'],
  failed: ['자동 저장을 완료하지 못했어요.', '현재 실험을 잃지 않으려면 아래에서 파일로 내려받으세요.', '자동 저장을 완료하지 못했습니다 · 파일로 보관하세요'],
};
function rememberBrowserDraft() {
  try {
    const draft = browserAutosave.unsavedDraft();
    // This is private to the current tab and survives a reload, not a safe
    // replacement for a project file if the tab/browser is closed.
    if (draft && !restoring && !tabDraftProtected) writeTabDraft(draftStorage, STORAGE_KEY, draft);
    return Boolean(draft);
  } catch { return true; }
}
function warnOnUnsavedExit(event) {
  const dirty = rememberBrowserDraft();
  if (!running && !dirty && !tabDraftProtected) return;
  event.preventDefault();
  event.returnValue = true;
}
function armUnloadGuard() {
  if (desktop || !browserAutosave || guardArmed) return;
  guardArmed = true;
  window.addEventListener('beforeunload', warnOnUnsavedExit);
}
function disarmUnloadGuard() {
  guardArmed = false;
  window.removeEventListener('beforeunload', warnOnUnsavedExit);
}
function reportAutosave(status, contents) {
  if (status === 'saved' || status === 'unchanged') {
    if (!desktop && !tabDraftProtected) clearTabDraft(draftStorage, STORAGE_KEY, contents);
    if (!running && !tabDraftProtected) disarmUnloadGuard();
    offeredProject = null;
    $('#confirm-project-download').hidden = true;
    $('#autosave-recovery').hidden = true;
    text('#save-status', status === 'saved' ? '이 기기에 자동 저장됨' : '자동 저장할 변경 없음');
    return;
  }
  const [title, hint, footer] = autosaveIssues[status];
  text('#autosave-title', title); text('#autosave-hint', hint); text('#save-status', footer);
  $('#autosave-recovery').hidden = false;
}
function saveLocal() {
  clearTimeout(saveTimer);
  if (restoring) return;
  if (!desktop) {
    armUnloadGuard();
    if (!storageBlocked && browserAutosave?.canSave()) {
      text('#save-status', '자동 저장 확인 중');
      void browserAutosave.flush();
    }
    return;
  }
  if (storageBlocked) return;
  try {
    const contents = currentProjectText();
    // The installed app uses its existing single-instance, synchronous path.
    if (!writeIfUnchanged(localStorage, STORAGE_KEY, lastStoredRaw, contents)) {
      storageBlocked = true;
      reportAutosave('conflict');
      return;
    }
    lastStoredRaw = contents;
    reportAutosave('saved');
  } catch { reportAutosave('failed'); }
}
function scheduleSave() {
  if (restoring) return;
  armUnloadGuard();
  if (storageBlocked || (!desktop && !browserAutosave?.canSave())) return;
  if (!desktop) text('#save-status', '자동 저장 확인 중');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 230);
}
function flushBrowserOnHide() {
  if (!guardArmed || restoring || !browserAutosave) return;
  rememberBrowserDraft();
  if (!storageBlocked && browserAutosave.canSave()) {
    clearTimeout(saveTimer);
    void browserAutosave.flush();
  }
}
function protectOriginal(raw, future) {
  storageBlocked = true; recoveredRaw = raw;
  const backup = () => {
    const prefix = `${STORAGE_KEY}-original-`;
    const backedUp = Object.keys(localStorage).some(k => k.startsWith(prefix) && localStorage.getItem(k) === raw);
    if (!backedUp) localStorage.setItem(`${prefix}${Date.now()}`, raw);
  };
  // Recovery remains available from the primary record and in memory, even
  // when backup storage is full or browser coordination is unavailable.
  if (desktop) { try { backup(); } catch { /* Keep the original. */ } }
  else {
    const locks = getBrowserLocks();
    if (supportsAutosaveLock(locks)) void withAutosaveLock(locks, STORAGE_KEY, backup).catch(() => {});
  }
  $('#storage-recovery').hidden = false;
  if (future) text('#storage-recovery strong', '더 새로운 버전의 실험입니다. 원문을 보존합니다.');
  text('#save-status', '자동 저장 원문 보호 중 · 현재 실험은 파일로 보관하세요');
}
function applyRestoredProject(saved) {
  run = new ThermalRun(saved.experiment); snapshot = run.getSnapshot();
  ({ comparison, playbackRate } = saved); ({ view, camera: initialCamera } = saved.observation);
}
try {
  const raw = localStorage.getItem(STORAGE_KEY); lastStoredRaw = raw;
  if (raw !== null) try {
    applyRestoredProject(parseProject(raw));
  } catch (error) { protectOriginal(raw, error.futureVersion); }
} catch { storageBlocked = true; reportAutosave('unavailable'); }
function restoreTabDraft() {
  if (desktop) return;
  // Even if a new tab inherited sessionStorage from an opener, it must not
  // silently reapply that draft to the shared experiment.
  const reloading = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
  const draft = readTabDraft(draftStorage, STORAGE_KEY);
  if (!draft) return;
  if (draft.contents === lastStoredRaw) {
    clearTabDraft(draftStorage, STORAGE_KEY, draft.contents);
    return;
  }
  try {
    const saved = parseProject(draft.contents);
    if (reloading && !draft.interrupted && !storageBlocked && draft.expected === lastStoredRaw
        && supportsAutosaveLock(getBrowserLocks())) {
      applyRestoredProject(saved);
      resumedTabDraft = true;
    } else {
      // The latest shared version remains the active experiment. Hold the old
      // tab draft apart, even if the primary value later returns to old bytes.
      interruptedTabDraft = draft.contents;
      tabDraftProtected = true;
      writeTabDraft(draftStorage, STORAGE_KEY, { ...draft, interrupted: true });
      $('#tab-draft-recovery').hidden = false;
    }
  } catch { clearTabDraft(draftStorage, STORAGE_KEY, draft.contents); }
}
restoreTabDraft();

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
  if (snapshot.atLimit) { toast('2시간 기록을 마쳤습니다. 현재 주위 온도에서 다시 시작하세요.'); return; }
  running = true; armUnloadGuard(); lastTick = performance.now(); lastSave = lastTick; refresh(); frameId = requestAnimationFrame(frame);
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
  const nextRun = new ThermalRun(project.experiment);
  pause(); scene?.endInspection?.(); restoring = true;
  try {
    run = nextRun; snapshot = run.getSnapshot(); ({ comparison, playbackRate } = project);
    ({ view, camera: initialCamera } = project.observation); guide = restoredGuide; animationTimeS = 0; chartDisplay = 'both';
    syncControls({ resetAmbient: true }); refresh(); if (initialCamera) scene?.setCameraState(initialCamera); else scene?.resetCamera();
  } finally { restoring = false; }
  saveLocal();
}
function resetRun(config, { defaults = false } = {}) {
  pause(); remember(); scene?.endInspection?.(); run = new ThermalRun(createExperiment(config)); snapshot = run.getSnapshot(); guide = null; animationTimeS = 0; chartDisplay = 'both';
  if (defaults) { comparison = null; view = normalizeView(DEFAULT_VIEW); playbackRate = 60; }
  syncControls({ resetAmbient: true }); refresh(); if (defaults) scene?.resetCamera(); saveLocal();
  toast(`${conditionNumber(snapshot.parameters.ambientC)} °C에서 새 실험을 시작했습니다. 직전 실험은 되돌릴 수 있습니다.`);
}
function newExperiment() { if (!busy) resetRun(DEFAULT_CONFIG, { defaults: true }); }
function changeConfig(patch) {
  if (busy) return;
  syncTime();
  const request = { ...snapshot.config, ...patch };
  if (Object.hasOwn(patch, 'fan')) delete request.fanSpeedPct;
  const next = normalizeConfig(request), speed = fanSpeedPercent(next);
  const ambientChanged = (next.ambientC ?? AMBIENT_C.default) !== snapshot.parameters.ambientC;
  if (same(next, snapshot.config) && !ambientChanged && speed === fanSpeedPercent(snapshot.config)) { syncControls({ resetAmbient: Object.hasOwn(patch, 'ambientC') }); return; }
  const replacement = ambientChanged || next.module !== snapshot.config.module || next.contact !== snapshot.config.contact;
  const nextGuide = copy(guide); guideControlChange(nextGuide, next, snapshot);
  try {
    if (replacement) {
      pause(); remember(); scene?.endInspection?.(); guide = nextGuide; run = new ThermalRun(createExperiment(next)); snapshot = run.getSnapshot(); animationTimeS = 0;
      toast(`${conditionNumber(snapshot.parameters.ambientC)} °C에서 새 실험을 시작했습니다. 직전 실험은 되돌릴 수 있습니다.`);
    } else { snapshot = run.changeControl({ powerW: next.powerW, fanSpeedPct: speed }); guide = nextGuide; }
  } catch (error) { toast(`조건을 바꾸지 못했습니다. ${error.message}`); }
  syncControls({ resetAmbient: replacement }); refresh(); scheduleSave();
}
function showFanSpeed(value) {
  const label = `${conditionNumber(value)}%`;
  text('#fan-speed-value', label); $('#fan-speed').setAttribute('aria-valuetext', label);
}
function syncControls({ resetAmbient = false } = {}) {
  const config = snapshot.config, ambientC = snapshot.parameters.ambientC, fanAvailable = config.module === 'fins';
  $('#module').value = config.module; $('#contact').value = config.contact;
  $('#power').value = String(config.powerW); $('#fan').checked = config.fan;
  $('#fan').disabled = $('#fan-speed').disabled = !fanAvailable;
  $('#fan-speed').value = String(fanSpeedPercent(config)); showFanSpeed(fanSpeedPercent(config));
  text('#fan-availability', fanAvailable ? '핀 방열판과 공기 사이의 열전달을 조절합니다.' : '핀 방열판을 선택하면 팬을 조절할 수 있습니다.');
  const ambientInput = $('#ambient-c');
  if (resetAmbient || ambientInput.defaultValue !== String(ambientC)) ambientInput.defaultValue = ambientInput.value = String(ambientC);
  text('#scene-ambient', `주위 공기 ${conditionNumber(ambientC)} °C`);
  text('#reset', `${conditionNumber(ambientC)} °C에서 다시`);
  $('#playback-rate').value = String(playbackRate);
  for (const input of $$('[data-view]')) input.checked = view[input.dataset.view];
  $('#part-select').value = view.selectedPart;
  for (const button of $$('[data-lesson]')) button.setAttribute('aria-pressed', String(button.dataset.lesson === guide?.id));
}
function startLesson(id) {
  if (busy || !LESSONS[id]) return;
  pause(); remember(); scene?.endInspection?.(); guide = createGuide(id); run = new ThermalRun(createExperiment(LESSONS[id].config)); snapshot = run.getSnapshot();
  comparison = null; view = normalizeView(DEFAULT_VIEW); playbackRate = 60; animationTimeS = 0; chartDisplay = 'both';
  syncControls({ resetAmbient: true }); refresh(); scene?.resetCamera(); saveLocal();
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
  detailPanel.render(snapshot, view.selectedPart, running);
  const inspection = scene?.getInspection?.();
  $('#inspection-strip').hidden = !inspection;
  $('#inspection-note').textContent = inspection?.note ?? '';
  $('#inspect-part').disabled = !inspectionParts.has(view.selectedPart) || !scene?.beginInspection;
  $('#inspect-part').setAttribute('aria-pressed', String(Boolean(inspection)));
  text('#inspect-part', inspection ? '내부 관찰 마치기' : '내부 구조 자세히');
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
  text('#parameter-summary', `주위 ${conditionNumber(p.ambientC)} °C · 전력 ${snapshot.config.powerW} W. 발열체 열용량 ${p.heaterCapacityJPerK} J/K · 방열판 ${p.sinkCapacityJPerK} J/K. 접촉저항 ${p.contactResistanceKPerW} K/W · 공기로의 방열 계수 ${number(p.airConductanceWPerK, 3)} W/K.`);
  const part = COMPONENTS.find(item => item.id === view.selectedPart);
  if (part) { text('#part-name', part.name); text('#part-material', part.material); text('#part-description', part.description); }
  const fanPart = view.selectedPart.startsWith('fan-'), sinkPart = ['heat-sink', 'cartridge-handle'].includes(view.selectedPart), contactPart = view.selectedPart === 'contact-pad';
  $('#part-action').hidden = !(fanPart || sinkPart || contactPart);
  $('#part-action').disabled = fanPart && snapshot.config.module !== 'fins';
  text('#part-action', sinkPart ? `모듈을 ${snapshot.config.module === 'plate' ? '핀' : '평판'}으로 교체` : contactPart ? `접촉을 ${snapshot.config.contact === 'good' ? '나쁘게' : '좋게'} 변경` : snapshot.config.fan ? '팬 끄기' : '팬 켜기');
  text('#part-state', fanPart ? (snapshot.config.module !== 'fins' ? '핀 모듈을 장착하면 팬을 켤 수 있습니다.' : snapshot.config.fan ? `팬 운전 비율 ${fanLabel(snapshot.config)} · 회전은 대표 표시입니다.` : '팬 꺼짐') : contactPart ? `${snapshot.config.contact === 'good' ? '좋은' : '나쁜'} 접촉 · 온도 차이 ${number(snapshot.heaterC - snapshot.sinkC)} °C` : sinkPart ? `${moduleName(snapshot.config.module)} · 평균 ${number(snapshot.sinkC)} °C` : view.selectedPart === 'heater-block' ? `입력 ${snapshot.config.powerW} W · 평균 ${number(snapshot.heaterC)} °C` : '부품을 선택해도 실험 조건은 유지됩니다.');
  $('#comparison').hidden = !comparison; $('#comparison-key').hidden = !comparison; $('#comparison-display').hidden = !comparison;
  if (comparison) text('#comparison-summary', comparison.label);
  const events = run.exportExperiment().events;
  text('#event-summary', events.length ? `조건 변경 ${events.length}회 · 최근 ${events.slice(-3).map(event => `${time(event.timeS)} / ${event.powerW} W / 팬 ${fanLabel(event)}`).join(' → ')}` : '전력이나 팬 비율을 바꾸면 이곳에 변경 시점이 기록됩니다.');
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
function projectFilename(suffix = '') {
  return `thermal-lab-${new Date().toISOString().slice(0,10)}${suffix}.json`;
}
function downloadBrowserProject(contents, filename) {
  browserDownload(contents, filename);
  offeredProject = contents;
  armUnloadGuard();
  rememberBrowserDraft();
  if (storageBlocked) reportAutosave('unavailable');
  $('#confirm-project-download').hidden = false;
}
function confirmProjectDownload() {
  if (offeredProject === null) return;
  browserAutosave.confirmExported(offeredProject);
  if (!tabDraftProtected) clearTabDraft(draftStorage, STORAGE_KEY, offeredProject);
  offeredProject = null;
  $('#confirm-project-download').hidden = true;
  if (!rememberBrowserDraft() && !running && !tabDraftProtected) disarmUnloadGuard();
}
function exportInterruptedTabDraft() {
  if (busy || interruptedTabDraft === null) return;
  try {
    browserDownload(interruptedTabDraft, projectFilename('-interrupted'));
    $('#confirm-interrupted-download').hidden = false;
    toast('내려받은 복구 사본을 확인하세요.');
  } catch (error) { toast(`내려받지 못했습니다. ${error.message}`); }
}
function confirmInterruptedDownload() {
  clearTabDraft(draftStorage, STORAGE_KEY, interruptedTabDraft);
  interruptedTabDraft = null;
  tabDraftProtected = false;
  $('#tab-draft-recovery').hidden = true;
  if (!rememberBrowserDraft() && !running) disarmUnloadGuard();
}
function exportUnsavedProject() {
  if (busy) return;
  if (desktop) { void saveFile(); return; }
  try {
    syncTime();
    downloadBrowserProject(currentProjectText(), projectFilename('-recovered'));
    toast('내려받은 실험 파일을 확인한 뒤 새로고침하세요.');
  } catch (error) { toast(`내려받지 못했습니다. ${error.message}`); }
}
async function saveFile() {
  if (busy) return; setBusy(true);
  try {
    const contents = currentProjectText(), name = projectFilename();
    if (desktop) { const result = await desktop.saveProject({ contents, name }); if (result.canceled) { toast('저장을 취소했습니다. 현재 실험은 유지합니다.'); return; } }
    else {
      downloadBrowserProject(contents, name);
      saveLocal();
      toast('내려받은 실험 파일을 확인하세요.');
      return;
    }
    saveLocal(); toast('실험 이력·비교 기준·관찰 시점을 저장했습니다.');
  } catch (error) { toast(`저장하지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
async function openFile() {
  if (busy) return; pause();
  if (!desktop) { $('#project-file').click(); return; }
  setBusy(true);
  try { const result = await desktop.openProject(); if (result.canceled) { toast('열기를 취소했습니다. 현재 실험은 유지합니다.'); return; } remember(); readProject(result.project); toast('저장한 열 실험을 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
function toggleFocus() { focused = !focused; document.body.classList.toggle('focus-mode', focused); text('#focus', focused ? '실험 화면으로' : '3D 크게 보기'); returnToScene(); }

$('#part-select').replaceChildren(...COMPONENTS.map(part => Object.assign(document.createElement('option'), { value: part.id, textContent: part.name })));
Object.assign($('#ambient-c'), { min: AMBIENT_C.min, max: AMBIENT_C.max });
Object.assign($('#fan-speed'), { min: FAN_SPEED_PCT.min, max: FAN_SPEED_PCT.max });
text('#app-version', version);
text('#ambient-hint', `${AMBIENT_C.min}–${AMBIENT_C.max} °C · 적용하면 이 온도에서 새 실험을 시작합니다.`);
$('#temperature-gradient').style.background = `linear-gradient(90deg,${temperatureColor(25)},${temperatureColor(65)} 47%,${temperatureColor(110)})`;
try {
  scene = new ThermalScene($('#scene'), { onSelect: selectPart, onCameraChange: scheduleSave });
  if (initialCamera) scene.setCameraState(initialCamera);
} catch (error) { $('#scene-error').hidden = false; text('#scene-error', `3D 화면을 시작하지 못했습니다. ${error.message}`); }
syncControls({ resetAmbient: true }); refresh(); if (!initialCamera) scene?.resetCamera();
if (!desktop) {
  browserAutosave = createBrowserAutosave({
    key: STORAGE_KEY, storage: () => localStorage, locks: getBrowserLocks(), expected: lastStoredRaw,
    baseline: resumedTabDraft ? null : currentProjectText(), capture: currentProjectText, onStatus: reportAutosave,
  });
  if (tabDraftProtected) armUnloadGuard();
  if (!storageBlocked && !browserAutosave.canSave()) reportAutosave('unavailable');
  else if (resumedTabDraft) saveLocal();
}
for (const key of ['module', 'contact', 'power', 'fan']) $(`#${key}`).addEventListener('change', event => changeConfig({ [key === 'power' ? 'powerW' : key]: key === 'fan' ? event.target.checked : key === 'power' ? Number(event.target.value) : event.target.value }));
$('#ambient-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#ambient-c');
  if (input.reportValidity()) changeConfig({ ambientC: input.valueAsNumber });
});
$('#fan-speed').addEventListener('input', event => showFanSpeed(event.target.valueAsNumber));
$('#fan-speed').addEventListener('change', event => changeConfig({ fanSpeedPct: event.target.valueAsNumber }));
$('#play').addEventListener('click', togglePlay); $('#step').addEventListener('click', () => step(60)); $('#step-large').addEventListener('click', () => step(300));
$('#reset').addEventListener('click', () => { if (!busy) resetRun(snapshot.config); });
$('#playback-rate').addEventListener('change', event => { syncTime(); playbackRate = Number(event.target.value); refresh(); scheduleSave(); });
for (const input of $$('[data-view]')) input.addEventListener('change', () => { view[input.dataset.view] = input.checked; refresh(); scheduleSave(); });
for (const button of $$('[data-camera]')) button.addEventListener('click', () => { scene?.endInspection?.(); scene?.resetCamera(button.dataset.camera); refresh(false); returnToScene(); });
$('#part-select').addEventListener('change', event => selectPart(event.target.value));
$('#focus-part').addEventListener('click', () => { scene?.focusPart(view.selectedPart); refresh(false); returnToScene(); }); $('#focus').addEventListener('click', toggleFocus);
$('#inspect-part').addEventListener('click', () => { if (scene?.getInspection?.()) endInspection(); else beginInspection(); });
$('#end-inspection').addEventListener('click', endInspection);
$('#part-action').addEventListener('click', () => { if (['heat-sink', 'cartridge-handle'].includes(view.selectedPart)) changeConfig({ module: snapshot.config.module === 'plate' ? 'fins' : 'plate' }); else if (view.selectedPart === 'contact-pad') changeConfig({ contact: snapshot.config.contact === 'good' ? 'poor' : 'good' }); else if (view.selectedPart.startsWith('fan-')) changeConfig({ fan: !snapshot.config.fan }); });
for (const button of $$('[data-lesson]')) button.addEventListener('click', () => startLesson(button.dataset.lesson));
$('#guide-next').addEventListener('click', guideNext); $('#guide-restart').addEventListener('click', () => { if (guide) startLesson(guide.id); });
$('#guide-exit').addEventListener('click', () => { guide = null; syncControls(); refresh(false); });
$('#pin-comparison').addEventListener('click', pinComparison); $('#clear-comparison').addEventListener('click', () => { comparison = null; chartDisplay = 'both'; refresh(false); scheduleSave(); });
for (const button of $$('[data-chart-mode]')) button.addEventListener('click', () => { chartDisplay = button.dataset.chartMode; refresh(false); });
$('#new-project').addEventListener('click', newExperiment);
$('#undo-new').addEventListener('click', () => { if (!previous || busy) return; const saved = previous; previous = null; readProject(saved.project, saved.guide); $('#undo-new').hidden = true; toast('직전 실험과 안내를 복원했습니다.'); });
$('#export-unsaved-project').addEventListener('click', exportUnsavedProject);
$('#export-interrupted-draft').addEventListener('click', exportInterruptedTabDraft);
$('#confirm-project-download').addEventListener('click', confirmProjectDownload);
$('#confirm-interrupted-download').addEventListener('click', confirmInterruptedDownload);
$('#save-project').addEventListener('click', saveFile); $('#open-project').addEventListener('click', openFile);
$('#project-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file || busy) return; setBusy(true);
  try { if (file.size > MAX_PROJECT_BYTES) throw new Error('실험 파일은 1 MiB 이하여야 합니다.'); const saved = parseProject(await file.text()); remember(); readProject(saved); toast('저장한 열 실험을 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { event.target.value = ''; setBusy(false); }
});
$('#recover-original').addEventListener('click', () => { if (recoveredRaw !== null) browserDownload(recoveredRaw, 'thermal-lab-original.txt', 'text/plain;charset=utf-8'); });
function showHelp() {
  if (busy || $('#help-dialog').open) return;
  pause(); $('#help-dialog').showModal();
}
$('#help').addEventListener('click', showHelp);
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
desktop?.onCommand(command => { if (busy) return; if (command === 'new-project') newExperiment(); else if (command === 'open-project') openFile(); else if (command === 'save-project') saveFile(); else if (command === 'toggle-play') togglePlay(); else if (command === 'focus') toggleFocus(); else if (command === 'help') showHelp(); });
if (desktop) window.addEventListener('beforeunload', () => { syncTime(); saveLocal(); });
else window.addEventListener('pagehide', () => { if (running) pause(); flushBrowserOnHide(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (desktop || running) pause();
  if (!desktop) flushBrowserOnHide();
});
$('#sample-details').addEventListener('toggle', renderSamples);
new ResizeObserver(drawChart).observe($('#temperature-chart'));
if (__THERMAL_TEST_BUILD__) {
  window.thermalLab = {
    getState: () => copy({ experiment: run.exportExperiment(), snapshot, view, comparison, playbackRate, running }),
    project: () => { syncTime(); return copy(capture()); },
    loadProject: raw => { const saved = parseProject(raw); remember(); readProject(saved); return copy(capture()); },
    step, sceneDebug: () => scene?.getDebug() ?? null, guide: () => copy(guide), chartDebug: () => copy(chart.debug),
    getDetail: () => thermalDetail(snapshot), getInspection: () => scene?.getInspection?.() ?? null, beginInspection, endInspection,
  };
  window.render_game_to_text = () => JSON.stringify({ mode: running ? 'running' : 'paused', coordinateSystem: 'SI; x right, y up, z toward front. Temperatures are two lumped mean values.', snapshot, selectedPart: view.selectedPart, inspection: scene?.getInspection?.() ?? null, playbackRate, comparison: Boolean(comparison) });
  window.advanceTime = milliseconds => step(milliseconds / 1000);
}
