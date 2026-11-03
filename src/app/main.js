import { readSelectionComparison } from "../domain/compare.js";
import { computeIndicatorValues } from "../domain/indicator.js";
import { createSelector } from "../domain/memo.js";
import { createTerritory } from "../domain/territory.js";
import { readSharedArcs } from "../domain/topology.js";
import { createEngine } from "../engine/engine.js";
import { buildMunicipalities } from "../engine/geometry.js";
import { mountAuthorshipView } from "../features/authorship/authorship-view.js";
import { mountCameraControls } from "../features/camera/camera-view.js";
import {
  mountDemoSettingsControl,
  mountIndicatorNotice,
  mountStageBanner,
  STAGE_BANNER_TITLE,
} from "../features/demo/demo-view.js";
import {
  changeIndicator,
  INDICATOR_IDS,
  selectIndicatorDefinition,
} from "../features/indicator/indicator-slice.js";
import { mountIndicatorView } from "../features/indicator/indicator-view.js";
import { mountPillView } from "../features/indicator/pill-view.js";
import { mountSourceView } from "../features/indicator/source-view.js";
import {
  mountBottomNavView,
  NAV_TAB_COMPARE,
  NAV_TAB_INDICATORS,
  NAV_TAB_LAYERS,
  NAV_TAB_MAP,
  NAV_TAB_MUNICIPALITIES,
} from "../features/layout/bottom-nav-view.js";
import { mountLayoutToggle } from "../features/layout/layout-view.js";
import { mountModeToggle } from "../features/layout/mode-toggle-view.js";
import { mountThemeToggle } from "../features/layout/theme-toggle-view.js";
import { changeLevel } from "../features/level/level-slice.js";
import { mountLevelView } from "../features/level/level-view.js";
import {
  changeTerritory,
  completeTransition,
  resolveUfCode,
  resolveUfSigla,
  startTransition,
} from "../features/navigation/navigation-slice.js";
import { mountNavigationView } from "../features/navigation/navigation-view.js";
import { mountRegionLabelsView } from "../features/region-labels/region-labels-view.js";
import { mountHowToReadView } from "../features/scale/how-to-read-view.js";
import { mountLegendView } from "../features/scale/legend-view.js";
import {
  buildBandLabels,
  hasMissingValues,
  selectBreaks,
  selectClassIndexes,
  selectHeightTargets,
  selectStepHeightTargets,
} from "../features/scale/scale-slice.js";
import { mountClassFilterView } from "../features/selection/class-filter-view.js";
import { mountClearView } from "../features/selection/clear-view.js";
import { mountPanelView } from "../features/selection/panel-view.js";
import { mountSearchView } from "../features/selection/search-view.js";
import {
  toggleGovernmentRegionAction,
  toggleMunicipalityAction,
  toggleRegionAction,
} from "../features/selection/selection-slice.js";
import {
  buildAppearanceViewModel,
  createAppearanceView,
} from "../features/settings/appearance-view.js";
import { createMeasurementsView } from "../features/settings/measurements-view.js";
import {
  changeMotionReduced,
  selectCameraSettings,
  selectLightSettings,
} from "../features/settings/settings-slice.js";
import { createSettingsView } from "../features/settings/settings-view.js";
import { mountTableFeature } from "../features/table/table-slice.js";
import { loadStatus, loadTerritoryData } from "./data-loader.js";
import { isElectionFeatureEnabled, loadElectionModules } from "./election-loader.js";
import { buildHeaderStats, buildMapMetrics, mountHeaderStats } from "./header-stats.js";
import { projectPaletteForMode, readPalette } from "./palette.js";
import {
  attachProjection,
  bindToChange,
  createProjection,
  createRootSelectors,
} from "./projection.js";
import { mountStageView } from "./stage-view.js";
import {
  changeData,
  changeInspectedUnit,
  changePointedUnit,
  changeTab,
  createInitialState,
  readModeAttribute,
  reduceRootState,
} from "./state.js";
import { createStore } from "./store.js";
import { installTestHooks } from "./test-hooks.js";
import { parseUrlState, syncUrlState } from "./url-state.js";

const MEASUREMENTS_REFRESH_MS = 500;
const STEP_HEIGHT_MODE = "step";

/** @type {import("./projection.js").ScaleRules} */
const SCALE_RULES = {
  toColorPositions: classifyColorPositions,
  toHeightTargets: computeModeHeightTargets,
};

/**
 * Boots the application runtime and mounts all views and projections.
 * Follows BAS-01, BAS-03, BAS-04, BAS-11, BAS-12, ERR-01, ERR-02 and ERR-03.
 *
 * @param {Document} [documentRef]
 * @param {Window} [windowRef]
 */
export async function bootApplication(documentRef = document, windowRef = window) {
  performance.mark("data:start");

  const stageElement = documentRef.getElementById("map-stage");
  const canvasElement = /** @type {HTMLCanvasElement | null} */ (
    documentRef.getElementById("map-canvas")
  );
  if (!stageElement || !canvasElement) {
    throw new Error("Missing stage or canvas elements");
  }

  const stageView = mountStageView(documentRef, stageElement, canvasElement);
  stageView.setStatus("Carregando dados...");

  const status = await loadStatus(fetch);
  const injectedNow = /** @type {any} */ (windowRef)?.__mapNow;
  const urlState = parseUrlState(windowRef?.location?.search || "", {
    status,
    now: injectedNow,
  });

  const initialUf = urlState.uf || null;
  let data;
  try {
    data = await loadTerritoryData(initialUf, fetch, (file) => {
      stageView.setStatus(`Carregando ${file}...`);
    });
  } catch (error) {
    const message = /** @type {Error} */ (error).message;
    stageView.setAlert(message);
    return { store: null, engine: null, territory: null };
  }

  let territory = createTerritory({
    municipalities: data.municipalities,
    regions: data.regions,
  });

  const buildStartedAt = performance.now();
  const geo = buildMunicipalities(data.mesh);
  const buildMilliseconds = performance.now() - buildStartedAt;

  const selectors = createRootSelectors(SCALE_RULES, readMapCenters(geo.municipalities));
  const municipalityIndexByCode = indexByCode(data.municipalities);

  const initialState = createInitialState(data, {
    indicatorId: urlState.indicatorId,
    levelId: urlState.levelId,
    tab: urlState.tab,
    status,
    uf: initialUf,
  });
  const store = createStore(reduceRootState, initialState);
  if (documentRef?.documentElement) {
    documentRef.documentElement.dataset.mode = readModeAttribute(store.getState());
  }
  if (windowRef) {
    /** @type {any} */ (windowRef).__appStore = store;
  }

  const pillContainer = documentRef.getElementById("pointed-pill");
  let pillView = null;
  let pillYear = null;
  if (pillContainer) {
    pillView = mountPillView(documentRef, pillContainer);
    pillYear = documentRef.createElement("span");
    pillYear.className = "pill-year";
    pillContainer.append(pillYear);
  }

  const periodBadge = documentRef.getElementById("period-badge");
  const headerStatsContainer = documentRef.getElementById("header-stats");
  let headerStatsView = null;
  if (headerStatsContainer) {
    headerStatsView = mountHeaderStats(documentRef, headerStatsContainer);
  }

  let isTransitioning = false;
  let currentGeo = geo;
  /** @type {any} */
  let nationalBounds = null;
  const nationalUfBounds = new Map();

  /**
   * @param {any} targetGeo
   */
  function recordNationalBounds(targetGeo) {
    if (!targetGeo) {
      return;
    }
    nationalBounds = targetGeo.mapBounds;
    for (let i = 0; i < targetGeo.municipalities.length; i += 1) {
      const m = targetGeo.municipalities[i];
      if (m && m.bounds) {
        nationalUfBounds.set(m.code, m.bounds);
        const sigla = resolveUfSigla(m.code);
        if (sigla) {
          nationalUfBounds.set(sigla, m.bounds);
          nationalUfBounds.set(sigla.toLowerCase(), m.bounds);
        }
        const code = resolveUfCode(m.code);
        if (code) {
          nationalUfBounds.set(code, m.bounds);
        }
      }
    }
  }

  /**
   * @param {any} ufKey
   * @param {any} [nationalGeoRef]
   */
  function findNationalUfBounds(ufKey, nationalGeoRef) {
    if (ufKey && nationalUfBounds.has(ufKey)) {
      return nationalUfBounds.get(ufKey);
    }
    const sigla = resolveUfSigla(ufKey);
    if (sigla && nationalUfBounds.has(sigla)) {
      return nationalUfBounds.get(sigla);
    }
    const code = resolveUfCode(ufKey);
    if (code && nationalUfBounds.has(code)) {
      return nationalUfBounds.get(code);
    }
    if (nationalGeoRef && nationalGeoRef.municipalities) {
      for (let i = 0; i < nationalGeoRef.municipalities.length; i += 1) {
        const m = nationalGeoRef.municipalities[i];
        if (m.code === ufKey || m.code === sigla || m.code === code) {
          return m.bounds;
        }
      }
    }
    return null;
  }

  if (!initialUf) {
    recordNationalBounds(geo);
  }

  const navigationContainer = documentRef.getElementById("navigation-container");
  /** @type {import("../features/navigation/navigation-view.js").NavigationView | null} */
  let navigationView = null;
  /** @type {ReturnType<typeof mountSearchView> | null} */
  let searchView = null;
  if (navigationContainer) {
    navigationView = mountNavigationView(navigationContainer, {
      documentRef,
      onSelectTerritory: (targetUf) => {
        if (isTransitioning) {
          return;
        }
        transitionTerritory(targetUf);
      },
    });
    navigationView.update(store.getState().navigation);
    store.subscribe((state) => {
      if (navigationView) {
        navigationView.update(state.navigation);
      }
    });
  }

  /**
   * @param {string | null} [targetUf]
   */
  async function transitionTerritory(targetUf) {
    if (isTransitioning) {
      return;
    }
    const cleanUf = targetUf || null;
    const currentActiveUf = store.getState().navigation.activeUf;
    if (currentActiveUf === cleanUf) {
      return;
    }

    let isMotionReduced = false;
    if (windowRef?.matchMedia) {
      const media = windowRef.matchMedia("(prefers-reduced-motion: reduce)");
      if (media.matches) {
        isMotionReduced = true;
      }
    }
    const currentSettings = store.getState().settings;
    if (currentSettings && currentSettings.isMotionReduced) {
      isMotionReduced = true;
    }

    if (isMotionReduced) {
      isTransitioning = true;
      store.dispatch(startTransition());
      stageView.setStatus("Carregando território...");
      try {
        const nextData = await loadTerritoryData(cleanUf, fetch, (file) => {
          stageView.setStatus(`Carregando ${file}...`);
        });
        territory = createTerritory({
          municipalities: nextData.municipalities,
          regions: nextData.regions,
        });
        if (searchView && typeof searchView.updateTerritory === "function") {
          searchView.updateTerritory(territory);
        }
        const nextGeo = buildMunicipalities(nextData.mesh);
        currentGeo = nextGeo;
        if (cleanUf === null) {
          recordNationalBounds(nextGeo);
        }
        if (engine) {
          engine.replaceMesh(nextGeo, { immediate: true });
          engine.frameBoundsNow(nextGeo.mapBounds, { isWholeMap: true });
        }
        store.dispatch(changeData(nextData));
        store.dispatch(changeTerritory(cleanUf));
        syncUrlState(windowRef, {
          indicatorId: store.getState().indicator.id,
          levelId: store.getState().level.id,
          tab: store.getState().tab,
          uf: cleanUf,
        });
        stageView.setStatus("");
      } catch (_error) {
        stageView.setAlert("Falha ao carregar território.");
      } finally {
        isTransitioning = false;
        store.dispatch(completeTransition());
      }
      return;
    }

    isTransitioning = true;
    store.dispatch(startTransition());

    if (currentActiveUf === null && cleanUf !== null) {
      stageView.setStatus("Carregando território...");
      try {
        recordNationalBounds(currentGeo);
        const targetCode = resolveUfCode(cleanUf);
        const targetSigla = resolveUfSigla(cleanUf);
        let targetUnit = null;
        for (let i = 0; i < currentGeo.municipalities.length; i += 1) {
          const m = currentGeo.municipalities[i];
          if (m.code === targetCode || m.code === targetSigla || m.code === cleanUf) {
            targetUnit = m;
            break;
          }
        }

        let targetBounds = currentGeo.mapBounds;
        if (targetUnit && targetUnit.bounds) {
          targetBounds = targetUnit.bounds;
        }

        let cameraFlightPromise = Promise.resolve();
        let flattenOthersPromise = Promise.resolve();
        if (engine) {
          cameraFlightPromise = engine.transitionCameraToBounds(targetBounds, {
            durationMs: 500,
          });
          /** @type {(string | number)[]} */
          let selectedIndexes = [];
          if (targetUnit) {
            selectedIndexes = [targetUnit.code];
          }
          flattenOthersPromise = engine.interpolateUnselectedHeights(0.001, {
            durationMs: 450,
            selectedIndexes,
          });
        }

        const dataPromise = loadTerritoryData(cleanUf, fetch, (file) => {
          stageView.setStatus(`Carregando ${file}...`);
        });

        const [_, __, nextData] = await Promise.all([
          cameraFlightPromise,
          flattenOthersPromise,
          dataPromise,
        ]);

        const nextGeo = buildMunicipalities(nextData.mesh);
        currentGeo = nextGeo;

        if (engine) {
          engine.replaceMesh(nextGeo, {
            immediate: true,
            initialScaleZ: 0.001,
            initialCamera: { pan: { x: 0, y: 0, z: 0 }, zoom: 1.15 },
            resetView: false,
          });
        }

        territory = createTerritory({
          municipalities: nextData.municipalities,
          regions: nextData.regions,
        });
        if (searchView && typeof searchView.updateTerritory === "function") {
          searchView.updateTerritory(territory);
        }

        store.dispatch(changeData(nextData));
        store.dispatch(changeTerritory(cleanUf));

        if (engine) {
          const cameraAdjustPromise = engine.transitionCameraToBounds(nextGeo.mapBounds, {
            durationMs: 300,
            isWholeMap: true,
          });
          /** @type {number | Float32Array} */
          let targetHeights = 1.0;
          const currentTab = store.getState().tab;
          if (currentTab !== "first-round" && currentTab !== "second-round") {
            targetHeights = selectors.selectHeightTargets(store.getState());
          }
          const heightsRisePromise = engine.interpolateHeights(targetHeights, { durationMs: 400 });
          await Promise.all([cameraAdjustPromise, heightsRisePromise]);
        }

        syncUrlState(windowRef, {
          indicatorId: store.getState().indicator.id,
          levelId: store.getState().level.id,
          tab: store.getState().tab,
          uf: cleanUf,
        });
        stageView.setStatus("");
      } catch (_error) {
        stageView.setAlert("Falha ao carregar território.");
      } finally {
        isTransitioning = false;
        store.dispatch(completeTransition());
      }
      return;
    }

    if (currentActiveUf !== null && cleanUf === null) {
      stageView.setStatus("Retornando ao Brasil...");
      try {
        const previousUf = currentActiveUf;
        let flattenPromise = Promise.resolve();
        if (engine) {
          flattenPromise = engine.flattenHeights({ durationMs: 350, scaleZ: 0.001 });
        }
        const dataPromise = loadTerritoryData(null, fetch, (file) => {
          stageView.setStatus(`Carregando ${file}...`);
        });

        const [_, nextData] = await Promise.all([flattenPromise, dataPromise]);
        const nextGeo = buildMunicipalities(nextData.mesh);
        currentGeo = nextGeo;
        recordNationalBounds(nextGeo);

        const ufBounds = findNationalUfBounds(previousUf, nextGeo);

        if (engine) {
          let initialBounds = nextGeo.mapBounds;
          if (ufBounds) {
            initialBounds = ufBounds;
          }
          engine.replaceMesh(nextGeo, {
            immediate: true,
            initialScaleZ: 0.001,
            bounds: initialBounds,
            resetView: false,
          });
        }

        territory = createTerritory({
          municipalities: nextData.municipalities,
          regions: nextData.regions,
        });
        if (searchView && typeof searchView.updateTerritory === "function") {
          searchView.updateTerritory(territory);
        }

        store.dispatch(changeData(nextData));
        store.dispatch(changeTerritory(null));

        if (engine) {
          const cameraFlightPromise = engine.transitionCameraToBounds(nextGeo.mapBounds, {
            durationMs: 600,
            isWholeMap: true,
          });
          /** @type {number | Float32Array} */
          let targetHeights = 1.0;
          const currentTab = store.getState().tab;
          if (currentTab !== "first-round" && currentTab !== "second-round") {
            targetHeights = selectors.selectHeightTargets(store.getState());
          }
          const heightsRisePromise = engine.interpolateHeights(targetHeights, { durationMs: 500 });
          await Promise.all([cameraFlightPromise, heightsRisePromise]);
        }

        syncUrlState(windowRef, {
          indicatorId: store.getState().indicator.id,
          levelId: store.getState().level.id,
          tab: store.getState().tab,
          uf: null,
        });
        stageView.setStatus("");
      } catch (_error) {
        stageView.setAlert("Falha ao carregar território.");
      } finally {
        isTransitioning = false;
        store.dispatch(completeTransition());
      }
      return;
    }

    stageView.setStatus("Carregando território...");
    try {
      let flattenPromise = Promise.resolve();
      if (engine) {
        flattenPromise = engine.flattenHeights({ durationMs: 350, scaleZ: 0.001 });
      }
      const dataPromise = loadTerritoryData(cleanUf, fetch, (file) => {
        stageView.setStatus(`Carregando ${file}...`);
      });

      const [_, nextData] = await Promise.all([flattenPromise, dataPromise]);
      const nextGeo = buildMunicipalities(nextData.mesh);
      currentGeo = nextGeo;

      if (engine) {
        engine.replaceMesh(nextGeo, {
          immediate: true,
          initialScaleZ: 0.001,
          initialCamera: { pan: { x: 0, y: 0, z: 0 }, zoom: 1.15 },
          resetView: false,
        });
      }

      territory = createTerritory({
        municipalities: nextData.municipalities,
        regions: nextData.regions,
      });
      if (searchView && typeof searchView.updateTerritory === "function") {
        searchView.updateTerritory(territory);
      }

      store.dispatch(changeData(nextData));
      store.dispatch(changeTerritory(cleanUf));

      if (engine) {
        const cameraAdjustPromise = engine.transitionCameraToBounds(nextGeo.mapBounds, {
          durationMs: 300,
          isWholeMap: true,
        });
        /** @type {number | Float32Array} */
        let targetHeights = 1.0;
        const currentTab = store.getState().tab;
        if (currentTab !== "first-round" && currentTab !== "second-round") {
          targetHeights = selectors.selectHeightTargets(store.getState());
        }
        const heightsRisePromise = engine.interpolateHeights(targetHeights, { durationMs: 400 });
        await Promise.all([cameraAdjustPromise, heightsRisePromise]);
      }

      syncUrlState(windowRef, {
        indicatorId: store.getState().indicator.id,
        levelId: store.getState().level.id,
        tab: store.getState().tab,
        uf: cleanUf,
      });
      stageView.setStatus("");
    } catch (_error) {
      stageView.setAlert("Falha ao carregar território.");
    } finally {
      isTransitioning = false;
      store.dispatch(completeTransition());
    }
  }

  const indicatorContainer = documentRef.getElementById("indicator-container");
  let indicatorView = null;
  if (indicatorContainer) {
    indicatorView = mountIndicatorView(documentRef, store.dispatch);
    indicatorView.update(store.getState().indicator);
    indicatorContainer.append(indicatorView.element);
  }

  const demoNotice = mountIndicatorNotice(documentRef);
  if (indicatorView) {
    indicatorView.element.append(demoNotice.element);
  }
  const demoBanner = mountStageBanner(documentRef, store.dispatch);
  stageElement.append(demoBanner.element);
  const demoSettings = mountDemoSettingsControl(documentRef, store.dispatch);
  const demoViews = [demoNotice, demoBanner, demoSettings];

  const levelContainer = documentRef.getElementById("level-container");
  let levelView = null;
  if (levelContainer) {
    levelView = mountLevelView(documentRef, store.dispatch);
    levelView.update(store.getState().level);
    levelContainer.append(levelView.element);
  }

  const appearanceView = mountAppearanceView(documentRef, store);

  const selectionContainer = documentRef.getElementById("selection-container");
  let classFilterView = null;
  let clearView = null;
  let panelView = null;

  const sidebar = documentRef.getElementById("sidebar");
  if (sidebar && !documentRef.getElementById("app-footer")) {
    const authorship = mountAuthorshipView(documentRef);
    sidebar.append(authorship.element);
  }

  let layoutToggle = null;
  if (sidebar) {
    const handleResize = () => {
      if (windowRef) {
        windowRef.dispatchEvent(new Event("resize"));
      }
    };
    layoutToggle = mountLayoutToggle(documentRef, sidebar, () => {
      handleResize();
    });
    sidebar.addEventListener("transitionend", handleResize);
    layoutToggle.element.style.left = "0";
    layoutToggle.element.style.right = "auto";
    stageElement.append(layoutToggle.element);
  }

  const palette = readPalette(documentRef);

  const stageOverlay = documentRef.getElementById("stage-overlay") || stageElement;
  const initialDef = selectIndicatorDefinition(store.getState().indicator);
  const sourceView = mountSourceView(documentRef, initialDef);
  if (periodBadge) {
    periodBadge.textContent = describePeriod(initialDef, false);
  }
  if (headerStatsView) {
    headerStatsView.update(
      buildHeaderStats({
        municipalities: data.municipalities,
        isDemoActive: false,
        syntheticLabel: STAGE_BANNER_TITLE,
      }),
    );
  }

  const initialValues = computeIndicatorValues(initialDef, data.municipalities);
  const initialLevel = /** @type {import("../domain/classification.js").TerritorialLevel} */ (
    store.getState().level.id
  );
  const initialBreaks = selectBreaks(initialValues, initialLevel);
  const initialBandLabels = buildBandLabels(initialBreaks, store.getState().indicator.id);
  const initialHeightMode = store.getState().settings.heightMode;
  const legendView = mountLegendView(documentRef, {
    indicator: {
      ...initialDef,
      year: initialDef.yearDescription || initialDef.year,
    },
    level: initialLevel,
    labels: initialBandLabels,
    colors: palette.colors,
    hasMissing: hasMissingValues(initialValues),
    metrics: buildMapMetrics({
      definition: initialDef,
      records: data.municipalities,
      isDemoActive: false,
    }),
    heightMode: initialHeightMode,
  });

  const howToReadView = mountHowToReadView(documentRef, initialHeightMode);
  legendView.element.append(howToReadView.element);

  stageOverlay.append(legendView.element, sourceView.element);

  const regionLabelsView = mountRegionLabelsView(documentRef, stageElement);
  const updateRegionLabels = () => {
    if (!stageElement || !regionLabelsView) {
      return;
    }
    const state = store.getState();
    const isRegionLevel = state.level?.id === "region";
    const isRegionColor = state.settings?.colorMode === "region";
    const isElection = state.tab === "first-round" || state.tab === "second-round";
    const shouldShow = (isRegionLevel || isRegionColor) && !isElection;
    regionLabelsView.element.hidden = !shouldShow;
    if (!shouldShow) {
      return;
    }
    const stageRect = stageElement.getBoundingClientRect();
    let width = stageRect.width;
    let height = stageRect.height;
    if (width <= 0) {
      width = windowRef?.innerWidth || 1366;
    }
    if (height <= 0) {
      height = windowRef?.innerHeight || 768;
    }
    const occlusionBoxes = [];
    if (stageOverlay) {
      const overlayRect = stageOverlay.getBoundingClientRect();
      occlusionBoxes.push({
        x: overlayRect.left - stageRect.left,
        y: overlayRect.top - stageRect.top,
        width: overlayRect.width,
        height: overlayRect.height,
      });
    }
    regionLabelsView.update(width, height, { occlusionBoxes, hoverOnly: true });
  };
  updateRegionLabels();
  if (windowRef) {
    windowRef.addEventListener("resize", updateRegionLabels);
    windowRef.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      if (isTransitioning) {
        return;
      }
      const state = store.getState();
      if (state.navigation.activeUf === null) {
        return;
      }
      const isSearchOpen = documentRef.querySelector(".search-menu:not([hidden])");
      if (isSearchOpen) {
        return;
      }
      const isSettingsOpen = documentRef.querySelector(".settings-panel:not([hidden])");
      if (isSettingsOpen) {
        return;
      }
      const isTableOpen = documentRef.querySelector(".table-dialog:not([hidden])");
      if (isTableOpen) {
        return;
      }
      transitionTerritory(null);
    });
  }

  /** @type {import("../engine/engine.js").Engine} */
  let engine;
  try {
    engine = createEngine({
      canvas: canvasElement,
      geometry: {
        municipalities: geo.municipalities,
        plate: geo.plate,
        mapCenter: geo.mapCenter,
      },
      palette,
      onPoint: (code) => {
        if (isTransitioning) {
          return;
        }
        store.dispatch(changePointedUnit(code));
      },
      onInspect: (code) => {
        if (isTransitioning) {
          return;
        }
        store.dispatch(changeInspectedUnit(code));
      },
      onPick: (code) => {
        if (isTransitioning) {
          return;
        }
        if (!code) {
          return;
        }
        const state = store.getState();
        if (state.navigation.activeUf === null) {
          transitionTerritory(code);
          return;
        }
        if (state.level.id === "region") {
          const region = territory.regionOf(code);
          if (region) {
            store.dispatch(toggleRegionAction(region.code, territory));
          }
          return;
        }
        if (state.level.id === "governmentRegion") {
          const govRegion = territory.governmentRegionOf(code);
          if (govRegion) {
            store.dispatch(toggleGovernmentRegionAction(govRegion.code, territory));
          }
          return;
        }
        store.dispatch(toggleMunicipalityAction(code));
      },
      onZoomChange: () => {
        updateZoomButtons();
      },
    });
  } catch (_error) {
    stageView.setAlert("Este navegador não liberou WebGL, então o mapa não pode ser desenhado.");
    return { store, engine: null, territory };
  }

  // The search results follow the active indicator, the demo and the level (SEL-14). A hover
  // changes none of them, so it never recomputes the window (BAS-05).
  const selectSearchContext = createSelector(
    [
      selectors.selectActiveRecords,
      selectors.selectActiveIndicator,
      (state) => state.demo.isActive,
      (state) => state.level.id,
    ],
    (records, indicator, isDemoActive, level) => ({
      records,
      territory,
      indicator,
      isDemoActive,
      level,
    }),
  );

  if (selectionContainer) {
    searchView = mountSearchView(documentRef, store.dispatch, {
      territory,
      context: selectSearchContext(store.getState()),
      readSelectedCodes: () => store.getState().selection.selectedCodes,
      readActiveUf: () => store.getState().navigation?.activeUf ?? "SP",
      onSelectMunicipality: (selection) => {
        if (isTransitioning) {
          return;
        }
        const targetUf = selection?.targetUf || selection?.uf || selection?.destinationUf;
        if (targetUf && targetUf !== store.getState().navigation?.activeUf) {
          transitionTerritory(targetUf);
        }
      },
    });

    const initialClassIndexes = selectClassIndexes(initialValues, initialBreaks);
    const initialClassMap = buildClassIndexByCode(data.municipalities, initialClassIndexes);
    classFilterView = mountClassFilterView(documentRef, store.dispatch, {
      labels: initialBandLabels,
      classIndexByCode: initialClassMap,
      selectedClassIndex: null,
    });

    clearView = mountClearView(documentRef, store.dispatch, {
      onResetView: () => {
        engine.resetView();
        updateZoomButtons();
      },
    });

    const geometryIndexByCode = indexByCode(geo.municipalities);

    panelView = mountPanelView(documentRef, store.dispatch, {
      onPointUnit: (code) => {
        store.dispatch(changePointedUnit(code));
      },
      onFocusUnit: (/** @type {string} */ code) => {
        const indexes = readGeometryIndexes([code], geometryIndexByCode);
        if (indexes.length > 0) {
          engine.frameNow(indexes);
          updateZoomButtons();
        }
      },
    });

    const searchContainer = documentRef.getElementById("search-container");
    if (searchContainer) {
      searchContainer.append(searchView.element);
    }
    if (!searchContainer) {
      selectionContainer.append(searchView.element);
    }
    selectionContainer.append(classFilterView.element, clearView.element, panelView.element);
  }

  const cameraContainer = documentRef.getElementById("camera-controls");
  /** @type {ReturnType<typeof mountCameraControls> | null} */
  let cameraControls = null;
  function updateZoomButtons() {
    if (!cameraControls) {
      return;
    }
    if (!engine) {
      return;
    }
    if (typeof engine.readCamera !== "function") {
      return;
    }
    const cam = engine.readCamera();
    cameraControls.update(cam.zoomTarget, 7);
  }

  if (cameraContainer) {
    cameraControls = mountCameraControls(cameraContainer, {
      onZoomIn: () => {
        engine.zoomStep(1);
        updateZoomButtons();
      },
      onZoomOut: () => {
        engine.zoomStep(-1);
        updateZoomButtons();
      },
      onResetView: () => {
        engine.resetView();
        updateZoomButtons();
      },
      onToggle3d: () => {
        const cam = engine.readCamera();
        let nextAngle = 55;
        if (cam.viewAngleDegrees >= 50) {
          nextAngle = 0;
        }
        engine.setCameraOptions({ viewAngleDegrees: nextAngle });
        updateZoomButtons();
      },
      onCompass: () => {
        engine.resetView();
        updateZoomButtons();
      },
    });
    updateZoomButtons();
  }

  const geometryIndexByCode = indexByCode(geo.municipalities);
  const compareController = createLazyCompareController(documentRef, stageElement, store.dispatch, {
    onFocusUnits: (codes) => {
      const indexes = readGeometryIndexes(codes, geometryIndexByCode);
      if (indexes.length === 0) {
        return;
      }
      engine.frameNow(indexes);
      updateZoomButtons();
    },
  });

  const mobileBottomNavContainer = documentRef.getElementById("mobile-bottom-nav");
  /** @type {ReturnType<typeof mountBottomNavView> | null} */
  let mobileBottomNav = null;
  if (mobileBottomNavContainer) {
    const initialTab = store.getState().tab;
    const isInitialElection = initialTab === "first-round" || initialTab === "second-round";
    mobileBottomNav = mountBottomNavView(documentRef, mobileBottomNavContainer, {
      activeTab: NAV_TAB_MAP,
      isElection: isInitialElection,
      onTabSelect: (navTab) => {
        if (navTab === NAV_TAB_MAP) {
          if (layoutToggle) {
            layoutToggle.setSheetState("collapsed");
          }
          engine.resetView();
          updateZoomButtons();
          return;
        }
        if (navTab === NAV_TAB_INDICATORS) {
          if (layoutToggle) {
            layoutToggle.setSheetState("half");
          }
          const modeSlot = documentRef.getElementById("mode-selector-slot");
          if (modeSlot && !modeSlot.hidden) {
            modeSlot.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
          }
          if (indicatorContainer) {
            indicatorContainer.scrollIntoView({ behavior: "smooth", block: "start" });
          }
          return;
        }
        if (navTab === NAV_TAB_MUNICIPALITIES) {
          if (layoutToggle) {
            layoutToggle.setSheetState("expanded");
          }
          const searchInput = documentRef.getElementById("city-search");
          if (searchInput) {
            searchInput.focus();
          }
          if (selectionContainer) {
            selectionContainer.scrollIntoView({ behavior: "smooth", block: "start" });
          }
          return;
        }
        if (navTab === NAV_TAB_COMPARE) {
          const currentCodes = store.getState().selection.selectedCodes;
          if (currentCodes.length < 2) {
            store.dispatch(toggleMunicipalityAction("3550308"));
            store.dispatch(toggleMunicipalityAction("3509502"));
          }
          const compareDock = documentRef.getElementById("compare-dock");
          if (compareDock) {
            compareDock.hidden = false;
            compareDock.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
          return;
        }
        if (navTab === NAV_TAB_LAYERS) {
          if (layoutToggle) {
            layoutToggle.setSheetState("half");
          }
          if (levelContainer) {
            levelContainer.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
      },
    });
  }

  const settingsContainer = documentRef.getElementById("settings-container");
  /** @type {ReturnType<typeof mountSettingsPanel> | null} */
  let settingsPanel = null;
  if (settingsContainer) {
    settingsPanel = mountSettingsPanel(
      documentRef,
      settingsContainer,
      store,
      () => readMeasurements(engine, geo, buildMilliseconds),
      [demoSettings.element],
    );
    windowRef.setInterval(settingsPanel.refreshMeasurements, MEASUREMENTS_REFRESH_MS);
  }

  stageView.clearStatus();
  applyMotionPreferences(engine, store, windowRef);
  const modeToggleContainer = documentRef.getElementById("mode-toggle-container");
  /** @type {ReturnType<typeof mountModeToggle> | null} */
  let modeToggle = null;
  const isElectionEnabled = isElectionFeatureEnabled(status);
  if (modeToggleContainer) {
    if (!isElectionEnabled) {
      modeToggleContainer.hidden = true;
      modeToggleContainer.style.display = "none";
    }
    if (isElectionEnabled) {
      modeToggle = mountModeToggle(modeToggleContainer, {
        activeTab: store.getState().tab,
        documentRef,
        onSelectTab: (nextTab) => {
          store.dispatch(changeTab(nextTab));
        },
      });
    }
  }
  const themeToggle = mountThemeSwitch(engine, store, documentRef, windowRef);
  applyColorSchemePreferences(engine, store, documentRef, windowRef, () => {
    if (themeToggle) {
      themeToggle.refresh();
    }
  });

  const limitArcs = readSharedArcs(data.mesh, (code) => territory.regionOf(code)?.code ?? "");
  engine.setLimits({
    level: store.getState().level.id,
    limitArcs,
    topology: data.mesh,
  });

  const selectPillInputs = createSelector(
    [
      (state) => state.pointer?.pointedCode ?? state.pointer?.inspectedCode ?? null,
      selectors.selectActiveIndicator,
      selectors.selectActiveRecords,
      (state) => state.demo.isActive,
    ],
    (pointedCode, def, records, isDemoActive) => ({ pointedCode, def, records, isDemoActive }),
  );

  const pillBinding = bindToChange(
    selectPillInputs,
    ({ pointedCode, def, records, isDemoActive }) => {
      if (pillYear) {
        pillYear.textContent = describePeriod(def, isDemoActive);
      }
      if (!pillView) {
        return;
      }
      if (!pointedCode) {
        pillView.update({ code: null });
        if (regionLabelsView) {
          regionLabelsView.setPointedRegion(null);
        }
        return;
      }
      const mun = records[municipalityIndexByCode.get(pointedCode) ?? -1];
      let name = "";
      let value = null;
      let regionCode = null;
      if (mun) {
        name = mun.name;
        regionCode = mun.regionCode;
        const currentLevel = store.getState().level?.id;
        const currentColorMode = store.getState().settings?.colorMode;
        if (currentLevel === "region" || currentColorMode === "region") {
          name = mun.governmentRegionName || name;
        }
        if (currentLevel === "governmentRegion") {
          name = mun.governmentRegionName || name;
        }
        value = def.computeValue(mun);
      }
      pillView.update({
        code: pointedCode,
        name,
        value,
        indicatorId: def.id,
      });
      if (regionLabelsView) {
        const state = store.getState();
        const isRegionActive =
          state.level?.id === "region" || state.settings?.colorMode === "region";
        if (isRegionActive && regionCode) {
          regionLabelsView.setPointedRegion(regionCode);
        }
        if (!isRegionActive || !regionCode) {
          regionLabelsView.setPointedRegion(null);
        }
      }
    },
  );

  const demoBinding = bindToChange(
    (state) => state.demo,
    (demo) => {
      for (const view of demoViews) {
        view.update(demo);
      }
      setIndicatorsDisabled(indicatorView, demo.isActive);
    },
  );

  const selectIndicatorInputs = createSelector(
    [
      selectors.selectActiveIndicator,
      (state) => state.indicator.id,
      (state) => state.level.id,
      (state) => state.demo.isActive,
      selectors.selectIndicatorValues,
    ],
    (def, indicatorId, levelId, isDemoActive, values) => ({
      def,
      indicatorId,
      levelId,
      isDemoActive,
      values,
    }),
  );

  const indicatorBinding = bindToChange(
    selectIndicatorInputs,
    ({ def, indicatorId, levelId, isDemoActive }) => {
      const currentLevel = /** @type {import("../features/level/level-slice.js").LevelId} */ (
        levelId
      );
      if (indicatorView) {
        indicatorView.update(def.id);
      }
      if (levelView) {
        levelView.update({ id: currentLevel });
      }
      sourceView.update(def);
      if (periodBadge) {
        const isElectionTabActive =
          store.getState().tab === "first-round" || store.getState().tab === "second-round";
        if (isElectionTabActive) {
          periodBadge.textContent = "ELEIÇÕES 2026";
        }
        if (!isElectionTabActive) {
          periodBadge.textContent = describePeriod(def, isDemoActive);
        }
      }
      if (headerStatsView) {
        headerStatsView.update(
          buildHeaderStats({
            municipalities: data.municipalities,
            isDemoActive,
            syntheticLabel: STAGE_BANNER_TITLE,
          }),
        );
      }
      const values = selectors.selectIndicatorValues(store.getState());
      const breaks = selectors.selectHeatBreaks(store.getState());
      const labels = buildBandLabels(breaks, def.id);
      legendView.update({
        indicator: describeLegendIndicator(def, isDemoActive),
        level: currentLevel,
        labels,
        colors: palette.colors,
        hasMissing: hasMissingValues(values),
      });
      engine.setLimits({ level: currentLevel });
      updateRegionLabels();
      syncUrlState(windowRef, {
        indicatorId,
        levelId,
        tab: store.getState().tab,
        uf: store.getState().navigation?.activeUf,
        isDemoActive,
      });
    },
  );

  const modeBinding = bindToChange(selectors.selectModeAttribute, (mode) => {
    if (documentRef?.documentElement) {
      documentRef.documentElement.dataset.mode = mode;
    }
    updateRegionLabels();
    const currentState = store.getState();
    const isElection = currentState.tab === "first-round" || currentState.tab === "second-round";
    if (periodBadge) {
      if (isElection) {
        periodBadge.textContent = "ELEIÇÕES 2026";
      }
      if (!isElection) {
        const activeDef = selectIndicatorDefinition(currentState.indicator);
        periodBadge.textContent = describePeriod(activeDef, currentState.demo.isActive);
      }
    }
    if (mobileBottomNav) {
      mobileBottomNav.setElectionMode(isElection);
    }
    if (modeToggle) {
      modeToggle.update(currentState.tab);
    }
    syncUrlState(windowRef, {
      indicatorId: currentState.indicator.id,
      levelId: currentState.level.id,
      tab: currentState.tab,
      uf: currentState.navigation?.activeUf,
      isDemoActive: currentState.demo.isActive,
    });
  });

  const tabBinding = bindToChange(
    (state) => state.tab,
    (tab) => {
      if (modeToggle) {
        modeToggle.update(tab);
      }
      const currentState = store.getState();
      syncUrlState(windowRef, {
        indicatorId: currentState.indicator.id,
        levelId: currentState.level.id,
        tab,
        uf: currentState.navigation?.activeUf,
        isDemoActive: currentState.demo.isActive,
      });
    },
  );

  if (windowRef?.addEventListener) {
    windowRef.addEventListener("popstate", () => {
      const injected = /** @type {any} */ (windowRef)?.__mapNow;
      const parsed = parseUrlState(windowRef.location?.search || "", {
        status,
        now: injected,
      });
      const currentState = store.getState();
      if (parsed.tab !== currentState.tab) {
        store.dispatch(changeTab(parsed.tab));
      }
      if (parsed.indicatorId && parsed.indicatorId !== currentState.indicator.id) {
        store.dispatch(changeIndicator(parsed.indicatorId));
      }
      if (parsed.levelId && parsed.levelId !== currentState.level.id) {
        store.dispatch(changeLevel(parsed.levelId));
      }
    });
  }

  // The legend card figures follow the indicator, the demo and the selection (LAY-09)
  const selectMetricsInputs = createSelector(
    [
      selectors.selectActiveIndicator,
      selectors.selectActiveRecords,
      (state) => state.demo.isActive,
      (state) => state.selection.selectedCodes,
    ],
    (definition, records, isDemoActive, selectedCodes) => ({
      definition,
      records,
      isDemoActive,
      selectedCodes,
    }),
  );

  const metricsBinding = bindToChange(selectMetricsInputs, (inputs) => {
    legendView.updateMetrics(buildMapMetrics(inputs));
  });

  const selectSelectionInputs = createSelector(
    [
      (state) => state.selection.selectedCodes,
      (state) => state.selection.selectedClassIndex,
      (state) => state.selection.retentionNotice,
      selectors.selectActiveIndicator,
      selectors.selectActiveRecords,
      (state) => state.level.id,
      (state) => state.pointer?.inspectedCode ?? null,
    ],
    (selectedCodes, selectedClassIndex, retentionNotice, def, records, levelId, inspectedCode) => ({
      selectedCodes,
      selectedClassIndex,
      retentionNotice,
      def,
      records,
      levelId,
      inspectedCode,
    }),
  );

  // The comparison follows the selection, the active indicator, the demo and the level (SEL-11)
  const selectComparison = createSelector(
    [
      (state) => state.selection.selectedCodes,
      selectors.selectActiveIndicator,
      selectors.selectActiveRecords,
      (state) => state.demo.isActive,
      (state) => state.level.id,
    ],
    (selectedCodes, indicator, records, isDemoActive, level) =>
      readSelectionComparison(selectedCodes, {
        records,
        territory,
        indicator,
        isDemoActive,
        level,
      }),
  );

  const compareBinding = bindToChange(selectComparison, (comparison) => {
    compareController.update(comparison);
  });

  const searchBinding = bindToChange(selectSearchContext, (context) => {
    if (searchView) {
      searchView.updateContext(context);
    }
  });

  const selectLiftFlags = createSelector([(state) => state.settings.heightMode], (heightMode) => ({
    pointed: true,
    selected: heightMode === "flat",
  }));

  const liftBinding = bindToChange(selectLiftFlags, (flags) => {
    engine.setLiftEnabled(flags);
  });

  const selectionBinding = bindToChange(
    selectSelectionInputs,
    ({
      selectedCodes,
      selectedClassIndex,
      retentionNotice,
      def,
      records,
      levelId,
      inspectedCode,
    }) => {
      if (clearView) {
        clearView.update(store.getState().selection);
      }

      const vals = selectors.selectIndicatorValues(store.getState());
      const brks = selectors.selectHeatBreaks(store.getState());
      const bandLabels = buildBandLabels(brks, def.id);
      const classIdxs = selectClassIndexes(vals, brks);
      const classMap = buildClassIndexByCode(records, classIdxs);
      if (classFilterView) {
        classFilterView.update(bandLabels, selectedClassIndex, classMap);
      }

      if (panelView) {
        panelView.update(
          selectedCodes,
          retentionNotice,
          territory,
          def,
          /** @type {any} */ (levelId),
          records,
          inspectedCode,
        );
      }

      if (selectionContainer && selectedCodes.length > 0) {
        selectionContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      if (selectionContainer && inspectedCode) {
        selectionContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    },
  );

  const cameraSettingsBinding = bindToChange(
    (state) => selectCameraSettings(state.settings),
    (cameraSettings) => {
      engine.setCameraOptions(cameraSettings);
    },
  );

  const lightSettingsBinding = bindToChange(
    (state) => selectLightSettings(state.settings),
    ({ shadow, borders }) => {
      engine.setRenderOptions({ shadow, borders });
    },
  );

  const settingsViewBinding = bindToChange(
    (state) => state.settings,
    (settings) => {
      if (settingsPanel) {
        settingsPanel.refresh(settings);
      }
    },
  );

  // The color and height cards follow every settings change. A hover keeps the settings
  // reference, so it never rebuilds their view model (BAS-05).
  const selectAppearanceViewModel = createSelector(
    [(state) => state.settings],
    buildAppearanceViewModel,
  );

  const appearanceBinding = bindToChange(selectAppearanceViewModel, (viewModel) => {
    if (!appearanceView) {
      return;
    }
    appearanceView.update(viewModel);
    legendView.updateColorMode(viewModel.colorMode);
    howToReadView.updateColorMode(viewModel.colorMode);
    const updatedPalette = projectPaletteForMode(readPalette(documentRef), store.getState());
    engine.setPalette(updatedPalette);
    updateRegionLabels();
  });

  // The "Altura 3D" legend row and the height line of "Como ler este mapa" follow the mode (ESC-11)
  const heightModeBinding = bindToChange(
    (state) => state.settings.heightMode,
    (heightMode) => {
      legendView.updateHeightMode(heightMode);
      howToReadView.updateHeightMode(heightMode);
    },
  );

  const selectFramingInputs = createSelector(
    [(state) => state.selection.selectedCodes, (state) => state.settings.isFramingOn],
    (selectedCodes, isFramingOn) => ({ selectedCodes, isFramingOn }),
  );

  const framingBinding = bindToChange(selectFramingInputs, ({ selectedCodes, isFramingOn }) => {
    if (!isFramingOn) {
      return;
    }
    if (selectedCodes.length === 0) {
      engine.resetView();
      updateZoomButtons();
      return;
    }
    const indexes = readGeometryIndexes(selectedCodes, geometryIndexByCode);
    engine.frame(indexes);
    updateZoomButtons();
  });

  const project = createProjection({
    engine,
    selectors,
    views: [
      pillBinding,
      indicatorBinding,
      modeBinding,
      tabBinding,
      metricsBinding,
      selectionBinding,
      compareBinding,
      searchBinding,
      cameraSettingsBinding,
      framingBinding,
      liftBinding,
      lightSettingsBinding,
      settingsViewBinding,
      appearanceBinding,
      heightModeBinding,
      demoBinding,
    ],
  });
  attachProjection(store, project);
  mountTableFeature(documentRef, { store, territory, data });

  if (isElectionEnabled) {
    let electionLoading = false;
    const ensureElection = () => {
      const tab = store.getState().tab;
      if (electionLoading || tab === "indicators") return;
      electionLoading = true;
      loadElectionModules({ documentRef, windowRef, rawStatus: status })
        .then((result) => {
          if (!result.ok) throw result.error;
          return import("./election-wiring.js");
        })
        .then(({ initElectionWiring }) =>
          initElectionWiring({
            store,
            engine,
            documentRef,
            windowRef,
            status,
            fetchImpl: fetch,
            restoreIndicator: () => project(store.getState()),
          }),
        )
        .catch((error) => {
          electionLoading = false;
          console.warn("Failed to initialize election wiring:", error);
        });
    };
    store.subscribe(ensureElection);
    ensureElection();
  }

  installTestHooks({
    windowRef,
    store,
    engine,
    geometry: geo,
    territory,
    scaleRules: SCALE_RULES,
    palette,
    readCamera: () => {
      if (engine) {
        if (typeof engine.readCamera === "function") {
          return engine.readCamera();
        }
      }
      let height = canvasElement.clientHeight;
      if (!height) {
        height = 1;
      }
      let width = canvasElement.clientWidth;
      if (!width) {
        width = 1;
      }
      return {
        viewAngleDegrees: 55,
        aspect: width / height,
        zoom: 1,
        zoomTarget: 1,
        panX: 0,
        panY: 0,
        pan: { x: 0, y: 0, z: 0 },
      };
    },
    readLimits: () => {
      const level = store.getState().level.id;
      const isRegion = level === "region" || level === "governmentRegion";
      let borderOpacity = 1;
      if (isRegion) {
        borderOpacity = 0.3;
      }
      let activeArcs = limitArcs;
      if (level === "governmentRegion")
        activeArcs = readSharedArcs(data.mesh, (code) => territory.groupOf(level, code));
      return {
        visible: isRegion,
        borderOpacity,
        arcCount: activeArcs.length,
      };
    },
    readLegend: () => {
      const state = store.getState();
      const def = selectors.selectActiveIndicator(state);
      const legendIndicator = describeLegendIndicator(def, state.demo.isActive);
      const currentLevel = /** @type {import("../features/level/level-slice.js").LevelId} */ (
        state.level.id
      );
      const values = selectors.selectIndicatorValues(state);
      const breaks = selectors.selectHeatBreaks(state);
      const labels = buildBandLabels(breaks, def.id);
      const hasMissing = hasMissingValues(values);
      let levelLabel = "Município";
      if (currentLevel === "region") {
        levelLabel = "Região administrativa";
      }
      return {
        indicatorId: def.id,
        indicatorLabel: legendIndicator.label,
        levelId: currentLevel,
        levelLabel,
        unit: def.unit,
        year: legendIndicator.year,
        source: def.source,
        breaks: Array.from(breaks),
        labels,
        colors: palette.colors,
        hasMissing,
      };
    },
    selectors,
  });

  return { store, engine, territory };
}

/**
 * @param {Float64Array} values
 * @param {number[]} breaks heat breaks of the active level.
 * @returns {Uint8Array} the heat band of each value; the lowest band when the value has none.
 */
function classifyColorPositions(values, breaks) {
  const classIndexes = selectClassIndexes(values, breaks);
  return Uint8Array.from(classIndexes, readPalettePosition);
}

const MISSING_PALETTE_INDEX = 255;

/**
 * @param {number} classIndex heat band from 0 to 6, or -1 for a value without band.
 * @returns {number}
 */
function readPalettePosition(classIndex) {
  if (classIndex < 0) {
    return MISSING_PALETTE_INDEX;
  }
  return classIndex;
}

/**
 * The step mode reads the same breaks that paint the map, so a unit stands as tall as its color
 * says (ESC-10). The proportional and flat modes read the value alone.
 *
 * @param {Float64Array} values
 * @param {import("./projection.js").HeightTargetOptions} options
 * @returns {Float32Array}
 */
function computeModeHeightTargets(values, options) {
  if (options.heightMode === STEP_HEIGHT_MODE) {
    return selectStepHeightTargets(values, options.breaks, options);
  }
  return selectHeightTargets(values, undefined, undefined, options);
}

/**
 * Mounts the "Cor do mapa" and "Altura (eixo Z)" cards right after "Ver por" (LAY-02, LAY-10).
 *
 * @param {Document} documentRef
 * @param {import("./store.js").Store<import("./state.js").RootState, import("./state.js").Action>} store
 * @returns {ReturnType<typeof createAppearanceView> | null} null when the page has no place for them.
 */
function mountAppearanceView(documentRef, store) {
  const container = documentRef.getElementById("appearance-container");
  if (!container) {
    return null;
  }
  const view = createAppearanceView(documentRef, store.getState().settings, store.dispatch);
  container.append(view.element);
  return view;
}

/**
 * @param {readonly string[]} codes
 * @param {Map<string, number>} geometryIndexByCode
 * @returns {number[]} the geometry index of each code the map knows.
 */
function readGeometryIndexes(codes, geometryIndexByCode) {
  const indexes = codes.map((code) => geometryIndexByCode.get(code));
  return indexes.filter((index) => index !== undefined);
}

/**
 * Mounts the collapsed settings panel and its "Medições" section into the container.
 *
 * @param {Document} documentRef
 * @param {HTMLElement} container
 * @param {import("./store.js").Store<import("./state.js").RootState, import("./state.js").Action>} store
 * @param {() => import("../features/settings/measurements-view.js").Measurements} readMeasurements
 * @param {HTMLElement[]} extraSections sections of other features, placed before "Medições".
 */
function mountSettingsPanel(documentRef, container, store, readMeasurements, extraSections) {
  const view = createSettingsView(documentRef, store.getState().settings, store.dispatch);
  const measurements = createMeasurementsView(documentRef);
  const panel = view.element.querySelector("#settings-panel");
  if (panel) {
    panel.append(...extraSections, measurements.element);
  }
  container.append(view.element);
  const refreshMeasurements = () => {
    if (view.toggleButton.getAttribute("aria-expanded") !== "true") {
      return;
    }
    measurements.update(readMeasurements());
  };
  view.toggleButton.addEventListener("click", refreshMeasurements);
  return { refresh: view.refresh, refreshMeasurements };
}

/**
 * @param {import("../engine/engine.js").Engine} engine
 * @param {{ plate: { geometry: { getAttribute: (name: string) => { count: number } } } }} geo
 * @param {number} buildMilliseconds
 * @returns {import("../features/settings/measurements-view.js").Measurements}
 */
function readMeasurements(engine, geo, buildMilliseconds) {
  const stats = engine.readStats();
  return {
    buildMilliseconds,
    vertexCount: geo.plate.geometry.getAttribute("position").count,
    drawCalls: stats.drawCalls,
    triangles: stats.triangles,
    medianFrameMilliseconds: stats.medianRenderDuration,
  };
}

/**
 * @param {import("../engine/engine.js").Engine} engine
 * @param {import("./store.js").Store<import("./state.js").RootState, import("./state.js").Action>} store
 * @param {Window} windowRef
 */
function applyMotionPreferences(engine, store, windowRef) {
  if (typeof windowRef.matchMedia !== "function") {
    return;
  }
  const mediaQuery = windowRef.matchMedia("(prefers-reduced-motion: reduce)");
  if (!mediaQuery) {
    return;
  }
  if (mediaQuery.matches) {
    store.dispatch(changeMotionReduced(true));
    engine.setCameraOptions({ isMotionReduced: true });
  }
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", (e) => {
      store.dispatch(changeMotionReduced(e.matches));
      engine.setCameraOptions({ isMotionReduced: e.matches });
    });
  }
}

/**
 * Loads `compare-view.js` via dynamic `import()` only when 2 or more units are selected (`comparison !== null`),
 * keeping a hidden `#compare-dock` placeholder in `#map-stage` until then (PUB-08).
 *
 * @param {Document} documentRef
 * @param {HTMLElement} stageElement
 * @param {(action: any) => void} dispatch
 * @param {{ onFocusUnits: (codes: string[]) => void }} options
 * @returns {{ update: (comparison: any) => void }}
 */
function createLazyCompareController(documentRef, stageElement, dispatch, options) {
  let placeholder = documentRef.getElementById("compare-dock");
  if (!placeholder) {
    placeholder = documentRef.createElement("div");
    placeholder.id = "compare-dock";
    placeholder.className = "compare-dock";
    placeholder.hidden = true;
    stageElement.append(placeholder);
  }

  /** @type {{ element: HTMLElement, update: (comparison: any) => void } | null} */
  let mountedView = null;
  /** @type {Promise<any> | null} */
  let loadingPromise = null;
  /** @type {any} */
  let latestComparison = null;

  return {
    update(comparison) {
      latestComparison = comparison;
      if (mountedView) {
        mountedView.update(comparison);
        return;
      }
      if (!comparison) {
        if (placeholder) {
          placeholder.hidden = true;
        }
        return;
      }
      if (loadingPromise) {
        return;
      }
      loadingPromise = import("../features/selection/compare-view.js").then(
        ({ mountCompareView }) => {
          mountedView = mountCompareView(documentRef, dispatch, options);
          if (placeholder?.parentNode) {
            placeholder.replaceWith(mountedView.element);
          }
          if (!mountedView.element.parentNode) {
            stageElement.append(mountedView.element);
          }
          mountedView.update(latestComparison);
        },
      );
    },
  };
}

/**
 * @param {import("../engine/engine.js").Engine} engine
 * @param {import("./store.js").Store<import("./state.js").RootState, import("./state.js").Action>} store
 * @param {Document} documentRef
 * @param {Window} windowRef
 * @param {() => void} onSchemeChange runs after the map palette follows a system theme change.
 */
function applyColorSchemePreferences(engine, store, documentRef, windowRef, onSchemeChange) {
  if (typeof windowRef.matchMedia !== "function") {
    return;
  }
  const mediaQuery = windowRef.matchMedia("(prefers-color-scheme: dark)");
  if (!mediaQuery) {
    return;
  }
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", () => {
      const nextPalette = projectPaletteForMode(readPalette(documentRef), store.getState());
      engine.setPalette(nextPalette);
      onSchemeChange();
    });
  }
}

/**
 * Mounts the Claro and Escuro switch in the top bar and repaints the map on every pick (LAY-08, ELE-15).
 *
 * @param {import("../engine/engine.js").Engine} engine
 * @param {import("./store.js").Store<import("./state.js").RootState, import("./state.js").Action>} store
 * @param {Document} documentRef
 * @param {Window} windowRef
 * @returns {{ refresh: () => void } | null}
 */
function mountThemeSwitch(engine, store, documentRef, windowRef) {
  const container = documentRef.getElementById("theme-toggle-container");
  if (!container) {
    return null;
  }
  const themeToggle = mountThemeToggle(documentRef, {
    prefersDark: () => readPrefersDark(windowRef),
    onChange: () => {
      const nextPalette = projectPaletteForMode(readPalette(documentRef), store.getState());
      engine.setPalette(nextPalette);
    },
  });
  container.append(themeToggle.element);
  return themeToggle;
}

/**
 * @param {Window} windowRef
 * @returns {boolean}
 */
function readPrefersDark(windowRef) {
  if (typeof windowRef.matchMedia !== "function") {
    return false;
  }
  return windowRef.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * @param {Array<{ code: string, center: { x: number, y: number } }>} geometryMunicipalities
 * @returns {import("./projection.js").MapCenters}
 */
function readMapCenters(geometryMunicipalities) {
  return new Map(
    geometryMunicipalities.map((municipality) => [
      municipality.code,
      { x: municipality.center.x, y: municipality.center.y },
    ]),
  );
}

/**
 * @param {Array<{ code: string }>} records
 * @returns {Map<string, number>} position of each code in the list
 */
function indexByCode(records) {
  return new Map(records.map((record, index) => [record.code, index]));
}

/**
 * The year line of an indicator; the demo has no year, so it says where the data comes from.
 *
 * @param {import("../domain/indicator.js").IndicatorDefinition} def
 * @param {boolean} isDemoActive
 * @returns {string}
 */
function describePeriod(def, isDemoActive) {
  if (isDemoActive) {
    return STAGE_BANNER_TITLE;
  }
  return def.yearDescription || def.year;
}

/**
 * @param {import("../domain/indicator.js").IndicatorDefinition} def
 * @param {boolean} isDemoActive
 * @returns {import("../domain/indicator.js").IndicatorDefinition} the legend title names the
 *   synthetic data while the demo is on.
 */
function describeLegendIndicator(def, isDemoActive) {
  const year = describePeriod(def, isDemoActive);
  if (!isDemoActive) {
    return { ...def, year };
  }
  return { ...def, label: `${STAGE_BANNER_TITLE}: ${def.label}`, year };
}

/**
 * @param {{ getRadio: (id: string) => HTMLInputElement | null } | null} indicatorView
 * @param {boolean} isDisabled
 */
function setIndicatorsDisabled(indicatorView, isDisabled) {
  if (!indicatorView) {
    return;
  }
  for (const id of INDICATOR_IDS) {
    const radio = indicatorView.getRadio(id);
    if (radio) {
      radio.disabled = isDisabled;
    }
  }
}

/**
 * @param {Array<{ code: string }>} municipalities
 * @param {Int8Array} classIndexes
 * @returns {Map<string, number>}
 */
function buildClassIndexByCode(municipalities, classIndexes) {
  const map = new Map();
  for (let i = 0; i < municipalities.length; i += 1) {
    map.set(municipalities[i].code, classIndexes[i]);
  }
  return map;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  bootApplication().catch((error) => {
    console.error("Boot failure:", error);
  });
}
