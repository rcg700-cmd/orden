const api = window.orden;

const state = {
  root: null,
  plan: null,
  selected: new Set(),
  undo: null,
  busy: false,
};

const el = {
  rootPath: document.getElementById("rootPath"),
  configBadge: document.getElementById("configBadge"),
  empty: document.getElementById("empty"),
  content: document.getElementById("content"),
  cards: document.getElementById("cards"),
  list: document.getElementById("list"),
  selectAll: document.getElementById("selectAll"),
  selection: document.getElementById("selection"),
  apply: document.getElementById("apply"),
  undo: document.getElementById("undo"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modalTitle"),
  modalBody: document.getElementById("modalBody"),
  modalOk: document.getElementById("modalOk"),
  modalCancel: document.getElementById("modalCancel"),
  toast: document.getElementById("toast"),
};

const boxes = new Map();
let toastTimer = null;
let modalResolve = null;

async function call(promise) {
  const response = await promise;
  if (!response || response.ok !== true) {
    throw new Error(response?.error ?? "error desconocido");
  }
  return response.data;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function toast(message, kind = "info") {
  el.toast.textContent = message;
  el.toast.className = `toast ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 4000);
}

function confirmModal(title, body, okLabel) {
  el.modalTitle.textContent = title;
  el.modalBody.textContent = body;
  el.modalOk.textContent = okLabel;
  el.modal.classList.remove("hidden");
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(value) {
  el.modal.classList.add("hidden");
  const resolve = modalResolve;
  modalResolve = null;
  resolve?.(value);
}

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  updateFooter();
}

function selectedBytes() {
  if (!state.plan) return 0;
  return state.plan.items
    .filter((item) => state.selected.has(item.source))
    .reduce((total, item) => total + item.size, 0);
}

function updateFooter() {
  const total = state.plan?.items.length ?? 0;
  const count = state.selected.size;

  el.selection.textContent = `${count} de ${total} seleccionados · ${humanSize(selectedBytes())}`;
  el.selectAll.checked = count > 0 && count === total;
  el.selectAll.indeterminate = count > 0 && count < total;

  el.apply.disabled = state.busy || count === 0;
  el.apply.textContent = count > 0 ? `Aplicar ${count}` : "Aplicar";
  el.undo.disabled = state.busy || !state.undo;
}

function updateGroupChecks() {
  for (const section of el.list.querySelectorAll(".group")) {
    const groupBox = section.querySelector("header input[type=checkbox]");
    const items = [...section.querySelectorAll(".row")].map((row) => row.dataset.source);
    const chosen = items.filter((source) => state.selected.has(source)).length;
    groupBox.checked = chosen === items.length && items.length > 0;
    groupBox.indeterminate = chosen > 0 && chosen < items.length;
  }
}

function syncBox(source) {
  const box = boxes.get(source);
  if (box) box.checked = state.selected.has(source);
}

function renderCards() {
  const plan = state.plan;
  const cards = [
    ["Revisados", String(plan.scanned)],
    ["Por mover", String(plan.items.length)],
    ["Tamaño", humanSize(plan.items.reduce((total, item) => total + item.size, 0))],
    ["Sin regla", String(plan.unmatched)],
  ];

  el.cards.replaceChildren(
    ...cards.map(([label, value]) => {
      const card = document.createElement("div");
      card.className = "card";
      const valueEl = document.createElement("div");
      valueEl.className = "value";
      valueEl.textContent = value;
      const labelEl = document.createElement("div");
      labelEl.className = "label";
      labelEl.textContent = label;
      card.append(valueEl, labelEl);
      return card;
    }),
  );
}

function buildRow(item) {
  const row = document.createElement("label");
  row.className = "row";
  row.dataset.source = item.source;

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = state.selected.has(item.source);
  box.addEventListener("change", () => {
    if (box.checked) state.selected.add(item.source);
    else state.selected.delete(item.source);
    updateGroupChecks();
    updateFooter();
  });
  boxes.set(item.source, box);

  const source = document.createElement("span");
  source.className = "src";
  source.textContent = item.source;
  source.title = item.source;

  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "→";

  const destination = document.createElement("span");
  destination.className = "dst";
  destination.textContent = item.destination;
  destination.title = item.destination;

  const size = document.createElement("span");
  size.className = "size";
  size.textContent = humanSize(item.size);

  row.append(box, source, arrow, destination, size);
  return row;
}

function buildGroup(rule, items) {
  const section = document.createElement("section");
  section.className = "group";

  const header = document.createElement("header");
  const box = document.createElement("input");
  box.type = "checkbox";

  const name = document.createElement("strong");
  name.textContent = rule;

  const meta = document.createElement("span");
  meta.className = "meta";
  const bytes = items.reduce((total, item) => total + item.size, 0);
  meta.textContent = `${items.length} archivo(s) · ${humanSize(bytes)}`;

  box.addEventListener("change", () => {
    for (const item of items) {
      if (box.checked) state.selected.add(item.source);
      else state.selected.delete(item.source);
      syncBox(item.source);
    }
    updateGroupChecks();
    updateFooter();
  });

  header.append(box, name, meta);
  section.append(header, ...items.map(buildRow));
  return section;
}

function renderList() {
  boxes.clear();

  if (state.plan.items.length === 0) {
    const done = document.createElement("div");
    done.className = "empty";
    done.innerHTML = "";
    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = "✓";
    const title = document.createElement("h1");
    title.textContent = "Nada que mover";
    const text = document.createElement("p");
    text.textContent = "Esta carpeta ya está ordenada según tus reglas.";
    done.append(icon, title, text);
    el.list.replaceChildren(done);
    return;
  }

  const groups = new Map();
  for (const item of state.plan.items) {
    const bucket = groups.get(item.rule);
    if (bucket) bucket.push(item);
    else groups.set(item.rule, [item]);
  }

  el.list.replaceChildren(...[...groups].map(([rule, items]) => buildGroup(rule, items)));
  updateGroupChecks();
}

function render() {
  const hasPlan = state.plan !== null;
  el.empty.classList.toggle("hidden", hasPlan);
  el.content.classList.toggle("hidden", !hasPlan);

  if (!hasPlan) {
    updateFooter();
    return;
  }

  el.rootPath.textContent = state.plan.root;
  el.rootPath.title = state.plan.root;

  el.configBadge.textContent = state.plan.configFile ? "orden.config.json" : "reglas por defecto";
  el.configBadge.title = state.plan.configFile ?? "No hay orden.config.json en esta carpeta";
  el.configBadge.classList.remove("hidden");
  el.configBadge.classList.toggle("warn", !state.plan.configFile);

  renderCards();
  renderList();
  updateFooter();
}

async function openFolder(root, options = {}) {
  setBusy(true);
  try {
    const plan = await call(api.scan(root));
    state.root = plan.root;
    state.plan = plan;
    state.selected = new Set(plan.items.map((item) => item.source));
    state.undo = await call(api.undoStatus(plan.root));
    try {
      localStorage.setItem("orden:lastFolder", plan.root);
    } catch {
      // sin persistencia, no pasa nada
    }
    render();
    return { ok: true, items: plan.items.length };
  } catch (error) {
    if (!options.quiet) toast(error.message, "error");
    return { ok: false, error: error.message };
  } finally {
    setBusy(false);
  }
}

async function reload() {
  if (!state.root) return;
  await openFolder(state.root);
}

async function applySelected(skipConfirm = false) {
  if (state.busy || !state.plan || state.selected.size === 0) return null;

  const sources = [...state.selected];
  if (!skipConfirm) {
    const ok = await confirmModal(
      "Mover archivos",
      `Se moverán ${sources.length} archivo(s) (${humanSize(selectedBytes())}). Podrás deshacerlo cuando quieras.`,
      "Mover",
    );
    if (!ok) return null;
  }

  setBusy(true);
  try {
    const result = await call(api.apply(state.root, sources));
    toast(`${result.moves} archivo(s) movidos`, "ok");
    await openFolder(state.root);
    return { ok: true, ...result };
  } catch (error) {
    toast(error.message, "error");
    return { ok: false, error: error.message };
  } finally {
    setBusy(false);
  }
}

async function doUndo(skipConfirm = false) {
  if (state.busy || !state.plan || !state.undo) return null;

  if (!skipConfirm) {
    const ok = await confirmModal(
      "Deshacer",
      `Se restaurarán ${state.undo.moves} archivo(s) de la última acción y se borrarán las carpetas que queden vacías.`,
      "Deshacer",
    );
    if (!ok) return null;
  }

  setBusy(true);
  try {
    const result = await call(api.undo(state.root));
    toast(`${result.restored} archivo(s) restaurados`, "ok");
    await openFolder(state.root);
    return { ok: true, ...result };
  } catch (error) {
    toast(error.message, "error");
    return { ok: false, error: error.message };
  } finally {
    setBusy(false);
  }
}

async function pickFolder() {
  if (state.busy) return;
  try {
    const root = await call(api.chooseFolder());
    if (root) await openFolder(root);
  } catch (error) {
    toast(error.message, "error");
  }
}

document.getElementById("pick").addEventListener("click", pickFolder);
document.getElementById("pick2").addEventListener("click", pickFolder);
document.getElementById("apply").addEventListener("click", () => void applySelected(false));
document.getElementById("undo").addEventListener("click", () => void doUndo(false));

el.selectAll.addEventListener("change", () => {
  if (!state.plan) return;
  if (el.selectAll.checked) {
    for (const item of state.plan.items) state.selected.add(item.source);
  } else {
    state.selected.clear();
  }
  for (const source of boxes.keys()) syncBox(source);
  updateGroupChecks();
  updateFooter();
});

el.modalOk.addEventListener("click", () => closeModal(true));
el.modalCancel.addEventListener("click", () => closeModal(false));
el.modal.addEventListener("click", (event) => {
  if (event.target === el.modal) closeModal(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalResolve) closeModal(false);
});

const params = new URLSearchParams(location.search);
const initialFolder = params.get("folder");

async function bootstrap() {
  if (initialFolder) {
    return openFolder(initialFolder);
  }
  if (params.has("smoke")) return;

  let last = null;
  try {
    last = localStorage.getItem("orden:lastFolder");
  } catch {
    // localStorage no disponible
  }
  if (!last) return;

  const result = await openFolder(last, { quiet: true });
  if (!result?.ok) {
    try {
      localStorage.removeItem("orden:lastFolder");
    } catch {
      // nada que limpiar
    }
  }
}

render();
void bootstrap()
  .catch((error) => console.log("BOOTSTRAP_ERROR", error?.message ?? String(error)))
  .finally(() => {
    window.__ordenReady = true;
  });

if (params.has("smoke")) {
  window.__ordenSmoke = {
    open: (root) => openFolder(root),
    state: () => ({
      root: state.root,
      groups: el.list.querySelectorAll(".group").length,
      rows: el.list.querySelectorAll(".row").length,
      items: state.plan?.items.length ?? 0,
      selected: state.selected.size,
      undoAvailable: Boolean(state.undo),
      badge: el.configBadge.textContent,
      undoDisabled: el.undo.disabled,
    }),
    apply: () => applySelected(true),
    undo: () => doUndo(true),
  };
}
