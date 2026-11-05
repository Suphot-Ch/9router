// Run against the isolated preview dev server with NEXT_PUBLIC_ROUTING_MAP_PREVIEW=1,
// never production. This explicitly opts into fictional demo data for hydration tests:
// USAGE_E2E_BASE_URL=http://127.0.0.1:20132 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome \
//   node --test tests/e2e/usage-hydration.e2e.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

const baseURL = process.env.USAGE_E2E_BASE_URL;

for (const locale of ["th", "en"]) {
  test(`Usage preview hydrates and navigates with ${locale} locale`, {
    skip: !baseURL && "Set USAGE_E2E_BASE_URL to the isolated preview server",
    timeout: 90000,
  }, async () => {
    const browser = await chromium.launch({
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: "locale", value: locale, url: baseURL }]);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Real app, API, and translation JSON. Delay only the actual lazy JS response
      // so the runtime translator has time to touch SSR text before hydration.
      await page.route(/\/[^/]*RoutingMapPreview[^/]*\.js(?:\?.*)?$/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route.continue();
      });
      const response = await page.goto(new URL("/dashboard/usage?tab=routing-map&demo=1", baseURL).href, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(response.status(), 200);
      await page.locator(".react-flow__node").first().waitFor({ timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll('template[id^="B:"]').length === 0);
      assert.ok(await page.locator(".react-flow__node").count() > 0, "map must render, not just the shell");
      if (locale === "th") {
        await page.waitForFunction(() =>
          document.querySelector('[aria-label="Filter by provider"] option[value="all"]')?.textContent === "ผู้ให้บริการทั้งหมด"
        );
      }
      assert.deepEqual(errors, [], "translation must not invalidate pending preview hydration");

      // Match both source and translated labels, since i18n updates text in place.
      const tabs = page.locator("main button").filter({ hasText: /^(Overview|ภาพรวม)$/ });
      assert.equal(await tabs.count(), 1, "Overview tab remains present");
      await tabs.click();
      await page.waitForURL((url) => url.searchParams.get("tab") === "overview");
      await page.locator("select").filter({ has: page.locator('option[value="model"]') }).waitFor();
      await page.locator(".react-flow__node").first().waitFor({ timeout: 30000 });
      assert.equal(await page.locator('[aria-label="Synthetic routing map preview"]').count(), 0,
        "Overview still uses its existing provider topology, not the preview");
      await page.getByRole("button", { name: /^(Details|รายละเอียด)$/ }).click();
      await page.waitForURL((url) => url.searchParams.get("tab") === "details");
      await page.locator("table").waitFor();
      await page.getByRole("button", { name: "Routing Map", exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get("tab") === "routing-map");
      await page.locator(".react-flow__node").first().waitFor({ timeout: 30000 });
      await page.goBack();
      await page.waitForURL((url) => url.searchParams.get("tab") === "details");
      await page.locator("table").waitFor();
      assert.deepEqual(errors, [], "tab navigation must not trigger hydration or rendering errors");
      console.log(JSON.stringify({ locale, status: response.status(), url: page.url(), pageErrors: errors.length }));
    } finally {
      await browser.close();
    }
  });
}
