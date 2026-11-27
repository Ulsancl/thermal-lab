import { thermalDetail, describeThermalDetail } from './detail-model.js';
import { fanSpeedPercent } from './model.js';

const format = (value, digits = 2) => typeof value === 'number'
  ? (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : String(value);
const conditionNumber = value => value > 0 && value < .01 ? value.toExponential(1) : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

const flowRows = [
  ['전원 → 발열체', 'inputW', 'input'],
  ['발열체 → 방열판', 'contactW', 'contact'],
  ['방열판 → 공기', 'airW', 'air'],
  ['발열체 저장 변화', 'heaterStorageW', 'contact'],
  ['방열판 저장 변화', 'sinkStorageW', 'sink'],
];
const flowScaleW = 24;

function thermalPhase({ totalStorageW, inputW }) {
  if (totalStorageW >= .005) return ['heating', '가열 · 열 축적'];
  if (totalStorageW <= -.005) return ['cooling', inputW === 0 ? '전원 끔 · 냉각' : '전원 켜짐 · 순냉각'];
  return ['balanced', inputW === 0 ? '전원 끔 · 방열 미미' : '입력과 방열 균형'];
}

export class ThermalDetailPanel {
  constructor(root, facts, note, onSelect) {
    this.root = root; this.facts = facts; this.note = note;
    root.innerHTML = `<div class="section-heading"><div><span class="eyebrow">HEAT BALANCE / 열의 흐름</span><h2 id="thermal-detail-title">들어온 열은 어디에 남을까요?</h2></div><span class="thermal-phase" role="status" aria-atomic="true"></span></div>
      <p class="detail-explainer thermal-context"></p>
      <div class="heat-rates" role="group" aria-label="입력·전달 열률과 저장 변화율">
        <div class="heat-rate-axis" aria-hidden="true"><span>열률 [W]</span><div class="heat-rate-ticks"><span class="heat-rate-min"></span><span>0</span><span class="heat-rate-max"></span></div></div>
        ${flowRows.map(([label, key, color]) => `<div class="heat-rate-row">
          <span>${label}</span><div class="heat-rate-track" aria-hidden="true"><i data-flow-rate="${key}" class="heat-rate-${color}"></i></div><b data-value="power.${key}"></b>
        </div>`).join('')}
      </div>
      <p class="detail-explainer heat-rate-caption">같은 W 축에서 저장 변화가 음수이면 해당 부품의 저장열이 줄어듭니다.</p>
      <p class="detail-balance" id="thermal-balance"></p><p class="detail-explainer" id="thermal-rate-note"></p>
      <div class="thermal-circuit" role="group" aria-label="저장열과 누적 전달열">
        <button type="button" class="circuit-node heater-node" data-part="heater-block"><span>발열체 저장열</span><strong data-value="energy.heaterJ"></strong></button>
        <button type="button" class="circuit-node sink-node" data-part="heat-sink"><span>방열판 저장열</span><strong data-value="energy.sinkJ"></strong></button>
        <button type="button" class="circuit-node air-node" data-part="fan-frame"><span>누적 공기 전달열</span><strong data-value="energy.releasedJ"></strong></button>
      </div>
      <details class="thermal-resistance"><summary>접촉면과 공기의 열저항 비교</summary><div class="resistance-labels"><button type="button" data-part="contact-pad">접촉 <b data-value="path.contactResistanceKPerW"></b></button><button type="button" data-part="fan-frame">공기 <b data-value="path.airResistanceKPerW"></b></button></div><div class="resistance-bar" aria-hidden="true"><i id="contact-resistance-share"></i></div><p id="resistance-explanation"></p></details>
      <details class="thermal-modes"><summary>서로 다른 두 응답 시간</summary><p>같은 전력·팬 조건을 유지하면 현재 온도와 정상온도의 차이는 각각 감쇠하는 빠른 성분과 느린 성분의 합으로 표현됩니다.</p><div class="mode-pair"><div><span>빠른 성분의 시간상수</span><strong data-value="modes.fastTauS"></strong><small>발열체 <b data-value="modes.heaterFastK"></b> · 방열판 <b data-value="modes.sinkFastK"></b></small></div><div><span>느린 성분의 시간상수</span><strong data-value="modes.slowTauS"></strong><small>발열체 <b data-value="modes.heaterSlowK"></b> · 방열판 <b data-value="modes.sinkSlowK"></b></small></div></div><p>각 시간상수 뒤에는 해당 성분이 약 36.8% 남습니다. 표시된 K는 현재 성분의 크기이며, 시간상수는 정상온도에 도달하는 시각이 아닙니다.</p></details>`;
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
