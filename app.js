'use strict';

const destinations = {
  songyang: { name: '松阳 · 住进山的褶皱里', location: '浙江 · 丽水 / 山间有风', description: '在浙南的群山之间，找一个小村子住下。看看晨雾中的茶田，在老街喝一杯茶，让生活重新有了缓缓流动的声音。', plan: ['第一天：抵达松阳，在松阳老街散步，尝一碗当地的手工面。', '第二天：清晨前往陈家铺村或杨家堂村，留半天给山间散步与阅读。', '第三天：在大木山茶园感受茶田的绿，午后慢慢返程。'] },
  pingtan: { name: '平潭 · 风是海写来的信', location: '福建 · 福州 / 向海而行', description: '这里有石头厝、长长的海岸线和自由的风。选择一段环岛路，骑到喜欢的地方就停下来，不必赶路。', plan: ['第一天：抵达平潭，沿龙王头海岸散步，找一家小店吃晚饭。', '第二天：顺着北部海岸慢行，看看北港村的石头厝与长江澳的风车。', '第三天：留一个早晨看海，再带着海风的记忆返程。'] },
  yili: { name: '伊犁 · 去没有天花板的地方', location: '新疆 · 伊犁 / 旷野漫游', description: '夏日的草原像一片绿色的海。远处是雪山，近处是野花。把行程拉长一点，把脚步放慢一点，给辽阔留出足够的位置。', plan: ['第 1–2 天：抵达伊宁，逛逛街巷，适应当地节奏，确认后续交通。', '第 3–4 天：选择那拉提或喀拉峻，在开放步道上感受草原与雪山。', '第 5–7 天：根据天气安排赛里木湖或继续草原慢行，预留返程时间。'] }
};
const storageKey = 'wild-letters-v1';
let persisted = {};
try { persisted = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { /* Storage may be unavailable in private browsers. */ }
const saved = new Set(Array.isArray(persisted.saved) ? persisted.saved.filter(id => Object.hasOwn(destinations, id)) : []);
const packing = new Set(Array.isArray(persisted.packing) ? persisted.packing : []);
let currentFilter = 'all';
let showingSaved = false;
let currentDestination = null;
let toastTimeout;
const dialog = document.getElementById('destination-dialog');

function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify({ saved: [...saved], packing: [...packing] })); return true; }
  catch { return false; }
}
function notify(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('visible'), 2800);
}
function render() {
  let visibleCount = 0;
  document.querySelectorAll('.destination').forEach(card => {
    const visible = showingSaved ? saved.has(card.dataset.id) : currentFilter === 'all' || currentFilter === card.dataset.category;
    card.hidden = !visible;
    if (visible) visibleCount++;
    const button = card.querySelector('[data-save]');
    const isSaved = saved.has(card.dataset.id);
    button.textContent = isSaved ? '♥' : '♡';
    button.setAttribute('aria-pressed', String(isSaved));
    button.setAttribute('aria-label', `${isSaved ? '取消收藏' : '收藏'}${destinations[card.dataset.id].name.split(' · ')[0]}`);
  });
  document.getElementById('saved-count').textContent = saved.size;
  document.getElementById('saved-nav').setAttribute('aria-pressed', String(showingSaved));
  document.getElementById('discovery-title').textContent = showingSaved ? '收藏下一次，心动的出发。' : '下一站，去自然里。';
  document.getElementById('result-count').textContent = `${visibleCount} 个${showingSaved ? '已收藏' : '值得出发'}的地方`;
  document.getElementById('empty-state').hidden = visibleCount !== 0;
  document.querySelectorAll('.filter').forEach(button => {
    const active = !showingSaved && button.dataset.filter === currentFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (currentDestination) document.getElementById('dialog-save').textContent = saved.has(currentDestination) ? '已收藏 · 点击取消 ♥' : '收藏这次出发 ♡';
}
function toggleSave(id) {
  const isRemoving = saved.has(id);
  isRemoving ? saved.delete(id) : saved.add(id);
  const stored = persist();
  render();
  notify(`${isRemoving ? '已取消收藏' : '已收藏，愿我们很快出发。'}${stored ? '' : '（仅本次访问有效）'}`);
}
document.querySelectorAll('[data-save]').forEach(button => button.addEventListener('click', () => toggleSave(button.dataset.save)));
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  currentFilter = button.dataset.filter;
  showingSaved = false;
  render();
}));
document.getElementById('saved-nav').addEventListener('click', () => {
  showingSaved = true;
  render();
  document.getElementById('discover').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
});
document.getElementById('show-all').addEventListener('click', () => { showingSaved = false; currentFilter = 'all'; render(); });
document.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => {
  currentDestination = button.dataset.detail;
  const destination = destinations[currentDestination];
  document.getElementById('dialog-location').textContent = destination.location;
  document.getElementById('dialog-title').textContent = destination.name;
  document.getElementById('dialog-description').textContent = destination.description;
  document.getElementById('dialog-plan').replaceChildren(...destination.plan.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  render();
  dialog.showModal();
}));
document.getElementById('dialog-save').addEventListener('click', () => { if (currentDestination) toggleSave(currentDestination); });
document.getElementById('close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
dialog.addEventListener('close', () => { currentDestination = null; });
document.querySelectorAll('[data-pack]').forEach(input => {
  input.checked = packing.has(input.dataset.pack);
  input.addEventListener('change', () => {
    input.checked ? packing.add(input.dataset.pack) : packing.delete(input.dataset.pack);
    if (!persist()) notify('浏览器未允许保存，清单仅本次访问有效。');
  });
});
document.getElementById('year').textContent = new Date().getFullYear();
render();
