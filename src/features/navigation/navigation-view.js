import {
  getAllUfs,
  isNationalView,
  resolveUfCode,
  resolveUfName,
  resolveUfSigla,
  selectActiveUf,
} from "./navigation-slice.js";

/**
 * @typedef {import("./navigation-slice.js").NavigationState} NavigationState
 *
 * @typedef {{
 *   onSelectTerritory?: ((ufCodeOrNull: string | null) => void) | undefined,
 *   documentRef?: Document | undefined,
 * }} NavigationViewOptions
 *
 * @typedef {{
 *   element: HTMLElement,
 *   update: (state: NavigationState) => void,
 *   destroy: () => void,
 * }} NavigationView
 */

const NAV_LABEL = "Navegação territorial";
const SELECT_LABEL = "Selecionar estado";
const COUNTRY_LABEL = "Brasil";

/**
 * Resolves DOM Document reference from options or global environment.
 *
 * @param {NavigationViewOptions} [options]
 * @returns {Document | null}
 */
function resolveDocument(options) {
  if (options?.documentRef) {
    return options.documentRef;
  }
  if (typeof document !== "undefined") {
    return document;
  }
  return null;
}

/**
 * Creates accessible navigation view with breadcrumb and fast UF select dropdown.
 *
 * @param {NavigationViewOptions} [options]
 * @returns {NavigationView}
 */
export function createNavigationView(options = {}) {
  const doc = resolveDocument(options);
  if (!doc) {
    throw new Error("Document reference is required to create navigation view.");
  }

  const callback = options.onSelectTerritory;

  const nav = doc.createElement("nav");
  nav.className = "nav-territory";
  nav.setAttribute("aria-label", NAV_LABEL);

  const breadcrumbsList = doc.createElement("ol");
  breadcrumbsList.className = "nav-breadcrumbs";
  breadcrumbsList.setAttribute("role", "list");

  const countryItem = doc.createElement("li");
  countryItem.className = "nav-breadcrumb-item nav-breadcrumb-country-item";

  const countryButton = doc.createElement("button");
  countryButton.type = "button";
  countryButton.className = "nav-breadcrumb-btn nav-breadcrumb-country";
  countryButton.textContent = COUNTRY_LABEL;
  countryButton.setAttribute("data-territory", "BR");
  countryItem.append(countryButton);

  const separatorItem = doc.createElement("li");
  separatorItem.className = "nav-breadcrumb-separator";
  separatorItem.setAttribute("aria-hidden", "true");
  separatorItem.textContent = "/";
  separatorItem.hidden = true;

  const stateItem = doc.createElement("li");
  stateItem.className = "nav-breadcrumb-item nav-breadcrumb-state-item";
  stateItem.hidden = true;

  const stateCurrent = doc.createElement("span");
  stateCurrent.className = "nav-breadcrumb-current";
  stateItem.append(stateCurrent);

  breadcrumbsList.append(countryItem, separatorItem, stateItem);

  const selectWrapper = doc.createElement("div");
  selectWrapper.className = "nav-quick-select-wrapper";

  const selectElement = doc.createElement("select");
  selectElement.className = "nav-uf-select";
  selectElement.setAttribute("aria-label", SELECT_LABEL);

  const nationalOption = doc.createElement("option");
  nationalOption.value = "";
  nationalOption.textContent = COUNTRY_LABEL;
  selectElement.append(nationalOption);

  const ufs = getAllUfs();
  for (let i = 0; i < ufs.length; i += 1) {
    const uf = ufs[i];
    const option = doc.createElement("option");
    option.value = uf.code;
    option.textContent = `${uf.name} (${uf.sigla})`;
    selectElement.append(option);
  }

  selectWrapper.append(selectElement);
  nav.append(breadcrumbsList, selectWrapper);

  /**
   * @param {MouseEvent} event
   */
  function handleCountryClick(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (countryButton.disabled) {
      return;
    }
    if (typeof callback === "function") {
      callback(null);
    }
  }

  /**
   * @param {Event} _event
   */
  function handleSelectChange(_event) {
    if (selectElement.disabled) {
      return;
    }
    const rawValue = selectElement.value;
    if (typeof callback !== "function") {
      return;
    }
    if (rawValue === "" || rawValue === "BR") {
      callback(null);
      return;
    }
    callback(rawValue);
  }

  countryButton.addEventListener("click", handleCountryClick);
  selectElement.addEventListener("change", handleSelectChange);

  /**
   * @param {NavigationState} state
   */
  function update(state) {
    if (state.isTransitioning) {
      nav.classList.add("is-transitioning");
      nav.setAttribute("aria-busy", "true");
      countryButton.disabled = true;
      selectElement.disabled = true;
    }
    if (!state.isTransitioning) {
      nav.classList.remove("is-transitioning");
      nav.removeAttribute("aria-busy");
      countryButton.disabled = false;
      selectElement.disabled = false;
    }

    const national = isNationalView(state);

    if (national) {
      countryButton.setAttribute("aria-current", "page");
      countryButton.classList.add("is-current");
      separatorItem.hidden = true;
      stateItem.hidden = true;
      stateCurrent.textContent = "";
      stateCurrent.removeAttribute("aria-current");
      selectElement.value = "";
      return;
    }

    const activeUf = selectActiveUf(state);
    countryButton.removeAttribute("aria-current");
    countryButton.classList.remove("is-current");

    separatorItem.hidden = false;
    stateItem.hidden = false;

    const ufCode = resolveUfCode(activeUf);
    const ufSigla = resolveUfSigla(activeUf);
    const ufName = resolveUfName(activeUf);

    let displayLabel = String(activeUf);
    if (ufName && ufSigla) {
      displayLabel = `${ufName} (${ufSigla})`;
    }
    if (ufName && !ufSigla) {
      displayLabel = ufName;
    }

    stateCurrent.textContent = displayLabel;
    stateCurrent.setAttribute("aria-current", "page");

    if (ufCode) {
      selectElement.value = ufCode;
      return;
    }
    selectElement.value = "";
  }

  function destroy() {
    countryButton.removeEventListener("click", handleCountryClick);
    selectElement.removeEventListener("change", handleSelectChange);
  }

  return {
    element: nav,
    update,
    destroy,
  };
}

/**
 * Mounts the navigation view into a parent container.
 *
 * @param {HTMLElement} container
 * @param {NavigationViewOptions} [options]
 * @returns {NavigationView}
 */
export function mountNavigationView(container, options = {}) {
  const doc = options.documentRef || container?.ownerDocument || resolveDocument(options);
  const view = createNavigationView({
    ...options,
    documentRef: doc,
  });
  if (container && typeof container.append === "function") {
    container.append(view.element);
  }
  return view;
}
