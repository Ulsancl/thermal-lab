import { MODEL_VERSION, normalizeConfig } from './model.js';
import { createExperiment, assertExperiment } from './experiment.js';
import { DEFAULT_VIEW, COMPONENTS } from './geometry.js';
export { DEFAULT_VIEW };
export const projectType = 'thermal-lab-project', projectVersion = 1, projectModelVersion = MODEL_VERSION;
export const MAX_PROJECT_BYTES = 1024 * 1024;
const rates = [1, 10, 60];
const flags = ['temperature', 'flows', 'exploded', 'labels'];
const parts = new Set(COMPONENTS.map(part => part.id));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const copy = value => structuredClone(value);
export class ProjectError extends Error {
  constructor(message, code = 'INVALID_PROJECT') {
    super(`${message} 원본 파일은 변경하지 않습니다.`); this.name = 'ProjectError'; this.code = code;
    this.preserveOriginal = true; this.futureVersion = ['FUTURE_SCHEMA', 'FUTURE_MODEL'].includes(code);
  }
}
const fail = (message, code) => { throw new ProjectError(message, code); };
function shape(value, required, label, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail(`${label}에 누락되거나 지원하지 않는 항목이 있습니다.`);
}
function number(value, label, low, high) { if (!finite(value) || Object.is(value, -0) || value < low || value > high) fail(`${label} 수치가 올바르지 않습니다.`); }
function modelVersion(value) {
  if (value === MODEL_VERSION) return;
  const version = typeof value === 'string' ? /^thermal-two-node-(\d+)$/.exec(value) : null;
  fail('이 열 모형 버전의 원래 기록을 보호합니다.', version && Number(version[1]) > 1 ? 'FUTURE_MODEL' : 'UNSUPPORTED_MODEL');
}
export function normalizePlaybackRate(value) { return rates.includes(value) ? value : 60; }
export function normalizeView(input) {
  const value = record(input) ? input : {};
  return { ...Object.fromEntries(flags.map(key => [key, typeof value[key] === 'boolean' ? value[key] : DEFAULT_VIEW[key]])),
    selectedPart: parts.has(value.selectedPart) ? value.selectedPart : DEFAULT_VIEW.selectedPart };
}
function savedView(value) {
  shape(value, [...flags, 'selectedPart'], '관찰 화면');
  if (!parts.has(value.selectedPart) || flags.some(key => typeof value[key] !== 'boolean')) fail('관찰 부품 또는 표시 상태가 올바르지 않습니다.');
  return normalizeView(value);
}
function savedCamera(value) {
  if (value === null) return null;
  shape(value, ['position', 'target'], '카메라', ['zoom']);
  for (const key of ['position', 'target']) {
    if (!Array.isArray(value[key]) || value[key].length !== 3) fail('카메라 좌표는 세 개의 수치여야 합니다.');
    for (const coordinate of value[key]) number(coordinate, '카메라 좌표', -100, 100);
  }
  number(Math.hypot(...value.position.map((coordinate, index) => coordinate - value.target[index])), '카메라 거리', .05 - 1e-10, 10 + 1e-10);
  if (Object.hasOwn(value, 'zoom')) number(value.zoom, '카메라 확대', .25, 4);
  return copy(value);
}
function savedExperiment(value) {
  try { assertExperiment(value); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    fail(`실험 조건 또는 변경 이력이 올바르지 않습니다. ${error.message}`, 'INVALID_EXPERIMENT');
  }
  return copy(value);
}
function savedComparison(value) {
  if (value === null) return null;
  shape(value, ['label', 'experiment'], '비교 기록');
  if (typeof value.label !== 'string' || value.label.length < 1 || value.label.length > 80 || !value.label.trim() || /[\u0000-\u001f\u007f]/.test(value.label)) fail('비교 이름은 제어 문자 없는 1~80자여야 합니다.');
  return { label: value.label, experiment: savedExperiment(value.experiment) };
}
function validateProject(value) {
  if (!record(value) || value.type !== projectType) fail('지원하지 않는 열 실험 파일입니다.', 'UNSUPPORTED_FORMAT');
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > projectVersion) fail('새로운 저장 형식을 보호합니다.', 'FUTURE_SCHEMA');
  if (value.schemaVersion !== projectVersion) fail('지원하지 않는 저장 형식 버전입니다.', 'UNSUPPORTED_SCHEMA');
  modelVersion(value.modelVersion);
  shape(value, ['type', 'schemaVersion', 'modelVersion', 'experiment', 'comparison', 'playbackRate', 'observation'], '열 실험 파일');
  shape(value.observation, ['view', 'camera'], '관찰 기록');
  if (!rates.includes(value.playbackRate)) fail('재생 배율은 1, 10, 60 중 하나여야 합니다.');
  return { type: projectType, schemaVersion: projectVersion, modelVersion: MODEL_VERSION,
    experiment: savedExperiment(value.experiment), comparison: savedComparison(value.comparison), playbackRate: value.playbackRate,
    observation: { view: savedView(value.observation.view), camera: savedCamera(value.observation.camera) } };
}
/** Live defaults only. A malformed live timeline starts at ambient; file imports use strict parseProject. */
export function createProject(input = {}) {
  const value = record(input) ? input : {};
  let experiment;
  try { experiment = savedExperiment(value.experiment); }
  catch (error) { if (!(error instanceof ProjectError)) throw error; experiment = createExperiment(normalizeConfig(record(value.experiment) ? value.experiment.config : undefined)); }
  let comparison = null, camera = null;
  if (value.comparison !== undefined) try { comparison = savedComparison(value.comparison); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  if (value.camera !== undefined) try { camera = savedCamera(value.camera); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  return { type: projectType, schemaVersion: projectVersion, modelVersion: MODEL_VERSION, experiment, comparison,
    playbackRate: normalizePlaybackRate(value.playbackRate), observation: { view: normalizeView(value.view), camera } };
}
function checkJsonStructure(text) {
  let depth = 0, marks = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char !== ',' && char !== ':') continue;
    // Two 256-event timelines have fewer than 5,300 structural marks.
    if (depth > 8 || ++marks > 12000) fail('실험 파일 구조가 한도를 초과했습니다.', 'PROJECT_TOO_COMPLEX');
    if (depth < 0) fail('JSON 실험 파일을 읽을 수 없습니다.', 'INVALID_JSON');
  }
}
export function parseProject(text) {
  if (typeof text !== 'string') fail('실험 파일은 JSON 텍스트여야 합니다.', 'INVALID_JSON');
  if (text.length > MAX_PROJECT_BYTES || new TextEncoder().encode(text).byteLength > MAX_PROJECT_BYTES) fail('실험 파일은 1 MiB 이하여야 합니다.', 'PROJECT_TOO_LARGE');
  checkJsonStructure(text);
  let value; try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { fail('JSON 실험 파일을 읽을 수 없습니다.', 'INVALID_JSON'); }
  return validateProject(value);
}
export function serializeProject(project) { return JSON.stringify(validateProject(project), null, 2); }
