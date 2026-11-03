import * as THREE from "three";
import { decodeArc } from "../domain/topology.js";
import { PLATE_DEPTH } from "./constants.js";

/**
 * @typedef {[number, number]} Point
 * @typedef {Point[]} Ring
 */

/**
 * One municipality in the units of the topology, centered on the map center. The map group of the
 * scene scales it to world units and flips Y.
 * @typedef {{
 *   code: string;
 *   shapes: THREE.Shape[];
 *   geometry: THREE.ExtrudeGeometry;
 *   outline: Float32Array;
 *   bounds: THREE.Box2;
 *   center: THREE.Vector2;
 *   size: THREE.Vector2;
 *   instanceId: number;
 * }} MapMunicipality
 */

/**
 * Builds the municipalities and the plate that draws them. The map size is not measured here: it
 * only exists in world units, after the scene puts the plate in the scaled map group.
 * @param {any} topology
 * @param {string} [collectionName]
 * @returns {{
 *   municipalities: MapMunicipality[];
 *   plate: THREE.BatchedMesh;
 *   mapCenter: THREE.Vector2;
 *   mapBounds: THREE.Box2;
 *   topology: any;
 * }}
 */
export function buildMunicipalities(topology, collectionName) {
  const collection = findGeometryCollection(topology, collectionName);
  if (!collection) {
    throw new Error("Topology does not contain a valid geometry collection");
  }
  const rawMunicipalities = [];
  const mapBounds = new THREE.Box2();

  for (const geometry of collection.geometries) {
    const code = readGeometryCode(geometry);
    const polygons = extractPolygons(geometry, topology.arcs, topology.transform);
    const shapes = [];

    for (const polygonRings of polygons) {
      if (polygonRings.length === 0 || polygonRings[0].length === 0) {
        continue;
      }
      const outerRing = polygonRings[0];
      const shape = new THREE.Shape();
      shape.moveTo(outerRing[0][0], outerRing[0][1]);
      for (let i = 1; i < outerRing.length; i += 1) {
        shape.lineTo(outerRing[i][0], outerRing[i][1]);
      }

      for (let h = 1; h < polygonRings.length; h += 1) {
        const holeRing = polygonRings[h];
        if (holeRing.length === 0) {
          continue;
        }
        const hole = new THREE.Path();
        hole.moveTo(holeRing[0][0], holeRing[0][1]);
        for (let i = 1; i < holeRing.length; i += 1) {
          hole.lineTo(holeRing[i][0], holeRing[i][1]);
        }
        shape.holes.push(hole);
      }
      shapes.push(shape);
    }

    for (const shape of shapes) {
      for (const pt of shape.getPoints()) {
        mapBounds.expandByPoint(pt);
      }
    }

    rawMunicipalities.push({
      code,
      shapes,
      polygons,
    });
  }

  const mapCenter = mapBounds.getCenter(new THREE.Vector2());
  /** @type {MapMunicipality[]} */
  const municipalities = [];

  for (const raw of rawMunicipalities) {
    const geometry = buildMunicipalityGeometry(raw.shapes, mapCenter);
    const outline = buildOutlineSegments(raw.shapes, mapCenter);
    const bounds = readOutlineBounds(outline);
    const center = bounds.getCenter(new THREE.Vector2());
    const size = bounds.getSize(new THREE.Vector2());

    municipalities.push({
      code: raw.code,
      shapes: raw.shapes,
      geometry,
      outline,
      bounds,
      center,
      size,
      instanceId: -1,
    });
  }

  const plate = buildPlate(municipalities);

  return {
    municipalities,
    plate,
    mapCenter,
    mapBounds,
    topology,
  };
}

/**
 * Modern alias for buildMunicipalities to support any territory collection (e.g. states, UFs).
 * @param {any} topology
 * @param {string} [collectionName]
 */
export function buildUnits(topology, collectionName) {
  return buildMunicipalities(topology, collectionName);
}

/**
 * @param {any} topology
 * @param {string} [preferredName]
 * @returns {any}
 */
export function findGeometryCollection(topology, preferredName) {
  if (!topology || !topology.objects) {
    return null;
  }
  if (preferredName && topology.objects[preferredName]) {
    return topology.objects[preferredName];
  }
  if (topology.objects.municipalities) {
    return topology.objects.municipalities;
  }
  if (topology.objects.states) {
    return topology.objects.states;
  }
  if (topology.objects.units) {
    return topology.objects.units;
  }
  const keys = Object.keys(topology.objects);
  if (keys.length > 0) {
    return topology.objects[keys[0]];
  }
  return null;
}

/**
 * @param {any} geometry
 * @returns {string}
 */
export function readGeometryCode(geometry) {
  if (geometry.id !== undefined && geometry.id !== null) {
    return String(geometry.id);
  }
  const props = geometry.properties;
  if (props) {
    const code = props.id ?? props.code ?? props.codarea ?? props.sigla ?? props.UF;
    if (code !== undefined && code !== null) {
      return String(code);
    }
  }
  return "";
}

/**
 * Disposes a BatchedMesh plate safely.
 * @param {THREE.BatchedMesh | any} plate
 */
export function disposePlate(plate) {
  if (!plate) {
    return;
  }
  if (typeof plate.dispose === "function") {
    plate.dispose();
  }
  if (plate.geometry && typeof plate.geometry.dispose === "function") {
    plate.geometry.dispose();
  }
  if (plate.material && typeof plate.material.dispose === "function") {
    plate.material.dispose();
  }
}

/**
 * Disposes lines and their geometry and material safely.
 * @param {THREE.LineSegments | any} lines
 */
export function disposeOwnedLines(lines) {
  if (!lines) {
    return;
  }
  if (lines.geometry && typeof lines.geometry.dispose === "function") {
    lines.geometry.dispose();
  }
  if (lines.material && typeof lines.material.dispose === "function") {
    lines.material.dispose();
  }
}

/**
 * @param {THREE.Shape[]} shapes
 * @param {THREE.Vector2} mapCenter
 * @returns {THREE.ExtrudeGeometry}
 */
function buildMunicipalityGeometry(shapes, mapCenter) {
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: PLATE_DEPTH,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.translate(-mapCenter.x, -mapCenter.y, 0);
  return geometry;
}

/**
 * @param {Float32Array} outline
 * @returns {THREE.Box2}
 */
export function readOutlineBounds(outline) {
  const bounds = new THREE.Box2();
  const point = new THREE.Vector2();
  for (let readIndex = 0; readIndex < outline.length; readIndex += 2) {
    bounds.expandByPoint(point.set(outline[readIndex], outline[readIndex + 1]));
  }
  return bounds;
}

/**
 * @param {THREE.Shape[]} shapes
 * @param {THREE.Vector2} mapCenter
 * @returns {Float32Array}
 */
function buildOutlineSegments(shapes, mapCenter) {
  /** @type {number[]} */
  const coordinates = [];
  for (const shape of shapes) {
    const contours = [shape, ...shape.holes];
    for (const contour of contours) {
      pushContourSegments(contour.getPoints(), mapCenter, coordinates);
    }
  }
  return new Float32Array(coordinates);
}

/**
 * @param {THREE.Vector2[]} points
 * @param {THREE.Vector2} mapCenter
 * @param {number[]} coordinates
 */
function pushContourSegments(points, mapCenter, coordinates) {
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    const nextPoint = points[(pointIndex + 1) % points.length];
    if (point.equals(nextPoint)) {
      continue;
    }
    coordinates.push(
      point.x - mapCenter.x,
      point.y - mapCenter.y,
      nextPoint.x - mapCenter.x,
      nextPoint.y - mapCenter.y,
    );
  }
}

/**
 * One draw call for every block: each municipality is an instance, so its color, height and lift
 * change by writing one matrix or one color, never by rebuilding geometry.
 * @param {Array<{ geometry: THREE.BufferGeometry; instanceId: number }>} municipalities
 * @returns {THREE.BatchedMesh}
 */
export function buildPlate(municipalities) {
  let vertexCount = 0;
  for (const municipality of municipalities) {
    vertexCount += municipality.geometry.attributes.position.count;
  }

  const plate = new THREE.BatchedMesh(
    municipalities.length,
    vertexCount,
    0,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
  );
  plate.sortObjects = false;
  plate.castShadow = true;
  plate.receiveShadow = true;

  for (const municipality of municipalities) {
    municipality.instanceId = plate.addInstance(plate.addGeometry(municipality.geometry));
    municipality.geometry.dispose();
  }

  return plate;
}

/**
 * @param {Array<{ outline: Float32Array }>} municipalities
 * @param {number[]} municipalityIndexes
 * @returns {THREE.BufferGeometry}
 */
export function buildOwnedLines(municipalities, municipalityIndexes) {
  let vertexTotal = 0;
  for (const index of municipalityIndexes) {
    vertexTotal += municipalities[index].outline.length / 2;
  }

  const positions = new Float32Array(vertexTotal * 3);
  const owners = new Uint16Array(vertexTotal);
  let vertexIndex = 0;

  for (const municipalityIndex of municipalityIndexes) {
    const outline = municipalities[municipalityIndex].outline;
    for (let readIndex = 0; readIndex < outline.length; readIndex += 2) {
      positions[vertexIndex * 3] = outline[readIndex];
      positions[vertexIndex * 3 + 1] = outline[readIndex + 1];
      positions[vertexIndex * 3 + 2] = 0;
      owners[vertexIndex] = municipalityIndex;
      vertexIndex += 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.userData.owners = owners;
  return geometry;
}

/**
 * @param {any} geometry
 * @param {any} arcs
 * @param {any} transform
 * @returns {Ring[][]}
 */
function extractPolygons(geometry, arcs, transform) {
  if (geometry.type === "Polygon") {
    return [decodePolygonArcs(geometry.arcs, arcs, transform)];
  }
  if (geometry.type === "MultiPolygon") {
    /** @type {Ring[][]} */
    const result = [];
    for (const polyArcs of geometry.arcs) {
      result.push(decodePolygonArcs(polyArcs, arcs, transform));
    }
    return result;
  }
  return [];
}

/**
 * @param {number[][]} polygonArcs
 * @param {any} arcs
 * @param {any} transform
 * @returns {Ring[]}
 */
function decodePolygonArcs(polygonArcs, arcs, transform) {
  /** @type {Ring[]} */
  const rings = [];
  for (const ringIndices of polygonArcs) {
    /** @type {Point[]} */
    const ring = [];
    for (const index of ringIndices) {
      const arcPoints = resolveArcPoints(index, arcs, transform);
      appendPointsSkippingDuplicate(ring, arcPoints);
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * @param {number} arcIndex
 * @param {any} arcs
 * @param {any} transform
 * @returns {Point[]}
 */
function resolveArcPoints(arcIndex, arcs, transform) {
  if (arcIndex >= 0) {
    return decodeArc(arcs[arcIndex], transform);
  }
  const positiveIndex = ~arcIndex;
  const decoded = decodeArc(arcs[positiveIndex], transform);
  return decoded.slice().reverse();
}

/**
 * @param {Point[]} target
 * @param {Point[]} source
 */
function appendPointsSkippingDuplicate(target, source) {
  if (source.length === 0) {
    return;
  }
  let startIndex = 0;
  if (target.length > 0) {
    const lastTarget = target[target.length - 1];
    const firstSource = source[0];
    if (lastTarget[0] === firstSource[0] && lastTarget[1] === firstSource[1]) {
      startIndex = 1;
    }
  }
  for (let i = startIndex; i < source.length; i += 1) {
    target.push(source[i]);
  }
}

export const SAFE_MIN_SCALE_Z = 0.001;

const scratchInstanceMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();

/**
 * Sets scale Z of a BatchedMesh instance safely without breaking WebGL limits.
 * @param {THREE.BatchedMesh} plate
 * @param {number} instanceId
 * @param {number} scaleZ
 * @param {{ minScaleZ?: number }} [options]
 */
export function setInstanceHeightScale(plate, instanceId, scaleZ, options = {}) {
  if (!plate || instanceId < 0 || instanceId >= plate.instanceCount) {
    return;
  }
  let minScaleZ = SAFE_MIN_SCALE_Z;
  if (options.minScaleZ !== undefined) {
    minScaleZ = options.minScaleZ;
  }
  const safeScaleZ = Math.max(minScaleZ, scaleZ);

  plate.getMatrixAt(instanceId, scratchInstanceMatrix);
  scratchInstanceMatrix.decompose(scratchPosition, scratchQuaternion, scratchScale);
  scratchScale.z = safeScaleZ;
  scratchInstanceMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
  plate.setMatrixAt(instanceId, scratchInstanceMatrix);
}

/**
 * Flattens vertical scale (scale.z) for specified instances or the entire BatchedMesh.
 * @param {THREE.BatchedMesh} plate
 * @param {{
 *   scaleZ?: number;
 *   instanceIds?: number[] | Set<number>;
 *   excludeInstanceIds?: number[] | Set<number>;
 *   minScaleZ?: number;
 * }} [options]
 */
export function flattenMeshHeights(plate, options = {}) {
  if (!plate || plate.instanceCount <= 0) {
    return;
  }
  let targetScaleZ = SAFE_MIN_SCALE_Z;
  if (options.scaleZ !== undefined) {
    targetScaleZ = options.scaleZ;
  }
  let targetIds = null;
  if (options.instanceIds) {
    targetIds = new Set(options.instanceIds);
  }
  let excludeIds = null;
  if (options.excludeInstanceIds) {
    excludeIds = new Set(options.excludeInstanceIds);
  }

  for (let id = 0; id < plate.instanceCount; id += 1) {
    if (targetIds && !targetIds.has(id)) {
      continue;
    }
    if (excludeIds && excludeIds.has(id)) {
      continue;
    }
    setInstanceHeightScale(plate, id, targetScaleZ, options);
  }
}

/**
 * Interpolates height scale (scale.z) of a single instance.
 * @param {THREE.BatchedMesh} plate
 * @param {number} instanceId
 * @param {number} startScaleZ
 * @param {number} targetScaleZ
 * @param {number} t Progress from 0 to 1
 * @param {{ minScaleZ?: number; easing?: (t: number) => number }} [options]
 */
export function interpolateInstanceHeightScale(
  plate,
  instanceId,
  startScaleZ,
  targetScaleZ,
  t,
  options = {},
) {
  const clampedT = THREE.MathUtils.clamp(t, 0, 1);
  let progress = clampedT;
  if (typeof options.easing === "function") {
    progress = options.easing(clampedT);
  }
  const currentScaleZ = THREE.MathUtils.lerp(startScaleZ, targetScaleZ, progress);
  setInstanceHeightScale(plate, instanceId, currentScaleZ, options);
}

/**
 * Interpolates height scale (scale.z) across mesh instances.
 * @param {THREE.BatchedMesh} plate
 * @param {ArrayLike<number> | number} startScales
 * @param {ArrayLike<number> | number} targetScales
 * @param {number} t Progress from 0 to 1
 * @param {{
 *   excludeInstanceIds?: number[] | Set<number>;
 *   minScaleZ?: number;
 *   easing?: (t: number) => number;
 * }} [options]
 */
export function interpolateMeshHeightScales(plate, startScales, targetScales, t, options = {}) {
  if (!plate || plate.instanceCount <= 0) {
    return;
  }
  const clampedT = THREE.MathUtils.clamp(t, 0, 1);
  let progress = clampedT;
  if (typeof options.easing === "function") {
    progress = options.easing(clampedT);
  }
  let excludeIds = null;
  if (options.excludeInstanceIds) {
    excludeIds = new Set(options.excludeInstanceIds);
  }

  for (let id = 0; id < plate.instanceCount; id += 1) {
    if (excludeIds && excludeIds.has(id)) {
      continue;
    }
    let startVal = 1;
    if (typeof startScales === "number") {
      startVal = startScales;
    }
    if (typeof startScales !== "number" && startScales && startScales[id] !== undefined) {
      startVal = startScales[id];
    }
    let targetVal = SAFE_MIN_SCALE_Z;
    if (typeof targetScales === "number") {
      targetVal = targetScales;
    }
    if (typeof targetScales !== "number" && targetScales && targetScales[id] !== undefined) {
      targetVal = targetScales[id];
    }
    const currentScaleZ = THREE.MathUtils.lerp(startVal, targetVal, progress);
    setInstanceHeightScale(plate, id, currentScaleZ, options);
  }
}
