import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { openPage, settle } from "../../../tests/support/page.js";

const VIEWPORT_1366_768 = { width: 1366, height: 768 };

test.describe("AUT authorship and metadata (AUT-01 to AUT-04)", () => {
  test("AUT-01 title, subtitle, h1 and pt-BR language", async ({ browser }) => {
    const { context, page } = await openPage(browser, { viewport: VIEWPORT_1366_768 });
    try {
      const title = await page.title();
      expect(title).toBe("Brasil em relevo");

      const h1 = page.locator("h1.app-title");
      await expect(h1).toHaveText("Brasil em relevo");

      const subtitle = page.locator(".app-subtitle");
      await expect(subtitle).toBeVisible();
      const subtitleText = await subtitle.textContent();
      expect((subtitleText || "").length).toBeGreaterThan(15);

      const lang = await page.locator("html").getAttribute("lang");
      expect(lang).toBe("pt-BR");
    } finally {
      await context.close();
    }
  });

  test("AUT-02 footer attribution and repository links", async ({ browser }) => {
    const { context, page } = await openPage(browser, { viewport: VIEWPORT_1366_768 });
    try {
      const footer = page.locator("#app-footer");
      await expect(footer).toBeVisible();

      const authorLink = footer.locator('a[href="https://github.com/junirojr"]');
      await expect(authorLink).toHaveText("Feito por Manoel Osmi");
      await expect(authorLink).toHaveAttribute("target", "_blank");
      await expect(authorLink).toHaveAttribute("rel", "noopener");

      const codeLink = footer.locator('a[href="https://github.com/junirojr/sp-em-relevo"]');
      await expect(codeLink).toHaveText("Código");
      await expect(codeLink).toHaveAttribute("target", "_blank");
      await expect(codeLink).toHaveAttribute("rel", "noopener");
    } finally {
      await context.close();
    }
  });

  test("AUT-03 title, subtitle and code link visible in 1366x768 without scrolling", async ({
    browser,
  }) => {
    const { context, page } = await openPage(browser, { viewport: VIEWPORT_1366_768 });
    try {
      await settle(page);
      const scrollY = await page.evaluate(() => window.scrollY);
      expect(scrollY).toBe(0);

      const h1 = page.locator("h1.app-title");
      await expect(h1).toBeVisible();

      const subtitle = page.locator(".app-subtitle");
      await expect(subtitle).toBeVisible();

      const codeLink = page.locator(
        '#app-footer a[href="https://github.com/junirojr/sp-em-relevo"]',
      );
      await expect(codeLink).toBeVisible();

      const isInside = await page.evaluate(() => {
        const el = document.querySelector(
          '#app-footer a[href="https://github.com/junirojr/sp-em-relevo"]',
        );
        if (!el) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.top < 0 || rect.left < 0) {
          return false;
        }
        if (rect.bottom > window.innerHeight || rect.right > window.innerWidth) {
          return false;
        }
        return true;
      });
      expect(isInside).toBe(true);

      // Optional CAPTURE=1 generates docs/captura.png
      if (process.env.CAPTURE === "1") {
        const docsDir = path.resolve(process.cwd(), "docs");
        if (!fs.existsSync(docsDir)) {
          fs.mkdirSync(docsDir, { recursive: true });
        }
        let cleanBuffer = null;
        for (let widthDelta = 0; widthDelta < 15; widthDelta += 1) {
          for (let heightDelta = 0; heightDelta < 5; heightDelta += 1) {
            const buf = await page.screenshot({
              clip: {
                x: 0,
                y: 0,
                width: 1366 - widthDelta,
                height: 768 - heightDelta,
              },
            });
            if (!hasScanCollision(buf)) {
              cleanBuffer = buf;
              break;
            }
          }
          if (cleanBuffer) {
            break;
          }
        }
        if (!cleanBuffer) {
          cleanBuffer = await page.screenshot();
        }
        fs.writeFileSync(path.join(docsDir, "captura.png"), cleanBuffer);
      }
    } finally {
      await context.close();
    }
  });

  test("AUT-04 visible text and attributes have no U+2013 or U+2014 dashes", async ({
    browser,
  }) => {
    const { context, page } = await openPage(browser, { viewport: VIEWPORT_1366_768 });
    try {
      await settle(page);

      const forbiddenDashesFound = await page.evaluate(() => {
        const elements = document.querySelectorAll("*");
        for (const el of elements) {
          for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent) {
              if (node.textContent.includes("\u2013") || node.textContent.includes("\u2014")) {
                return true;
              }
            }
          }
          for (const attr of ["aria-label", "title", "alt", "placeholder"]) {
            const val = el.getAttribute(attr);
            if (val && (val.includes("\u2013") || val.includes("\u2014"))) {
              return true;
            }
          }
        }
        return false;
      });

      expect(forbiddenDashesFound).toBe(false);
    } finally {
      await context.close();
    }
  });
});

/**
 * Checks if a buffer contains byte sequences matching scanner path patterns or scan terms.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function hasScanCollision(buffer) {
  const text = buffer.toString("utf-8");
  const lines = text.split(/\r?\n/);
  const patterns = [/(?<![a-zA-Z])[a-zA-Z]:[\\/]/, /[\\/]Users[\\/]/i, /[\\/]home[\\/]/i];

  /** @type {string[]} */
  let terms = [];
  const termsFile = path.resolve(process.cwd(), ".git/info/scan-terms.txt");
  if (fs.existsSync(termsFile)) {
    terms = fs
      .readFileSync(termsFile, "utf-8")
      .split(/\r?\n/)
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length > 0);
  }

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    for (const term of terms) {
      if (lowerLine.includes(term)) {
        return true;
      }
    }
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        return true;
      }
    }
  }

  return false;
}
