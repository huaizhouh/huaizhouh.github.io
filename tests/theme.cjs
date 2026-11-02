// Verify real system-preference changes, native controls, and export consistency.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function luminance(rgb) {
  const channels = rgb
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number)
    .map((value) => {
      const channel = value / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  const artifacts = await fs.mkdtemp(
    path.join(os.tmpdir(), "tier-studio-theme-"),
  );
  try {
    const context = await browser.newContext({
      colorScheme: "dark",
      viewport: { width: 1440, height: 1100 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.TEST_URL || "http://127.0.0.1:8000/");
    await page.waitForFunction(() => !document.querySelector("main").inert);
    // The CSS should already follow dark mode on the first navigation.
    assert.ok(
      luminance(
        await page
          .locator("body")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ) < 0.1,
    );
    await page.locator("#demo-button").click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-image]").length === 9,
    );
    const originalOrder = await page.locator(".tier-label").allTextContents();
    const originalLabelColors = await page
      .locator(".tier-label")
      .evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).backgroundColor),
      );
    const originalSources = await page
      .locator("[data-image] img")
      .evaluateAll((els) => els.map((el) => el.src));
    const exports = [];

    // Switch without reload; a CSS media query must react in the existing editor.
    for (const scheme of ["dark", "light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction(
        (expected) =>
          getComputedStyle(document.documentElement).colorScheme === expected,
        scheme,
      );
      const dark = scheme === "dark";
      const ui = await page.evaluate(() => {
        const selectors = [
          "body",
          ".app-header",
          ".project-bar",
          ".board-panel",
          ".pool-panel",
          ".settings-panel",
          ".board",
          ".tier-controls",
          ".counter",
          ".segmented",
          ".settings-note",
        ];
        return selectors.map((selector) => ({
          selector,
          background: getComputedStyle(document.querySelector(selector))
            .backgroundColor,
        }));
      });
      for (const element of ui) {
        const lightness = luminance(element.background);
        assert.ok(
          dark ? lightness < 0.1 : lightness > 0.8,
          `${scheme}: ${element.selector} remained in the wrong appearance`,
        );
      }
      const textSelectors = [
        "body",
        "#project-title",
        ".subtitle",
        ".small-hint",
        ".setting-hint",
        "legend",
        ".toggle-field label",
        ".text-button",
        "#export-button",
      ];
      if (dark) {
        for (const selector of textSelectors) {
          const style = await page
            .locator(selector)
            .first()
            .evaluate((el) => ({
              color: getComputedStyle(el).color,
              background: getComputedStyle(el).backgroundColor,
            }));
          const background =
            selector === "#export-button"
              ? luminance(style.background)
              : luminance(
                  ui.find((el) => el.selector === ".settings-panel").background,
                );
          const foreground = luminance(style.color);
          const contrast =
            (Math.max(background, foreground) + 0.05) /
            (Math.min(background, foreground) + 0.05);
          assert.ok(
            contrast >= 4.5,
            `${selector} has insufficient dark-mode contrast: ${contrast}`,
          );
        }
      }
      const meta = await page
        .locator("meta[name=theme-color]")
        .evaluateAll((tags) =>
          tags
            .filter((tag) => matchMedia(tag.media).matches)
            .map((tag) => tag.content),
        );
      assert.equal(meta.length, 1);
      assert.equal(meta[0], dark ? "#13141e" : "#f5f6fa");
      assert.deepEqual(
        await page.locator(".tier-label").allTextContents(),
        originalOrder,
      );
      assert.deepEqual(
        await page
          .locator(".tier-label")
          .evaluateAll((els) =>
            els.map((el) => getComputedStyle(el).backgroundColor),
          ),
        originalLabelColors,
      );
      assert.deepEqual(
        await page
          .locator("[data-image] img")
          .evaluateAll((els) => els.map((el) => el.src)),
        originalSources,
      );

      // Dialog surfaces, text inputs, disabled fields and native selects all adapt.
      await page.locator("[data-edit-tier]").first().click();
      const dialogBg = await page
        .locator("#tier-dialog")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      assert.ok(dark ? luminance(dialogBg) < 0.1 : luminance(dialogBg) > 0.8);
      for (const selector of ["#tier-name", "#tier-columns"]) {
        const background = await page
          .locator(selector)
          .evaluate((el) => getComputedStyle(el).backgroundColor);
        assert.ok(
          dark ? luminance(background) < 0.1 : luminance(background) > 0.8,
        );
      }
      await page.screenshot({
        path: path.join(artifacts, `${scheme}-dialog.png`),
      });
      await page.keyboard.press("Escape");
      await page.locator("#help-button").click();
      assert.equal(
        await page
          .locator("#help-dialog")
          .evaluate((el) => getComputedStyle(el).colorScheme),
        scheme,
      );
      await page.keyboard.press("Escape");
      await page.locator("#pool-grid [data-image]").first().dblclick();
      await page.locator("#crop-dialog").waitFor({ state: "visible" });
      const cropBg = await page
        .locator(".crop-preview-wrap")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      assert.ok(dark ? luminance(cropBg) < 0.1 : luminance(cropBg) > 0.8);
      await page.keyboard.press("Escape");
      await page.locator("#export-button").click();
      assert.equal(
        await page
          .locator("#export-scale")
          .evaluate((el) => getComputedStyle(el).colorScheme),
        scheme,
      );
      await page.locator("#export-scale").selectOption("1");
      const pending = page.waitForEvent("download");
      await page.locator("#download-png").click();
      const download = await pending;
      const filename = path.join(artifacts, `${scheme}-${exports.length}.png`);
      await download.saveAs(filename);
      exports.push(await fs.readFile(filename));
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: path.join(artifacts, `${scheme}-desktop.png`),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(artifacts, `${scheme}-mobile.png`),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1100 });
    }
    assert.ok(
      exports.every((buffer) => buffer.equals(exports[0])),
      "System theme changed exported PNG content",
    );
    assert.deepEqual(errors, []);
    // A fresh light-mode navigation also uses the preference before any interaction.
    const lightContext = await browser.newContext({ colorScheme: "light" });
    const light = await lightContext.newPage();
    await light.goto(process.env.TEST_URL || "http://127.0.0.1:8000/");
    assert.ok(
      luminance(
        await light
          .locator("body")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ) > 0.8,
    );
    await lightContext.close();
    console.log(
      "PASS: initial light/dark appearance, live system changes, dark text contrast, surfaces, dialogs, controls, mobile layout, unchanged tier colors/images and identical PNG exports.",
    );
    console.log(`Artifacts: ${artifacts}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
