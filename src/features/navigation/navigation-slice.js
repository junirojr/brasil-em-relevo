import { UF_CODE_TO_SIGLA, UF_SIGLA_TO_NAME } from "../../domain/territory-constants.js";

export const TERRITORY_CHANGED = "navigation/territoryChanged";
export const TRANSITION_STARTED = "navigation/transitionStarted";
export const TRANSITION_COMPLETED = "navigation/transitionCompleted";

/**
 * Reverse mapping from UF 2-letter uppercase abbreviation to 2-digit IBGE code.
 * @type {ReadonlyMap<string, string>}
 */
export const UF_SIGLA_TO_CODE = new Map(
  Array.from(UF_CODE_TO_SIGLA.entries()).map(([code, sigla]) => [sigla, code]),
);

/**
 * Validates whether the given value corresponds to a recognized Brazilian UF.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidUf(value) {
  if (typeof value !== "string") {
    return false;
  }
  const clean = value.trim().toUpperCase();
  if (UF_CODE_TO_SIGLA.has(clean)) {
    return true;
  }
  if (UF_SIGLA_TO_NAME.has(clean)) {
    return true;
  }
  return false;
}

/**
 * Resolves a UF code or abbreviation into its 2-digit IBGE code.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function resolveUfCode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const clean = value.trim().toUpperCase();
  if (UF_CODE_TO_SIGLA.has(clean)) {
    return clean;
  }
  const code = UF_SIGLA_TO_CODE.get(clean);
  if (code) {
    return code;
  }
  return null;
}

/**
 * Resolves a UF code or abbreviation into its 2-letter abbreviation.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function resolveUfSigla(value) {
  if (typeof value !== "string") {
    return null;
  }
  const clean = value.trim().toUpperCase();
  if (UF_SIGLA_TO_NAME.has(clean)) {
    return clean;
  }
  const sigla = UF_CODE_TO_SIGLA.get(clean);
  if (sigla) {
    return sigla;
  }
  return null;
}

/**
 * Resolves a UF code or abbreviation into its official state name.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function resolveUfName(value) {
  const sigla = resolveUfSigla(value);
  if (!sigla) {
    return null;
  }
  const name = UF_SIGLA_TO_NAME.get(sigla);
  if (name) {
    return name;
  }
  return null;
}

/**
 * Returns a list of all 27 Brazilian Federative Units sorted alphabetically by name.
 *
 * @returns {readonly { code: string, sigla: string, name: string }[]}
 */
export function getAllUfs() {
  const list = [];
  for (const [code, sigla] of UF_CODE_TO_SIGLA) {
    const name = UF_SIGLA_TO_NAME.get(sigla) || sigla;
    list.push({ code, sigla, name });
  }
  list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return Object.freeze(list);
}

/**
 * @typedef {{ activeUf: string | null, isTransitioning: boolean }} NavigationState
 * @typedef {{ type: typeof TERRITORY_CHANGED, uf: string | null }} TerritoryChangedAction
 * @typedef {{ type: typeof TRANSITION_STARTED }} TransitionStartedAction
 * @typedef {{ type: typeof TRANSITION_COMPLETED }} TransitionCompletedAction
 * @typedef {TerritoryChangedAction | TransitionStartedAction | TransitionCompletedAction | { type: string }} NavigationAction
 */

/**
 * Creates initial navigation state. Default is national view (null).
 *
 * @param {string | null} [initialUf=null]
 * @returns {NavigationState}
 */
export function createNavigationState(initialUf = null) {
  let activeUf = null;
  if (initialUf) {
    const valid = isValidUf(initialUf);
    if (valid) {
      activeUf = initialUf;
    }
  }
  return { activeUf, isTransitioning: false };
}

/**
 * Action creator to start a smooth territory transition.
 *
 * @returns {TransitionStartedAction}
 */
export function startTransition() {
  return { type: TRANSITION_STARTED };
}

/**
 * Action creator to complete a territory transition.
 *
 * @returns {TransitionCompletedAction}
 */
export function completeTransition() {
  return { type: TRANSITION_COMPLETED };
}

/**
 * Action creator to change territorial scope.
 *
 * @param {string | null} ufCodeOrNull
 * @returns {TerritoryChangedAction}
 */
export function changeTerritory(ufCodeOrNull) {
  let uf = null;
  if (ufCodeOrNull) {
    const text = String(ufCodeOrNull).trim();
    if (text !== "" && text !== "BR" && text !== "Brasil") {
      uf = ufCodeOrNull;
    }
  }
  return {
    type: TERRITORY_CHANGED,
    uf,
  };
}

/**
 * Reducer for territorial navigation.
 *
 * @param {NavigationState} state
 * @param {NavigationAction} action
 * @returns {NavigationState}
 */
export function reduceNavigation(state, action) {
  if (action.type === TRANSITION_STARTED) {
    if (state.isTransitioning) {
      return state;
    }
    return { ...state, isTransitioning: true };
  }

  if (action.type === TRANSITION_COMPLETED) {
    if (!state.isTransitioning) {
      return state;
    }
    return { ...state, isTransitioning: false };
  }

  if (action.type !== TERRITORY_CHANGED) {
    return state;
  }
  const territoryAction = /** @type {TerritoryChangedAction} */ (action);
  const targetUf = territoryAction.uf;

  if (targetUf === null || targetUf === undefined || targetUf === "" || targetUf === "BR") {
    if (state.activeUf === null && !state.isTransitioning) {
      return state;
    }
    return { activeUf: null, isTransitioning: false };
  }

  if (!isValidUf(targetUf)) {
    return state;
  }

  if (state.activeUf === targetUf && !state.isTransitioning) {
    return state;
  }

  return { activeUf: targetUf, isTransitioning: false };
}

/**
 * Selects the active UF code, abbreviation, or null for national view.
 *
 * @param {NavigationState} state
 * @returns {string | null}
 */
export function selectActiveUf(state) {
  return state.activeUf;
}

/**
 * Selects whether the navigation is currently in national view.
 *
 * @param {NavigationState} state
 * @returns {boolean}
 */
export function isNationalView(state) {
  return state.activeUf === null;
}

/**
 * Selects whether territorial navigation is currently transitioning.
 *
 * @param {NavigationState | undefined} state
 * @returns {boolean}
 */
export function isTerritoryTransitioning(state) {
  if (!state) {
    return false;
  }
  return Boolean(state.isTransitioning);
}
