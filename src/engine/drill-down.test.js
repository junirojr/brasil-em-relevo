import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  easeInOutCubic,
  interpolateCameraState,
  interpolateCameraToBounds,
  normalizeBox2,
  readBoxFraming,
} from "./camera.js";
import { createEngine } from "./engine.js";
import {
  buildMunicipalities,
  buildUnits,
  flattenMeshHeights,
  interpolateInstanceHeightScale,
  interpolateMeshHeightScales,
  SAFE_MIN_SCALE_Z,
  setInstanceHeightScale,
} from "./geometry.js";

if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof globalThis.window === "undefined") {
  globalThis.window = /** @type {any} */ ({
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
  });
}

const TINY_TOPOLOGY_URL = new URL("../domain/fixtures/tiny.topo.json", import.meta.url);

async function readTinyTopology() {
  return JSON.parse(await readFile(TINY_TOPOLOGY_URL, "utf8"));
}

function createStatesTopologyFixture() {
  return {
    type: "Topology",
    transform: { scale: [1, 1], translate: [0, 0] },
    arcs: [
      [
        [0, 0],
        [100, 0],
        [0, 100],
        [-100, 0],
        [0, -100],
      ],
      [
        [100, 0],
        [100, 0],
        [0, 100],
        [-100, 0],
        [0, -100],
      ],
    ],
    objects: {
      states: {
        type: "GeometryCollection",
        geometries: [
          { type: "Polygon", arcs: [[0]], properties: { sigla: "SP", name: "Sao Paulo" } },
          { type: "Polygon", arcs: [[1]], properties: { sigla: "RJ", name: "Rio de Janeiro" } },
        ],
      },
    },
  };
}

function createMockCanvas() {
  return {
    clientWidth: 800,
    clientHeight: 600,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600 };
    },
  };
}

function createMockRenderer() {
  let isDisposed = false;
  return {
    render() {},
    setSize() {},
    setPixelRatio() {},
    setClearColor() {},
    dispose() {
      isDisposed = true;
    },
    get isDisposed() {
      return isDisposed;
    },
    shadowMap: { enabled: false, type: 0 },
    info: {
      render: { calls: 0, triangles: 0 },
      memory: { geometries: 0 },
    },
  };
}

const TEST_PALETTE = {
  background: "#ffffff",
  border: "#cccccc",
  regionBorder: "#333333",
  colors: ["#2b6cb0", "#c53030"],
  selection: "#2f4bff",
  neutral: "#999999",
};

test("DRL-01 buildUnits resolves custom collection names and property codes", () => {
  const topology = createStatesTopologyFixture();
  const geometry = buildUnits(topology, "states");

  assert.equal(geometry.municipalities.length, 2);
  assert.equal(geometry.municipalities[0].code, "SP");
  assert.equal(geometry.municipalities[1].code, "RJ");
  assert.equal(geometry.plate.instanceCount, 2);
});

test("DRL-02 replaceMesh dynamically swaps mesh without recreating or destroying renderer", async () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  assert.equal(engine.readStats().instanceCount, 2);
  assert.equal(renderer.isDisposed, false);

  let oldPlateDisposed = false;
  const originalDispose = statesGeometry.plate.dispose.bind(statesGeometry.plate);
  statesGeometry.plate.dispose = () => {
    oldPlateDisposed = true;
    originalDispose();
  };

  const municipalTopology = await readTinyTopology();
  const municipalGeometry = buildMunicipalities(municipalTopology);

  engine.replaceMesh(municipalGeometry);

  assert.equal(oldPlateDisposed, true);
  assert.equal(renderer.isDisposed, false);
  assert.equal(engine.readStats().instanceCount, 3);
  assert.equal(engine.inspect(0)?.code, "3500001");

  engine.destroy();
  assert.equal(renderer.isDisposed, true);
});

test("DRL-03 replaceMesh accepts raw Topology object directly", async () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  assert.equal(engine.readStats().instanceCount, 2);

  const tinyTopology = await readTinyTopology();
  engine.replaceMesh(tinyTopology);

  assert.equal(engine.readStats().instanceCount, 3);
  assert.equal(engine.inspect(0)?.code, "3500001");

  engine.destroy();
});

test("DRL-04 frameBounds sets camera targets to enclose active territory bounding box", () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  const territoryBox = new THREE.Box2(new THREE.Vector2(-20, -10), new THREE.Vector2(20, 10));

  engine.frameBounds(territoryBox);

  const cameraState = engine.readCamera();
  assert.ok(typeof cameraState.zoomTarget === "number");
  assert.ok(cameraState.zoomTarget >= 1);

  engine.frameBoundsNow(territoryBox);
  const immediateState = engine.readCamera();
  assert.equal(immediateState.zoomTarget, cameraState.zoomTarget);

  engine.destroy();
});

test("DRL-05 readBoxFraming handles varied bounding box representations", () => {
  const mapSize = new THREE.Vector3(200, 100, 10);

  const box2 = new THREE.Box2(new THREE.Vector2(-50, -25), new THREE.Vector2(50, 25));
  const framing2 = readBoxFraming(box2, mapSize);
  assert.ok(framing2.pan instanceof THREE.Vector3);
  assert.ok(framing2.zoom >= 1);

  const box3 = new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 5));
  const framing3 = readBoxFraming(box3, mapSize);
  assert.ok(framing3.zoom >= 1);

  const rawArray = [-20, -20, 20, 20];
  const framingArray = readBoxFraming(rawArray, mapSize);
  assert.ok(framingArray.zoom >= 1);

  const plainBox = { minX: -30, minY: -30, maxX: 30, maxY: 30 };
  const framingPlain = readBoxFraming(plainBox, mapSize);
  assert.ok(framingPlain.zoom >= 1);

  const normalized = normalizeBox2(null);
  assert.equal(normalized, null);
});

test("DRL-06 easeInOutCubic produces smooth S-curve without discontinuities", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(1), 1);

  const quarter = easeInOutCubic(0.25);
  const threeQuarters = easeInOutCubic(0.75);

  assert.ok(quarter < 0.25);
  assert.ok(threeQuarters > 0.75);

  let previous = -1;
  for (let step = 0; step <= 20; step += 1) {
    const val = easeInOutCubic(step / 20);
    assert.ok(val >= previous);
    previous = val;
  }
});

test("DRL-07 interpolateCameraToBounds smoothly interpolates pan and zoom with progress callbacks", async () => {
  const mapSize = new THREE.Vector3(200, 100, 10);
  const from = { pan: new THREE.Vector3(0, 0, 0), zoom: 1 };
  const targetBounds = new THREE.Box2(new THREE.Vector2(-20, -10), new THREE.Vector2(20, 10));

  const progressStates = [];
  let completedState = null;

  let simulatedTime = 1000;
  const simulatedGetTime = () => simulatedTime;
  const simulatedRequestFrame = (/** @type {any} */ callback) => {
    simulatedTime += 200;
    setTimeout(() => callback(simulatedTime), 1);
    return 1;
  };

  const finalState = await interpolateCameraToBounds({
    from,
    targetBounds,
    mapSize,
    durationMs: 600,
    getTime: simulatedGetTime,
    requestFrame: simulatedRequestFrame,
    onProgress: (state) => {
      progressStates.push(state);
    },
    onComplete: (state) => {
      completedState = state;
    },
  });

  assert.ok(progressStates.length > 0);
  assert.ok(completedState);
  assert.equal(finalState.progress, 1);
  assert.equal(finalState.eased, 1);
  assert.ok(finalState.zoom >= 1);
});

test("DRL-08 flattenMeshHeights and setInstanceHeightScale safely clamp scale Z to WebGL minimums", () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const plate = statesGeometry.plate;

  setInstanceHeightScale(plate, 0, 0);

  const matrix0 = new THREE.Matrix4();
  plate.getMatrixAt(0, matrix0);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix0.decompose(position, quaternion, scale);

  assert.ok(scale.z >= SAFE_MIN_SCALE_Z);
  assert.ok(!Number.isNaN(scale.z));

  flattenMeshHeights(plate, { scaleZ: 0.005, excludeInstanceIds: [1] });

  plate.getMatrixAt(0, matrix0);
  matrix0.decompose(position, quaternion, scale);
  assert.ok(Math.abs(scale.z - 0.005) < 0.0001);

  const matrix1 = new THREE.Matrix4();
  plate.getMatrixAt(1, matrix1);
  matrix1.decompose(position, quaternion, scale);
  assert.ok(scale.z >= 0.99);

  statesGeometry.plate.dispose();
});

test("DRL-09 engine.transitionCameraToBounds animates camera to target bounding box", async () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  const territoryBox = new THREE.Box2(new THREE.Vector2(-10, -5), new THREE.Vector2(10, 5));

  let simulatedTime = 500;
  const simulatedGetTime = () => simulatedTime;
  const simulatedRequestFrame = (/** @type {any} */ callback) => {
    simulatedTime += 300;
    setTimeout(() => callback(simulatedTime), 1);
    return 1;
  };

  const finalCameraState = await engine.transitionCameraToBounds(territoryBox, {
    durationMs: 600,
    getTime: simulatedGetTime,
    requestFrame: simulatedRequestFrame,
  });

  assert.ok(finalCameraState);
  assert.equal(finalCameraState.progress, 1);
  const camera = engine.readCamera();
  assert.ok(camera.zoom >= 1);

  engine.destroy();
});

test("DRL-10 engine.interpolateUnselectedHeights and interpolateInstanceHeight morph heights", async () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  engine.setRaised({ pointed: null, selected: ["SP"] });

  await engine.interpolateUnselectedHeights(0.001, { immediate: true });

  const spInspection = engine.inspect(0);
  const rjInspection = engine.inspect(1);

  assert.ok(spInspection);
  assert.ok(rjInspection);
  assert.equal(spInspection.heightTarget, 1);
  assert.ok(Math.abs(rjInspection.heightTarget - 0.001) < 0.0001);

  await engine.interpolateInstanceHeight("SP", 3.0, { immediate: true });
  const updatedSp = engine.inspect(0);
  assert.ok(updatedSp);
  assert.equal(updatedSp.heightTarget, 3.0);
  assert.equal(updatedSp.heightCurrent, 3.0);

  engine.destroy();
});

test("DRL-11 engine.replaceMesh with initialScaleZ initializes heights at flat scale", () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  const nextTopology = createStatesTopologyFixture();
  const nextGeometry = buildUnits(nextTopology, "states");
  engine.replaceMesh(nextGeometry, { immediate: true, initialScaleZ: 0.001, resetView: false });

  const sp = engine.inspect(0);
  assert.ok(sp);
  assert.ok(Math.abs(sp.heightCurrent - 0.001) < 0.0001);
  assert.ok(Math.abs(sp.heightTarget - 0.001) < 0.0001);

  engine.destroy();
});

test("DRL-12 engine.replaceMesh with initialCamera sets pan and zoom without reset jump", () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  const nextTopology = createStatesTopologyFixture();
  const nextGeometry = buildUnits(nextTopology, "states");
  engine.replaceMesh(nextGeometry, {
    immediate: true,
    initialCamera: { pan: { x: 5, y: -10, z: 0 }, zoom: 1.25 },
    resetView: false,
  });

  const cam = engine.readCamera();
  assert.equal(cam.zoom, 1.25);
  assert.equal(cam.panX, 5);
  assert.equal(cam.panY, -10);

  engine.destroy();
});

test("DRL-13 engine.frameBoundsNow synchronously positions camera zoom and pan", () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  const subBox = new THREE.Box2(new THREE.Vector2(-2, -2), new THREE.Vector2(2, 2));
  engine.frameBoundsNow(subBox);

  const cam = engine.readCamera();
  assert.ok(cam.zoom > 1);

  engine.destroy();
});

test("DRL-14 engine.transitionCameraToBounds supports fromBounds for smooth recoil flight", async () => {
  const statesTopology = createStatesTopologyFixture();
  const statesGeometry = buildUnits(statesTopology, "states");
  const renderer = createMockRenderer();
  const canvas = createMockCanvas();

  const engine = createEngine({
    canvas: /** @type {any} */ (canvas),
    renderer: /** @type {any} */ (renderer),
    geometry: statesGeometry,
    palette: TEST_PALETTE,
  });

  const ufBox = new THREE.Box2(new THREE.Vector2(-5, -5), new THREE.Vector2(5, 5));
  const fullBox = new THREE.Box2(new THREE.Vector2(-50, -50), new THREE.Vector2(50, 50));

  let simulatedTime = 1000;
  const simulatedGetTime = () => simulatedTime;
  const simulatedRequestFrame = (/** @type {any} */ callback) => {
    simulatedTime += 300;
    setTimeout(() => callback(simulatedTime), 1);
    return 1;
  };

  const finalState = await engine.transitionCameraToBounds(fullBox, {
    fromBounds: ufBox,
    durationMs: 600,
    getTime: simulatedGetTime,
    requestFrame: simulatedRequestFrame,
  });

  assert.ok(finalState);
  assert.equal(finalState.progress, 1);
  const cam = engine.readCamera();
  assert.equal(cam.zoom, 1);

  engine.destroy();
});
