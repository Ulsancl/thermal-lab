import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY as G, finCenters, clampPositions, assemblyOffsets, temperatureColor } from './geometry.js';
import './scene.css';

const V = value => new THREE.Vector3(...value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const clean = value => Object.is(value, -0) ? 0 : value;
const TAU = Math.PI * 2;

export class ThermalScene {
  constructor(container, { onSelect = () => {}, onCameraChange = () => {} } = {}) {
    this.container = container; this.onSelect = onSelect; this.onCameraChange = onCameraChange;
    this.components = new Map(); this.geometries = new Set(); this.materials = new Set(); this.textures = new Set();
    this.view = structuredClone(DEFAULT_VIEW); this.updating = true; this.thermalMeshes = { heater: [], sink: [] };
    container.classList.add('thermal-scene');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.7)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', '발열 블록과 방열 모듈의 두 평균온도를 관찰하는 3D 실험대'); this.renderer.domElement.tabIndex = 0; container.append(this.renderer.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#18282e');
    this.camera = new THREE.PerspectiveCamera(35, 1, .001, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = false;
    this.controls.minDistance = .05; this.controls.maxDistance = 10; this.controls.maxPolarAngle = Math.PI;
    this.controls.zoomSpeed = .7; this.controls.panSpeed = .6;
    this.controlsChanged = () => { if (!this.updating && !this.disposed) { this.render(); this.onCameraChange(this.getCameraState()); } };
    this.controls.addEventListener('change', this.controlsChanged);
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(this.renderer); this.environment = pmrem.fromScene(room, .04); room.dispose(); pmrem.dispose();
    this.scene.environment = this.environment.texture; this.scene.environmentIntensity = .7;
    this.scene.add(new THREE.HemisphereLight('#d7ebff', '#233438', 1.5));
    const key = new THREE.DirectionalLight('#fff0d8', 3); key.position.set(-.5, .9, .7); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -.4, right: .4, top: .35, bottom: -.35, near: .05, far: 3 }); key.shadow.normalBias = .0005; this.scene.add(key);
    const rim = new THREE.DirectionalLight('#a8d6ed', 2.1); rim.position.set(.5, .5, -.7); this.scene.add(rim);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.heaterRoot = new THREE.Group(); this.padRoot = new THREE.Group(); this.sinkRoot = new THREE.Group(); this.clampsRoot = new THREE.Group(); this.root.add(this.heaterRoot, this.padRoot, this.sinkRoot, this.clampsRoot);
    this.makeMaterials(); this.buildBench(); this.buildStack(); this.buildFan(); this.buildPower(); this.buildConnections(); this.buildFlows(); this.buildOverlay();
    this.root.traverse(object => { if (!object.isMesh) return; let ancestor = object; while (ancestor && !ancestor.userData.partId) ancestor = ancestor.parent; if (ancestor) object.userData.partId = ancestor.userData.partId; });
    this.pointer = new THREE.Vector2(); this.raycaster = new THREE.Raycaster();
    this.pointerDown = event => { this.down = [event.clientX, event.clientY]; };
    this.pointerUp = event => {
      if (event.button !== 0 || !this.down || Math.hypot(event.clientX - this.down[0], event.clientY - this.down[1]) > 4) { this.down = null; return; }
      this.down = null; const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1); this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObject(this.root, true).find(item => item.object.userData.partId && !item.object.userData.nonPickable && this.actuallyVisible(item.object));
      if (hit) this.select(hit.object.userData.partId);
    };
    this.pointerCancel = () => { this.down = null; };
    for (const [type, listener] of [['pointerdown', this.pointerDown], ['pointerup', this.pointerUp], ['pointercancel', this.pointerCancel]]) this.renderer.domElement.addEventListener(type, listener);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container); this.resize(); this.updating = false; this.resetCamera();
  }
  material(values) { const m = new THREE.MeshStandardMaterial({ metalness: .7, roughness: .35, ...values }); this.materials.add(m); return m; }
  makeMaterials() {
    this.mat = { steel: this.material({ color: '#bccbd0', metalness: .92, roughness: .25 }), aluminum: this.material({ color: '#c8d6d8', metalness: .86, roughness: .32 }),
      copper: this.material({ color: '#b87e53', metalness: .84, roughness: .31 }), dark: this.material({ color: '#293e48', metalness: .72 }), base: this.material({ color: '#3e5861', metalness: .5, roughness: .55 }),
      black: this.material({ color: '#172127', metalness: .18, roughness: .56 }), rubber: this.material({ color: '#151e22', metalness: 0, roughness: .86 }), ceramic: this.material({ color: '#dbd3b7', metalness: 0, roughness: .85 }),
      orange: this.material({ color: '#f19f54', metalness: .12 }), cyan: this.material({ color: '#68d0de', metalness: .12 }), pad: this.material({ color: '#b8a5b8', metalness: .02, roughness: .82 }),
      red: this.material({ color: '#b74935', metalness: .1, roughness: .7 }), white: this.material({ color: '#d8e6e4', metalness: 0, roughness: .7 }) };
  }
  mesh(geometry, material, parent, position, thermal) {
    this.geometries.add(geometry); const own = material.clone(); this.materials.add(own); const mesh = new THREE.Mesh(geometry, own);
    mesh.castShadow = true; mesh.receiveShadow = true; if (position) mesh.position.set(...position); parent.add(mesh);
    if (thermal) { mesh.userData.thermalNode = thermal; this.thermalMeshes[thermal].push(mesh); } return mesh;
  }
  box(size, material, parent, position, radius = .0007, thermal) { return this.mesh(new RoundedBoxGeometry(...size, 2, Math.min(radius, ...size.map(n => n / 3))), material, parent, position, thermal); }
  cylinder(radius, length, material, parent, position, axis = 'y', segments = 40) {
    const mesh = this.mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material, parent, position); if (axis === 'z') mesh.rotation.x = Math.PI / 2; else if (axis === 'x') mesh.rotation.z = Math.PI / 2; return mesh;
  }
  tube(points, radius, material, parent, segments = 48) { return this.mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(V)), segments, radius, 8, false), material, parent); }
  ring(radius, wire, material, parent, position) { return this.mesh(new THREE.TorusGeometry(radius, wire, 8, 64), material, parent, position); }
  part(id, anchor, parent = this.root) { const node = new THREE.Group(); node.name = id; node.userData.partId = id; parent.add(node); this.components.set(id, { ...COMPONENTS.find(p => p.id === id), node, anchor: V(anchor) }); return node; }
  bolt(parent, position) { this.cylinder(.0026, .002, this.mat.steel, parent, position, 'y', 6); this.cylinder(.0011, .0021, this.mat.black, parent, position, 'y', 6); }
  textPlate(text, size, parent, position, rotation = [0, 0, 0]) {
    const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 128; const context = canvas.getContext('2d');
    context.fillStyle = '#192e36'; context.fillRect(0, 0, 768, 128); context.strokeStyle = '#77949f'; context.strokeRect(3, 3, 762, 122); context.fillStyle = '#dceae9'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.font = '600 38px sans-serif'; context.fillText(text, 384, 65);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture);
    const mesh = this.mesh(new THREE.PlaneGeometry(...size), this.material({ map: texture, metalness: .05, roughness: .7 }), parent, position); mesh.rotation.set(...rotation); mesh.userData.nonPickable = true; return mesh;
  }
  buildBench() {
    const node = this.part('bench-base', [-.01, .025, .117]), m = this.mat;
    this.box(G.bench.size, m.base, node, G.bench.center, .005);
    for (const x of [-.185, .185]) for (const z of [-.105, .105]) { this.cylinder(.016, .007, m.rubber, node, [x, .0025, z]); this.bolt(node, [x, .026, z]); }
    for (const x of [-.19, .19]) this.box([.007, .003, .245], m.steel, node, [x, .026, 0]);
    this.textPlate('THERMAL LAB  /  TWO-NODE BENCH', [.18, .018], node, [-.05, .014, .1401]);
    const support = this.part('insulator', [-.095, .033, .031]); this.box(G.insulator.size, m.ceramic, support, G.insulator.center, .001);
    for (let i = 0; i < 4; i++) this.box([.065, .00035, .0645], m.white, support, [-.07, .026 + i * .0026, 0], .0001);
    for (const [x, , z] of clampPositions()) this.cylinder(.004, .006, m.steel, node, [x, .027, z]);
    const ground = this.mesh(new THREE.PlaneGeometry(40, 30), this.material({ color: '#28434c', roughness: .85, metalness: .1 }), this.scene, [0, -.002, 0]); ground.rotation.x = -Math.PI / 2; ground.castShadow = false;
  }
  sinkBase(parent) {
    const { size, holeRadius, boltX, boltZ } = G.sink; const shape = new THREE.Shape(); shape.moveTo(-size[0] / 2, -size[2] / 2); shape.lineTo(size[0] / 2, -size[2] / 2); shape.lineTo(size[0] / 2, size[2] / 2); shape.lineTo(-size[0] / 2, size[2] / 2); shape.closePath();
    for (const x of [-boltX, boltX]) for (const z of [-boltZ, boltZ]) { const hole = new THREE.Path(); hole.absarc(x, z, holeRadius, 0, TAU, true); shape.holes.push(hole); }
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: size[1], bevelEnabled: false, curveSegments: 20 }); geometry.translate(0, 0, -size[1] / 2); geometry.rotateX(-Math.PI / 2);
    return this.mesh(geometry, this.mat.aluminum, parent, G.sink.center, 'sink');
  }
  buildStack() {
    const m = this.mat, heater = this.part('heater-block', [-.089, .047, .026], this.heaterRoot);
    this.box(G.heater.size, m.copper, heater, G.heater.center, .0012, 'heater');
    for (const x of [-.084, -.056]) this.cylinder(.0035, .002, m.steel, heater, [x, .043, .026], 'z');
    const pad = this.part('contact-pad', [-.093, .057, .025], this.padRoot); this.padMesh = this.box(G.pad.size, m.pad, pad, G.pad.center, .00015);
    // One module node owns both alternatives; only the selected cartridge is visible.
    const sink = this.part('heat-sink', [-.07, .076, .010], this.sinkRoot);
    this.plateGroup = new THREE.Group(); this.finsGroup = new THREE.Group(); sink.add(this.plateGroup, this.finsGroup); this.sinkBase(this.plateGroup); this.sinkBase(this.finsGroup);
    for (const center of finCenters()) this.box([G.fins.thickness, G.fins.height, G.fins.length], m.aluminum, this.finsGroup, center, .0005, 'sink'); this.finsGroup.visible = false;
    const handle = this.part('cartridge-handle', [-.071, .067, .061], this.sinkRoot);
    for (const x of [-.096, -.044]) { this.cylinder(.0027, .022, m.steel, handle, [x, .0645, .050], 'z'); this.cylinder(.004, .002, m.steel, handle, [x, .0645, .0395], 'z'); }
    this.cylinder(.0045, .052, m.black, handle, [-.070, .0645, .061], 'x');
    const screws = this.part('clamp-screws', [-.108, .073, -.029], this.clampsRoot);
    for (const [x, y, z] of clampPositions()) {
      this.cylinder(G.clamp.radius, G.clamp.topY - G.clamp.bottomY, m.steel, screws, [x, y, z]);
      this.cylinder(.005, .0015, m.steel, screws, [x, .06525, z]);
      this.cylinder(.004, .006, m.black, screws, [x, .069, z], 'y', 12);
      this.cylinder(.0015, .0006, m.steel, screws, [x, .0723, z], 'y', 6);
      for (let i = 0; i < 5; i++) { const ring = this.ring(.0021, .00023, m.dark, screws, [x, .034 + i * .005, z]); ring.rotation.x = Math.PI / 2; }
    }
    this.makeProbe('probe-heater', G.probeHeater, m.orange, this.heaterRoot);
    this.makeProbe('probe-sink', G.probeSink, m.cyan, this.sinkRoot);
  }
  makeProbe(id, shape, color, parent) {
    const [x, y, z] = shape.tip, end = shape.outlet[2], node = this.part(id, [x, y, end - .009], parent);
    this.cylinder(shape.radius, end - z, this.mat.steel, node, [x, y, (z + end) / 2], 'z');
    this.cylinder(.0027, .014, color, node, [x, y, end - .005], 'z');
    this.cylinder(.0032, .0025, this.mat.steel, node, [x, y, id === 'probe-heater' ? .027 : .040], 'z');
  }
  buildFan() {
    const { center, size, openingRadius, rotorRadius, hubRadius } = G.fan, m = this.mat;
    const frame = this.part('fan-frame', [center[0] - .033, center[1] + .033, center[2]]);
    const shape = new THREE.Shape(); shape.moveTo(-size[0] / 2, -size[1] / 2); shape.lineTo(size[0] / 2, -size[1] / 2); shape.lineTo(size[0] / 2, size[1] / 2); shape.lineTo(-size[0] / 2, size[1] / 2); shape.closePath(); const hole = new THREE.Path(); hole.absarc(0, 0, openingRadius, 0, TAU, true); shape.holes.push(hole);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: size[2], bevelEnabled: false, curveSegments: 64 }); geometry.translate(0, 0, -size[2] / 2); this.mesh(geometry, m.dark, frame, center);
    for (const x of [-.034, .034]) { this.box([.011, .037, .017], m.dark, frame, [center[0] + x, .0425, center[2]], .002); this.box([.019, .003, .037], m.steel, frame, [center[0] + x, .026, center[2]], .002); this.bolt(frame, [center[0] + x, .028, center[2] + .010]); }
    for (const x of [-.036, .036]) for (const y of [-.036, .036]) this.cylinder(.003, .002, m.steel, frame, [center[0] + x, center[1] + y, center[2] + .012], 'z', 6);
    // The stationary rear motor carrier supports the rotor shaft inside the frame.
    this.cylinder(.011, .003, m.black, frame, [center[0], center[1], center[2] - .0128], 'z');
    this.cylinder(.002, .010, m.steel, frame, [center[0], center[1], center[2] - .009], 'z');
    for (const angle of [0, Math.PI / 2]) { const strut = this.box([.080, .004, .003], m.black, frame, [center[0], center[1], center[2] - .0105]); strut.rotation.z = angle; }
    const rotor = this.part('fan-rotor', [center[0], center[1], center[2] + .004]); this.rotor = new THREE.Group(); this.rotor.position.set(...center); rotor.add(this.rotor);
    this.cylinder(hubRadius, .012, m.black, this.rotor, [0, 0, 0], 'z'); this.cylinder(.0035, .013, m.steel, this.rotor, [0, 0, 0], 'z');
    for (let i = 0; i < 7; i++) {
      const blade = new THREE.Shape(); blade.moveTo(.008, -.003); blade.bezierCurveTo(.015, -.012, .025, -.014, rotorRadius, -.003); blade.bezierCurveTo(.035, .004, .023, .009, .011, .004); blade.closePath();
      const g = new THREE.ExtrudeGeometry(blade, { depth: .002, bevelEnabled: true, bevelThickness: .0003, bevelSize: .0003, bevelSegments: 1, curveSegments: 12 }); g.translate(0, 0, -.001);
      const mesh = this.mesh(g, m.black, this.rotor); mesh.material.color.set('#536975'); mesh.rotation.z = i * TAU / 7;
    }
    const guard = this.part('fan-guard', [center[0] + .018, center[1] + .02, center[2] + .014]);
    for (const side of [-1, 1]) {
      const z = center[2] + side * .014;
      for (const radius of [.012, .020, .028, .036]) this.ring(radius, .0007, m.steel, guard, [center[0], center[1], z]);
      for (const angle of [Math.PI / 4, -Math.PI / 4]) { const bar = this.cylinder(.0008, .082, m.steel, guard, [center[0], center[1], z]); bar.rotation.z = angle; }
    }
    this.textPlate('FAN  /  ILLUSTRATIVE', [.066, .011], frame, [center[0], center[1] + .041, center[2] + .012]);
  }
  buildPower() {
    const p = G.power, m = this.mat, node = this.part('power-unit', [.143, .093, .066]);
    this.box(p.size, m.dark, node, p.center, .005); this.box([.102, .068, .002], m.black, node, [.13, .065, .065], .002);
    for (const x of [.084, .176]) for (const y of [.038, .092]) this.cylinder(.002, .0025, m.steel, node, [x, y, .067], 'z', 6);
    for (let i = 0; i < 7; i++) this.box([.001, .020, .004], m.black, node, [.1862, .063, -.025 + i * .007], .0002);
    this.displayCanvas = document.createElement('canvas'); this.displayCanvas.width = 768; this.displayCanvas.height = 320; this.displayContext = this.displayCanvas.getContext('2d');
    this.displayTexture = new THREE.CanvasTexture(this.displayCanvas); this.displayTexture.colorSpace = THREE.SRGBColorSpace; this.textures.add(this.displayTexture);
    const display = this.mesh(new THREE.PlaneGeometry(.083, .031), new THREE.MeshBasicMaterial({ map: this.displayTexture, toneMapped: false }), node, [.13, .083, .0671]); display.userData.nonPickable = true;
    this.textPlate('HEATER   H       S   SINK', [.085, .009], node, [.13, .1062, .008], [-Math.PI / 2, 0, 0]);
    const dial = this.part('power-dial', [.155, .049, .077]); this.cylinder(.011, .009, m.steel, dial, [.155, .047, .072], 'z', 48); this.cylinder(.009, .002, m.black, dial, [.155, .047, .0775], 'z');
    this.dialPointer = this.box([.0015, .0065, .001], m.white, dial, [.155, .051, .079], .0002); this.dialPointer.position.set(.155, .047, .079); this.dialPointer.geometry.translate(0, .005, 0);
    for (const value of [0, 4, 8, 12]) { const angle = (-120 + value * 20) * Math.PI / 180; const tick = this.box([.001, .003, .0005], m.white, dial, [.155 + .014 * Math.sin(angle), .047 + .014 * Math.cos(angle), .0672], .0001); tick.rotation.z = -angle; }
    this.textPlate('0   4   8   12 W', [.043, .007], dial, [.155, .031, .0673]);
    for (const [x, material] of [[.094, m.red], [.109, m.black]]) { this.cylinder(.004, .004, m.steel, node, [x, .048, .067], 'z'); this.cylinder(.0024, .0045, material, node, [x, .048, .069], 'z'); }
    for (const [x, material] of [[.094, m.orange], [.109, m.cyan]]) this.cylinder(.003, .005, material, node, [x, .035, .068], 'z');
    this.drawDisplay({ config: { powerW: 12 }, heaterC: 25, sinkC: 25 });
  }
  buildConnections() {
    this.leads = this.part('heater-leads', [-.028, .029, .095]); this.probeCables = this.part('probe-cables', [.018, .030, .117]); this.wireMeshes = [];
    this.updateWires(false);
  }
  updateWires(exploded) {
    for (const mesh of this.wireMeshes) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); this.geometries.delete(mesh.geometry); this.materials.delete(mesh.material); } this.wireMeshes = [];
    const offsets = assemblyOffsets(exploded), h = offsets.heater[1], s = offsets.sink[1];
    const add = (points, radius, material, parent) => { const mesh = this.tube(points, radius, material, parent); mesh.userData.partId = parent.userData.partId; this.wireMeshes.push(mesh); };
    for (const [index, material] of [this.mat.red, this.mat.black].entries()) {
      const x = index ? -.056 : -.084, endX = index ? .109 : .094;
      add([[x, .043 + h, .027], [x, .043 + h, .041], [x + .005, .028, .080 + index * .013], [.010, .028, .102 + index * .012], [.059, .030, .101 + index * .012], [endX, .048, .074]], .0019, material, this.leads);
    }
    add([[-.070, .104, -.122], [-.054, .092, -.123], [-.029, .061, -.125], [.014, .028, -.120], [.100, .028, -.106], [.130, .047, -.047]], .0016, this.mat.black, this.leads);
    for (const [shape, offset, endX, material] of [[G.probeHeater, h, .094, this.mat.orange], [G.probeSink, s, .109, this.mat.cyan]]) {
      const [x, y, z] = shape.outlet; add([[x, y + offset, z], [x, y + offset, z + .013], [x + .016, .033 + offset * .5, .123], [.010, .030, .125], [.056, .031, .124], [endX, .035, .074]], .00095, material, this.probeCables);
    }
  }
  drawDisplay(snapshot) {
    const value = `${snapshot.config.powerW}|${snapshot.heaterC.toFixed(1)}|${snapshot.sinkC.toFixed(1)}`; if (value === this.displayKey) return; this.displayKey = value;
    const c = this.displayContext; c.fillStyle = '#091719'; c.fillRect(0, 0, 768, 320); c.textAlign = 'left'; c.fillStyle = '#e8e4c5'; c.font = '600 73px monospace'; c.fillText(`${snapshot.config.powerW} W`, 27, 94);
    c.fillStyle = '#a8bec4'; c.font = '29px sans-serif'; c.fillText('MEAN TEMPERATURE', 264, 78); c.font = '58px monospace'; c.fillStyle = '#f7b57c'; c.fillText(`H ${snapshot.heaterC.toFixed(1)}°C`, 27, 204); c.fillStyle = '#86d8e2'; c.fillText(`S ${snapshot.sinkC.toFixed(1)}°C`, 27, 285); this.displayTexture.needsUpdate = true;
  }
  buildFlows() {
    this.flows = new THREE.Group(); this.root.add(this.flows);
    this.contactArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), V([-.009, .044, .053]), .034, '#efbe79', .007, .004);
    this.airArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), V([-.073, .073, .052]), .044, '#86d8e2', .009, .005);
    this.flows.add(this.contactArrow, this.airArrow); this.flows.traverse(object => { object.userData.nonPickable = true; });
  }
  update(snapshot, view, { animationTimeS = 0, running = false } = {}) {
    if (this.disposed) return; this.updating = true; this.snapshot = snapshot; this.view = { ...DEFAULT_VIEW, ...view };
    const offsets = assemblyOffsets(this.view.exploded);
    this.heaterRoot.position.set(...offsets.heater); this.padRoot.position.set(...offsets.pad); this.sinkRoot.position.set(...offsets.sink); this.clampsRoot.position.set(...offsets.clamps);
    if (this.lastExploded !== this.view.exploded) { this.updateWires(this.view.exploded); this.lastExploded = this.view.exploded; }
    this.plateGroup.visible = snapshot.config.module === 'plate'; this.finsGroup.visible = snapshot.config.module === 'fins';
    this.components.get('heat-sink').anchor.y = snapshot.config.module === 'plate' ? .0645 : .104;
    this.padMesh.material.color.set(snapshot.config.contact === 'poor' ? '#816b83' : '#c5b2c4');
    for (const [kind, value, metal] of [['heater', snapshot.heaterC, '#b87e53'], ['sink', snapshot.sinkC, '#c8d6d8']]) for (const mesh of this.thermalMeshes[kind]) mesh.material.color.set(this.view.temperature ? temperatureColor(value) : metal);
    if (snapshot.config.fan && running && Number.isFinite(animationTimeS)) this.rotor.rotation.z = (animationTimeS * 7) % TAU;
    this.dialPointer.rotation.z = (120 - snapshot.config.powerW * 20) * Math.PI / 180; this.drawDisplay(snapshot); this.highlight();
    const heaterY = .046 + offsets.heater[1], sinkY = .061 + offsets.sink[1], top = (snapshot.config.module === 'fins' ? .1115 : .0645) + offsets.sink[1];
    this.flows.visible = this.view.flows;
    this.contactArrow.visible = Math.abs(snapshot.contactHeatW) > 1e-6; this.contactArrow.position.set(-.014, snapshot.contactHeatW >= 0 ? heaterY : sinkY, .053); this.contactArrow.setDirection(new THREE.Vector3(0, Math.sign(snapshot.contactHeatW) || 1, 0)); this.contactArrow.setLength(Math.abs(sinkY - heaterY), .005, .003);
    this.airArrow.visible = Math.abs(snapshot.airHeatW) > 1e-6; this.airArrow.position.set(-.113, snapshot.airHeatW >= 0 ? top : top + .046, .055); this.airArrow.setDirection(new THREE.Vector3(0, Math.sign(snapshot.airHeatW) || 1, 0)); this.airArrow.setLength(.046, .008, .004);
    this.note.textContent = this.view.exploded ? '분해 관찰용 간격 · 물리 계산은 조립 상태' : '두 색은 각각 평균온도 · 부품 선택은 실험 조건을 바꾸지 않습니다';
    this.flowReadout.textContent = this.view.flows ? `접촉 전달 ${snapshot.contactHeatW.toFixed(2)} W · 공기 방출 ${snapshot.airHeatW.toFixed(2)} W` : '열 흐름 숨김'; this.flowReadout.hidden = !this.view.flows;
    this.updating = false; this.render();
  }
  highlight() { this.root.traverse(object => { if (object.isMesh && object.material?.emissive) { const selected = object.userData.partId === this.view.selectedPart; object.material.emissive.set(selected ? '#314d54' : '#000000'); object.material.emissiveIntensity = selected ? .18 : 0; } }); }
  select(id) { if (!this.components.has(id)) return; this.view.selectedPart = id; this.highlight(); this.render(); this.onSelect(id); }
  actuallyVisible(object) { for (let node = object; node; node = node.parent) if (!node.visible) return false; return true; }
  buildOverlay() {
    this.overlay = document.createElement('div'); this.overlay.className = 'thermal-overlay'; this.container.append(this.overlay);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.svg.classList.add('thermal-label-lines'); this.overlay.append(this.svg); this.labels = new Map();
    for (const part of COMPONENTS) {
      const button = document.createElement('button'); button.className = 'thermal-part-label'; button.dataset.partId = part.id; button.type = 'button'; button.textContent = part.name; button.hidden = true; button.addEventListener('click', () => this.select(part.id)); this.overlay.append(button);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'g'); this.svg.append(line); const halo = document.createElementNS('http://www.w3.org/2000/svg', 'path'); halo.classList.add('thermal-leader-halo'); line.append(halo); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.classList.add('thermal-leader'); line.append(path); const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.setAttribute('r', '3'); line.append(dot); this.labels.set(part.id, { button, line, halo, path, dot });
    }
    this.note = document.createElement('div'); this.note.className = 'thermal-scene-note'; this.overlay.append(this.note);
    this.flowReadout = document.createElement('div'); this.flowReadout.className = 'thermal-flow-readout'; this.overlay.append(this.flowReadout);
  }
  layoutLabels() {
    if (!this.width) return; this.root.updateMatrixWorld(true);
    for (const [id, label] of this.labels) { label.button.hidden = true; label.line.style.display = 'none'; label.button.classList.toggle('is-selected', id === this.view.selectedPart); }
    if (!this.view.labels || this.height < 180) return;
    const ids = [...new Set([this.view.selectedPart, ...(this.focusContext || ['heater-block', 'heat-sink', 'fan-frame', 'power-unit'])])].slice(0, this.width < 480 ? 3 : 5), points = [];
    for (const id of ids) { const part = this.components.get(id); if (!part) continue; const p = part.node.localToWorld(part.anchor.clone()).project(this.camera); if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z < -1 || p.z > 1) continue; points.push({ id, x: (p.x + 1) * this.width / 2, y: (1 - p.y) * this.height / 2 }); }
    const width = this.width < 620 ? Math.min(126, this.width * .35) : 158, height = 30, placed = [];
    for (const p of points) {
      const candidates = [];
      for (const dy of [-60, -99, 39, 78, -138, 117]) for (const dx of [0, -width * .7, width * .7, -width, width]) {
        const box = { x: clamp(p.x - width / 2 + dx, 9, this.width - width - 9), y: clamp(p.y + dy, 54, Math.max(54, this.height - 116)), w: width, h: height };
        if (placed.some(b => box.x < b.x + b.w + 7 && box.x + box.w + 7 > b.x && box.y < b.y + b.h + 7 && box.y + box.h + 7 > b.y)) continue;
        const end = { x: clamp(p.x, box.x + 6, box.x + width - 6), y: clamp(p.y, box.y, box.y + height) };
        const covered = points.filter(q => q.x > box.x - 7 && q.x < box.x + width + 7 && q.y > box.y - 7 && q.y < box.y + height + 7).length;
        candidates.push({ box, end, score: Math.hypot(end.x - p.x, end.y - p.y) + Math.abs(dx) * .16 + (dy > 0 ? 12 : 0) + covered * 10000 });
      }
      candidates.sort((a, b) => a.score - b.score); if (!candidates.length) continue; const { box, end } = candidates[0], label = this.labels.get(p.id); placed.push(box);
      let title = this.components.get(p.id).name; if (this.snapshot && p.id === 'heater-block') title += ` ${this.snapshot.heaterC.toFixed(1)} °C`; if (this.snapshot && p.id === 'heat-sink') title += ` ${this.snapshot.sinkC.toFixed(1)} °C`;
      label.button.textContent = title; label.button.title = title; label.button.hidden = false; Object.assign(label.button.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${width}px` }); const d = `M ${p.x} ${p.y} L ${end.x} ${end.y}`; label.halo.setAttribute('d', d); label.path.setAttribute('d', d); label.dot.setAttribute('cx', p.x); label.dot.setAttribute('cy', p.y); label.line.style.display = '';
    }
  }
  visiblePoints(node) {
    this.root.updateMatrixWorld(true); const result = []; node.traverseVisible(object => { if (!object.isMesh || object.userData.nonPickable) return; object.geometry.computeBoundingBox(); const b = object.geometry.boundingBox; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) result.push(new THREE.Vector3(x, y, z).applyMatrix4(object.matrixWorld)); }); return result;
  }
  fit(ids, direction, verticalMargin = .68) {
    const points = ids.flatMap(id => this.visiblePoints(this.components.get(id).node)); if (!points.length) return false;
    const target = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3()), dir = V(direction).normalize(), right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize(), up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const tanV = Math.tan(this.camera.fov * Math.PI / 360), tanH = tanV * this.camera.aspect; let distance = .05;
    for (let iteration = 0; iteration < 4; iteration++) { const relative = points.map(p => p.clone().sub(target)); distance = .05; for (const p of relative) distance = Math.max(distance, p.dot(dir) + Math.abs(p.dot(right)) / (tanH * .77), p.dot(dir) + Math.abs(p.dot(up)) / (tanV * verticalMargin)); if (iteration === 3) break;
      let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity; for (const p of relative) { const depth = Math.max(.001, distance - p.dot(dir)); const x = p.dot(right) / depth, y = p.dot(up) / depth; l = Math.min(l, x); r = Math.max(r, x); b = Math.min(b, y); t = Math.max(t, y); } target.addScaledVector(right, (l + r) * distance / 2).addScaledVector(up, (b + t) * distance / 2);
    }
    this.updating = true; this.camera.zoom = 1; this.camera.updateProjectionMatrix(); this.controls.target.copy(target); this.camera.position.copy(target.clone().addScaledVector(dir, Math.min(10, distance))); this.controls.update(); this.updating = false; this.render(); this.onCameraChange(this.getCameraState()); return true;
  }
  resetCamera(preset = 'iso') {
    this.focusContext = null; if (preset === 'contact') return this.focusPart('contact-pad');
    return this.fit(COMPONENTS.map(p => p.id), preset === 'side' ? [-1, .30, .45] : [.65, .56, 1], .78);
  }
  focusPart(id) {
    if (!this.components.has(id)) return false; let ids = [id], direction = [.5, .6, 1];
    if (['heater-block', 'contact-pad', 'insulator', 'clamp-screws'].includes(id)) { ids = ['insulator', 'heater-block', 'contact-pad', 'heat-sink', 'clamp-screws']; direction = [-1, .18, .12]; }
    else if (['heat-sink', 'cartridge-handle', 'probe-sink'].includes(id)) { ids = ['heat-sink', 'cartridge-handle', 'probe-sink']; direction = [.45, .55, 1]; }
    else if (id.startsWith('fan-')) { ids = ['fan-frame', 'fan-rotor', 'fan-guard']; direction = [-.65, .2, -1]; }
    else if (['power-unit', 'power-dial'].includes(id)) { ids = ['power-unit', 'power-dial']; direction = [.18, .12, 1]; }
    else if (id === 'probe-heater') { ids = ['heater-block', 'probe-heater']; direction = [-.35, .3, 1]; }
    else if (id === 'heater-leads') { ids = ['heater-block', 'probe-heater', 'heater-leads']; direction = [-.35, .3, 1]; }
    this.focusContext = [...new Set([id, ...ids])].slice(0, 5); return this.fit(ids, direction);
  }
  getCameraState() { return { position: this.camera.position.toArray().map(clean), target: this.controls.target.toArray().map(clean), zoom: clean(this.camera.zoom) }; }
  setCameraState(value) {
    if (!value || ![value.position, value.target].every(p => Array.isArray(p) && p.length === 3 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 100))) return false;
    const position = V(value.position), target = V(value.target), distance = position.distanceTo(target), zoom = value.zoom ?? 1; if (distance < .05 - 1e-10 || distance > 10 + 1e-10 || !Number.isFinite(zoom) || zoom < .25 || zoom > 4) return false;
    this.updating = true; this.focusContext = null; this.camera.position.copy(position); this.controls.target.copy(target); this.camera.zoom = zoom; this.camera.updateProjectionMatrix(); this.controls.update(); this.camera.position.copy(position); this.controls.target.copy(target); this.camera.lookAt(target); this.updating = false; this.render(); return true;
  }
  getComponents() { return COMPONENTS.map(part => ({ ...part })); }
  getDebug() {
    const colors = kind => [...new Set(this.thermalMeshes[kind].filter(mesh => this.actuallyVisible(mesh)).map(mesh => '#' + mesh.material.color.getHexString()))];
    return { ready: !!this.snapshot, componentCount: this.components.size, module: this.finsGroup.visible ? 'fins' : 'plate', temperatures: this.snapshot ? { heaterC: this.snapshot.heaterC, sinkC: this.snapshot.sinkC } : null,
      heatFlow: this.snapshot ? { contactHeatW: this.snapshot.contactHeatW, airHeatW: this.snapshot.airHeatW, contactArrowVisible: this.flows.visible && this.contactArrow.visible, airArrowVisible: this.flows.visible && this.airArrow.visible } : null,
      fanVisible: this.actuallyVisible(this.rotor), fanRotation: this.rotor.rotation.z, guardRotation: this.components.get('fan-guard').node.rotation.toArray().slice(0, 3),
      explodedOffsets: { heater: this.heaterRoot.position.toArray(), pad: this.padRoot.position.toArray(), sink: this.sinkRoot.position.toArray(), clamps: this.clampsRoot.position.toArray() },
      materialColors: { heater: colors('heater'), sink: colors('sink'), pad: '#' + this.padMesh.material.color.getHexString() },
      labels: [...this.labels].filter(([, l]) => !l.button.hidden).map(([id, l]) => ({ id, left: parseFloat(l.button.style.left), top: parseFloat(l.button.style.top), width: l.button.offsetWidth, height: l.button.offsetHeight, anchor: [Number(l.dot.getAttribute('cx')), Number(l.dot.getAttribute('cy'))] })),
      camera: this.getCameraState(), drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, renderFrame: this.renderer.info.render.frame };
  }
  resize() { if (this.disposed) return; this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight); this.renderer.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); this.render(); }
  render() { if (this.disposed) return; this.camera.updateMatrixWorld(); this.layoutLabels(); this.renderer.render(this.scene, this.camera); }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.resizeObserver.disconnect(); this.controls.removeEventListener('change', this.controlsChanged); this.controls.dispose();
    for (const [type, listener] of [['pointerdown', this.pointerDown], ['pointerup', this.pointerUp], ['pointercancel', this.pointerCancel]]) this.renderer.domElement.removeEventListener(type, listener);
    this.flows.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); }); for (const geometry of this.geometries) geometry.dispose(); for (const material of this.materials) material.dispose(); for (const texture of this.textures) texture.dispose(); this.environment.dispose(); this.renderer.dispose(); this.overlay.remove(); this.renderer.domElement.remove(); this.container.classList.remove('thermal-scene');
  }
}
