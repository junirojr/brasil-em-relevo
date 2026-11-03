import assert from "node:assert/strict";
import { test } from "node:test";
import { createNavigationState } from "./navigation-slice.js";
import { createNavigationView, mountNavigationView } from "./navigation-view.js";

/**
 * Creates lightweight mock DOM element for unit testing in Node environment.
 *
 * @param {string} tagName
 */
function createFakeElement(tagName) {
  /** @type {Record<string, Array<(event: any) => void>>} */
  const listeners = {};
  /** @type {Record<string, string>} */
  const attributes = {};
  const classListSet = new Set();

  const element = {
    tagName,
    className: "",
    id: "",
    textContent: "",
    value: "",
    type: "",
    hidden: false,
    children: /** @type {any[]} */ ([]),
    classList: {
      add(/** @type {string[]} */ ...names) {
        for (const name of names) {
          classListSet.add(name);
        }
      },
      remove(/** @type {string[]} */ ...names) {
        for (const name of names) {
          classListSet.delete(name);
        }
      },
      contains(/** @type {string} */ name) {
        return classListSet.has(name);
      },
    },
    append(/** @type {any[]} */ ...nodes) {
      element.children.push(...nodes);
    },
    setAttribute(/** @type {string} */ name, /** @type {string} */ value) {
      attributes[name] = String(value);
    },
    getAttribute(/** @type {string} */ name) {
      const val = attributes[name];
      if (val !== undefined) {
        return val;
      }
      return null;
    },
    removeAttribute(/** @type {string} */ name) {
      delete attributes[name];
    },
    addEventListener(/** @type {string} */ event, /** @type {(event: any) => void} */ fn) {
      if (!listeners[event]) {
        listeners[event] = [];
      }
      listeners[event].push(fn);
    },
    removeEventListener(/** @type {string} */ event, /** @type {(event: any) => void} */ fn) {
      if (!listeners[event]) {
        return;
      }
      listeners[event] = listeners[event].filter((item) => item !== fn);
    },
    listenerCount(/** @type {string} */ event) {
      const list = listeners[event];
      if (!list) {
        return 0;
      }
      return list.length;
    },
    fire(/** @type {string} */ event, eventObj = {}) {
      const list = listeners[event];
      if (!list) {
        return;
      }
      for (const fn of list) {
        fn(eventObj);
      }
    },
  };
  return element;
}

function createFakeDocument() {
  return {
    createElement(/** @type {string} */ tag) {
      return createFakeElement(tag);
    },
  };
}

/**
 * @param {any} root
 * @param {(node: any) => boolean} predicate
 * @returns {any[]}
 */
function findAll(root, predicate) {
  const result = [];
  if (predicate(root)) {
    result.push(root);
  }
  if (Array.isArray(root.children)) {
    for (const child of root.children) {
      result.push(...findAll(child, predicate));
    }
  }
  return result;
}

test("NAV-10 creates nav landmark with aria-label Navegacao territorial and breadcrumb list", () => {
  const doc = createFakeDocument();
  const view = createNavigationView({ documentRef: /** @type {any} */ (doc) });

  assert.equal(view.element.tagName, "nav");
  assert.equal(view.element.getAttribute("aria-label"), "Navegação territorial");

  const ols = findAll(view.element, (node) => node.tagName === "ol");
  assert.equal(ols.length, 1);
  assert.equal(ols[0].getAttribute("role"), "list");
});

test("NAV-11 select dropdown contains Brasil as first option and all 27 UFs", () => {
  const doc = createFakeDocument();
  const view = createNavigationView({ documentRef: /** @type {any} */ (doc) });

  const selects = findAll(view.element, (node) => node.tagName === "select");
  assert.equal(selects.length, 1);
  const select = selects[0];
  assert.equal(select.getAttribute("aria-label"), "Selecionar estado");

  const options = findAll(select, (node) => node.tagName === "option");
  assert.equal(options.length, 28);
  assert.equal(options[0].value, "");
  assert.equal(options[0].textContent, "Brasil");

  const spOption = options.find((opt) => opt.value === "35");
  assert.ok(spOption);
  assert.equal(spOption.textContent, "São Paulo (SP)");
});

test("NAV-12 national state shows Brasil active with aria-current page and hides state separator and item", () => {
  const doc = createFakeDocument();
  const view = createNavigationView({ documentRef: /** @type {any} */ (doc) });
  const state = createNavigationState(null);

  view.update(state);

  const countryBtn = findAll(view.element, (node) => node.tagName === "button")[0];
  assert.equal(countryBtn.getAttribute("aria-current"), "page");
  assert.equal(countryBtn.classList.contains("is-current"), true);

  const separator = findAll(view.element, (node) =>
    node.className.includes("nav-breadcrumb-separator"),
  )[0];
  assert.equal(separator.hidden, true);

  const stateItem = findAll(view.element, (node) =>
    node.className.includes("nav-breadcrumb-state-item"),
  )[0];
  assert.equal(stateItem.hidden, true);

  const select = findAll(view.element, (node) => node.tagName === "select")[0];
  assert.equal(select.value, "");
});

test("NAV-13 active UF state shows Brasil as clickable, separator visible, and active state with aria-current", () => {
  const doc = createFakeDocument();
  const view = createNavigationView({ documentRef: /** @type {any} */ (doc) });
  const state = createNavigationState("35");

  view.update(state);

  const countryBtn = findAll(view.element, (node) => node.tagName === "button")[0];
  assert.equal(countryBtn.getAttribute("aria-current"), null);
  assert.equal(countryBtn.classList.contains("is-current"), false);

  const separator = findAll(view.element, (node) =>
    node.className.includes("nav-breadcrumb-separator"),
  )[0];
  assert.equal(separator.hidden, false);

  const stateItem = findAll(view.element, (node) =>
    node.className.includes("nav-breadcrumb-state-item"),
  )[0];
  assert.equal(stateItem.hidden, false);

  const stateCurrent = findAll(view.element, (node) =>
    node.className.includes("nav-breadcrumb-current"),
  )[0];
  assert.equal(stateCurrent.getAttribute("aria-current"), "page");
  assert.equal(stateCurrent.textContent, "São Paulo (SP)");

  const select = findAll(view.element, (node) => node.tagName === "select")[0];
  assert.equal(select.value, "35");
});

test("NAV-14 clicking Brasil breadcrumb button calls onSelectTerritory with null", () => {
  const doc = createFakeDocument();
  /** @type {(string | null)[]} */
  const selected = [];
  const view = createNavigationView({
    documentRef: /** @type {any} */ (doc),
    onSelectTerritory: (uf) => selected.push(uf),
  });

  const countryBtn = findAll(view.element, (node) => node.tagName === "button")[0];
  let prevented = false;
  countryBtn.fire("click", {
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(selected, [null]);
});

test("NAV-15 changing select dropdown calls onSelectTerritory with selected UF code or null for Brasil", () => {
  const doc = createFakeDocument();
  /** @type {(string | null)[]} */
  const selected = [];
  const view = createNavigationView({
    documentRef: /** @type {any} */ (doc),
    onSelectTerritory: (uf) => selected.push(uf),
  });

  const select = findAll(view.element, (node) => node.tagName === "select")[0];

  select.value = "35";
  select.fire("change");
  assert.deepEqual(selected, ["35"]);

  select.value = "";
  select.fire("change");
  assert.deepEqual(selected, ["35", null]);

  select.value = "BR";
  select.fire("change");
  assert.deepEqual(selected, ["35", null, null]);
});

test("NAV-16 update method synchronizes select value and breadcrumb labels when switching territories", () => {
  const doc = createFakeDocument();
  const view = createNavigationView({ documentRef: /** @type {any} */ (doc) });

  view.update(createNavigationState("RJ"));
  const stateCurrent = findAll(view.element, (node) =>
    node.className.includes("nav-breadcrumb-current"),
  )[0];
  const select = findAll(view.element, (node) => node.tagName === "select")[0];
  assert.equal(stateCurrent.textContent, "Rio de Janeiro (RJ)");
  assert.equal(select.value, "33");

  view.update(createNavigationState(null));
  assert.equal(stateCurrent.textContent, "");
  assert.equal(select.value, "");
});

test("NAV-17 mountNavigationView appends view element to container and returns view instance", () => {
  const doc = createFakeDocument();
  const container = doc.createElement("div");

  const view = mountNavigationView(/** @type {any} */ (container), {
    documentRef: /** @type {any} */ (doc),
  });

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], view.element);
});

test("NAV-18 destroy unbinds event listeners cleanly", () => {
  const doc = createFakeDocument();
  const view = createNavigationView({ documentRef: /** @type {any} */ (doc) });

  const countryBtn = findAll(view.element, (node) => node.tagName === "button")[0];
  const select = findAll(view.element, (node) => node.tagName === "select")[0];

  assert.equal(countryBtn.listenerCount("click"), 1);
  assert.equal(select.listenerCount("change"), 1);

  view.destroy();

  assert.equal(countryBtn.listenerCount("click"), 0);
  assert.equal(select.listenerCount("change"), 0);
});

test("NAV-19 createNavigationView throws if document reference is missing", () => {
  assert.throws(() => {
    createNavigationView({ documentRef: undefined });
  }, /Document reference is required/);
});

test("NAV-25 navigation view shows busy state and locks controls during Brazil to state transition", () => {
  const doc = createFakeDocument();
  const selected = [];
  const view = createNavigationView({
    documentRef: /** @type {any} */ (doc),
    onSelectTerritory: (uf) => selected.push(uf),
  });

  const countryBtn = findAll(view.element, (node) => node.tagName === "button")[0];
  const select = findAll(view.element, (node) => node.tagName === "select")[0];

  view.update({ activeUf: "SP", isTransitioning: true });

  assert.equal(view.element.classList.contains("is-transitioning"), true);
  assert.equal(view.element.getAttribute("aria-busy"), "true");
  assert.equal(countryBtn.disabled, true);
  assert.equal(select.disabled, true);

  countryBtn.fire("click");
  assert.equal(selected.length, 0);

  select.value = "33";
  select.fire("change");
  assert.equal(selected.length, 0);
});

test("NAV-26 navigation view restores controls and breadcrumb when transitioning back to Brazil", () => {
  const doc = createFakeDocument();
  const selected = [];
  const view = createNavigationView({
    documentRef: /** @type {any} */ (doc),
    onSelectTerritory: (uf) => selected.push(uf),
  });

  const countryBtn = findAll(view.element, (node) => node.tagName === "button")[0];
  const select = findAll(view.element, (node) => node.tagName === "select")[0];

  view.update({ activeUf: "SP", isTransitioning: true });
  assert.equal(view.element.classList.contains("is-transitioning"), true);
  assert.equal(countryBtn.disabled, true);

  view.update({ activeUf: null, isTransitioning: false });

  assert.equal(view.element.classList.contains("is-transitioning"), false);
  assert.equal(view.element.getAttribute("aria-busy"), null);
  assert.equal(countryBtn.disabled, false);
  assert.equal(select.disabled, false);
});

test("NAV-27 navigation view renders immediately without transitioning lock when motion is reduced", () => {
  const doc = createFakeDocument();
  const view = createNavigationView({
    documentRef: /** @type {any} */ (doc),
  });

  view.update({ activeUf: "35", isTransitioning: false });

  assert.equal(view.element.classList.contains("is-transitioning"), false);
  assert.equal(view.element.getAttribute("aria-busy"), null);

  const countryBtn = findAll(view.element, (node) => node.tagName === "button")[0];
  const select = findAll(view.element, (node) => node.tagName === "select")[0];
  assert.equal(countryBtn.disabled, false);
  assert.equal(select.disabled, false);
});
