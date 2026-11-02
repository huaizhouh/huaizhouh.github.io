// Run against the local HTTP server. Requires Playwright and a Chromium browser.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const artifacts = await fs.mkdtemp(
    path.join(os.tmpdir(), "tier-studio-test-"),
  );
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      colorScheme: process.env.TEST_COLOR_SCHEME || "light",
      viewport: { width: 1440, height: 1100 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const responses = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400)
        errors.push(`${response.status()}: ${response.url()}`);
    });
    page.on("request", (request) => responses.push(request.url()));
    await page.goto(process.env.TEST_URL || "http://127.0.0.1:8000/");
    await page.waitForFunction(() =>
      document.querySelector("#save-status").textContent.includes("开启"),
    );
    assert.equal(await page.locator(".tier-row").count(), 5);
    const fixture = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 200;
      const ctx = canvas.getContext("2d");
      ["#ff0000", "#00ff00", "#0000ff"].forEach((color, index) => {
        ctx.fillStyle = color;
        ctx.fillRect(index * 200, 0, 200, 200);
      });
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `fixture-${i}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(fixture, "base64"),
    }));
    await page.locator("#image-input").setInputFiles(files);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-image]").length === 5,
    );
    await page.waitForFunction(
      () => document.querySelector("#save-status").textContent === "已自动保存",
    );
    assert.equal(await page.locator("#pool-grid [data-image]").count(), 5);
    assert.match(await page.locator("#total-count").textContent(), /已排序 0/);

    // Click-to-place and actual mouse drag use the same placement model.
    const firstId = await page
      .locator("#pool-grid [data-image]")
      .first()
      .getAttribute("data-image");
    const secondId = await page
      .locator("#pool-grid [data-image]")
      .nth(1)
      .getAttribute("data-image");
    const firstRow = page.locator(".tier-items").nth(0);
    const secondRow = page.locator(".tier-items").nth(1);
    await page.locator(`[data-image="${firstId}"]`).click();
    await firstRow.click({ position: { x: 250, y: 30 } });
    assert.equal(await firstRow.locator("[data-image]").count(), 1);
    const source = await page
      .locator(`[data-image="${secondId}"]`)
      .boundingBox();
    const target = await secondRow.boundingBox();
    await page.mouse.move(
      source.x + source.width / 2,
      source.y + source.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(target.x + 100, target.y + 30, { steps: 18 });
    await page.mouse.up();
    assert.equal(await secondRow.locator("[data-image]").count(), 1);
    await page.waitForTimeout(450);

    // Multi-selection and within-tier ordering.
    await page.locator("#select-all").click();
    assert.equal(await page.locator(".is-selected").count(), 3);
    await firstRow.click({ position: { x: 300, y: 30 } });
    assert.equal(await firstRow.locator("[data-image]").count(), 4);
    const order = await firstRow
      .locator("[data-image]")
      .evaluateAll((tiles) => tiles.map((tile) => tile.dataset.image));
    const last = await firstRow.locator("[data-image]").last().boundingBox();
    const first = await firstRow.locator("[data-image]").first().boundingBox();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 2, first.y + first.height / 2, {
      steps: 15,
    });
    await page.mouse.up();
    assert.equal(
      await firstRow.locator("[data-image]").first().getAttribute("data-image"),
      order[3],
    );
    await page.waitForTimeout(450);

    // Name, color, custom columns, global columns, ratios and fit.
    await page.locator("[data-edit-tier]").first().click();
    await page.locator("#tier-name").fill("超级喜欢");
    await page.locator("#tier-color").fill("#112233");
    await page.locator("#use-global-columns").uncheck();
    await page.locator("#tier-columns").fill("2");
    await page.locator("#tier-form button[type=submit]").click();
    assert.equal(
      await page.locator(".tier-label").first().textContent(),
      "超级喜欢",
    );
    assert.equal(
      await firstRow.evaluate((el) => el.style.getPropertyValue("--columns")),
      "2",
    );
    assert.equal(
      await page
        .locator(".tier-label")
        .first()
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(255, 255, 255)",
    );
    await page.locator("#global-columns").fill("6");
    assert.equal(
      await secondRow.evaluate((el) => el.style.getPropertyValue("--columns")),
      "6",
    );
    assert.equal(
      await firstRow.evaluate((el) => el.style.getPropertyValue("--columns")),
      "2",
    );
    for (const [ratio, expected] of [
      ["portrait", 2 / 3],
      ["horizontal", 3 / 2],
      ["wide", 16 / 9],
      ["square", 1],
    ]) {
      await page.locator(`[data-ratio="${ratio}"]`).click();
      const size = await firstRow.locator("[data-image]").first().boundingBox();
      assert.ok(Math.abs(size.width / size.height - expected) < 0.02);
    }
    await page.locator("[data-fit=contain]").click();
    assert.equal(
      await firstRow
        .locator("img")
        .first()
        .evaluate((el) => getComputedStyle(el).objectFit),
      "contain",
    );
    await page.locator("[data-fit=cover]").click();
    await page.locator("#show-names").check();
    assert.equal(await page.locator(".image-name").count(), 5);

    // Crop at the left edge must produce red from the tricolour test image.
    await page.locator(`[data-image="${firstId}"]`).dblclick();
    await page.locator("#crop-dialog").waitFor({ state: "visible" });
    await page.locator("#crop-x").fill("0");
    await page.locator("#crop-y").fill("50");
    const pixel = await page
      .locator("#crop-preview")
      .evaluate((canvas) => [
        ...canvas
          .getContext("2d")
          .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
      ]);
    assert.ok(
      pixel[0] > 240 && pixel[1] < 20 && pixel[2] < 20,
      `Crop pixel: ${pixel}`,
    );
    await page.locator("#apply-crop").click();
    assert.equal(
      await page
        .locator(`[data-image="${firstId}"]`)
        .evaluate((el) => el.style.getPropertyValue("--pos-x")),
      "0%",
    );

    // Tier operations, undo and redo retain images.
    await page.locator("#add-tier").click();
    await page.locator("#tier-name").fill("新增层");
    await page.locator("#tier-form button[type=submit]").click();
    assert.equal(await page.locator(".tier-row").count(), 6);
    await page.locator('[data-move-tier][data-direction="-1"]').last().click();
    assert.equal(
      await page.locator(".tier-label").nth(4).textContent(),
      "新增层",
    );
    await page.locator("[data-edit-tier]").first().click();
    await page.locator("#delete-tier").click();
    assert.equal(await page.locator("#pool-grid [data-image]").count(), 4);
    await page.locator("#undo-button").click();
    assert.equal(await firstRow.locator("[data-image]").count(), 4);
    await page.locator("#redo-button").click();
    assert.equal(await page.locator("#pool-grid [data-image]").count(), 4);
    await page.locator("#undo-button").click();
    await page.locator("#project-title").fill("测试排行榜");
    await page.locator("#project-title").blur();
    await page.waitForFunction(
      () => document.querySelector("#save-status").textContent === "已自动保存",
    );
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector("#save-status").textContent.includes("恢复"),
    );
    assert.equal(
      await page.locator("#project-title").inputValue(),
      "测试排行榜",
    );
    assert.equal(await page.locator(".tier-row").count(), 6);
    assert.equal(await page.locator("[data-image]").count(), 5);
    assert.equal(
      await page
        .locator(`[data-image="${firstId}"]`)
        .evaluate((el) => el.style.getPropertyValue("--pos-x")),
      "0%",
    );

    // Downloaded project is valid and round-trips; unsafe/malformed projects are rejected.
    const backupPromise = page.waitForEvent("download");
    await page.locator("#save-project").click();
    const backup = await backupPromise;
    const backupPath = path.join(artifacts, "backup.json");
    await backup.saveAs(backupPath);
    const project = JSON.parse(await fs.readFile(backupPath, "utf8"));
    assert.equal(project.images.length, 5);
    assert.equal(project.tiers[0].columns, 2);
    assert.equal(project.tiers[0].color, "#112233");
    await page.locator("#new-project").click();
    await page.locator("#confirm-action").click();
    assert.equal(await page.locator("[data-image]").count(), 0);
    await page.locator("#project-input").setInputFiles(backupPath);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-image]").length === 5,
    );
    const invalid = structuredClone(project);
    invalid.images[0].src = "https://example.com/tracker.png";
    await page
      .locator("#project-input")
      .setInputFiles({
        name: "invalid.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(invalid)),
      });
    await page.waitForFunction(() =>
      document.querySelector("#toast").textContent.includes("导入失败"),
    );
    assert.equal(await page.locator("[data-image]").count(), 5);
    await page
      .locator("#image-input")
      .setInputFiles({
        name: "broken.png",
        mimeType: "image/png",
        buffer: Buffer.from("not an image"),
      });
    await page.waitForFunction(() =>
      document.querySelector("#toast").textContent.includes("未能读取"),
    );
    assert.equal(await page.locator("[data-image]").count(), 5);

    // PNG pixels and geometry demonstrate the downloaded image matches rows and crops.
    await page.locator("#export-button").click();
    await page.locator("#export-scale").selectOption("1");
    const pngPromise = page.waitForEvent("download");
    await page.locator("#download-png").click();
    const png = await pngPromise;
    const pngPath = path.join(artifacts, "ranking.png");
    await png.saveAs(pngPath);
    const pngData = await fs.readFile(pngPath);
    assert.equal(pngData.subarray(1, 4).toString(), "PNG");
    assert.equal(pngData.readUInt32BE(16), 1200);
    assert.ok(pngData.readUInt32BE(20) > 1000);
    const raster = await page.evaluate(
      async (source) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(50, 130, 1, 1).data];
      },
      "data:image/png;base64," + pngData.toString("base64"),
    );
    assert.deepEqual(raster, [17, 34, 51, 255], "Exported tier label color");
    const cropPosition = project.tiers[0].items.indexOf(firstId);
    const cropPixel = await page.evaluate(
      async ({ source, position }) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const cellWidth = (1026 - 16 - 5) / 2;
        const x = 150 + (position % 2) * (cellWidth + 5) + cellWidth / 2;
        const y =
          116 + Math.floor(position / 2) * (cellWidth + 5) + cellWidth / 2;
        return [...ctx.getImageData(x, y, 1, 1).data];
      },
      {
        source: "data:image/png;base64," + pngData.toString("base64"),
        position: cropPosition,
      },
    );
    assert.ok(
      cropPixel[0] > 240 && cropPixel[1] < 20 && cropPixel[2] < 20,
      "PNG preserves custom columns, order and crop",
    );
    await page.locator("#export-dialog [data-close]").click();
    await page.screenshot({
      path: path.join(artifacts, "desktop.png"),
      fullPage: true,
    });

    // Responsive layout, keyboard placement and touch input.
    for (const width of [1440, 1024, 860, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `Page overflow at ${width}px`,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(artifacts, "mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator("#return-all").click();
    assert.equal(await page.locator("#pool-grid [data-image]").count(), 5);
    await page.locator("#pool-grid [data-image]").first().focus();
    await page.keyboard.press("Space");
    await secondRow.focus();
    await page.keyboard.press("Enter");
    assert.equal(await secondRow.locator("[data-image]").count(), 1);
    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const touch = await touchContext.newPage();
    await touch.goto(process.env.TEST_URL || "http://127.0.0.1:8000/");
    await touch.locator("#demo-button").tap();
    await touch.waitForFunction(
      () => document.querySelectorAll("[data-image]").length === 9,
    );
    await touch.locator("#pool-grid [data-image]").first().tap();
    await touch
      .locator(".tier-items")
      .nth(2)
      .tap({ position: { x: 150, y: 30 } });
    assert.equal(
      await touch.locator(".tier-items").nth(2).locator("[data-image]").count(),
      2,
    );
    // Real touch events exercise pointer dragging, in addition to tap-to-place.
    await touch
      .locator(".tier-items")
      .first()
      .locator("[data-image]")
      .first()
      .scrollIntoViewIfNeeded();
    const touchSource = await touch
      .locator(".tier-items")
      .first()
      .locator("[data-image]")
      .first()
      .boundingBox();
    const touchTarget = await touch.locator(".tier-items").nth(1).boundingBox();
    const cdp = await touchContext.newCDPSession(touch);
    const start = {
      x: touchSource.x + touchSource.width / 2,
      y: touchSource.y + touchSource.height / 2,
    };
    const end = { x: touchTarget.x + 170, y: touchTarget.y + 35 };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    for (let i = 1; i <= 12; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + ((end.x - start.x) * i) / 12,
            y: start.y + ((end.y - start.y) * i) / 12,
          },
        ],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    assert.equal(
      await touch.locator(".tier-items").nth(1).locator("[data-image]").count(),
      4,
    );
    await touchContext.close();
    const noStorage = await browser.newContext();
    await noStorage.addInitScript(() =>
      Object.defineProperty(window, "indexedDB", { value: undefined }),
    );
    const offline = await noStorage.newPage();
    await offline.goto(process.env.TEST_URL || "http://127.0.0.1:8000/");
    await offline.waitForFunction(() => !document.querySelector("main").inert);
    await offline.locator("#project-title").fill("无存储也可编辑");
    const fallbackDownload = offline.waitForEvent("download");
    await offline.locator("#save-project").click();
    assert.match(
      (await fallbackDownload).suggestedFilename(),
      /无存储也可编辑/,
    );
    await noStorage.close();
    assert.deepEqual(errors, [], "Runtime or HTTP errors");
    assert.ok(
      responses.every(
        (url) =>
          url.startsWith(process.env.TEST_URL || "http://127.0.0.1:8000/") ||
          /^(blob:|data:)/.test(url),
      ),
      "Unexpected remote dependency",
    );
    console.log(
      "PASS: upload, invalid image handling, click/mouse/touch/keyboard placement, multi-select, reorder, tiers, columns, all ratios, crop pixels, undo/redo, reload persistence, JSON round-trip/rejection, PNG pixels, six viewport widths.",
    );
    console.log(`Artifacts: ${artifacts}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
