import { ThermalRun } from './experiment.js';

const plotMetrics = {
  temperature: {
    label: '모의 시간에 따른 발열체와 방열판 평균온도 이력', unit: '°C',
    legends: ['발열체', '방열판'],
    read: [(point) => point.heaterC, (point) => point.sinkC],
  },
  difference: {
    label: '모의 시간에 따른 접촉면과 공기 경로의 온도차 이력', unit: 'K',
    legends: ['발열체 − 방열판', '방열판 − 주변'],
    read: [(point) => point.heaterC - point.sinkC, (point, ambientC) => point.sinkC - ambientC],
  },
};
const colors = ['#f3a16c', '#78d5e4'];
const plotTime = seconds => {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
};
const kelvins = value => `${(Math.abs(value) < .005 ? 0 : value).toFixed(2)} K`;

export class TemperatureChart {
  constructor(canvas) {
    this.canvas = canvas; this.savedKey = ''; this.saved = []; this.debug = null;
    this.fontFamily = getComputedStyle(canvas).fontFamily;
    this.metric = 'temperature';
    const panel = canvas.closest('.chart-panel');
    this.legends = panel.querySelectorAll('.heater-key, .sink-key');
    panel.querySelector('#comparison-key').textContent = '● 실선 현재 · ◇ 점선 보관';
    const metricGroup = document.createElement('div');
    metricGroup.className = 'chart-modes chart-metric';
    metricGroup.setAttribute('role', 'group');
    metricGroup.setAttribute('aria-label', '그래프 측정값');
    metricGroup.innerHTML = `<button type="button" data-plot-metric="temperature" aria-pressed="true" aria-controls="temperature-chart">평균온도 (°C)</button>
      <button type="button" data-plot-metric="difference" aria-pressed="false" aria-controls="temperature-chart">구간 온도차 (K)</button>`;
    const metricButtons = [...metricGroup.querySelectorAll('button')];
    metricButtons.forEach(button => button.addEventListener('click', () => {
      this.metric = button.dataset.plotMetric;
      metricButtons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      this.updateMetricLabels();
      if (this.lastPlot) this.draw(...this.lastPlot);
    }));
    this.endpoints = document.createElement('dl');
    this.endpoints.id = 'temperature-chart-path-values';
    this.endpoints.className = 'chart-gradient-values';
    this.endpoints.setAttribute('aria-label', '이력 끝점의 모의 시간과 구간 온도차');
    this.endpoints.innerHTML = `<div data-plot-end="current"><dt></dt><dd></dd></div>
      <div data-plot-end="saved"><dt></dt><dd></dd></div>`;
    this.endpointRows = Object.fromEntries([...this.endpoints.children].map(row => [row.dataset.plotEnd, row]));
    canvas.before(metricGroup);
    canvas.after(this.endpoints);
    this.updateMetricLabels();
  }
  updateMetricLabels() {
    const { label, legends } = plotMetrics[this.metric];
    this.canvas.setAttribute('aria-label', label);
    this.legends.forEach((element, index) => { element.textContent = legends[index]; });
    const difference = this.metric === 'difference';
    this.endpoints.hidden = !difference;
    if (difference) this.canvas.setAttribute('aria-describedby', this.endpoints.id);
    else this.canvas.removeAttribute('aria-describedby');
  }
  setGradientEndpoint(kind, sample, ambientC, show) {
    const row = this.endpointRows[kind];
    row.hidden = !show || !sample;
    if (row.hidden) return;
    const [contact, air] = plotMetrics.difference.read;
    row.querySelector('dt').textContent = `${kind === 'current' ? '현재 끝점' : '보관 끝점'} · ${plotTime(sample.timeS)}`;
    row.querySelector('dd').textContent = `접촉 ${kelvins(contact(sample))} · 공기 ${kelvins(air(sample, ambientC))}`;
  }
  draw(samples, comparison, { display = 'both', events = [] } = {}) {
    this.lastPlot = [samples, comparison, { display, events }];
    const key = JSON.stringify(comparison);
    if (key !== this.savedKey) { this.savedKey = key; this.saved = comparison ? new ThermalRun(comparison.experiment).getSamples() : []; }
    const bounds = this.canvas.getBoundingClientRect(), width = bounds.width, height = bounds.height;
    if (!width || !height) return;
    const currentEnd = samples.at(-1), savedEnd = this.saved.at(-1) ?? null;
    // Each history starts at its own constant ambient temperature.
    const currentAmbientC = samples[0]?.sinkC ?? 25;
    const savedAmbientC = this.saved[0]?.sinkC ?? currentAmbientC;
    // Expand the legacy plot window to fit either run throughout its history.
    const temperatureRange = [
      Math.floor(Math.min(25, currentAmbientC, savedAmbientC) / 5) * 5,
      Math.ceil(Math.max(110, currentAmbientC + 85, savedAmbientC + 85) / 5) * 5,
    ];
    const difference = this.metric === 'difference', metric = plotMetrics[this.metric];
    // The warmest rise across either path is the unforced plate's 12 W / .2 W/K.
    const valueRange = difference ? [0, 60] : temperatureRange;
    const [min, max] = valueRange;
    const temperatureTicks = [25, 45, 65, 85, 110].filter(value => value - min >= 10 && max - value >= 10);
    const scaleTicks = difference ? [0, 15, 30, 45, 60] : [min, ...temperatureTicks, max];
    const dpr = Math.min(devicePixelRatio || 1, 2), ctx = this.canvas.getContext('2d');
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr); ctx.scale(dpr, dpr);
    const left = 43, right = width - 14, top = 15, bottom = height - 35;
    const end = Math.max(60, currentEnd?.timeS ?? 0, savedEnd?.timeS ?? 0);
    const x = t => left + (right - left) * t / end, y = value => bottom - (bottom - top) * (value - min) / (max - min);
    ctx.font = `11px ${this.fontFamily}`; ctx.lineWidth = 1;
    for (const value of scaleTicks) {
      ctx.strokeStyle = '#30434a'; ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
      ctx.fillStyle = '#9ab0b8'; ctx.textAlign = 'right'; ctx.fillText(String(value), left - 7, y(value) + 4);
    }
    const ticks = width < 430 ? 3 : 5;
    for (let index = 0; index <= ticks; index++) {
      const seconds = end * index / ticks, value = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
      ctx.textAlign = index === 0 ? 'left' : index === ticks ? 'right' : 'center'; ctx.fillText(value, x(seconds), bottom + 18);
    }
    ctx.textAlign = 'left'; ctx.fillText(metric.unit, 6, 12); ctx.textAlign = 'right'; ctx.fillText('모의 시간 [분:초]', right, height - 2);
    const renderedCurrent = !comparison || display !== 'saved', renderedSaved = !!comparison && display !== 'current';
    const currentEvents = new Set(events.map(event => event.timeS)), savedEvents = new Set(comparison?.experiment.events.map(event => event.timeS) ?? []);
    const line = (data, read, color, dashed, eventTimes, ambientC) => {
      if (!data.length) return;
      // Keep the recorded trace intact; only coarsen drawing to the canvas width.
      const stride = Math.max(1, Math.floor(data.length / Math.max(200, width * 2)));
      ctx.beginPath(); ctx.setLineDash(dashed ? [5, 5] : []);
      data.forEach((point, i) => { if (i % stride && i !== data.length - 1 && Number.isInteger(point.timeS) && !eventTimes.has(point.timeS)) return; const px = x(point.timeS), py = y(read(point, ambientC)); if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      if (dashed) { ctx.strokeStyle = '#10232d'; ctx.lineWidth = 4.5; ctx.stroke(); }
      ctx.strokeStyle = color; ctx.lineWidth = dashed ? 1.8 : 2.3; ctx.stroke(); ctx.setLineDash([]);
      const last = data.at(-1), px = x(last.timeS), py = y(read(last, ambientC)); ctx.fillStyle = color; ctx.beginPath();
      if (dashed) { ctx.moveTo(px, py - 5); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 5); ctx.lineTo(px - 5, py); ctx.closePath(); ctx.fillStyle = '#10232d'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke(); }
      else { ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill(); }
    };
    if (renderedCurrent) metric.read.forEach((read, index) => line(samples, read, colors[index], false, currentEvents, currentAmbientC));
    if (renderedSaved) metric.read.forEach((read, index) => line(this.saved, read, colors[index], true, savedEvents, savedAmbientC));
    if (difference) {
      this.setGradientEndpoint('current', currentEnd, currentAmbientC, renderedCurrent);
      this.setGradientEndpoint('saved', savedEnd, savedAmbientC, renderedSaved);
    }
    this.debug = { timeRange: [0, end], temperatureRange, metric: this.metric, valueRange, currentCount: samples.length, savedCount: this.saved.length, currentEnd, savedEnd,
      display: comparison ? display : 'both', renderedCurrent, renderedSaved,
      endpointMarkers: { current: renderedCurrent ? 'filled-circle' : null, saved: renderedSaved ? 'hollow-diamond' : null } };
  }
}
