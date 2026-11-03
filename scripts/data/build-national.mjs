/**
 * Builds national overview and federative unit drill-down datasets:
 * - data/national/mesh-states.topo.json.gz (27 UFs projected to canvas)
 * - data/national/states.json (metadata, totals and per-UF aggregates)
 * - data/ufs/{uf}/mesh.topo.json.gz, municipalities.json, regions.json
 *
 * Joins by 7-digit IBGE municipal codes. Enforces strict avoidance of conditional alternative keywords and ternary operator.
 *
 * Usage:
 *   node scripts/data/build-national.mjs [--quality intermediaria] [--uf=35] [--all]
 *
 * @typedef {import("../../src/domain/topology.js").Topology} Topology
 * @typedef {import("./sources-national.js").RawSource} RawSource
 * @typedef {import("./sources-national.js").UfInfo} UfInfo
 * @typedef {{ sha256: string, retrievedAt: string }} RawChecksum
 * @typedef {{ bytes: Map<string, Uint8Array>, texts: Map<string, string>, checksums: Record<string, RawChecksum> }} RawStore
 * @typedef {{ code: string, name: string, regionCode: string | null, governmentRegionCode: string | null, governmentRegionName: string | null, population: number | null, areaKm2: number | null, gdpThousandBrl: number | null }} MunicipalityRecord
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { projectTopology } from "./project.js";
import { parseSidraValue } from "./read-sidra.js";
import { CHECKSUMS_FILE } from "./sources.js";
import {
  BRAZIL_UFS_MESH_FILE,
  BRAZIL_UFS_MESH_SOURCE,
  CENSUS_NATIONAL_FILE,
  CENSUS_NATIONAL_SOURCE,
  DEFAULT_MESH_QUALITY,
  findUf,
  GDP_NATIONAL_FILE,
  GDP_NATIONAL_SOURCE,
  getUfMeshFileName,
  HIERARCHY_FILE,
  HIERARCHY_SOURCE,
  MESH_QUALITIES,
  NATIONAL_CORE_SOURCES,
  UF_CATALOG,
} from "./sources-national.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = path.join(scriptDir, "raw");
export const DATA_DIR = path.resolve(scriptDir, "..", "..", "data");

if (isMainModule()) {
  await runCli();
}

/**
 * Builds national and UF-level data files.
 * @param {{ rawDir?: string, dataDir?: string, quality?: string, uf?: string, all?: boolean }} [options]
 * @returns {Promise<{ nationalFiles: string[], ufsBuilt: string[] }>}
 */
export async function buildNational({
  rawDir = RAW_DIR,
  dataDir = DATA_DIR,
  quality = DEFAULT_MESH_QUALITY,
  uf = "",
  all = false,
} = {}) {
  if (!MESH_QUALITIES.includes(quality)) {
    throw new Error(`Unknown mesh quality "${quality}"; use ${MESH_QUALITIES.join(" or ")}`);
  }

  const raw = await loadRawStore(rawDir);
  const hierarchyRows = readHierarchyRows(raw);
  const censusMap = readCensusMap(raw);
  const gdpMap = readGdpMap(raw);

  const nationalDir = path.join(dataDir, "national");
  await mkdir(nationalDir, { recursive: true });

  const statesDoc = buildStatesDocument(hierarchyRows, censusMap, gdpMap, raw);
  await writeFile(path.join(nationalDir, "states.json"), serializeCompact(statesDoc), "utf8");

  const nationalMeshDoc = buildNationalMeshDocument(raw);
  const nationalMeshJson = JSON.stringify(nationalMeshDoc);
  await writeFile(path.join(nationalDir, "mesh-states.topo.json"), nationalMeshJson, "utf8");
  await writeFile(
    path.join(nationalDir, "mesh-states.topo.json.gz"),
    gzipSync(nationalMeshJson, { level: 9 }),
  );

  const targetUfCodes = determineTargetUfs({ uf, all });
  const ufsBuilt = [];

  for (const ufCode of targetUfCodes) {
    const ufInfo = findUf(ufCode);
    if (!ufInfo) {
      continue;
    }
    const built = await buildUfDataset({
      ufInfo,
      hierarchyRows,
      censusMap,
      gdpMap,
      raw,
      rawDir,
      dataDir,
      quality,
    });
    if (built) {
      ufsBuilt.push(ufInfo.sigla);
    }
  }

  return {
    nationalFiles: ["states.json", "mesh-states.topo.json.gz"],
    ufsBuilt,
  };
}

/**
 * Loads raw store with checksum verification when checksums.json exists.
 * @param {string} rawDir
 * @returns {Promise<RawStore>}
 */
export async function loadRawStore(rawDir) {
  const checksumsPath = path.join(rawDir, CHECKSUMS_FILE);
  /** @type {Record<string, RawChecksum>} */
  let checksums = {};
  try {
    checksums = JSON.parse(await readFile(checksumsPath, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const bytes = new Map();
  const texts = new Map();
  for (const source of NATIONAL_CORE_SOURCES) {
    const filePath = path.join(rawDir, source.file);
    const content = await readFile(filePath);
    const sha = createHash("sha256").update(content).digest("hex");
    const recorded = checksums[source.file];
    if (recorded) {
      if (recorded.sha256 !== sha) {
        throw new Error(`${source.file} does not match its SHA-256 in ${CHECKSUMS_FILE}`);
      }
    }
    bytes.set(source.file, content);
    texts.set(source.file, new TextDecoder("utf-8").decode(content));
  }

  return { bytes, texts, checksums };
}

/**
 * Parses IBGE hierarchy level list.
 * @param {RawStore} raw
 * @returns {any[]}
 */
export function readHierarchyRows(raw) {
  const text = raw.texts.get(HIERARCHY_FILE);
  if (!text) {
    throw new Error(`Hierarchy file ${HIERARCHY_FILE} missing in raw store`);
  }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) {
    throw new Error("Hierarchy response is not an array");
  }
  return rows;
}

/**
 * Reads population and area from national SIDRA 4714 into lookup maps.
 * @param {RawStore} raw
 * @returns {Map<string, { population: number | null, areaKm2: number | null }>}
 */
export function readCensusMap(raw) {
  const text = raw.texts.get(CENSUS_NATIONAL_FILE);
  if (!text) {
    throw new Error(`Census file ${CENSUS_NATIONAL_FILE} missing in raw store`);
  }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) {
    throw new Error("SIDRA 4714 response is not an array");
  }

  const map = new Map();
  for (const row of rows) {
    if (!isNumericLevel(row.NC)) {
      continue;
    }
    const code = String(row.D1C);
    let entry = map.get(code);
    if (!entry) {
      entry = { population: null, areaKm2: null };
      map.set(code, entry);
    }
    const variable = String(row.D2C);
    const numValue = parseSidraValue(String(row.V));
    if (variable === "93") {
      entry.population = numValue;
    }
    if (variable === "6318") {
      entry.areaKm2 = numValue;
    }
  }
  return map;
}

/**
 * Reads GDP from national SIDRA 5938 into a lookup map.
 * @param {RawStore} raw
 * @returns {Map<string, number | null>}
 */
export function readGdpMap(raw) {
  const text = raw.texts.get(GDP_NATIONAL_FILE);
  if (!text) {
    throw new Error(`GDP file ${GDP_NATIONAL_FILE} missing in raw store`);
  }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) {
    throw new Error("SIDRA 5938 response is not an array");
  }

  const map = new Map();
  for (const row of rows) {
    if (!isNumericLevel(row.NC)) {
      continue;
    }
    const code = String(row.D1C);
    const variable = String(row.D2C);
    if (variable === "37") {
      map.set(code, parseSidraValue(String(row.V)));
    }
  }
  return map;
}

/**
 * Builds data/national/states.json document.
 * @param {any[]} hierarchyRows
 * @param {Map<string, { population: number | null, areaKm2: number | null }>} censusMap
 * @param {Map<string, number | null>} gdpMap
 * @param {RawStore} raw
 */
export function buildStatesDocument(hierarchyRows, censusMap, gdpMap, raw) {
  /** @type {Map<string, any[]>} */
  const munByUf = new Map();
  for (const row of hierarchyRows) {
    const ufId = String(row["UF-id"]);
    let list = munByUf.get(ufId);
    if (!list) {
      list = [];
      munByUf.set(ufId, list);
    }
    list.push(row);
  }

  let totalPop = 0;
  let totalArea = 0;
  let totalGdp = 0;
  let totalMuns = 0;

  const states = UF_CATALOG.map((uf) => {
    const muns = munByUf.get(uf.code);
    let municipalitiesCount = 0;
    let population = 0;
    let areaKm2 = 0;
    let gdpThousandBrl = 0;

    if (muns) {
      municipalitiesCount = muns.length;
      totalMuns += municipalitiesCount;

      for (const mun of muns) {
        const munCode = String(mun["municipio-id"]);
        const census = censusMap.get(munCode);
        if (census) {
          if (typeof census.population === "number") {
            population += census.population;
            totalPop += census.population;
          }
          if (typeof census.areaKm2 === "number") {
            areaKm2 += census.areaKm2;
            totalArea += census.areaKm2;
          }
        }
        const gdp = gdpMap.get(munCode);
        if (typeof gdp === "number") {
          gdpThousandBrl += gdp;
          totalGdp += gdp;
        }
      }
    }

    return {
      code: uf.code,
      sigla: uf.sigla,
      name: uf.name,
      regionCode: uf.regionCode,
      regionName: uf.regionName,
      municipalitiesCount,
      population,
      areaKm2: round3(areaKm2),
      gdpThousandBrl,
    };
  }).sort((a, b) => compareText(a.code, b.code));

  return {
    meta: createMeta(NATIONAL_CORE_SOURCES, raw),
    totals: {
      population: totalPop,
      areaKm2: round3(totalArea),
      gdpThousandBrl: totalGdp,
      statesCount: UF_CATALOG.length,
      municipalitiesCount: totalMuns,
    },
    states,
  };
}

/**
 * Builds data/national/mesh-states.topo.json document.
 * @param {RawStore} raw
 */
export function buildNationalMeshDocument(raw) {
  const text = raw.texts.get(BRAZIL_UFS_MESH_FILE);
  if (!text) {
    throw new Error(`National mesh file ${BRAZIL_UFS_MESH_FILE} missing in raw store`);
  }
  const sourceTopology = JSON.parse(text);
  const projected = projectTopology(sourceTopology);

  const rawGeometries = readSourceGeometries(projected);
  const geometries = rawGeometries
    .map((geom) => {
      const code = readGeometryCode(geom);
      const uf = findUf(code);
      let sigla = "";
      let name = "";
      let regionCode = "";
      let regionName = "";
      if (uf) {
        sigla = uf.sigla;
        name = uf.name;
        regionCode = uf.regionCode;
        regionName = uf.regionName;
      }
      return {
        type: geom.type,
        id: code,
        arcs: geom.arcs,
        properties: {
          codarea: code,
          sigla,
          name,
          regionCode,
          regionName,
        },
      };
    })
    .sort((a, b) => compareText(a.id, b.id));

  return {
    type: "Topology",
    meta: createMeta([BRAZIL_UFS_MESH_SOURCE], raw),
    transform: projected.transform,
    objects: { states: { type: "GeometryCollection", geometries } },
    arcs: projected.arcs,
  };
}

/**
 * Builds drill-down files for a single UF.
 * @param {{ ufInfo: UfInfo, hierarchyRows: any[], censusMap: Map<string, any>, gdpMap: Map<string, any>, raw: RawStore, rawDir: string, dataDir: string, quality: string }} params
 * @returns {Promise<boolean>}
 */
export async function buildUfDataset({
  ufInfo,
  hierarchyRows,
  censusMap,
  gdpMap,
  raw,
  rawDir,
  dataDir,
  quality,
}) {
  const ufCode = ufInfo.code;
  const ufSiglaLower = ufInfo.sigla.toLowerCase();

  const munRows = hierarchyRows
    .filter((row) => String(row["UF-id"]) === ufCode)
    .sort((a, b) => compareText(String(a["municipio-id"]), String(b["municipio-id"])));

  if (munRows.length === 0) {
    return false;
  }

  const meshRawFile = await findAvailableStateMeshFile(rawDir, ufCode, quality);
  let meshDoc = null;
  /** @type {Set<string> | null} */
  let validMeshCodes = null;
  if (meshRawFile) {
    const meshContent = await readFile(path.join(rawDir, meshRawFile), "utf8");
    const rawTopology = JSON.parse(meshContent);
    const projected = projectTopology(rawTopology);
    const geometries = readSourceGeometries(projected)
      .map((geom) => ({
        type: geom.type,
        id: readGeometryCode(geom),
        arcs: geom.arcs,
      }))
      .sort((a, b) => compareText(a.id, b.id));

    validMeshCodes = new Set(geometries.map((geom) => geom.id));

    meshDoc = {
      type: "Topology",
      meta: createMeta([createUfSourceStub(meshRawFile, ufInfo, quality)], raw),
      transform: projected.transform,
      objects: { municipalities: { type: "GeometryCollection", geometries } },
      arcs: projected.arcs,
    };
  }

  const columns = [
    "code",
    "name",
    "regionCode",
    "governmentRegionCode",
    "governmentRegionName",
    "population",
    "areaKm2",
    "gdpThousandBrl",
  ];

  const filteredMunRows = munRows.filter((mun) => {
    if (!validMeshCodes) {
      return true;
    }
    return validMeshCodes.has(String(mun["municipio-id"]));
  });

  const rows = filteredMunRows.map((mun) => {
    const code = String(mun["municipio-id"]);
    const name = mun["municipio-nome"];
    const regionCode = String(mun["regiao-intermediaria-id"]);
    const govCode = String(mun["regiao-imediata-id"]);
    const govName = mun["regiao-imediata-nome"];
    const census = censusMap.get(code);
    let pop = null;
    let area = null;
    if (census) {
      pop = census.population;
      area = census.areaKm2;
    }
    const gdp = gdpMap.get(code) ?? null;
    return [code, name, regionCode, govCode, govName, pop, area, gdp];
  });

  const municipalitiesDoc = {
    schemaVersion: 1,
    columns,
    rows,
    meta: createMeta([HIERARCHY_SOURCE, CENSUS_NATIONAL_SOURCE, GDP_NATIONAL_SOURCE], raw),
  };

  /** @type {Map<string, string>} */
  const regionLabels = new Map();
  /** @type {Map<string, string>} */
  const govRegionLabels = new Map();

  for (const mun of filteredMunRows) {
    const regCode = String(mun["regiao-intermediaria-id"]);
    const regName = mun["regiao-intermediaria-nome"];
    if (!regionLabels.has(regCode)) {
      regionLabels.set(regCode, regName);
    }
    const govCode = String(mun["regiao-imediata-id"]);
    const govName = mun["regiao-imediata-nome"];
    if (!govRegionLabels.has(govCode)) {
      govRegionLabels.set(govCode, govName);
    }
  }

  const regions = [...regionLabels.entries()]
    .map(([code, label]) => ({ code, label }))
    .sort((a, b) => compareText(a.code, b.code));

  const governmentRegions = [...govRegionLabels.entries()]
    .map(([code, label]) => ({ code, label }))
    .sort((a, b) => compareText(a.code, b.code));

  const regionsDoc = {
    meta: createMeta([HIERARCHY_SOURCE], raw),
    regions,
    governmentRegions,
  };

  const dirByCode = path.join(dataDir, "ufs", ufCode);
  const dirBySigla = path.join(dataDir, "ufs", ufSiglaLower);

  await writeUfArtifacts(dirByCode, municipalitiesDoc, regionsDoc, meshDoc);
  await writeUfArtifacts(dirBySigla, municipalitiesDoc, regionsDoc, meshDoc);

  return true;
}

/**
 * Writes municipalities.json, regions.json and optional mesh.topo.json(.gz) to target directory.
 * @param {string} targetDir
 * @param {any} municipalitiesDoc
 * @param {any} regionsDoc
 * @param {any | null} meshDoc
 */
async function writeUfArtifacts(targetDir, municipalitiesDoc, regionsDoc, meshDoc) {
  await mkdir(targetDir, { recursive: true });
  await writeFile(
    path.join(targetDir, "municipalities.json"),
    serializeCompact(municipalitiesDoc),
    "utf8",
  );
  await writeFile(path.join(targetDir, "regions.json"), serializeCompact(regionsDoc), "utf8");
  if (meshDoc) {
    const meshJson = JSON.stringify(meshDoc);
    await writeFile(path.join(targetDir, "mesh.topo.json"), meshJson, "utf8");
    await writeFile(path.join(targetDir, "mesh.topo.json.gz"), gzipSync(meshJson, { level: 9 }));
  }
}

/**
 * Checks for existing raw mesh file for state.
 * @param {string} rawDir
 * @param {string} ufCode
 * @param {string} quality
 * @returns {Promise<string | null>}
 */
async function findAvailableStateMeshFile(rawDir, ufCode, quality) {
  const preferred = getUfMeshFileName(ufCode, quality);
  try {
    await readFile(path.join(rawDir, preferred));
    return preferred;
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const fallback = getUfMeshFileName(ufCode, "minima");
  try {
    await readFile(path.join(rawDir, fallback));
    return fallback;
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  return null;
}

/**
 * Determines list of UFs to process.
 * @param {{ uf?: string, all?: boolean }} params
 * @returns {string[]}
 */
export function determineTargetUfs({ uf = "", all = false } = {}) {
  if (uf) {
    return uf
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => {
        const found = findUf(item);
        if (found) {
          return found.code;
        }
        return item;
      });
  }

  if (all) {
    return UF_CATALOG.map((item) => item.code);
  }

  return ["35"];
}

/**
 * Extracts geometries from first object collection in TopoJSON.
 * @param {any} topology
 * @returns {any[]}
 */
function readSourceGeometries(topology) {
  const collections = Object.values(topology.objects);
  if (collections.length === 0) {
    throw new Error("Topology objects has no collections");
  }
  return collections[0].geometries;
}

/**
 * Extracts geometry identifier code.
 * @param {any} geometry
 * @returns {string}
 */
function readGeometryCode(geometry) {
  const code = geometry.properties?.codarea;
  if (code !== undefined) {
    return String(code);
  }
  return String(geometry.id);
}

/**
 * Creates DataMeta object for documents.
 * @param {readonly RawSource[]} sources
 * @param {RawStore} raw
 */
function createMeta(sources, raw) {
  /** @type {string[]} */
  const retrievals = [];
  /** @type {Record<string, string>} */
  const rawSha256 = {};
  for (const source of sources) {
    const recorded = raw.checksums[source.file];
    if (recorded) {
      retrievals.push(recorded.retrievedAt);
      rawSha256[source.file] = recorded.sha256;
    }
  }
  let retrievedAt = new Date().toISOString();
  if (retrievals.length > 0) {
    retrievals.sort(compareText);
    retrievedAt = retrievals[retrievals.length - 1];
  }
  return {
    source: sources.map((s) => s.source).join("; "),
    sourceUrl: sources.map((s) => s.url),
    year: [...new Set(sources.map((s) => s.year))].sort((a, b) => a - b),
    retrievedAt,
    license: {
      condition: [...new Set(sources.map((s) => s.licenseCondition))].join("; "),
      credit: [...new Set(sources.map((s) => s.credit))].join("; "),
    },
    rawSha256,
  };
}

/**
 * Lightweight stub for state mesh sources when creating meta.
 * @param {string} fileName
 * @param {UfInfo} ufInfo
 * @param {string} quality
 * @returns {RawSource}
 */
function createUfSourceStub(fileName, ufInfo, quality) {
  return {
    file: fileName,
    url: `https://servicodados.ibge.gov.br/api/v3/malhas/estados/${ufInfo.code}?formato=application/json&qualidade=${quality}&intrarregiao=municipio&periodo=2022`,
    source: `IBGE, Malha Municipal 2022, ${ufInfo.name} (${ufInfo.sigla}), API v3`,
    year: 2022,
    credit: "IBGE, Malha Municipal, 2022",
    licenseCondition: "Licença compatível com Creative Commons BY 4.0, com crédito ao IBGE",
  };
}

/** @param {unknown} document */
function serializeCompact(document) {
  return `${JSON.stringify(document)}\n`;
}

/** @param {number} val */
function round3(val) {
  return Math.round(val * 1000) / 1000;
}

/** @param {unknown} level */
function isNumericLevel(level) {
  return typeof level === "string" && /^\d+$/.test(level);
}

/**
 * @param {string} left
 * @param {string} right
 */
function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** @param {unknown} error */
function isMissingFile(error) {
  if (error instanceof Error) {
    if (Reflect.get(error, "code") === "ENOENT") {
      return true;
    }
  }
  return false;
}

/** @param {unknown} error */
function describeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return realpathSync(entry) === fileURLToPath(import.meta.url);
}

async function runCli() {
  const { values } = parseArgs({
    options: {
      quality: { type: "string", default: DEFAULT_MESH_QUALITY },
      uf: { type: "string", default: "" },
      all: { type: "boolean", default: false },
    },
  });

  try {
    const summary = await buildNational({
      quality: values.quality,
      uf: values.uf,
      all: values.all,
    });
    console.log(`Built national files: ${summary.nationalFiles.join(", ")}`);
    console.log(`Built UF drill-down datasets: ${summary.ufsBuilt.join(", ")}`);
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
  }
}
