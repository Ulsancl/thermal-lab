import { thermalDetail, describeThermalDetail } from './detail-model.js';
import { fanSpeedPercent } from './model.js';

const format = (value, digits = 2) => typeof value === 'number'
  ? (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : String(value);
const conditionNumber = value => value > 0 && value < .01 ? value.toExponential(1) : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

const flowScaleW = 24;

function thermalPhase({ totalStorageW, inputW }) {
  if (totalStorageW >= .005) return ['heating', '가열 · 열 축적'];
  if (totalStorageW <= -.005) return ['cooling', inputW === 0 ? '전원 끔 · 냉각' : '전원 켜짐 · 순냉각'];
  return ['balanced', inputW === 0 ? '전원 끔 · 방열 미미' : '입력과 방열 균형'];
}

export class ThermalDetailPanel {
  constructor(root, facts, note, onSelect) {
    this.root = root; this.facts = facts; this.note = note;
    root.querySelectorAll('[data-part]').forEach(button => button.addEventListener('click', () => onSelect(button.dataset.part)));
    this.phase = root.querySelector('.thermal-phase');
    this.context = root.querySelector('.thermal-context');
    this.rateNote = root.querySelector('#thermal-rate-note');
    this.rateMin = root.querySelector('.heat-rate-min');
    this.rateMax = root.querySelector('.heat-rate-max');
    this.rateBars = [...root.querySelectorAll('[data-flow-rate]')];
    this.values = [...root.querySelectorAll('[data-value]')].map(element => {
      const [group, key] = element.dataset.value.split('.');
      const unit = key.endsWith('KPerW') ? 'K/W' : key.endsWith('W') ? 'W' : key.endsWith('J') ? 'J' : key.endsWith('TauS') ? 's' : 'K';
      return { element, group, key, unit };
    });
  }
  render(snapshot, partId, running) {
    const detail = thermalDetail(snapshot);
    this.values.forEach(({ element, group, key, unit }) => {
      const value = detail[group][key];
      element.textContent = `${format(value)} ${unit}`; element.dataset.raw = String(value);
    });
    const { power: w, path: p } = detail;
    const [phase, phaseLabel] = thermalPhase(w);
    if (this.phase.textContent !== phaseLabel) {
      this.phase.dataset.thermalPhase = phase;
      this.phase.textContent = phaseLabel;
    }
    const fan = snapshot.config.module === 'fins' ? ` · 팬 ${conditionNumber(fanSpeedPercent(snapshot.config))}%` : '';
    this.context.textContent = `주위 ${conditionNumber(detail.ambientC)} °C${fan} · 공기 열전달도 ${format(p.airConductanceWPerK, 3)} W/K`;
    const scale = Math.max(flowScaleW, ...this.rateBars.map(bar => Math.ceil(Math.abs(w[bar.dataset.flowRate]))));
    this.rateMin.textContent = `−${scale}`;
    this.rateMax.textContent = `+${scale}`;
    this.rateBars.forEach(bar => {
      const percent = w[bar.dataset.flowRate] / scale * 50;
      bar.style.left = `${50 + Math.min(percent, 0)}%`;
      bar.style.width = `${Math.abs(percent)}%`;
    });
    this.root.querySelector('#thermal-balance').textContent = `${format(w.inputW)} W 입력 − ${format(w.airW)} W 공기 전달 = ${format(w.totalStorageW)} W 전체 저장 변화율`;
    this.rateNote.hidden = running;
    if (!running) this.rateNote.textContent = snapshot.atLimit ? '기록 종료 · 표시된 열률은 종료 시각에 계산한 순간값입니다.' : '일시정지 · 표시된 열률은 현재 조건에서 재생을 재개하는 순간의 값입니다.';
    this.root.querySelector('#contact-resistance-share').style.width = `${p.contactResistanceKPerW / p.totalResistanceKPerW * 100}%`;
    this.root.querySelector('#resistance-explanation').textContent = `전체 경로 ${format(p.totalResistanceKPerW)} K/W. 같은 열률이 흐르는 정상 상태에서 접촉 온도차는 ${format(p.steadyContactDeltaK)} K, 방열판과 공기 사이는 ${format(p.steadyAirDeltaK)} K입니다. 막대는 열저항 비율이며 현재 온도나 형상 길이가 아닙니다.`;
    const description = describeThermalDetail(partId, snapshot, detail);
    this.facts.replaceChildren(...description.facts.map(fact => {
      const pair = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd');
      term.textContent = fact.label; value.textContent = `${format(fact.value, fact.digits)}${fact.unit ? ` ${fact.unit}` : ''}`; value.dataset.raw = String(fact.value);
      pair.append(term, value); return pair;
    }));
    this.note.textContent = description.note;
    return detail;
  }
}
