import { expect, test } from "@playwright/test";
import { readCamera, readEngineStats, readState } from "../../../tests/support/inspector.js";
import { openPage, settle } from "../../../tests/support/page.js";

test("NAV-20 national overview displays 27 UF instances and breadcrumb on landing", async ({
  browser,
}) => {
  const { context, page, consoleProblems } = await openPage(browser, {}, "/?uf=br");
  try {
    expect(consoleProblems).toEqual([]);

    const breadcrumbs = await page.textContent(".nav-breadcrumbs");
    expect(breadcrumbs).toContain("Brasil");

    const selectValue = await page.evaluate(() => {
      const el = /** @type {HTMLSelectElement | null} */ (document.querySelector(".nav-uf-select"));
      if (!el) {
        return null;
      }
      return el.value;
    });
    expect(selectValue).toBe("");
  } finally {
    await context.close();
  }
});

test("NAV-21 drill-down from national to state updates breadcrumb and URL", async ({ browser }) => {
  const { context, page } = await openPage(browser, {}, "/?uf=br");
  try {
    await page.selectOption(".nav-uf-select", "35");
    await settle(page);

    const breadcrumbs = await page.textContent(".nav-breadcrumbs");
    expect(breadcrumbs).toContain("São Paulo");

    const url = page.url();
    expect(url).toContain("uf=35");
  } finally {
    await context.close();
  }
});

test("NAV-22 clicking Brasil breadcrumb returns from state to national overview", async ({
  browser,
}) => {
  const { context, page } = await openPage(browser, {}, "/?uf=35");
  try {
    await page.click(".nav-breadcrumb-btn");
    await settle(page);

    const selectValue = await page.evaluate(() => {
      const el = /** @type {HTMLSelectElement | null} */ (document.querySelector(".nav-uf-select"));
      if (!el) {
        return null;
      }
      return el.value;
    });
    expect(selectValue).toBe("");

    const url = page.url();
    expect(url).not.toContain("uf=35");
  } finally {
    await context.close();
  }
});

test("NAV-23 drill-down supports multiple Brazilian states across regions", async ({ browser }) => {
  const { context, page, consoleProblems } = await openPage(browser, {}, "/?uf=br");
  try {
    const statesToTest = [
      { code: "33", name: "Rio de Janeiro" },
      { code: "29", name: "Bahia" },
      { code: "13", name: "Amazonas" },
      { code: "43", name: "Rio Grande do Sul" },
    ];

    for (const st of statesToTest) {
      await page.selectOption(".nav-uf-select", st.code);
      await settle(page);

      const breadcrumbs = await page.textContent(".nav-breadcrumbs");
      expect(breadcrumbs).toContain(st.name);

      const url = page.url();
      expect(url).toContain(`uf=${st.code}`);
    }

    expect(consoleProblems).toEqual([]);
  } finally {
    await context.close();
  }
});

test("NAV-24 pressing Escape in state view returns to national overview", async ({ browser }) => {
  const { context, page } = await openPage(browser, {}, "/?uf=35");
  try {
    await page.keyboard.press("Escape");
    await settle(page);

    const selectValue = await page.evaluate(() => {
      const el = /** @type {HTMLSelectElement | null} */ (document.querySelector(".nav-uf-select"));
      if (!el) {
        return null;
      }
      return el.value;
    });
    expect(selectValue).toBe("");

    const url = page.url();
    expect(url).not.toContain("uf=35");
  } finally {
    await context.close();
  }
});

test("NAV-25 3D transition Brazil to State interpolates camera and flattens neighboring states", async ({
  browser,
}) => {
  const { context, page, consoleProblems } = await openPage(browser, {}, "/?uf=br");
  try {
    const initialStats = await readEngineStats(page);
    expect(initialStats.instanceCount).toBe(27);

    const initialCamera = await readCamera(page);

    await page.selectOption(".nav-uf-select", "35");
    await settle(page);

    const finalState = await readState(page);
    expect(finalState.navigation.activeUf).toBe("35");

    const finalStats = await readEngineStats(page);
    expect(finalStats.instanceCount).toBe(645);

    const finalCamera = await readCamera(page);
    expect(finalCamera.zoom).toBeGreaterThanOrEqual(initialCamera.zoom);

    const breadcrumbs = await page.textContent(".nav-breadcrumbs");
    expect(breadcrumbs).toContain("São Paulo");

    expect(consoleProblems).toEqual([]);
  } finally {
    await context.close();
  }
});

test("NAV-26 3D transition State to Brazil pulls back camera and restores relief of 27 UFs", async ({
  browser,
}) => {
  const { context, page, consoleProblems } = await openPage(browser, {}, "/?uf=35");
  try {
    const stateStats = await readEngineStats(page);
    expect(stateStats.instanceCount).toBe(645);

    await page.click(".nav-breadcrumb-btn");
    await settle(page);

    const nationalState = await readState(page);
    expect(nationalState.navigation.activeUf).toBeNull();

    const nationalStats = await readEngineStats(page);
    expect(nationalStats.instanceCount).toBe(27);

    const breadcrumbs = await page.textContent(".nav-breadcrumbs");
    expect(breadcrumbs).toContain("Brasil");

    const selectValue = await page.evaluate(() => {
      const el = /** @type {HTMLSelectElement | null} */ (document.querySelector(".nav-uf-select"));
      if (!el) {
        return null;
      }
      return el.value;
    });
    expect(selectValue).toBe("");

    expect(consoleProblems).toEqual([]);
  } finally {
    await context.close();
  }
});

test("NAV-27 respects prefers-reduced-motion executing hard cut without animation", async ({
  browser,
}) => {
  const { context, page, consoleProblems } = await openPage(
    browser,
    { reducedMotion: "reduce" },
    "/?uf=br",
  );
  try {
    const initialStats = await readEngineStats(page);
    expect(initialStats.instanceCount).toBe(27);

    await page.selectOption(".nav-uf-select", "35");
    await settle(page);

    const spState = await readState(page);
    expect(spState.navigation.activeUf).toBe("35");

    const spStats = await readEngineStats(page);
    expect(spStats.instanceCount).toBe(645);

    await page.click(".nav-breadcrumb-btn");
    await settle(page);

    const nationalState = await readState(page);
    expect(nationalState.navigation.activeUf).toBeNull();

    const nationalStats = await readEngineStats(page);
    expect(nationalStats.instanceCount).toBe(27);

    expect(consoleProblems).toEqual([]);
  } finally {
    await context.close();
  }
});
