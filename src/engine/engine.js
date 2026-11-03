import * as THREE from "three";
import { groupOf } from "../domain/territory.js";
import {
  accumulateWheelZoom,
  clampPanVector,
  clampZoomTarget,
  computeFitDistance,
  createWheelAccumulator,
  interpolateCameraToBounds,
  normalizeBox2,
  positionCamera,
  readBoxFraming,
  readCursorZoomPan,
  readSelectionFraming,
  readSteppedZoom,
} from "./camera.js";
import { WORLD_UNITS_PER_SVG_UNIT } from "./constants.js";
import {
  buildIndexByCode,
  createMapMotion,
  placeMunicipality,
  readElapsed,
  readMedianSample,
  readRaisedIndexes,
  readRaisedUnitIndexes,
  readTopHeight,
  recordFrameSample,
  retargetLifts,
  stepCamera,
  stepHeights,
  stepLifts,
  stepTilt,
  updateLineHeights,
} from "./frame-loop.js";
import {
  buildMunicipalities,
  buildOwnedLines,
  disposeOwnedLines,
  disposePlate,
  flattenMeshHeights,
  SAFE_MIN_SCALE_Z,
  setInstanceHeightScale,
} from "./geometry.js";
import {
  applyLimitStyle,
  buildLimitGeometry,
  computeLimitArcs,
  createLimitLines,
  updateLimitHeights,
} from "./limits.js";
import { createPointTracker, pickMunicipalityIndex, readGroundPoint } from "./picking.js";
import { setupContextHandlers, setupPointerHandlers } from "./pointer.js";
import {
  applyPalette,
  countMapMeshes,
  createScene,
  paintMunicipalities,
  paintSelected,
  readInstanceToMunicipality,
} from "./scene.js";
import {
  buildSelectionGeometry,
  createSelectionOutline,
  updateSelectionOutlineHeights,
} from "./selection-outline.js";

const DEFAULT_VIEW_ANGLE_DEGREES = 55;
const MAX_PIXEL_RATIO = 2;
const PANNABLE_ZOOM = 1.01;
const HOME_ZOOM = 1.001;
const BORDER_LIFT_SHARE = 0;
const OUTLINE_LIFT_SHARE = 1;

/**
 * @typedef {import("./scene.js").EnginePalette} EnginePalette
 * @typedef {import("./geometry.js").MapMunicipality} MapMunicipality
 * @typedef {import("./frame-loop.js").MapMotion} MapMotion
 * @typedef {import("./frame-loop.js").RaiseState} RaiseState
 * @typedef {import("./camera.js").CameraOrbit} CameraOrbit
 * @typedef {import("./picking.js").PickTarget} PickTarget
 * @typedef {import("./picking.js").PointTracker} PointTracker
 * @typedef {ReturnType<typeof createScene>} MapView
 */

/**
 * @typedef {{
 *   canvas: HTMLCanvasElement;
 *   renderer?: THREE.WebGLRenderer;
 *   geometry: {
 *     municipalities: MapMunicipality[];
 *     plate: THREE.BatchedMesh;
 *     mapCenter: THREE.Vector2;
 *     topology?: any;
 *   };
 *   palette: EnginePalette;
 *   mode?: "indicator" | "election";
 *   onPick?: (code: string | null) => void;
 *   onPoint?: (code: string | null) => void;
 *   onInspect?: (code: string | null) => void;
 *   onZoomChange?: (zoomTarget: number) => void;
 * }} EngineOptions
 */

/**
 * Unit codes: the pointed one, or null, and the selected ones. Same shape the projection sends.
 * @typedef {{ pointed: string | readonly string[] | null; selected: readonly string[] }} RaisedUnits
 */

/**
 * @typedef {{
 *   viewAngleDegrees?: number;
 *   isTiltOn?: boolean;
 *   isFramingOn?: boolean;
 *   isMotionReduced?: boolean;
 * }} CameraOptions
 */

/**
 * @typedef {{
 *   frameCount: number;
 *   isSettled: boolean;
 *   renderTimes: number[];
 *   lastRenderDuration: number;
 *   medianRenderDuration: number;
 *   drawCalls: number;
 *   triangles: number;
 *   meshCount: number;
 *   instanceCount: number;
 * }} EngineStats
 */

/**
 * @typedef {{ minX: number; minY: number; maxX: number; maxY: number }} PlainBox
 */

/**
 * @typedef {{
 *   code: string;
 *   color?: string;
 *   heightCurrent: number;
 *   heightTarget: number;
 *   liftCurrent: number;
 *   liftTarget: number;
 * }} MunicipalityInspection
 */

/**
 * What the map has built, to tell a repaint from a rebuild (ESC-12). A rebuilt geometry takes a new
 * id even when both counts stay the same.
 * @typedef {{
 *   geometryCount: number;
 *   vertexCount: number;
 *   geometryIds: number[];
 * }} GeometryStats
 */

/**
 * The top of one block and the lowest and highest border vertex it owns, in plate units.
 * @typedef {{ blockTop: number; lowestBorder: number; highestBorder: number }} BorderTop
 */

/**
 * @typedef {{
 *   setHeightTargets: (targets: Float32Array) => void;
 *   setColors: (colorPositions: Uint8Array) => void;
 *   setRaised: (raised: RaisedUnits) => void;
 *   setLiftEnabled: (flags: { pointed: boolean; selected: boolean }) => void;
 *   setLimits: (limits: { level: string; limitArcs?: readonly number[]; topology?: any }) => void;
 *   setRenderOptions: (options: { shadow?: boolean; borders?: boolean }) => void;
 *   setPalette: (palette: EnginePalette) => void;
 *   readPalette: () => EnginePalette;
 *   setCameraOptions: (options: CameraOptions) => void;
 *   setTiltTarget: (x: number, y: number) => void;
 *   setMode?: (mode: "indicator" | "election") => void;
 *   readMode?: () => "indicator" | "election";
 *   readSelectionOutline: () => any;
 *   frame: (indexes: number[]) => void;
 *   frameNow: (indexes: number[]) => void;
 *   frameBounds: (bounds: any, options?: { immediate?: boolean; isWorldUnits?: boolean; durationMs?: number }) => any;
 *   frameBoundsNow: (bounds: any, options?: { isWorldUnits?: boolean }) => void;
 *   transitionCameraToBounds: (bounds: any, options?: any) => Promise<any>;
 *   flattenHeights: (options?: any) => Promise<void>;
 *   interpolateHeights: (targets: any, options?: any) => Promise<void>;
 *   interpolateInstanceHeight: (indexOrCode: number | string, targetScaleZ: number, options?: any) => Promise<void>;
 *   interpolateUnselectedHeights: (targetScaleZ?: number, options?: any) => Promise<void>;
 *   replaceMesh: (geometry: any, options?: { collectionName?: string; bounds?: any; frame?: boolean; immediate?: boolean; resetView?: boolean; isWorldUnits?: boolean }) => void;
 *   setGeometry: (geometry: any, options?: { collectionName?: string; bounds?: any; frame?: boolean; immediate?: boolean; resetView?: boolean; isWorldUnits?: boolean }) => void;
 *   zoomStep: (direction: number, screenPoint?: { x: number; y: number }) => void;
 *   resetView: () => void;
 *   readCamera: () => {
 *     viewAngleDegrees: number;
 *     aspect: number;
 *     zoom: number;
 *     zoomTarget: number;
 *     panX: number;
 *     panY: number;
 *     pan: { x: number; y: number; z: number };
 *   };
 *   readStats: () => EngineStats;
 *   readGeometryStats: () => GeometryStats;
 *   readBorderTop: (index: number) => BorderTop | null;
 *   readLimitBounds: () => { limits: PlainBox | null; map: PlainBox | null };
 *   inspect: (index: number) => MunicipalityInspection | null;
 *   readGroundPointAt: (x: number, y: number) => THREE.Vector3 | null;
 *   projectGroundPoint: (point: THREE.Vector3) => { x: number; y: number };
 *   destroy: () => void;
 * }} Engine
 */

/**
 * @typedef {{
 *   isRequested: boolean;
 *   count: number;
 *   samples: number[];
 *   lastTime: number | undefined;
 *   draw: FrameRequestCallback;
 * }} FrameState
 */

/**
 * @typedef {{
 *   canvas: HTMLCanvasElement;
 *   renderer: THREE.WebGLRenderer;
 *   view: MapView;
 *   municipalities: MapMunicipality[];
 *   indexByCode: Map<string, number>;
 *   motion: MapMotion;
 *   raise: RaiseState;
 *   orbit: CameraOrbit;
 *   tiltTarget: THREE.Vector2;
 *   panTarget: THREE.Vector3;
 *   zoomState: { current: number; target: number };
 *   isTiltOn: boolean;
 *   isFramingOn: boolean;
 *   limitLines: import("./limits.js").LimitLines;
 *   selectionOutline: import("./selection-outline.js").SelectionOutline;
 *   mode: "indicator" | "election";
 *   limitGeometriesByLevel: Map<string, THREE.BufferGeometry>;
 *   topology?: any;
 *   mapCenter: THREE.Vector2;
 *   wheelAccumulator: { pixels: number };
 *   palette: EnginePalette;
 *   colorPositions: Uint8Array;
 *   pointerNdc: THREE.Vector2;
 *   pickTarget: PickTarget;
 *   pointTracker: PointTracker;
 *   frame: FrameState;
 *   onPick: (code: string | null) => void;
 *   onPoint: (code: string | null) => void;
 *   onInspect: (code: string | null) => void;
 *   onZoomChange?: (zoomTarget: number) => void;
 * }} EngineContext
 */

/**
 * Draws the map and owns everything that moves: heights, lifts, tilt, zoom, pan and pointer. It
 * draws only while something changes. `onPoint` hears a change of the pointed municipality, at most
 * once per frame; `onPick` hears a click that did not pan. `frame` follows the framing option, while
 * `frameNow` frames on request whatever the option says.
 * @param {EngineOptions} options
 * @returns {Engine}
 */
export function createEngine(options) {
  const ctx = createContext(options);
  const handleResize = () => resizeView(ctx);
  const detachPointer = wirePointer(ctx);
  const detachContext = wireContext(ctx);

  ctx.orbit.distance = computeFitDistance(
    ctx.view.camera,
    ctx.view.mapSize,
    DEFAULT_VIEW_ANGLE_DEGREES,
  );
  positionCamera(ctx.view.camera, ctx.orbit);
  updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
  ctx.selectionOutline.setResolution(ctx.canvas.clientWidth || 1, ctx.canvas.clientHeight || 1);
  setPalette(ctx, options.palette);
  window.addEventListener("resize", handleResize);
  resizeView(ctx);

  return {
    setHeightTargets: (targets) => setHeightTargets(ctx, targets),
    setColors: (colorPositions) => setColors(ctx, colorPositions),
    setRaised: (raised) => setRaised(ctx, raised),
    setLiftEnabled: (flags) => setLiftEnabled(ctx, flags),
    setLimits: (limits) => setLimits(ctx, limits),
    setRenderOptions: (renderOptions) => setRenderOptions(ctx, renderOptions),
    setPalette: (palette) => setPalette(ctx, palette),
    readPalette: () => ({ ...ctx.palette }),
    setCameraOptions: (cameraOptions) => setCameraOptions(ctx, cameraOptions),
    setMode: (mode) => setMode(ctx, mode),
    readMode: () => readActiveMode(ctx),
    readSelectionOutline: () => ({
      visible: ctx.selectionOutline.visible,
      outerWidth: ctx.selectionOutline.outerMaterial.linewidth,
      innerWidth: ctx.selectionOutline.innerMaterial.linewidth,
      outerColor: `#${ctx.selectionOutline.outerMaterial.color.getHexString()}`,
      innerColor: `#${ctx.selectionOutline.innerMaterial.color.getHexString()}`,
    }),
    frame: (indexes) => frameSelection(ctx, indexes),
    frameNow: (indexes) => frameIndexes(ctx, indexes),
    frameBounds: (bounds, options) => frameBounds(ctx, bounds, options),
    frameBoundsNow: (bounds, options) => frameBounds(ctx, bounds, { ...options, immediate: true }),
    transitionCameraToBounds: (bounds, options) => transitionCameraToBounds(ctx, bounds, options),
    flattenHeights: (options) => flattenHeights(ctx, options),
    interpolateHeights: (targets, options) => interpolateHeights(ctx, targets, options),
    interpolateInstanceHeight: (indexOrCode, targetScaleZ, options) =>
      interpolateInstanceHeight(ctx, indexOrCode, targetScaleZ, options),
    interpolateUnselectedHeights: (targetScaleZ, options) =>
      interpolateUnselectedHeights(ctx, targetScaleZ, options),
    replaceMesh: (geometry, options) => replaceMesh(ctx, geometry, options),
    setGeometry: (geometry, options) => replaceMesh(ctx, geometry, options),
    setTiltTarget: (/** @type {number} */ x, /** @type {number} */ y) => {
      ctx.tiltTarget.set(x, y);
      requestFrame(ctx);
    },
    zoomStep: (direction, screenPoint) => zoomStep(ctx, direction, screenPoint),
    resetView: () => resetView(ctx),
    readCamera: () => readCamera(ctx),
    readStats: () => readStats(ctx),
    readGeometryStats: () => readGeometryStats(ctx),
    readBorderTop: (index) => readBorderTop(ctx, index),
    readLimitBounds: () => readLimitBounds(ctx),
    inspect: (index) => inspect(ctx, index),
    readGroundPointAt: (x, y) => readGroundPointAt(ctx, x, y),
    projectGroundPoint: (point) => projectGroundPoint(ctx, point),
    destroy() {
      window.removeEventListener("resize", handleResize);
      detachPointer();
      detachContext();
      disposeEngine(ctx);
    },
  };
}

/**
 * @param {EngineOptions} options
 * @returns {EngineContext}
 */
function createContext({
  canvas,
  geometry,
  palette,
  mode,
  onPick,
  onPoint,
  onInspect,
  onZoomChange,
  renderer,
}) {
  const { municipalities, plate } = geometry;
  const view = createScene({ plate, municipalities });
  const motion = createMapMotion(plate, municipalities);
  const limitLines = createLimitLines();
  view.mapGroup.add(limitLines);
  const selectionOutline = createSelectionOutline();
  selectionOutline.group.scale.set(
    WORLD_UNITS_PER_SVG_UNIT,
    -WORLD_UNITS_PER_SVG_UNIT,
    WORLD_UNITS_PER_SVG_UNIT,
  );
  view.scene.add(selectionOutline.group);

  /** @type {EngineContext} */
  const ctx = {
    canvas,
    renderer: renderer || createRenderer(canvas),
    view,
    limitLines,
    selectionOutline,
    mode: mode || "indicator",
    limitGeometriesByLevel: new Map(),
    topology: geometry.topology,
    // Required: the limits are centered like the outlines, and a missing center shifted them off
    // the state by exactly the map center.
    mapCenter: geometry.mapCenter,
    wheelAccumulator: createWheelAccumulator(),
    municipalities,
    indexByCode: buildIndexByCode(municipalities),
    motion,
    raise: {
      pointed: null,
      selected: new Set(),
      isLiftEnabled: { pointed: true, selected: false },
    },
    orbit: createRestingOrbit(),
    tiltTarget: new THREE.Vector2(),
    panTarget: new THREE.Vector3(),
    zoomState: { current: 1, target: 1 },
    isTiltOn: true,
    isFramingOn: true,
    palette,
    colorPositions: new Uint8Array(0),
    pointerNdc: new THREE.Vector2(),
    pickTarget: buildPickTarget(view, motion, municipalities),
    pointTracker: createPointTracker({
      pickIndex: () => pickAtPointer(ctx),
      onChange: (index) => ctx.onPoint(readCode(ctx, index)),
    }),
    frame: createFrameState((now) => drawFrame(ctx, now)),
    onPick: onPick ?? ignoreCode,
    onPoint: onPoint ?? ignoreCode,
    onInspect: onInspect ?? ignoreCode,
    onZoomChange: onZoomChange ?? undefined,
  };
  return ctx;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {THREE.WebGLRenderer}
 */
function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

/**
 * @returns {CameraOrbit}
 */
function createRestingOrbit() {
  return {
    distance: 0,
    tilt: new THREE.Vector2(),
    pan: new THREE.Vector3(),
    viewAngleDegrees: DEFAULT_VIEW_ANGLE_DEGREES,
  };
}

/**
 * @param {MapView} view
 * @param {MapMotion} motion
 * @param {MapMunicipality[]} municipalities
 * @returns {PickTarget}
 */
function buildPickTarget(view, motion, municipalities) {
  return {
    camera: view.camera,
    raycaster: new THREE.Raycaster(),
    plate: view.plate,
    mapGroup: view.mapGroup,
    municipalities,
    instanceToMunicipality: view.instanceToMunicipality,
    heightCurrent: motion.heightCurrent,
    liftCurrent: motion.liftCurrent,
  };
}

/**
 * @param {FrameRequestCallback} draw
 * @returns {FrameState}
 */
function createFrameState(draw) {
  return { isRequested: false, count: 0, samples: [], lastTime: undefined, draw };
}

/**
 * @param {string | null} _code
 */
function ignoreCode(_code) {
  // No listener was given.
}

/**
 * @param {EngineContext} ctx
 * @param {{ level: string; limitArcs?: readonly number[]; topology?: any }} limits
 */
function setLimits(ctx, limits) {
  if (limits.topology && !ctx.topology) {
    ctx.topology = limits.topology;
    if (ctx.selectionOutline.visible) {
      rebuildSelectionOutline(ctx);
    }
  }
  const level = limits.level;
  const topology = limits.topology || ctx.topology;

  if (limits.limitArcs) {
    if (topology) {
      const geometry = buildLimitGeometry({
        topology,
        limitArcs: limits.limitArcs,
        indexByCode: ctx.indexByCode,
        mapCenter: ctx.mapCenter,
      });
      ctx.limitGeometriesByLevel.set(level, geometry);
      ctx.limitLines.geometry = geometry;
      updateLimitHeights(ctx.limitLines, ctx.motion.heightCurrent);
    }
  }

  const isGroupLevel =
    level === "region" || level === "governmentRegion" || level === "administrativeRegion";
  if (!limits.limitArcs && isGroupLevel) {
    let cached = ctx.limitGeometriesByLevel.get(level);
    if (!cached && topology) {
      const arcs = computeLimitArcs(topology, level, groupOf);
      cached = buildLimitGeometry({
        topology,
        limitArcs: arcs,
        indexByCode: ctx.indexByCode,
        mapCenter: ctx.mapCenter,
      });
      ctx.limitGeometriesByLevel.set(level, cached);
    }
    if (cached) {
      ctx.limitLines.geometry = cached;
      updateLimitHeights(ctx.limitLines, ctx.motion.heightCurrent);
    }
  }

  applyLimitStyle({ borders: ctx.view.borders, limitLines: ctx.limitLines }, level);
  if (ctx.limitLines.visible) {
    updateLimitHeights(ctx.limitLines, ctx.motion.heightCurrent);
  }
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @returns {() => void}
 */
function wirePointer(ctx) {
  return setupPointerHandlers({
    canvas: ctx.canvas,
    onPointerMove: (ndc) => markPointerMoved(ctx, ndc),
    onPointerLeave: () => leaveMap(ctx),
    onClick: (ndc) => pickOnClick(ctx, ndc),
    onInspect: (ndc) => pickOnInspect(ctx, ndc),
    onPanStart: () => ctx.pointTracker.clearPointed(),
    onPan: (delta) => panBy(ctx, delta),
    onWheel: (wheel) => handleWheel(ctx, wheel),
    readGroundPoint: (ndc) => readGroundPoint(ndc, ctx.pickTarget, new THREE.Vector3()),
    isPannable: () => ctx.zoomState.target > PANNABLE_ZOOM,
    isTiltOn: () => ctx.isTiltOn && !ctx.motion.isMotionReduced,
    setTiltTarget: (x, y) => ctx.tiltTarget.set(x, y),
  });
}

/**
 * @param {EngineContext} ctx
 * @returns {() => void}
 */
function wireContext(ctx) {
  return setupContextHandlers({
    canvas: ctx.canvas,
    onLost: () => handleContextLost(ctx),
    onRestored: () => handleContextRestored(ctx),
  });
}

/**
 * @param {EngineContext} ctx
 */
function handleContextLost(ctx) {
  ctx.frame.isRequested = false;
}

/**
 * @param {EngineContext} ctx
 */
function handleContextRestored(ctx) {
  paintCurrentColors(ctx);
  updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
  if (ctx.limitLines.visible) {
    updateLimitHeights(ctx.limitLines, ctx.motion.heightCurrent);
  }
  if (ctx.selectionOutline.visible) {
    updateSelectionOutlineHeights(ctx.selectionOutline, ctx.motion.heightCurrent);
  }
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @param {{ deltaPixels: number; x: number; y: number }} wheel
 */
function handleWheel(ctx, wheel) {
  const direction = accumulateWheelZoom(ctx.wheelAccumulator, wheel.deltaPixels);
  if (direction === 0) {
    return;
  }
  zoomStep(ctx, direction, { x: wheel.x, y: wheel.y });
}

/**
 * A move only marks the pick; the frame picks once, however many moves arrived.
 * @param {EngineContext} ctx
 * @param {THREE.Vector2} ndc
 */
function markPointerMoved(ctx, ndc) {
  ctx.pointerNdc.copy(ndc);
  ctx.pointTracker.markPickPending();
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 */
function leaveMap(ctx) {
  ctx.pointTracker.clearPointed();
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @param {THREE.Vector2} ndc
 */
function pickOnClick(ctx, ndc) {
  ctx.pointerNdc.copy(ndc);
  ctx.onPick(readCode(ctx, pickAtPointer(ctx)));
}

/**
 * @param {EngineContext} ctx
 * @param {THREE.Vector2} ndc
 */
function pickOnInspect(ctx, ndc) {
  ctx.pointerNdc.copy(ndc);
  ctx.onInspect(readCode(ctx, pickAtPointer(ctx)));
}

/**
 * The camera moves at once, so the next pointer move reads the ground with the camera that
 * already holds this pan, however many moves arrive in one frame.
 * @param {EngineContext} ctx
 * @param {THREE.Vector3} delta
 */
function panBy(ctx, delta) {
  ctx.orbit.pan.add(delta);
  clampPanVector(ctx.orbit.pan, ctx.view.mapSize);
  ctx.panTarget.copy(ctx.orbit.pan);
  positionCamera(ctx.view.camera, ctx.orbit);
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @returns {number | undefined}
 */
function pickAtPointer(ctx) {
  const pointedCandidates = readPointedCandidates(ctx.raise);
  const candidates = [
    ctx.pointTracker.readPointedIndex(),
    ...pointedCandidates,
    ...ctx.raise.selected,
  ];
  return pickMunicipalityIndex(ctx.pointerNdc, ctx.pickTarget, candidates);
}

/**
 * @param {RaiseState} raise
 * @returns {number[]}
 */
function readPointedCandidates(raise) {
  if (raise.pointedIndexes instanceof Set) {
    return [...raise.pointedIndexes];
  }
  if (raise.pointed instanceof Set) {
    return [...raise.pointed];
  }
  if (raise.pointed !== null && raise.pointed !== undefined) {
    return [raise.pointed];
  }
  return [];
}

/**
 * @param {EngineContext} ctx
 * @param {number | null | undefined} index
 * @returns {string | null}
 */
function readCode(ctx, index) {
  if (index === null || index === undefined) {
    return null;
  }
  return ctx.municipalities[index].code;
}

/**
 * Nothing is drawn while nothing changes: a still map costs no CPU and no GPU.
 * @param {EngineContext} ctx
 */
function requestFrame(ctx) {
  if (ctx.frame.isRequested) {
    return;
  }
  ctx.frame.isRequested = true;
  requestAnimationFrame(ctx.frame.draw);
}

/**
 * @param {EngineContext} ctx
 * @param {number} now
 */
function drawFrame(ctx, now) {
  ctx.frame.isRequested = false;
  const elapsed = readElapsed(ctx.frame.lastTime, now);
  ctx.frame.lastTime = now;

  ctx.pointTracker.flushPendingPick();
  const isMoving = stepFrame(ctx, elapsed);
  renderFrame(ctx);

  if (isMoving) {
    requestFrame(ctx);
  }
}

/**
 * @param {EngineContext} ctx
 * @param {number} elapsed
 * @returns {boolean}
 */
function stepFrame(ctx, elapsed) {
  const { motion, view, orbit } = ctx;
  const isMotionReduced = motion.isMotionReduced;
  const isHeightMoving = stepMapHeights(ctx);
  const isLiftMoving = stepLifts(motion, elapsed);
  const isTiltMoving = stepTilt({ tilt: orbit.tilt, tiltTarget: ctx.tiltTarget, isMotionReduced });
  const isCameraMoving = stepCamera({
    camera: view.camera,
    zoomState: ctx.zoomState,
    pan: orbit.pan,
    panTarget: ctx.panTarget,
    isMotionReduced,
  });
  updateLineHeights(view.raisedOutline, motion, OUTLINE_LIFT_SHARE);
  positionCamera(view.camera, orbit);

  return isHeightMoving || isLiftMoving || isTiltMoving || isCameraMoving;
}

/**
 * @param {EngineContext} ctx
 * @returns {boolean}
 */
function stepMapHeights(ctx) {
  if (!ctx.motion.isHeightMoving) {
    return false;
  }

  const isStillMoving = stepHeights(ctx.motion);
  updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
  if (ctx.limitLines.visible) {
    updateLimitHeights(ctx.limitLines, ctx.motion.heightCurrent);
  }
  if (ctx.selectionOutline.visible) {
    updateSelectionOutlineHeights(ctx.selectionOutline, ctx.motion.heightCurrent);
  }
  return isStillMoving;
}

/**
 * @param {EngineContext} ctx
 */
function renderFrame(ctx) {
  const renderStart = performance.now();
  ctx.renderer.render(ctx.view.scene, ctx.view.camera);
  recordFrameSample(ctx.frame.samples, performance.now() - renderStart);
  ctx.frame.count += 1;
}

/**
 * @param {EngineContext} ctx
 */
function resizeView(ctx) {
  const { clientWidth, clientHeight } = ctx.canvas;
  if (!clientWidth || !clientHeight) {
    return;
  }

  const { camera, mapSize } = ctx.view;
  ctx.renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
  ctx.orbit.distance = computeFitDistance(camera, mapSize, ctx.orbit.viewAngleDegrees);
  ctx.selectionOutline.setResolution(clientWidth, clientHeight);
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @param {Float32Array} targets one height scale per municipality
 */
function setHeightTargets(ctx, targets) {
  ctx.motion.heightTargets.set(targets);
  ctx.motion.isHeightMoving = true;
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @param {Uint8Array} colorPositions one palette position per municipality
 */
function setColors(ctx, colorPositions) {
  ctx.colorPositions = Uint8Array.from(colorPositions);
  paintCurrentColors(ctx);
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 */
function paintCurrentColors(ctx) {
  const target = { plate: ctx.view.plate, municipalities: ctx.municipalities };
  paintMunicipalities(target, ctx.colorPositions, ctx.palette.colors, ctx.palette.neutral);
  if (!ctx.palette.selection) {
    return;
  }
  const isElection = readActiveMode(ctx) === "election";
  if (isElection) {
    return;
  }
  paintSelected(target, ctx.raise.selected, ctx.palette.selection);
}

/**
 * @param {EngineContext} ctx
 * @param {RaisedUnits} raised
 */
function setRaised(ctx, raised) {
  const { pointed, pointedIndexes, selected } = readRaisedUnitIndexes(ctx.indexByCode, raised);
  ctx.raise.pointed = pointed;
  ctx.raise.pointedIndexes = pointedIndexes;
  const isSelectionChanged = !isSameIndexSet(ctx.raise.selected, selected);
  ctx.raise.selected = selected;
  if (isSelectionChanged) {
    paintCurrentColors(ctx);
    rebuildSelectionOutline(ctx);
  }
  refreshRaise(ctx);
}

/**
 * @param {Set<number>} current
 * @param {Set<number>} next
 * @returns {boolean}
 */
function isSameIndexSet(current, next) {
  if (current.size !== next.size) {
    return false;
  }
  for (const index of next) {
    if (!current.has(index)) {
      return false;
    }
  }
  return true;
}

/**
 * With height as data, only the pointed municipality lifts (P24).
 * @param {EngineContext} ctx
 * @param {{ pointed: boolean; selected: boolean }} flags
 */
function setLiftEnabled(ctx, { pointed, selected }) {
  ctx.raise.isLiftEnabled = { pointed, selected };
  refreshRaise(ctx);
}

/**
 * @param {EngineContext} ctx
 */
function refreshRaise(ctx) {
  const isElection = readActiveMode(ctx) === "election";
  if (isElection) {
    const electionRaise = {
      ...ctx.raise,
      isLiftEnabled: { pointed: false, selected: false },
    };
    retargetLifts(ctx.motion, electionRaise);
  }
  if (!isElection) {
    retargetLifts(ctx.motion, ctx.raise);
  }
  rebuildRaisedOutline(ctx);
  rebuildSelectionOutline(ctx);
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 */
function rebuildRaisedOutline(ctx) {
  const { raisedOutline } = ctx.view;
  const isElection = readActiveMode(ctx) === "election";
  /** @type {number[]} */
  let raisedIndexes = [];
  if (isElection) {
    if (ctx.raise.pointedIndexes instanceof Set) {
      raisedIndexes = [...ctx.raise.pointedIndexes];
    }
    if (
      raisedIndexes.length === 0 &&
      ctx.raise.pointed !== null &&
      ctx.raise.pointed !== undefined
    ) {
      if (typeof ctx.raise.pointed === "number") {
        raisedIndexes = [ctx.raise.pointed];
      }
    }
  }
  if (!isElection) {
    raisedIndexes = readRaisedIndexes(ctx.raise);
  }
  raisedOutline.geometry.dispose();
  raisedOutline.geometry = buildOwnedLines(ctx.municipalities, raisedIndexes);
  raisedOutline.visible = raisedIndexes.length > 0;
  updateLineHeights(raisedOutline, ctx.motion, OUTLINE_LIFT_SHARE);
}

/**
 * Rebuilds the strong perimeter outline for selected municipalities in election mode (ELE-12, ELE-14).
 * @param {EngineContext} ctx
 */
function rebuildSelectionOutline(ctx) {
  const isElection = readActiveMode(ctx) === "election";
  if (!isElection) {
    ctx.selectionOutline.setVisible(false);
    return;
  }
  if (ctx.raise.selected.size === 0) {
    ctx.selectionOutline.setVisible(false);
    return;
  }

  const selectedCodes = [];
  for (const index of ctx.raise.selected) {
    selectedCodes.push(ctx.municipalities[index].code);
  }

  const geometry = buildSelectionGeometry({
    topology: ctx.topology,
    selectedCodes,
    municipalities: ctx.municipalities,
    indexByCode: ctx.indexByCode,
    mapCenter: ctx.mapCenter,
  });

  if (!geometry) {
    ctx.selectionOutline.setVisible(false);
    return;
  }

  ctx.selectionOutline.updateGeometry(geometry);
  updateSelectionOutlineHeights(ctx.selectionOutline, ctx.motion.heightCurrent);
  ctx.selectionOutline.setVisible(true);
}

/**
 * Reads the active mode from context or the document element dataset (ELE-12, ELE-16).
 * @param {EngineContext} ctx
 * @returns {"indicator" | "election"}
 */
function readActiveMode(ctx) {
  if (ctx.mode === "election") {
    return "election";
  }
  if (typeof document !== "undefined" && document.documentElement?.dataset?.mode === "election") {
    return "election";
  }
  return "indicator";
}

/**
 * Sets the active mode and repaints colors and outlines (ELE-12, ELE-15).
 * @param {EngineContext} ctx
 * @param {"indicator" | "election"} mode
 */
function setMode(ctx, mode) {
  if (ctx.mode === mode) {
    return;
  }
  ctx.mode = mode;
  paintCurrentColors(ctx);
  refreshRaise(ctx);
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @param {{ shadow?: boolean; borders?: boolean }} renderOptions
 */
function setRenderOptions(ctx, { shadow, borders }) {
  if (shadow !== undefined) {
    ctx.view.sun.castShadow = shadow;
    ctx.view.ground.visible = shadow;
  }
  if (borders !== undefined) {
    ctx.view.borders.visible = borders;
  }
  requestFrame(ctx);
}

/**
 * Applies the background, the borders and the raised outline, and repaints with the last color
 * positions. The region border color is applied to limitLines when defined.
 * @param {EngineContext} ctx
 * @param {EnginePalette} palette
 */
function setPalette(ctx, palette) {
  ctx.palette = palette;
  const { borders, raisedOutline } = ctx.view;
  applyPalette({ renderer: ctx.renderer, borders, raisedOutline }, palette);
  if (palette.regionBorder) {
    ctx.limitLines.material.color.set(palette.regionBorder);
    ctx.limitLines.material.needsUpdate = true;
  }
  paintCurrentColors(ctx);
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @param {CameraOptions} cameraOptions
 */
function setCameraOptions(ctx, { viewAngleDegrees, isTiltOn, isFramingOn, isMotionReduced }) {
  if (viewAngleDegrees !== undefined) {
    setViewAngle(ctx, viewAngleDegrees);
  }
  if (isTiltOn !== undefined) {
    ctx.isTiltOn = isTiltOn;
  }
  if (isFramingOn !== undefined) {
    ctx.isFramingOn = isFramingOn;
  }
  if (isMotionReduced !== undefined) {
    setMotionReduced(ctx, isMotionReduced);
  }
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @param {number} viewAngleDegrees
 */
function setViewAngle(ctx, viewAngleDegrees) {
  ctx.orbit.viewAngleDegrees = viewAngleDegrees;
  ctx.orbit.distance = computeFitDistance(ctx.view.camera, ctx.view.mapSize, viewAngleDegrees);
}

/**
 * @param {EngineContext} ctx
 * @param {boolean} isMotionReduced
 */
function setMotionReduced(ctx, isMotionReduced) {
  ctx.motion.isMotionReduced = isMotionReduced;
  retargetLifts(ctx.motion, ctx.raise);
}

/**
 * Automatic framing: the camera follows the selection only while the framing option is on.
 * @param {EngineContext} ctx
 * @param {number[]} indexes
 */
function frameSelection(ctx, indexes) {
  if (!ctx.isFramingOn) {
    return;
  }
  frameIndexes(ctx, indexes);
}

/**
 * Frames the municipalities whatever the framing option says, and leaves the option as it is. An
 * empty list flies back to the whole state.
 * @param {EngineContext} ctx
 * @param {number[]} indexes
 */
function frameIndexes(ctx, indexes) {
  if (indexes.length === 0) {
    setZoomTarget(ctx, 1);
    return;
  }

  const boundsList = indexes.map((index) => ctx.municipalities[index].bounds);
  const framing = readSelectionFraming(boundsList, ctx.view.mapSize);
  ctx.panTarget.copy(framing.pan);
  setZoomTarget(ctx, framing.zoom);
  ctx.tiltTarget.set(0.12, -0.22);
  if (ctx.motion.isMotionReduced) {
    ctx.orbit.pan.copy(ctx.panTarget);
    positionCamera(ctx.view.camera, ctx.orbit);
  }
  requestFrame(ctx);
}

/**
 * Smoothly frames the camera on the given bounding box of a territory or selection.
 * @param {EngineContext} ctx
 * @param {THREE.Box2 | THREE.Box3 | any} bounds
 * @param {{ immediate?: boolean; isWorldUnits?: boolean; durationMs?: number } | any} [options]
 */
function frameBounds(ctx, bounds, options = {}) {
  if (!bounds) {
    resetView(ctx);
    return;
  }
  if (options.durationMs !== undefined && options.durationMs > 0) {
    return transitionCameraToBounds(ctx, bounds, options);
  }
  const framing = readBoxFraming(bounds, ctx.view.mapSize, options);
  ctx.panTarget.copy(framing.pan);
  setZoomTarget(ctx, framing.zoom);
  ctx.tiltTarget.set(0.12, -0.22);
  if (ctx.motion.isMotionReduced || options.immediate) {
    ctx.orbit.pan.copy(ctx.panTarget);
    positionCamera(ctx.view.camera, ctx.orbit);
  }
  requestFrame(ctx);
}

/**
 * Resolves the Set of selected municipality indexes from context and options without ternary operator.
 * @param {EngineContext} ctx
 * @param {any} [options]
 * @returns {Set<number>}
 */
function resolveSelectedSet(ctx, options = {}) {
  const selectedSet = new Set(ctx.raise.selected);
  if (options.selectedIndexes) {
    for (const item of options.selectedIndexes) {
      if (typeof item === "number") {
        selectedSet.add(item);
      }
      if (typeof item === "string") {
        const index = ctx.indexByCode.get(item);
        if (index !== undefined) {
          selectedSet.add(index);
        }
      }
    }
  }
  return selectedSet;
}

/**
 * Resolves animation requester function without ternary operator.
 * @param {((cb: (time: number) => void) => number) | undefined} customRequestFrame
 * @returns {(cb: (time: number) => void) => number}
 */
function resolveEngineRequestFrameFn(customRequestFrame) {
  if (typeof customRequestFrame === "function") {
    return customRequestFrame;
  }
  if (typeof requestAnimationFrame !== "undefined") {
    return (callback) => requestAnimationFrame(callback);
  }
  return (callback) => /** @type {any} */ (setTimeout(() => callback(Date.now()), 16));
}

/**
 * Smoothly transitions the camera to target bounds using cubic easing.
 * @param {EngineContext} ctx
 * @param {any} bounds
 * @param {any} [options]
 * @returns {Promise<{ pan: THREE.Vector3; zoom: number; progress: number; eased: number }>}
 */
function transitionCameraToBounds(ctx, bounds, options = {}) {
  const from = {
    pan: ctx.orbit.pan.clone(),
    zoom: ctx.zoomState.current,
  };
  let durationMs = 600;
  if (options.durationMs !== undefined) {
    durationMs = options.durationMs;
  }
  const requestFrameFn = resolveEngineRequestFrameFn(options.requestFrame);

  return interpolateCameraToBounds({
    from,
    targetBounds: bounds,
    mapSize: ctx.view.mapSize,
    durationMs,
    isWorldUnits: options.isWorldUnits,
    requestFrame: requestFrameFn,
    getTime: options.getTime,
    onProgress: (state) => {
      ctx.orbit.pan.copy(state.pan);
      ctx.panTarget.copy(state.pan);
      ctx.zoomState.current = state.zoom;
      ctx.zoomState.target = state.zoom;
      ctx.view.camera.zoom = state.zoom;
      ctx.view.camera.updateProjectionMatrix();
      positionCamera(ctx.view.camera, ctx.orbit);
      if (typeof options.onProgress === "function") {
        options.onProgress(state);
      }
      requestFrame(ctx);
    },
    onComplete: (state) => {
      ctx.orbit.pan.copy(state.pan);
      ctx.panTarget.copy(state.pan);
      ctx.zoomState.current = state.zoom;
      ctx.zoomState.target = state.zoom;
      ctx.view.camera.zoom = state.zoom;
      ctx.view.camera.updateProjectionMatrix();
      positionCamera(ctx.view.camera, ctx.orbit);
      if (typeof options.onComplete === "function") {
        options.onComplete(state);
      }
      requestFrame(ctx);
    },
  });
}

/**
 * Flattens vertical scale (scale.z) for all or unselected instances.
 * @param {EngineContext} ctx
 * @param {any} [options]
 * @returns {Promise<void>}
 */
function flattenHeights(ctx, options = {}) {
  let targetScaleZ = SAFE_MIN_SCALE_Z;
  if (options.scaleZ !== undefined) {
    targetScaleZ = options.scaleZ;
  }
  const safeTarget = Math.max(SAFE_MIN_SCALE_Z, targetScaleZ);
  if (options.excludeSelected) {
    return interpolateUnselectedHeights(ctx, safeTarget, options);
  }
  let durationMs = 0;
  if (options.durationMs !== undefined) {
    durationMs = options.durationMs;
  }
  if (durationMs > 0) {
    return interpolateHeights(ctx, safeTarget, options);
  }

  for (let i = 0; i < ctx.municipalities.length; i += 1) {
    ctx.motion.heightTargets[i] = safeTarget;
    if (options.immediate) {
      ctx.motion.heightCurrent[i] = safeTarget;
      placeMunicipality(ctx.motion, i);
    }
  }

  if (!options.immediate) {
    ctx.motion.isHeightMoving = true;
  }
  updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
  requestFrame(ctx);
  if (typeof options.onComplete === "function") {
    options.onComplete();
  }
  return Promise.resolve();
}

/**
 * Interpolates heights toward target scales across instances.
 * @param {EngineContext} ctx
 * @param {any} targets
 * @param {any} [options]
 * @returns {Promise<void>}
 */
function interpolateHeights(ctx, targets, options = {}) {
  let durationMs = 0;
  if (options.durationMs !== undefined) {
    durationMs = options.durationMs;
  }
  const municipalityCount = ctx.municipalities.length;

  if (durationMs <= 0) {
    if (typeof targets === "number") {
      const safe = Math.max(SAFE_MIN_SCALE_Z, targets);
      for (let i = 0; i < municipalityCount; i += 1) {
        ctx.motion.heightTargets[i] = safe;
        if (options.immediate) {
          ctx.motion.heightCurrent[i] = safe;
          placeMunicipality(ctx.motion, i);
        }
      }
    }
    if (typeof targets !== "number" && targets && targets.length) {
      for (let i = 0; i < municipalityCount && i < targets.length; i += 1) {
        const safe = Math.max(SAFE_MIN_SCALE_Z, targets[i]);
        ctx.motion.heightTargets[i] = safe;
        if (options.immediate) {
          ctx.motion.heightCurrent[i] = safe;
          placeMunicipality(ctx.motion, i);
        }
      }
    }
    if (!options.immediate) {
      ctx.motion.isHeightMoving = true;
    }
    updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
    requestFrame(ctx);
    if (typeof options.onComplete === "function") {
      options.onComplete();
    }
    return Promise.resolve();
  }

  const startScales = new Float32Array(ctx.motion.heightCurrent);
  const requestFrameFn = resolveEngineRequestFrameFn(options.requestFrame);

  return new Promise((resolve) => {
    let startTime = /** @type {number | null} */ (null);

    function step(/** @type {number} */ timestamp) {
      if (startTime === null) {
        startTime = timestamp;
      }
      const elapsed = timestamp - startTime;
      const progress = THREE.MathUtils.clamp(elapsed / durationMs, 0, 1);
      let eased = progress;
      if (progress < 0.5) {
        eased = 4 * progress * progress * progress;
      }
      if (progress >= 0.5) {
        eased = 1 - Math.pow(-2 * progress + 2, 3) / 2;
      }

      for (let i = 0; i < municipalityCount; i += 1) {
        let targetVal = SAFE_MIN_SCALE_Z;
        if (typeof targets === "number") {
          targetVal = targets;
        }
        if (typeof targets !== "number" && targets && targets[i] !== undefined) {
          targetVal = targets[i];
        }
        const safeTarget = Math.max(SAFE_MIN_SCALE_Z, targetVal);
        const current = THREE.MathUtils.lerp(startScales[i], safeTarget, eased);
        ctx.motion.heightCurrent[i] = current;
        ctx.motion.heightTargets[i] = safeTarget;
        placeMunicipality(ctx.motion, i);
      }

      updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
      requestFrame(ctx);

      if (typeof options.onProgress === "function") {
        options.onProgress({ progress, eased });
      }

      if (progress < 1) {
        requestFrameFn(step);
        return;
      }

      if (typeof options.onComplete === "function") {
        options.onComplete();
      }
      resolve();
    }

    requestFrameFn(step);
  });
}

/**
 * Interpolates height of a specific instance or municipality by index or code.
 * @param {EngineContext} ctx
 * @param {number | string} indexOrCode
 * @param {number} targetScaleZ
 * @param {any} [options]
 * @returns {Promise<void>}
 */
function interpolateInstanceHeight(ctx, indexOrCode, targetScaleZ, options = {}) {
  let index = -1;
  if (typeof indexOrCode === "number") {
    index = indexOrCode;
  }
  if (typeof indexOrCode === "string") {
    const found = ctx.indexByCode.get(indexOrCode);
    if (found !== undefined) {
      index = found;
    }
  }

  if (index < 0 || index >= ctx.municipalities.length) {
    return Promise.resolve();
  }

  const safeTarget = Math.max(SAFE_MIN_SCALE_Z, targetScaleZ);
  let durationMs = 0;
  if (options.durationMs !== undefined) {
    durationMs = options.durationMs;
  }

  if (durationMs <= 0) {
    ctx.motion.heightTargets[index] = safeTarget;
    if (options.immediate) {
      ctx.motion.heightCurrent[index] = safeTarget;
      placeMunicipality(ctx.motion, index);
      updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
    }
    if (!options.immediate) {
      ctx.motion.isHeightMoving = true;
    }
    requestFrame(ctx);
    if (typeof options.onComplete === "function") {
      options.onComplete();
    }
    return Promise.resolve();
  }

  const startScale = ctx.motion.heightCurrent[index];
  const requestFrameFn = resolveEngineRequestFrameFn(options.requestFrame);

  return new Promise((resolve) => {
    let startTime = /** @type {number | null} */ (null);

    function step(/** @type {number} */ timestamp) {
      if (startTime === null) {
        startTime = timestamp;
      }
      const elapsed = timestamp - startTime;
      const progress = THREE.MathUtils.clamp(elapsed / durationMs, 0, 1);
      let eased = progress;
      if (progress < 0.5) {
        eased = 4 * progress * progress * progress;
      }
      if (progress >= 0.5) {
        eased = 1 - Math.pow(-2 * progress + 2, 3) / 2;
      }

      const current = THREE.MathUtils.lerp(startScale, safeTarget, eased);
      ctx.motion.heightCurrent[index] = current;
      ctx.motion.heightTargets[index] = safeTarget;
      placeMunicipality(ctx.motion, index);
      updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
      requestFrame(ctx);

      if (typeof options.onProgress === "function") {
        options.onProgress({ progress, eased, scaleZ: current });
      }

      if (progress < 1) {
        requestFrameFn(step);
        return;
      }

      if (typeof options.onComplete === "function") {
        options.onComplete();
      }
      resolve();
    }

    requestFrameFn(step);
  });
}

/**
 * Interpolates heights of all unselected municipalities to a target vertical scale (e.g. flattened).
 * @param {EngineContext} ctx
 * @param {number} [targetScaleZ]
 * @param {any} [options]
 * @returns {Promise<void>}
 */
function interpolateUnselectedHeights(ctx, targetScaleZ = SAFE_MIN_SCALE_Z, options = {}) {
  const safeTarget = Math.max(SAFE_MIN_SCALE_Z, targetScaleZ);
  const selectedSet = resolveSelectedSet(ctx, options);
  let durationMs = 0;
  if (options.durationMs !== undefined) {
    durationMs = options.durationMs;
  }

  if (durationMs <= 0) {
    for (let i = 0; i < ctx.municipalities.length; i += 1) {
      if (selectedSet.has(i)) {
        continue;
      }
      ctx.motion.heightTargets[i] = safeTarget;
      if (options.immediate) {
        ctx.motion.heightCurrent[i] = safeTarget;
        placeMunicipality(ctx.motion, i);
      }
    }
    if (!options.immediate) {
      ctx.motion.isHeightMoving = true;
    }
    updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
    requestFrame(ctx);
    if (typeof options.onComplete === "function") {
      options.onComplete();
    }
    return Promise.resolve();
  }

  const startScales = new Float32Array(ctx.motion.heightCurrent);
  const requestFrameFn = resolveEngineRequestFrameFn(options.requestFrame);

  return new Promise((resolve) => {
    let startTime = /** @type {number | null} */ (null);

    function step(/** @type {number} */ timestamp) {
      if (startTime === null) {
        startTime = timestamp;
      }
      const elapsed = timestamp - startTime;
      const progress = THREE.MathUtils.clamp(elapsed / durationMs, 0, 1);
      let eased = progress;
      if (progress < 0.5) {
        eased = 4 * progress * progress * progress;
      }
      if (progress >= 0.5) {
        eased = 1 - Math.pow(-2 * progress + 2, 3) / 2;
      }

      for (let i = 0; i < ctx.municipalities.length; i += 1) {
        if (selectedSet.has(i)) {
          continue;
        }
        const current = THREE.MathUtils.lerp(startScales[i], safeTarget, eased);
        ctx.motion.heightCurrent[i] = current;
        ctx.motion.heightTargets[i] = safeTarget;
        placeMunicipality(ctx.motion, i);
      }

      updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);
      requestFrame(ctx);

      if (typeof options.onProgress === "function") {
        options.onProgress({ progress, eased });
      }

      if (progress < 1) {
        requestFrameFn(step);
        return;
      }

      if (typeof options.onComplete === "function") {
        options.onComplete();
      }
      resolve();
    }

    requestFrameFn(step);
  });
}

/**
 * Dynamically replaces the BatchedMesh and geometry without leaking WebGL memory or destroying the renderer.
 * @param {EngineContext} ctx
 * @param {any} geometryInput
 * @param {{
 *   collectionName?: string;
 *   bounds?: any;
 *   frame?: boolean;
 *   immediate?: boolean;
 *   resetView?: boolean;
 *   isWorldUnits?: boolean;
 * }} [options]
 */
function replaceMesh(ctx, geometryInput, options = {}) {
  let newGeometry = geometryInput;
  if (newGeometry && newGeometry.type === "Topology") {
    newGeometry = buildMunicipalities(newGeometry, options.collectionName);
  }
  if (!newGeometry || !newGeometry.plate || !newGeometry.municipalities) {
    throw new Error("Invalid geometry supplied to replaceMesh");
  }

  const oldPlate = ctx.view.plate;
  if (oldPlate) {
    ctx.view.mapGroup.remove(oldPlate);
    disposePlate(oldPlate);
  }

  if (ctx.view.borders && ctx.view.borders.geometry) {
    ctx.view.borders.geometry.dispose();
  }
  if (ctx.view.raisedOutline && ctx.view.raisedOutline.geometry) {
    ctx.view.raisedOutline.geometry.dispose();
  }

  for (const geom of ctx.limitGeometriesByLevel.values()) {
    geom.dispose();
  }
  ctx.limitGeometriesByLevel.clear();
  ctx.limitLines.visible = false;
  ctx.selectionOutline.setVisible(false);

  ctx.view.plate = newGeometry.plate;
  ctx.view.mapGroup.add(newGeometry.plate);
  ctx.municipalities = newGeometry.municipalities;
  ctx.indexByCode = buildIndexByCode(newGeometry.municipalities);
  ctx.mapCenter = newGeometry.mapCenter;
  ctx.topology = newGeometry.topology;
  ctx.view.instanceToMunicipality = readInstanceToMunicipality(newGeometry.municipalities);

  const allIndexes = ctx.municipalities.map((_, index) => index);
  ctx.view.borders.geometry = buildOwnedLines(ctx.municipalities, allIndexes);
  ctx.view.raisedOutline.geometry = buildOwnedLines(ctx.municipalities, []);

  const wasMotionReduced = ctx.motion.isMotionReduced;
  ctx.motion = createMapMotion(newGeometry.plate, newGeometry.municipalities);
  ctx.motion.isMotionReduced = wasMotionReduced;

  new THREE.Box3().setFromObject(newGeometry.plate).getSize(ctx.view.mapSize);
  if (ctx.view.ground && ctx.view.ground.geometry) {
    ctx.view.ground.geometry.dispose();
    ctx.view.ground.geometry = new THREE.PlaneGeometry(
      ctx.view.mapSize.x * 1.8,
      ctx.view.mapSize.y * 1.8,
    );
  }
  if (ctx.view.sun && ctx.view.sun.shadow) {
    const shadowReach = Math.hypot(ctx.view.mapSize.x, ctx.view.mapSize.y) * 0.55;
    ctx.view.sun.shadow.camera.left = -shadowReach;
    ctx.view.sun.shadow.camera.right = shadowReach;
    ctx.view.sun.shadow.camera.top = shadowReach;
    ctx.view.sun.shadow.camera.bottom = -shadowReach;
    ctx.view.sun.shadow.camera.updateProjectionMatrix();
  }

  ctx.pickTarget = buildPickTarget(ctx.view, ctx.motion, ctx.municipalities);

  ctx.raise.pointed = null;
  ctx.raise.pointedIndexes = undefined;
  ctx.raise.selected = new Set();
  ctx.pointTracker.clearPointed();
  ctx.colorPositions = new Uint8Array(newGeometry.municipalities.length);

  paintCurrentColors(ctx);
  updateLineHeights(ctx.view.borders, ctx.motion, BORDER_LIFT_SHARE);

  ctx.orbit.distance = computeFitDistance(
    ctx.view.camera,
    ctx.view.mapSize,
    ctx.orbit.viewAngleDegrees,
  );

  if (options.bounds) {
    frameBounds(ctx, options.bounds, options);
  }
  if (!options.bounds) {
    if (options.resetView !== false) {
      if (options.immediate) {
        ctx.panTarget.set(0, 0, 0);
        ctx.zoomState.target = 1;
        ctx.zoomState.current = 1;
        ctx.orbit.pan.set(0, 0, 0);
        positionCamera(ctx.view.camera, ctx.orbit);
      }
      if (!options.immediate) {
        ctx.panTarget.set(0, 0, 0);
        setZoomTarget(ctx, 1);
      }
    }
  }

  requestFrame(ctx);
}

/**
 * Steps one level of the zoom ladder. Zooming on the cursor keeps the ground point fixed.
 * @param {EngineContext} ctx
 * @param {number} direction positive zooms in, otherwise zooms out
 * @param {{ x: number; y: number }} [screenPoint]
 */
function zoomStep(ctx, direction, screenPoint) {
  const currentTarget = ctx.zoomState.target;
  const nextZoom = readSteppedZoom(currentTarget, direction);
  if (nextZoom === currentTarget) {
    return;
  }

  if (screenPoint) {
    const rect = ctx.canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const cursorNdc = new THREE.Vector2(
        ((screenPoint.x - rect.left) / rect.width) * 2 - 1,
        -((screenPoint.y - rect.top) / rect.height) * 2 + 1,
      );
      const groundPoint = readGroundPoint(cursorNdc, ctx.pickTarget, new THREE.Vector3());
      if (groundPoint) {
        const newPan = readCursorZoomPan({
          camera: ctx.view.camera,
          orbit: ctx.orbit,
          cursorNdc,
          zoom: nextZoom,
          groundPoint,
        });
        if (newPan) {
          clampPanVector(newPan, ctx.view.mapSize);
          ctx.panTarget.copy(newPan);
        }
      }
    }
  }

  setZoomTarget(ctx, nextZoom);
}

/**
 * @param {EngineContext} ctx
 */
function resetView(ctx) {
  ctx.panTarget.set(0, 0, 0);
  setZoomTarget(ctx, 1);
  if (ctx.motion.isMotionReduced) {
    ctx.zoomState.current = 1;
    ctx.orbit.pan.set(0, 0, 0);
    positionCamera(ctx.view.camera, ctx.orbit);
  }
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @param {number} zoomTarget
 */
function setZoomTarget(ctx, zoomTarget) {
  const previousTarget = ctx.zoomState.target;
  ctx.zoomState.target = clampZoomTarget(zoomTarget);
  if (ctx.zoomState.target <= HOME_ZOOM) {
    ctx.panTarget.set(0, 0, 0);
  }
  if (ctx.motion.isMotionReduced) {
    ctx.zoomState.current = ctx.zoomState.target;
    ctx.orbit.pan.copy(ctx.panTarget);
    positionCamera(ctx.view.camera, ctx.orbit);
  }
  if (previousTarget !== ctx.zoomState.target && typeof ctx.onZoomChange === "function") {
    ctx.onZoomChange(ctx.zoomState.target);
  }
  requestFrame(ctx);
}

/**
 * @param {EngineContext} ctx
 * @returns {EngineStats}
 */
function readStats(ctx) {
  const renderInfo = ctx.renderer.info.render;
  const samples = ctx.frame.samples;
  return {
    frameCount: ctx.frame.count,
    isSettled: isSettled(ctx),
    renderTimes: [...samples],
    lastRenderDuration: samples.at(-1) ?? 0,
    medianRenderDuration: readMedianSample(samples),
    drawCalls: renderInfo.calls,
    triangles: renderInfo.triangles,
    meshCount: countMapMeshes(ctx.view.mapGroup),
    instanceCount: ctx.view.plate.instanceCount,
  };
}

/**
 * Reads the geometries the renderer holds, the vertices of every geometry in the scene and the id
 * of each one, in scene order. It changes nothing.
 * @param {EngineContext} ctx
 * @returns {GeometryStats}
 */
function readGeometryStats(ctx) {
  const geometries = readSceneGeometries(ctx.view.scene);
  return {
    geometryCount: ctx.renderer.info.memory.geometries,
    vertexCount: sumVertices(geometries),
    geometryIds: geometries.map((geometry) => geometry.id),
  };
}

/**
 * @param {THREE.Object3D} root
 * @returns {THREE.BufferGeometry[]}
 */
function readSceneGeometries(root) {
  /** @type {THREE.BufferGeometry[]} */
  const geometries = [];
  root.traverse((object) => {
    const geometry = readObjectGeometry(object);
    if (geometry) {
      geometries.push(geometry);
    }
  });
  return geometries;
}

/**
 * @param {THREE.Object3D} object
 * @returns {THREE.BufferGeometry | null} the geometry of a mesh or a line, null for anything else.
 */
function readObjectGeometry(object) {
  if (object instanceof THREE.Mesh) {
    return object.geometry;
  }
  if (object instanceof THREE.Line) {
    return object.geometry;
  }
  return null;
}

/**
 * @param {THREE.BufferGeometry[]} geometries
 * @returns {number}
 */
function sumVertices(geometries) {
  return geometries.reduce((total, geometry) => total + readVertexCount(geometry), 0);
}

/**
 * @param {THREE.BufferGeometry} geometry
 * @returns {number}
 */
function readVertexCount(geometry) {
  const position = geometry.getAttribute("position");
  if (!position) {
    return 0;
  }
  return position.count;
}

/**
 * The borders follow the top of each block while its height moves (ESC-12): every border vertex a
 * block owns sits the same offset above that top. It changes nothing.
 * @param {EngineContext} ctx
 * @param {number} index
 * @returns {BorderTop | null} null for an index the map does not draw or a block without borders.
 */
function readBorderTop(ctx, index) {
  const isDrawnIndex = index >= 0 && index < ctx.municipalities.length;
  if (!isDrawnIndex) {
    return null;
  }
  const borderHeights = readOwnedLineHeights(ctx.view.borders, index);
  if (borderHeights.length === 0) {
    return null;
  }

  return {
    blockTop: readTopHeight(ctx.motion.heightCurrent[index]),
    lowestBorder: Math.min(...borderHeights),
    highestBorder: Math.max(...borderHeights),
  };
}

/**
 * @param {THREE.LineSegments} lines
 * @param {number} ownerIndex
 * @returns {number[]} the z of every line vertex the owner has.
 */
function readOwnedLineHeights(lines, ownerIndex) {
  const owners = lines.geometry.userData.owners;
  const positions = lines.geometry.attributes.position.array;
  /** @type {number[]} */
  const heights = [];
  for (let vertexIndex = 0; vertexIndex < owners.length; vertexIndex += 1) {
    if (owners[vertexIndex] !== ownerIndex) {
      continue;
    }
    heights.push(positions[vertexIndex * 3 + 2]);
  }
  return heights;
}

/**
 * The box of the region limits and the box of the map, both in centered map units. The limits must
 * sit inside the map (NIV-07). A box with nothing in it reads as null.
 * @param {EngineContext} ctx
 * @returns {{ limits: PlainBox | null; map: PlainBox | null }}
 */
function readLimitBounds(ctx) {
  const limits = new THREE.Box2();
  const positions = ctx.limitLines.geometry.attributes.position;
  if (positions) {
    for (let index = 0; index < positions.count; index += 1) {
      limits.expandByPoint(new THREE.Vector2(positions.getX(index), positions.getY(index)));
    }
  }
  const map = new THREE.Box2();
  for (const municipality of ctx.municipalities) {
    map.union(municipality.bounds);
  }
  return { limits: toPlainBox(limits), map: toPlainBox(map) };
}

/**
 * @param {THREE.Box2} box
 * @returns {PlainBox | null}
 */
function toPlainBox(box) {
  if (box.isEmpty()) {
    return null;
  }
  return { minX: box.min.x, minY: box.min.y, maxX: box.max.x, maxY: box.max.y };
}

/**
 * @param {EngineContext} ctx
 */
function readCamera(ctx) {
  return {
    viewAngleDegrees: ctx.orbit.viewAngleDegrees,
    aspect: ctx.view.camera.aspect,
    zoom: ctx.zoomState.current,
    zoomTarget: ctx.zoomState.target,
    panX: ctx.orbit.pan.x,
    panY: ctx.orbit.pan.y,
    pan: {
      x: ctx.orbit.pan.x,
      y: ctx.orbit.pan.y,
      z: ctx.orbit.pan.z,
    },
  };
}

/**
 * @param {EngineContext} ctx
 * @returns {boolean}
 */
function isSettled(ctx) {
  if (ctx.frame.isRequested) {
    return false;
  }
  if (ctx.motion.isHeightMoving) {
    return false;
  }
  return ctx.motion.movingLifts.size === 0;
}

/**
 * @param {EngineContext} ctx
 * @param {number} index
 * @returns {MunicipalityInspection | null}
 */
function inspect(ctx, index) {
  if (index < 0 || index >= ctx.municipalities.length) {
    return null;
  }
  const { motion } = ctx;
  const instanceColor = new THREE.Color();
  ctx.view.plate.getColorAt(ctx.municipalities[index].instanceId, instanceColor);
  return {
    code: ctx.municipalities[index].code,
    color: `#${instanceColor.getHexString()}`,
    heightCurrent: motion.heightCurrent[index],
    heightTarget: motion.heightTargets[index],
    liftCurrent: motion.liftCurrent[index],
    liftTarget: motion.liftTargets[index],
  };
}

/**
 * @param {EngineContext} ctx
 * @param {number} x client x, in CSS pixels
 * @param {number} y client y, in CSS pixels
 * @returns {THREE.Vector3 | null}
 */
function readGroundPointAt(ctx, x, y) {
  const rect = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1,
  );
  return readGroundPoint(ndc, ctx.pickTarget, new THREE.Vector3());
}

/**
 * @param {EngineContext} ctx
 * @param {THREE.Vector3} point world point
 * @returns {{ x: number; y: number }} client position, in CSS pixels
 */
function projectGroundPoint(ctx, point) {
  const vec = new THREE.Vector3(point.x, point.y, point.z);
  const projected = vec.project(ctx.view.camera);
  const rect = ctx.canvas.getBoundingClientRect();
  return {
    x: ((projected.x + 1) / 2) * rect.width + rect.left,
    y: ((-projected.y + 1) / 2) * rect.height + rect.top,
  };
}

/**
 * @param {EngineContext} ctx
 */
function disposeEngine(ctx) {
  const { plate, borders, raisedOutline, ground } = ctx.view;
  ctx.renderer.dispose();
  if (plate) {
    disposePlate(plate);
  }
  if (borders?.geometry) {
    borders.geometry.dispose();
  }
  if (raisedOutline?.geometry) {
    raisedOutline.geometry.dispose();
  }
  if (ground?.geometry) {
    ground.geometry.dispose();
  }
  for (const geometry of ctx.limitGeometriesByLevel.values()) {
    geometry.dispose();
  }
  ctx.limitGeometriesByLevel.clear();
  ctx.limitLines.geometry.dispose();
  ctx.limitLines.material.dispose();
  ctx.selectionOutline.dispose();
  ctx.view.scene.remove(ctx.selectionOutline.group);
}
