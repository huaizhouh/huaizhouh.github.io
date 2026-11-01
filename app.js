"use strict";

// Everything stays in this browser: no upload service or remote dependencies.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const RATIOS = { square: 1, portrait: 2 / 3, horizontal: 3 / 2, wide: 16 / 9 };
const COLORS = [
  "#f3a7aa",
  "#f5c09a",
  "#f5d985",
  "#b9d99d",
  "#a7cce8",
  "#c4b4eb",
  "#d7d9e4",
];
const MAX_IMAGES = 300;
const MAX_TIERS = 50;
const imageCache = new Map();
const selected = new Set();
let state = blankProject();
let undoStack = [];
let redoStack = [];
let database;
let saveTimer;
let saveRevision = 0;
let savedRevision = 0;
let saveRunning = false;
let toastTimer;
let editingTier;
let cropId;
let cropImage;
let cropRequest = 0;
let confirmAction;
let busy = false;
let exporting = false;
let drag;
let dragFrame;
let suppressClickUntil = 0;

function uid() {
  return crypto.randomUUID();
}
function blankProject() {
  return {
    version: 1,
    title: "我的灵感排行榜",
    settings: { ratio: "square", fit: "cover", columns: 8, showNames: false },
    tiers: ["S", "A", "B", "C", "D"].map((name, i) => ({
      id: uid(),
      name,
      color: COLORS[i],
      columns: null,
      items: [],
    })),
    images: [],
    pool: [],
  };
}
function notify(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 3300);
}
// Share immutable image data strings across history entries; copy only editable records.
function cloneProject(project = state) {
  return {
    ...project,
    settings: { ...project.settings },
    images: project.images.map((image) => ({ ...image })),
    tiers: project.tiers.map((tier) => ({ ...tier, items: [...tier.items] })),
    pool: [...project.pool],
  };
}
function checkpoint() {
  undoStack.push(cloneProject());
  if (undoStack.length > 30) undoStack.shift();
  redoStack = [];
}
function commit(change) {
  checkpoint();
  change();
  render();
  scheduleSave();
}
function undo() {
  if (!undoStack.length || busy) return;
  redoStack.push(cloneProject());
  state = undoStack.pop();
  selected.clear();
  render();
  scheduleSave();
}
function redo() {
  if (!redoStack.length || busy) return;
  undoStack.push(cloneProject());
  state = redoStack.pop();
  selected.clear();
  render();
  scheduleSave();
}

// IndexedDB has space for images; localStorage's small quota is unsuitable here.
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("tier-studio", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("projects");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("数据库被其他页面占用"));
  });
}
function databaseRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("projects", mode);
    const request = operation(transaction.objectStore("projects"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error || new Error("保存失败"));
  });
}
function scheduleSave() {
  saveRevision++;
  $("#save-status").textContent = database
    ? "正在保存…"
    : "仅本次会话 · 请下载备份";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 350);
}
async function flushSave() {
  if (!database || saveRunning) return;
  saveRunning = true;
  try {
    while (savedRevision < saveRevision) {
      const revision = saveRevision;
      await databaseRequest("readwrite", (store) =>
        store.put(state, "current"),
      );
      savedRevision = revision;
    }
    $("#save-status").textContent = "已自动保存";
  } catch {
    $("#save-status").textContent = "未能保存 · 请下载备份";
    notify("浏览器存储不可用或空间不足，请下载项目文件备份。");
  } finally {
    saveRunning = false;
  }
}

function contrast(color) {
  const rgb = color
    .slice(1)
    .match(/../g)
    .map((value) => parseInt(value, 16) / 255);
  const linear = rgb.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] > 0.3
    ? "#30303b"
    : "#ffffff";
}
function imageById(id) {
  return state.images.find((image) => image.id === id);
}
function targetItems(target) {
  return target === "pool"
    ? state.pool
    : state.tiers.find((tier) => tier.id === target)?.items;
}
function tileFor(image) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "image-tile";
  tile.dataset.image = image.id;
  tile.title = `${image.name} · 点击选择，双击调整裁剪`;
  tile.setAttribute("aria-label", `选择图片：${image.name}`);
  tile.setAttribute("aria-pressed", String(selected.has(image.id)));
  tile.classList.toggle("is-selected", selected.has(image.id));
  tile.style.setProperty("--pos-x", `${image.x}%`);
  tile.style.setProperty("--pos-y", `${image.y}%`);
  const img = document.createElement("img");
  img.src = image.src;
  img.alt = image.name;
  img.draggable = false;
  tile.append(img);
  if (state.settings.showNames) {
    const label = document.createElement("span");
    label.className = "image-name";
    label.textContent = image.name;
    tile.append(label);
  }
  return tile;
}
function render() {
  const active = document.activeElement;
  const focusImage = active?.dataset.image;
  const focusTier = active?.dataset.editTier;
  document.documentElement.style.setProperty(
    "--ratio",
    RATIOS[state.settings.ratio],
  );
  document.documentElement.style.setProperty("--fit", state.settings.fit);
  if (active !== $("#project-title")) $("#project-title").value = state.title;
  const byId = new Map(state.images.map((image) => [image.id, image]));
  const rows = state.tiers.map((tier, index) => {
    const row = document.createElement("div");
    row.className = "tier-row";
    row.dataset.tier = tier.id;
    const label = document.createElement("button");
    label.className = "tier-label";
    label.classList.toggle("long-name", [...tier.name].length > 3);
    label.dataset.editTier = tier.id;
    label.style.setProperty("--tier-color", tier.color);
    label.style.setProperty("--tier-ink", contrast(tier.color));
    label.textContent = tier.name;
    label.title = "编辑名称、颜色和列数";
    label.setAttribute("aria-label", `编辑层级 ${tier.name}`);
    const items = document.createElement("div");
    items.className = "tier-items drop-target";
    items.dataset.target = tier.id;
    items.style.setProperty(
      "--columns",
      tier.columns || state.settings.columns,
    );
    items.setAttribute("role", "group");
    items.setAttribute(
      "aria-label",
      `${tier.name} 层，${tier.items.length} 张图片，每行 ${tier.columns || state.settings.columns} 张`,
    );
    items.tabIndex = 0;
    items.append(...tier.items.map((id) => tileFor(byId.get(id))));
    const controls = document.createElement("div");
    controls.className = "tier-controls";
    for (const [direction, text, disabled] of [
      [-1, "↑", index === 0],
      [1, "↓", index === state.tiers.length - 1],
    ]) {
      const button = document.createElement("button");
      button.textContent = text;
      button.disabled = disabled;
      button.dataset.moveTier = tier.id;
      button.dataset.direction = direction;
      button.setAttribute(
        "aria-label",
        `${direction < 0 ? "上移" : "下移"} ${tier.name} 层`,
      );
      controls.append(button);
    }
    row.append(label, items, controls);
    return row;
  });
  $("#board").replaceChildren(...rows);
  $("#pool-grid").replaceChildren(
    ...state.pool.map((id) => tileFor(byId.get(id))),
  );
  $("#tier-count").textContent = `${state.tiers.length} 层`;
  $("#pool-count").textContent = `${state.pool.length} 张`;
  $("#total-count").textContent =
    `共 ${state.images.length} 张图片 · 已排序 ${state.images.length - state.pool.length} 张`;
  $(".pool-panel").classList.toggle("has-images", state.images.length > 0);
  $("#global-columns").value = state.settings.columns;
  $("#columns-value").value = state.settings.columns;
  $("#show-names").checked = state.settings.showNames;
  $$(".ratio-option").forEach((button) => {
    const active = button.dataset.ratio === state.settings.ratio;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $$("[data-fit]").forEach((button) => {
    const active = button.dataset.fit === state.settings.fit;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#undo-button").disabled = !undoStack.length || busy;
  $("#redo-button").disabled = !redoStack.length || busy;
  $("#add-tier").disabled = state.tiers.length >= MAX_TIERS;
  $("#return-all").disabled = !state.tiers.some((tier) => tier.items.length);
  $("#select-all").disabled = !state.pool.length;
  renderSelection();
  if (focusImage)
    $$("[data-image]")
      .find((tile) => tile.dataset.image === focusImage)
      ?.focus({ preventScroll: true });
  if (focusTier)
    $$("[data-edit-tier]")
      .find((label) => label.dataset.editTier === focusTier)
      ?.focus({ preventScroll: true });
}
function renderSelection() {
  for (const id of selected) if (!imageById(id)) selected.delete(id);
  $$("[data-image]").forEach((tile) => {
    tile.classList.toggle("is-selected", selected.has(tile.dataset.image));
    tile.setAttribute("aria-pressed", String(selected.has(tile.dataset.image)));
  });
  $("#selection-bar").hidden = !selected.size;
  $("#selection-count").textContent = `已选择 ${selected.size} 张`;
  $("#crop-image").disabled = selected.size !== 1;
}
function moveImages(ids, target, before = null) {
  const destination = targetItems(target);
  if (!destination || !ids.length) return;
  // A multi-selection keeps its visual order, regardless of selection order.
  const chosen = new Set(ids);
  const ordered = [
    ...state.tiers.flatMap((tier) => tier.items),
    ...state.pool,
  ].filter((id) => chosen.has(id));
  const position = before ? destination.indexOf(before) : -1;
  const anchor =
    position < 0
      ? null
      : destination.slice(position).find((id) => !chosen.has(id));
  commit(() => {
    state.tiers.forEach((tier) => {
      tier.items = tier.items.filter((id) => !chosen.has(id));
    });
    state.pool = state.pool.filter((id) => !chosen.has(id));
    const list = targetItems(target);
    const insertion = anchor ? list.indexOf(anchor) : list.length;
    list.splice(insertion, 0, ...ordered);
    selected.clear();
  });
}

function decodeImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      image.naturalWidth && image.naturalHeight
        ? resolve(image)
        : reject(new Error("图片尺寸无效"));
    image.onerror = () => reject(new Error("无法解码图片"));
    image.src = src;
  });
}
function loadImage(image) {
  if (imageCache.has(image.src)) {
    const cached = imageCache.get(image.src);
    imageCache.delete(image.src);
    imageCache.set(image.src, cached);
    return cached;
  }
  const decoded = decodeImage(image.src);
  imageCache.set(image.src, decoded);
  if (imageCache.size > 12) imageCache.delete(imageCache.keys().next().value);
  return decoded;
}
async function normalizeFile(file) {
  if (
    !/^image\/(jpeg|png|webp|gif|avif|bmp|x-ms-bmp)$/i.test(file.type) &&
    !/\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name)
  )
    throw new Error("不支持的图片格式");
  if (file.size > 25 * 1024 * 1024) throw new Error("单张图片超过 25 MB");
  const url = URL.createObjectURL(file);
  try {
    const image = await decodeImage(url);
    const scale = Math.min(
      1,
      1600 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      id: uid(),
      name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "未命名图片",
      src: canvas.toDataURL("image/webp", 0.9),
      x: 50,
      y: 50,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function uploadFiles(files, target = "pool") {
  if (busy) return notify("正在处理图片，请稍候。");
  const available = MAX_IMAGES - state.images.length;
  if (available <= 0)
    return notify(`一个项目最多支持 ${MAX_IMAGES} 张图片，请新建另一个项目。`);
  const incoming = [...files].slice(0, available);
  if (!incoming.length) return;
  busy = true;
  render();
  const images = [];
  const failures = [];
  try {
    for (let index = 0; index < incoming.length; index++) {
      $("#save-status").textContent =
        `处理图片 ${index + 1}/${incoming.length}…`;
      try {
        images.push(await normalizeFile(incoming[index]));
      } catch (error) {
        failures.push(`${incoming[index].name}：${error.message}`);
      }
    }
    if (images.length)
      commit(() => {
        state.images.push(...images);
        (targetItems(target) || state.pool).push(
          ...images.map((image) => image.id),
        );
      });
    const summary = `已添加 ${images.length} 张图片${failures.length ? `，${failures.length} 张未能读取（格式不支持、文件损坏或超过 25 MB）` : ""}${files.length > available ? `；超出 ${MAX_IMAGES} 张的部分已跳过` : ""}。`;
    notify(summary);
  } finally {
    busy = false;
    render();
    if (!images.length)
      $("#save-status").textContent = database
        ? "项目未变更"
        : "仅本次会话 · 请下载备份";
    $("#image-input").value = "";
  }
}

// Pointer dragging supports mouse, pen and touch. Click-to-place is also keyboard accessible.
function clearDragHighlights() {
  $$(".drag-over, .insert-before").forEach((element) =>
    element.classList.remove("drag-over", "insert-before"),
  );
}
function dropLocation(x, y) {
  const element = document.elementFromPoint(x, y);
  const target = element?.closest(".drop-target");
  if (!target) return null;
  const tile = element.closest("[data-image]");
  let before = null;
  if (tile) {
    const rect = tile.getBoundingClientRect();
    const list = targetItems(target.dataset.target);
    const index = list.indexOf(tile.dataset.image);
    before =
      x < rect.left + rect.width / 2
        ? tile.dataset.image
        : list[index + 1] || null;
  }
  return { target, before };
}
function updateDrag() {
  if (!drag?.active) return;
  const { x, y } = drag;
  $("#drag-ghost").style.left = `${Math.min(x + 14, innerWidth - 110)}px`;
  $("#drag-ghost").style.top = `${y + 14}px`;
  clearDragHighlights();
  const location = dropLocation(x, y);
  if (location) {
    location.target.classList.add("drag-over");
    if (location.before)
      [...location.target.children]
        .find((tile) => tile.dataset.image === location.before)
        ?.classList.add("insert-before");
  }
  if (y < 75) window.scrollBy(0, -12);
  if (y > innerHeight - 75) window.scrollBy(0, 12);
  const viewport = $(".board-viewport");
  const rect = viewport.getBoundingClientRect();
  if (y > rect.top && y < rect.bottom) {
    if (x < rect.left + 32) viewport.scrollLeft -= 10;
    if (x > rect.right - 32) viewport.scrollLeft += 10;
  }
  dragFrame = requestAnimationFrame(updateDrag);
}
document.addEventListener("pointerdown", (event) => {
  const tile = event.target.closest("[data-image]");
  if (!tile || event.button !== 0 || busy) return;
  drag = {
    id: tile.dataset.image,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    active: false,
  };
});
document.addEventListener(
  "pointermove",
  (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (
      !drag.active &&
      Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 7
    ) {
      drag.active = true;
      drag.ids = selected.has(drag.id) ? [...selected] : [drag.id];
      $("#drag-ghost").textContent = `移动 ${drag.ids.length} 张图片`;
      $("#drag-ghost").hidden = false;
      document.body.classList.add("is-dragging");
      dragFrame = requestAnimationFrame(updateDrag);
    }
    if (drag.active) event.preventDefault();
  },
  { passive: false },
);
function finishDrag(event, cancelled = false) {
  if (
    !drag ||
    (event.pointerId !== undefined && event.pointerId !== drag.pointerId)
  )
    return;
  const activeDrag = drag;
  drag = null;
  cancelAnimationFrame(dragFrame);
  clearDragHighlights();
  $("#drag-ghost").hidden = true;
  document.body.classList.remove("is-dragging");
  if (activeDrag.active) {
    suppressClickUntil = performance.now() + 400;
    if (!cancelled) {
      const location = dropLocation(event.clientX, event.clientY);
      if (location)
        moveImages(
          activeDrag.ids,
          location.target.dataset.target,
          location.before,
        );
    }
  }
}
document.addEventListener("pointerup", (event) => finishDrag(event));
document.addEventListener("pointercancel", (event) => finishDrag(event, true));
window.addEventListener("blur", () => {
  if (drag) finishDrag({}, true);
});

document.addEventListener("click", (event) => {
  if (performance.now() < suppressClickUntil) return;
  const tile = event.target.closest("[data-image]");
  if (tile) {
    const id = tile.dataset.image;
    selected.has(id) ? selected.delete(id) : selected.add(id);
    renderSelection();
    return;
  }
  const target = event.target.closest(".drop-target");
  if (target && selected.size && !busy)
    moveImages([...selected], target.dataset.target);
  const label = event.target.closest("[data-edit-tier]");
  if (label) openTier(label.dataset.editTier);
  const move = event.target.closest("[data-move-tier]");
  if (move)
    commit(() => {
      const index = state.tiers.findIndex(
        (tier) => tier.id === move.dataset.moveTier,
      );
      const next = index + Number(move.dataset.direction);
      if (next >= 0 && next < state.tiers.length)
        [state.tiers[index], state.tiers[next]] = [
          state.tiers[next],
          state.tiers[index],
        ];
    });
});
document.addEventListener("dblclick", (event) => {
  const tile = event.target.closest("[data-image]");
  if (tile) openCrop(tile.dataset.image);
});
document.addEventListener("keydown", (event) => {
  const editing = event.target.matches(
    "input, textarea, select, [contenteditable]",
  );
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    selected.clear();
    renderSelection();
    if (drag) finishDrag({}, true);
  }
  if (editing || document.querySelector("dialog[open]")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
  }
  if (
    (event.key === "Enter" || event.key === " ") &&
    event.target.matches(".drop-target") &&
    selected.size
  ) {
    event.preventDefault();
    moveImages([...selected], event.target.dataset.target);
  }
});
// Prevent browser navigation when image files are dropped outside the uploader.
document.addEventListener("dragover", (event) => {
  if (![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault();
  if (event.target.closest(".pool-panel, .drop-target"))
    $("#upload-zone").classList.add("file-over");
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) $("#upload-zone").classList.remove("file-over");
});
document.addEventListener("drop", (event) => {
  if (![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault();
  $("#upload-zone").classList.remove("file-over");
  const target = event.target.closest(".drop-target");
  if (event.target.closest(".pool-panel") || target)
    uploadFiles(event.dataTransfer.files, target?.dataset.target || "pool");
});

function openTier(id) {
  if (busy) return;
  const tier = state.tiers.find((tier) => tier.id === id);
  if (!tier) return;
  editingTier = id;
  $("#tier-name").value = tier.name;
  $("#tier-color").value = tier.color;
  $("#color-value").textContent = tier.color.toUpperCase();
  $("#use-global-columns").checked = tier.columns === null;
  $("#tier-columns").disabled = tier.columns === null;
  $("#tier-columns").value = tier.columns || state.settings.columns;
  $("#delete-tier").disabled = state.tiers.length === 1;
  $("#tier-dialog").showModal();
}
for (const color of COLORS) {
  const button = document.createElement("button");
  button.type = "button";
  button.style.background = color;
  button.setAttribute("aria-label", `使用颜色 ${color}`);
  button.addEventListener("click", () => {
    $("#tier-color").value = color;
    $("#color-value").textContent = color.toUpperCase();
  });
  $("#color-swatches").append(button);
}
$("#tier-color").addEventListener("input", (event) => {
  $("#color-value").textContent = event.target.value.toUpperCase();
});
$("#use-global-columns").addEventListener("change", (event) => {
  $("#tier-columns").disabled = event.target.checked;
  if (event.target.checked) $("#tier-columns").value = state.settings.columns;
});
$("#tier-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#tier-name").value.trim();
  if (!name) return notify("请输入层级名称。");
  const columns = $("#use-global-columns").checked
    ? null
    : Number($("#tier-columns").value);
  if (
    columns !== null &&
    (!Number.isInteger(columns) || columns < 1 || columns > 20)
  )
    return notify("列数需要是 1–20 的整数。");
  commit(() => {
    const tier = state.tiers.find((tier) => tier.id === editingTier);
    Object.assign(tier, { name, columns, color: $("#tier-color").value });
  });
  $("#tier-dialog").close();
});
$("#delete-tier").addEventListener("click", () => {
  if (state.tiers.length === 1) return;
  commit(() => {
    const index = state.tiers.findIndex((tier) => tier.id === editingTier);
    state.pool.push(...state.tiers[index].items);
    state.tiers.splice(index, 1);
  });
  $("#tier-dialog").close();
  notify("层级已删除，图片已移回待排序区。可撤销此操作。");
});
$("#add-tier").addEventListener("click", () => {
  if (state.tiers.length >= MAX_TIERS || busy) return;
  const tier = {
    id: uid(),
    name: `新层级`,
    color: COLORS[state.tiers.length % COLORS.length],
    columns: null,
    items: [],
  };
  commit(() => state.tiers.push(tier));
  openTier(tier.id);
});

function drawPhoto(
  context,
  image,
  x,
  y,
  width,
  height,
  fit,
  posX = 50,
  posY = 50,
) {
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;
  context.fillStyle = "#e8eaf1";
  context.fillRect(x, y, width, height);
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  if (fit === "contain") {
    const scale = Math.min(width / iw, height / ih);
    context.drawImage(
      image,
      x + ((width - iw * scale) * posX) / 100,
      y + ((height - ih * scale) * posY) / 100,
      iw * scale,
      ih * scale,
    );
  } else {
    const scale = Math.max(width / iw, height / ih);
    const sw = width / scale;
    const sh = height / scale;
    context.drawImage(
      image,
      ((iw - sw) * posX) / 100,
      ((ih - sh) * posY) / 100,
      sw,
      sh,
      x,
      y,
      width,
      height,
    );
  }
  context.restore();
}
async function openCrop(id) {
  const image = imageById(id);
  if (!image || busy) return;
  const request = ++cropRequest;
  try {
    const decoded = await loadImage(image);
    if (request !== cropRequest) return;
    cropId = id;
    cropImage = decoded;
    $("#crop-x").value = image.x;
    $("#crop-y").value = image.y;
    $("#crop-name").textContent = image.name;
    renderCrop();
    if (!$("#crop-dialog").open) $("#crop-dialog").showModal();
  } catch {
    notify("无法读取这张图片，请重新上传。");
  }
}
function renderCrop() {
  const canvas = $("#crop-preview");
  const ratio = RATIOS[state.settings.ratio];
  canvas.width = ratio >= 1 ? 640 : Math.round(640 * ratio);
  canvas.height = ratio >= 1 ? Math.round(640 / ratio) : 640;
  $("#crop-x-value").value = `${$("#crop-x").value}%`;
  $("#crop-y-value").value = `${$("#crop-y").value}%`;
  drawPhoto(
    canvas.getContext("2d"),
    cropImage,
    0,
    0,
    canvas.width,
    canvas.height,
    state.settings.fit,
    Number($("#crop-x").value),
    Number($("#crop-y").value),
  );
}
$("#crop-x").addEventListener("input", renderCrop);
$("#crop-y").addEventListener("input", renderCrop);
$("#reset-crop").addEventListener("click", () => {
  $("#crop-x").value = 50;
  $("#crop-y").value = 50;
  renderCrop();
});
$("#apply-crop").addEventListener("click", () => {
  commit(() =>
    Object.assign(imageById(cropId), {
      x: Number($("#crop-x").value),
      y: Number($("#crop-y").value),
    }),
  );
  $("#crop-dialog").close();
});

function confirm(title, message, action) {
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  confirmAction = action;
  $("#confirm-dialog").showModal();
}
$("#confirm-action").addEventListener("click", () => {
  $("#confirm-dialog").close();
  const action = confirmAction;
  confirmAction = null;
  action?.();
});
$$("[data-close]").forEach((button) =>
  button.addEventListener("click", () => button.closest("dialog").close()),
);
$("#help-button").addEventListener("click", () =>
  $("#help-dialog").showModal(),
);
$("#undo-button").addEventListener("click", undo);
$("#redo-button").addEventListener("click", redo);
$("#upload-button").addEventListener("click", () => {
  if (!busy) $("#image-input").click();
});
$("#upload-zone").addEventListener("click", () => {
  if (!busy) $("#image-input").click();
});
$("#upload-zone").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (!busy) $("#image-input").click();
  }
});
$("#image-input").addEventListener("change", (event) =>
  uploadFiles(event.target.files),
);
$("#deselect").addEventListener("click", () => {
  selected.clear();
  renderSelection();
});
$("#select-all").addEventListener("click", () => {
  state.pool.forEach((id) => selected.add(id));
  renderSelection();
});
$("#crop-image").addEventListener("click", () => {
  if (selected.size === 1) openCrop([...selected][0]);
});
$("#delete-images").addEventListener("click", () => {
  if (!selected.size || busy) return;
  const ids = new Set(selected);
  confirm(
    "删除所选图片？",
    `将从项目中删除 ${ids.size} 张图片，可使用撤销恢复。`,
    () =>
      commit(() => {
        state.images = state.images.filter((image) => !ids.has(image.id));
        state.tiers.forEach((tier) => {
          tier.items = tier.items.filter((id) => !ids.has(id));
        });
        state.pool = state.pool.filter((id) => !ids.has(id));
        selected.clear();
      }),
  );
});
$("#return-all").addEventListener("click", () => {
  if (busy) return;
  const ids = state.tiers.flatMap((tier) => tier.items);
  if (ids.length) moveImages(ids, "pool");
});
$$("[data-ratio]").forEach((button) =>
  button.addEventListener("click", () => {
    if (state.settings.ratio !== button.dataset.ratio)
      commit(() => {
        state.settings.ratio = button.dataset.ratio;
      });
  }),
);
$$("[data-fit]").forEach((button) =>
  button.addEventListener("click", () => {
    if (state.settings.fit !== button.dataset.fit)
      commit(() => {
        state.settings.fit = button.dataset.fit;
      });
  }),
);
$("#show-names").addEventListener("change", (event) =>
  commit(() => {
    state.settings.showNames = event.target.checked;
  }),
);
// One undo step per editing gesture, instead of one per keystroke/range tick.
function groupedInput(element, change) {
  let checkpointed = false;
  element.addEventListener("input", () => {
    if (!checkpointed) {
      checkpoint();
      checkpointed = true;
    }
    change(element.value);
    if (element.id !== "project-title") render();
    else {
      $("#undo-button").disabled = false;
      $("#redo-button").disabled = true;
    }
    scheduleSave();
  });
  element.addEventListener("change", () => {
    checkpointed = false;
  });
  element.addEventListener("blur", () => {
    checkpointed = false;
  });
}
groupedInput($("#project-title"), (value) => {
  state.title = value;
});
groupedInput($("#global-columns"), (value) => {
  state.settings.columns = Number(value);
});

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function filename() {
  return (state.title.trim() || "我的排行榜")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 80);
}
function saveProject() {
  download(
    new Blob([JSON.stringify(state)], { type: "application/json" }),
    `${filename()}.tier.json`,
  );
  notify("项目文件已生成，包含图片与布局，可随时重新导入。");
}
$("#save-project").addEventListener("click", saveProject);
$("#export-backup").addEventListener("click", saveProject);
$("#import-project").addEventListener("click", () => {
  if (!busy) $("#project-input").click();
});

function validateProject(data) {
  const validInt = (value, min, max) =>
    Number.isInteger(value) && value >= min && value <= max;
  if (
    !data ||
    data.version !== 1 ||
    typeof data.title !== "string" ||
    data.title.length > 100 ||
    !Array.isArray(data.images) ||
    data.images.length > MAX_IMAGES ||
    !Array.isArray(data.tiers) ||
    !data.tiers.length ||
    data.tiers.length > MAX_TIERS ||
    !Array.isArray(data.pool)
  )
    throw new Error("不是有效的 Tier Studio 项目文件");
  const settings = data.settings;
  if (
    !settings ||
    !Object.hasOwn(RATIOS, settings.ratio) ||
    !["cover", "contain"].includes(settings.fit) ||
    !validInt(settings.columns, 1, 20) ||
    typeof settings.showNames !== "boolean"
  )
    throw new Error("项目设置无效");
  const ids = new Set();
  for (const image of data.images) {
    if (
      !image ||
      typeof image.id !== "string" ||
      !image.id ||
      image.id.length > 100 ||
      ids.has(image.id) ||
      typeof image.name !== "string" ||
      image.name.length > 120 ||
      typeof image.src !== "string" ||
      !/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image.src) ||
      image.src.length > 15 * 1024 * 1024 ||
      !Number.isFinite(image.x) ||
      !Number.isFinite(image.y) ||
      image.x < 0 ||
      image.x > 100 ||
      image.y < 0 ||
      image.y > 100
    )
      throw new Error("图片数据或裁剪参数无效");
    ids.add(image.id);
  }
  const tierIds = new Set();
  const placements = [...data.pool];
  for (const tier of data.tiers) {
    if (
      !tier ||
      typeof tier.id !== "string" ||
      !tier.id ||
      tier.id === "pool" ||
      tier.id.length > 100 ||
      tierIds.has(tier.id) ||
      typeof tier.name !== "string" ||
      !tier.name.trim() ||
      tier.name.length > 40 ||
      !/^#[a-f\d]{6}$/i.test(tier.color) ||
      !(tier.columns === null || validInt(tier.columns, 1, 20)) ||
      !Array.isArray(tier.items)
    )
      throw new Error("层级数据无效");
    tierIds.add(tier.id);
    placements.push(...tier.items);
  }
  if (
    placements.length !== ids.size ||
    new Set(placements).size !== ids.size ||
    placements.some((id) => !ids.has(id))
  )
    throw new Error("图片位置数据不完整或重复");
  // Construct known fields only. Imported HTML/scripts and arbitrary object fields are never used.
  return {
    version: 1,
    title: data.title,
    settings: {
      ratio: settings.ratio,
      fit: settings.fit,
      columns: settings.columns,
      showNames: settings.showNames,
    },
    images: data.images.map(({ id, name, src, x, y }) => ({
      id,
      name,
      src,
      x,
      y,
    })),
    tiers: data.tiers.map(({ id, name, color, columns, items }) => ({
      id,
      name,
      color,
      columns,
      items: [...items],
    })),
    pool: [...data.pool],
  };
}
$("#project-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || busy) return;
  if (file.size > 100 * 1024 * 1024)
    return notify("项目文件超过 100 MB，请使用较小的项目。");
  busy = true;
  try {
    const imported = validateProject(JSON.parse(await file.text()));
    for (const image of imported.images) {
      const decoded = await decodeImage(image.src);
      if (decoded.naturalWidth > 1600 || decoded.naturalHeight > 1600)
        throw new Error("图片工作副本的最长边应不超过 1600 像素");
    }
    const apply = () => {
      commit(() => {
        state = imported;
        selected.clear();
      });
      imageCache.clear();
      notify("项目已导入，可继续编辑。");
    };
    if (state.images.length)
      confirm(
        "导入项目？",
        "将替换当前画板，之后仍可使用撤销恢复。建议先下载当前项目备份。",
        apply,
      );
    else apply();
  } catch (error) {
    notify(
      `导入失败：${error instanceof SyntaxError ? "文件不是有效的 JSON" : error.message}`,
    );
  } finally {
    busy = false;
    render();
  }
});
$("#new-project").addEventListener("click", () => {
  if (busy) return;
  confirm(
    "新建空白画板？",
    "当前画板将被替换，自动保存也会更新。你可以先保存项目文件备份；此操作也支持撤销。",
    () => {
      commit(() => {
        state = blankProject();
        selected.clear();
      });
      imageCache.clear();
    },
  );
});

// PNG is rendered directly from the same placement/crop data, without DOM-capture libraries.
function fitText(context, text, width) {
  if (context.measureText(text).width <= width) return text;
  const chars = [...text];
  while (
    chars.length &&
    context.measureText(chars.join("") + "…").width > width
  )
    chars.pop();
  return chars.join("") + "…";
}
function wrapText(context, text, width) {
  const lines = [];
  let current = "";
  for (const character of text) {
    if (current && context.measureText(current + character).width > width) {
      lines.push(current);
      current = "";
    }
    current += character;
  }
  if (current) lines.push(current);
  return lines;
}
async function exportPng() {
  if (exporting || busy) return;
  const includePool = $("#export-pool").checked;
  const count =
    state.images.length -
    state.pool.length +
    (includePool ? state.pool.length : 0);
  if (!count) {
    $("#export-status").textContent =
      "还没有可导出的图片。请先排序，或勾选“包含待排序图片”。";
    return;
  }
  exporting = true;
  $("#download-png").disabled = true;
  $("#export-status").textContent = "正在绘制高清图片…";
  const snapshot = cloneProject();
  try {
    const byId = new Map(snapshot.images.map((image) => [image.id, image]));
    const width = 1200;
    const margin = 32;
    const labelWidth = 110;
    const contentWidth = width - margin * 2 - labelWidth;
    const gap = 5;
    const padding = 8;
    const ratio = RATIOS[snapshot.settings.ratio];
    const font =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
    const rows = [...snapshot.tiers];
    if (includePool && snapshot.pool.length)
      rows.push({
        name: "待排序",
        color: "#ddd9ed",
        columns: null,
        items: snapshot.pool,
      });
    const measure = document.createElement("canvas").getContext("2d");
    const metrics = rows.map((tier) => {
      const columns = tier.columns || snapshot.settings.columns;
      const cellWidth =
        (contentWidth - padding * 2 - (columns - 1) * gap) / columns;
      const cellHeight = cellWidth / ratio;
      measure.font = `600 ${tier.name.length <= 3 ? 29 : 16}px ${font}`;
      const labelHeight =
        wrapText(measure, tier.name, labelWidth - 18).length * 23 + 24;
      return {
        columns,
        cellWidth,
        cellHeight,
        height: Math.max(
          88,
          labelHeight,
          Math.ceil(tier.items.length / columns) * (cellHeight + gap) -
            gap +
            padding * 2,
        ),
      };
    });
    const headerHeight = $("#export-title-check").checked ? 108 : 32;
    const height = Math.ceil(
      headerHeight +
        metrics.reduce((sum, metric) => sum + metric.height + 3, 0) +
        52,
    );
    const requestedScale = Number($("#export-scale").value);
    // Keep both canvas dimensions and total pixels within conservative browser limits.
    const scale = Math.min(
      requestedScale,
      16000 / height,
      Math.sqrt(24000000 / (width * height)),
    );
    if (scale < 0.3)
      throw new Error("内容太长，请增加每层列数或拆分项目后导出。");
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建导出画布");
    context.scale(scale, scale);
    context.fillStyle = "#f5f6fa";
    context.fillRect(0, 0, width, height);
    context.textBaseline = "middle";
    if ($("#export-title-check").checked) {
      context.fillStyle = "#282439";
      context.font = `600 30px ${font}`;
      context.fillText(
        fitText(context, snapshot.title || "我的排行榜", width - margin * 2),
        margin,
        49,
      );
      context.fillStyle = "#9490a5";
      context.font = `12px ${font}`;
      context.fillText(
        `${snapshot.tiers.length} 个层级 · ${count} 张图片`,
        margin,
        82,
      );
    }
    let y = headerHeight;
    for (const [index, tier] of rows.entries()) {
      const {
        columns,
        cellWidth,
        cellHeight,
        height: rowHeight,
      } = metrics[index];
      context.fillStyle = "#e9ebf2";
      context.fillRect(margin + labelWidth, y, contentWidth, rowHeight);
      context.fillStyle = tier.color;
      context.fillRect(margin, y, labelWidth, rowHeight);
      context.save();
      context.beginPath();
      context.rect(margin, y, labelWidth, rowHeight);
      context.clip();
      context.fillStyle = contrast(tier.color);
      context.font = `600 ${tier.name.length <= 3 ? 29 : 16}px ${font}`;
      context.textAlign = "center";
      const lines = wrapText(context, tier.name, labelWidth - 18);
      lines.forEach((line, i) =>
        context.fillText(
          line,
          margin + labelWidth / 2,
          y + rowHeight / 2 + (i - (lines.length - 1) / 2) * 23,
        ),
      );
      context.restore();
      for (const [position, id] of tier.items.entries()) {
        const image = byId.get(id);
        const x =
          margin +
          labelWidth +
          padding +
          (position % columns) * (cellWidth + gap);
        const top =
          y + padding + Math.floor(position / columns) * (cellHeight + gap);
        drawPhoto(
          context,
          await loadImage(image),
          x,
          top,
          cellWidth,
          cellHeight,
          snapshot.settings.fit,
          image.x,
          image.y,
        );
        if (snapshot.settings.showNames) {
          const nameHeight = Math.min(24, cellHeight * 0.35);
          context.fillStyle = "#172037ba";
          context.fillRect(
            x,
            top + cellHeight - nameHeight,
            cellWidth,
            nameHeight,
          );
          context.fillStyle = "#ffffff";
          context.font = `${Math.min(11, nameHeight * 0.6)}px ${font}`;
          context.fillText(
            fitText(context, image.name, cellWidth - 8),
            x + 4,
            top + cellHeight - nameHeight / 2,
          );
        }
      }
      y += rowHeight + 3;
    }
    context.fillStyle = "#a29bae";
    context.font = `11px ${font}`;
    context.fillText(
      "tierstudio.  /  你的排名，你来定义。",
      margin,
      height - 24,
    );
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("图片生成失败，请尝试标准清晰度。");
    download(blob, `${filename()}.png`);
    $("#export-status").textContent =
      `已生成 ${canvas.width} × ${canvas.height} PNG${scale < requestedScale ? "（内容较长，已自动调整分辨率）" : ""}。`;
    notify("PNG 已生成，保存你的独家排名吧。");
  } catch (error) {
    $("#export-status").textContent = `导出失败：${error.message}`;
  } finally {
    exporting = false;
    $("#download-png").disabled = false;
  }
}
$("#export-button").addEventListener("click", () => {
  $("#export-status").textContent = "";
  $("#export-dialog").showModal();
});
$("#download-png").addEventListener("click", exportPng);

async function loadDemo() {
  if (busy) return;
  busy = true;
  render();
  try {
    const images = [];
    const art = ["mountains", "coast", "grassland"];
    const names = [
      "山间的日出",
      "海边发呆",
      "草原漫游",
      "山里住一晚",
      "追一场日落",
      "旷野看云",
      "茶田散步",
      "沿海公路",
      "野餐时刻",
    ];
    for (let i = 0; i < names.length; i++) {
      const image = await decodeImage(`assets/${art[i % 3]}.svg`);
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 400;
      const context = canvas.getContext("2d");
      context.drawImage(image, -i * 7, -i * 10, 500 + i * 10, 400 + i * 10);
      if (i >= 3) {
        context.fillStyle = i < 6 ? "#dda77520" : "#6377ba20";
        context.fillRect(0, 0, 400, 400);
      }
      images.push({
        id: uid(),
        name: names[i],
        src: canvas.toDataURL("image/webp", 0.9),
        x: 50,
        y: 50,
      });
    }
    commit(() => {
      state = blankProject();
      state.title = "我的理想周末排行榜";
      state.images = images;
      state.tiers[0].items = images.slice(0, 2).map((image) => image.id);
      state.tiers[1].items = images.slice(2, 5).map((image) => image.id);
      state.tiers[2].items = images.slice(5, 6).map((image) => image.id);
      state.pool = images.slice(6).map((image) => image.id);
      selected.clear();
    });
    notify("示例已就位。试着把图片拖到你喜欢的层级吧！");
  } catch {
    notify("示例图片加载失败，请使用本地图片开始。");
  } finally {
    busy = false;
    render();
  }
}
$("#demo-button").addEventListener("click", () => {
  if (state.images.length)
    confirm(
      "载入示例画板？",
      "示例会替换当前画板，之后可以撤销恢复。建议先下载备份。",
      loadDemo,
    );
  else loadDemo();
});

async function initialize() {
  busy = true;
  render();
  try {
    database = await openDatabase();
    database.onversionchange = () => {
      database.close();
      database = null;
      $("#save-status").textContent = "存储已更新 · 请刷新页面";
    };
    const saved = await databaseRequest("readonly", (store) =>
      store.get("current"),
    );
    if (saved) state = validateProject(saved);
    $("#save-status").textContent = saved ? "已恢复本地项目" : "自动保存已开启";
  } catch {
    $("#save-status").textContent = "自动恢复不可用 · 请保存备份";
    notify("无法恢复本地项目。你仍可编辑，并导出项目文件备份。");
  } finally {
    busy = false;
    render();
    $(".workspace").inert = false;
  }
}
window.addEventListener("pagehide", () => {
  clearTimeout(saveTimer);
  flushSave();
});
initialize();
