const api = window.orden;

const state = {
  root: null,
  plan: null,
  selected: new Set(),
  undo: null,
  busy: false,
  tab: "plan",
  dupes: null,
  dupesLoading: false,
  config: null,
  configFile: null,
};

const el = {
  rootPath: document.getElementById("rootPath"),
  configBadge: document.getElementById("configBadge"),
  tabs: document.getElementById("tabs"),
  empty: document.getElementById("empty"),
  content: document.getElementById("content"),
  cards: document.getElementById("cards"),
  list: document.getElementById("list"),
  statusbar: document.getElementById("statusbar"),
  selectAll: document.getElementById("selectAll"),
  selection: document.getElementById("selection"),
  apply: document.getElementById("apply"),
  undo: document.getElementById("undo"),
  dupeView: document.getElementById("dupesView"),
  dupeMinSize: document.getElementById("dupeMinSize"),
  dupeScan: document.getElementById("dupeScan"),
  dupeSummary: document.getElementById("dupeSummary"),
  dupeList: document.getElementById("dupeList"),
  rulesView: document.getElementById("rulesView"),
  includeHidden: document.getElementById("includeHidden"),
  ignorePatterns: document.getElementById("ignorePatterns"),
  rulesList: document.getElementById("rulesList"),
  addRule: document.getElementById("addRule"),
  rulesReload: document.getElementById("rulesReload"),
  rulesSave: document.getElementById("rulesSave"),
  rulesFile: document.getElementById("rulesFile"),
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

/** Crea un nodo con propiedades y listeners sin usar innerHTML. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node[key] = value;
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function field(label, input) {
  return h("label", { class: "field" }, h("span", { text: label }), input);
}

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

function renderDupes() {
  const report = state.dupes;
  if (!report) return;

  el.dupeSummary.textContent =
    `${report.scanned} revisados · ${report.groups.length} grupo(s) · ` +
    `${humanSize(report.wasted)} recuperables`;

  if (report.groups.length === 0) {
    el.dupeList.replaceChildren(
      h("p", { class: "empty-note", text: "Sin duplicados por encima del tamaño mínimo." }),
    );
    return;
  }

  el.dupeList.replaceChildren(
    ...report.groups.map((group) =>
      h(
        "section",
        { class: "dupe-group" },
        h(
          "header",
          {},
          h("span", { class: "size", text: `${humanSize(group.size)} cada uno` }),
          h("span", { class: "hash", text: group.hash.slice(0, 16) }),
          h("span", { class: "muted", text: `${group.files.length} copias` }),
        ),
        h(
          "ul",
          { class: "files" },
          ...group.files.map((file) => h("li", { text: file })),
        ),
      ),
    ),
  );
}

async function runDupes() {
  if (!state.plan || state.dupesLoading) return null;

  state.dupesLoading = true;
  el.dupeSummary.textContent = "Analizando…";
  el.dupeList.replaceChildren(h("p", { class: "empty-note", text: "Calculando hashes…" }));

  try {
    const minSize = Number(el.dupeMinSize.value);
    const report = await call(api.dupes(state.root, minSize));
    state.dupes = report;
    renderDupes();
    return { ok: true, groups: report.groups.length, scanned: report.scanned, wasted: report.wasted };
  } catch (error) {
    toast(error.message, "error");
    el.dupeSummary.textContent = "";
    el.dupeList.replaceChildren();
    return { ok: false, error: error.message };
  } finally {
    state.dupesLoading = false;
  }
}

function setMatchList(rule, key, raw) {
  const list = raw
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);

  if (list.length > 0) rule.match[key] = [...new Set(list)];
  else delete rule.match[key];
}

function setMatchNumber(rule, key, raw) {
  const text = String(raw).trim();
  if (text === "") {
    delete rule.match[key];
    return;
  }
  const value = Number(text);
  if (Number.isFinite(value) && value >= 0) rule.match[key] = value;
}

function moveRule(index, delta) {
  const rules = state.config.rules;
  const target = index + delta;
  if (target < 0 || target >= rules.length) return;
  [rules[index], rules[target]] = [rules[target], rules[index]];
  renderRules();
}

function buildRuleCard(rule, index) {
  const card = h("div", { class: `rule-card${rule.disabled ? " disabled" : ""}` });

  const nameInput = h("input", {
    class: "input rule-name",
    value: rule.name,
    placeholder: "Nombre de la regla",
  });
  nameInput.addEventListener("input", () => {
    rule.name = nameInput.value;
  });

  const up = h("button", { class: "icon-btn", title: "Subir", text: "↑" });
  up.disabled = index === 0;
  up.addEventListener("click", () => moveRule(index, -1));

  const down = h("button", { class: "icon-btn", title: "Bajar", text: "↓" });
  down.disabled = index === state.config.rules.length - 1;
  down.addEventListener("click", () => moveRule(index, 1));

  const remove = h("button", { class: "icon-btn danger", title: "Eliminar", text: "✕" });
  remove.addEventListener("click", () => {
    state.config.rules.splice(index, 1);
    renderRules();
  });

  const header = h(
    "header",
    {},
    h("span", { class: "rule-index", text: String(index + 1) }),
    nameInput,
    up,
    down,
    remove,
  );

  const destInput = h("input", {
    class: "input mono",
    value: rule.dest,
    placeholder: "Imagenes/{year}",
  });
  destInput.addEventListener("input", () => {
    rule.dest = destInput.value;
  });

  const extInput = h("input", {
    class: "input mono",
    value: (rule.match.ext ?? []).join(", "),
    placeholder: "jpg, png",
  });
  extInput.addEventListener("input", () => setMatchList(rule, "ext", extInput.value));

  const globInput = h("input", {
    class: "input mono",
    value: (rule.match.glob ?? []).join(", "),
    placeholder: "captura-*.png",
  });
  globInput.addEventListener("input", () => setMatchList(rule, "glob", globInput.value));

  const daysInput = h("input", {
    class: "input",
    type: "number",
    min: "0",
    value: rule.match.olderThanDays ?? "",
    placeholder: "—",
  });
  daysInput.addEventListener("input", () => setMatchNumber(rule, "olderThanDays", daysInput.value));

  const sizeInput = h("input", {
    class: "input",
    type: "number",
    min: "0",
    value: rule.match.minSizeBytes ?? "",
    placeholder: "—",
  });
  sizeInput.addEventListener("input", () => setMatchNumber(rule, "minSizeBytes", sizeInput.value));

  const disabledBox = h("input", { type: "checkbox" });
  disabledBox.checked = rule.disabled === true;
  disabledBox.addEventListener("change", () => {
    rule.disabled = disabledBox.checked;
    card.classList.toggle("disabled", disabledBox.checked);
  });

  const grid = h(
    "div",
    { class: "rule-grid" },
    field("Destino", destInput),
    field("Extensiones", extInput),
    field("Glob", globInput),
    field("Más de (días)", daysInput),
    field("Tamaño mínimo (bytes)", sizeInput),
    h("label", { class: "check" }, disabledBox, h("span", { text: "Desactivada" })),
  );

  card.append(header, grid);
  return card;
}

function renderRules() {
  if (!state.config) return;

  if (state.config.rules.length === 0) {
    el.rulesList.replaceChildren(
      h("p", { class: "empty-note", text: "No hay reglas: añade al menos una." }),
    );
    return;
  }

  el.rulesList.replaceChildren(
    ...state.config.rules.map((rule, index) => buildRuleCard(rule, index)),
  );
}

async function loadRules() {
  if (!state.root) return null;
  try {
    const data = await call(api.configRead(state.root));
    state.config = data.config;
    state.configFile = data.configFile;
    el.includeHidden.checked = data.config.includeHidden === true;
    el.ignorePatterns.value = (data.config.ignore ?? []).join(", ");
    renderRules();
    el.rulesFile.textContent = data.configFile
      ? `Archivo: ${data.configFile}`
      : "Aún no hay orden.config.json: al guardar se creará en esta carpeta.";
    return { ok: true, rules: data.config.rules.length };
  } catch (error) {
    toast(error.message, "error");
    return { ok: false, error: error.message };
  }
}

function splitPatterns(raw) {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function saveRules() {
  if (state.busy || !state.root || !state.config) return null;

  const payload = {
    ...state.config,
    includeHidden: el.includeHidden.checked,
    ignore: splitPatterns(el.ignorePatterns.value),
    rules: state.config.rules,
  };

  setBusy(true);
  try {
    const result = await call(api.configWrite(state.root, payload));
    toast("Reglas guardadas", "ok");
    await openFolder(state.root);
    return { ok: true, file: result.file };
  } catch (error) {
    toast(error.message, "error");
    return { ok: false, error: error.message };
  } finally {
    setBusy(false);
  }
}

function showTab(name) {
  if (name !== "plan" && !state.plan) return;
  state.tab = name;
  render();

  if (name === "dupes" && !state.dupes && !state.dupesLoading) void runDupes();
  if (name === "rules" && !state.config) void loadRules();
}

function render() {
  const hasPlan = state.plan !== null;
  const tab = state.tab;

  el.tabs.classList.toggle("hidden", !hasPlan);
  el.empty.classList.toggle("hidden", hasPlan || tab !== "plan");
  el.content.classList.toggle("hidden", !hasPlan || tab !== "plan");
  el.dupeView.classList.toggle("hidden", !hasPlan || tab !== "dupes");
  el.rulesView.classList.toggle("hidden", !hasPlan || tab !== "rules");
  el.statusbar.classList.toggle("hidden", !hasPlan || tab !== "plan");

  for (const button of el.tabs.querySelectorAll(".tab")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }

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

  if (tab === "plan") {
    renderCards();
    renderList();
  }

  updateFooter();
}

async function openFolder(root, options = {}) {
  setBusy(true);
  try {
    const plan = await call(api.scan(root));
    const changed = state.root !== plan.root;

    state.root = plan.root;
    state.plan = plan;
    state.selected = new Set(plan.items.map((item) => item.source));
    state.undo = await call(api.undoStatus(plan.root));

    if (changed) {
      state.dupes = null;
      state.config = null;
      state.configFile = null;
    }

    try {
      localStorage.setItem("orden:lastFolder", plan.root);
    } catch {
      // sin persistencia, no pasa nada
    }

    render();

    if (state.tab === "rules") await loadRules();
    else if (state.tab === "dupes" && !state.dupes) await runDupes();

    return { ok: true, items: plan.items.length };
  } catch (error) {
    if (!options.quiet) toast(error.message, "error");
    return { ok: false, error: error.message };
  } finally {
    setBusy(false);
  }
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

el.tabs.addEventListener("click", (event) => {
  const button = event.target.closest(".tab");
  if (button) showTab(button.dataset.tab);
});

el.dupeScan.addEventListener("click", () => {
  state.dupes = null;
  void runDupes();
});

el.dupeMinSize.addEventListener("change", () => {
  state.dupes = null;
  if (state.tab === "dupes") void runDupes();
});

el.addRule.addEventListener("click", () => {
  if (!state.config) return;
  state.config.rules.push({ name: "Nueva regla", dest: "Otros", match: { ext: [] } });
  renderRules();
});

el.rulesReload.addEventListener("click", () => void loadRules());
el.rulesSave.addEventListener("click", () => void saveRules());

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
const initialTab = params.get("tab");

async function bootstrap() {
  let opened = null;

  if (initialFolder) {
    opened = await openFolder(initialFolder);
  } else if (!params.has("smoke")) {
    let last = null;
    try {
      last = localStorage.getItem("orden:lastFolder");
    } catch {
      // localStorage no disponible
    }

    if (last) {
      opened = await openFolder(last, { quiet: true });
      if (!opened?.ok) {
        try {
          localStorage.removeItem("orden:lastFolder");
        } catch {
          // nada que limpiar
        }
      }
    }
  }

  if (opened?.ok && initialTab) {
    if (initialTab === "dupes") {
      state.tab = "dupes";
      render();
      await runDupes();
    } else if (initialTab === "rules") {
      state.tab = "rules";
      render();
      await loadRules();
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
      tab: state.tab,
      groups: el.list.querySelectorAll(".group").length,
      rows: el.list.querySelectorAll(".row").length,
      items: state.plan?.items.length ?? 0,
      selected: state.selected.size,
      undoAvailable: Boolean(state.undo),
      badge: el.configBadge.textContent,
      undoDisabled: el.undo.disabled,
      dupeGroups: state.dupes?.groups.length ?? 0,
      ruleCards: el.rulesList.querySelectorAll(".rule-card").length,
      configFile: state.configFile,
    }),
    apply: () => applySelected(true),
    undo: () => doUndo(true),
    tab: (name) => showTab(name),
    dupes: () => runDupes(),
    rules: () => loadRules(),
    saveRules: () => saveRules(),
  };
}
