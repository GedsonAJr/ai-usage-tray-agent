// Painel de configurações nativo (abas), renderizado na webview.
// Lê/grava o config.json + autostart pelos comandos IPC `get_settings` e
// `save_settings`. Antes era um formulário servido por HTTP no navegador.
import { invoke } from "@tauri-apps/api/core";

interface CodexConfig {
  habilitado: boolean;
  mostraNaTaskbarWindows: boolean;
  authJsonPath: string;
}
interface ClaudeConfig {
  habilitado: boolean;
  mostraNaTaskbarWindows: boolean;
  organizationId: string;
  cookie: string;
}
interface BarraConfig {
  lado: string;
  deslocamento: number;
  tamanhoFonte: number;
  corFonte: string;
  formatoReset: string;
  janelas: string;
}
interface WidgetConfig {
  habilitado: boolean;
  mostraClaude: boolean;
  mostraCodex: boolean;
  fundo: string;
  sempreNaFrente: boolean;
  opacidade: number;
  janelas: string;
  formatoReset: string;
}
interface AppConfig {
  usuario: string;
  intervaloSegundos: number;
  loki: { url: string };
  providers: { codex: CodexConfig; claude: ClaudeConfig };
  barraTarefas: BarraConfig;
  widget: WidgetConfig;
}
interface SettingsData {
  autostart: boolean;
  os: string;
  autostartLabel: string;
  config: AppConfig;
}
interface SaveSettings {
  config: AppConfig;
  autostart: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

function fillForm(data: SettingsData): void {
  const c = data.config;
  const codex = c.providers.codex;
  const claude = c.providers.claude;
  const barra = c.barraTarefas;
  const widget = c.widget;

  $<HTMLInputElement>("set-usuario").value = c.usuario ?? "";
  $<HTMLInputElement>("set-intervalo").value = String(c.intervaloSegundos ?? 10);
  $<HTMLInputElement>("set-lokiUrl").value = c.loki?.url ?? "";

  $<HTMLInputElement>("set-codexHab").checked = codex.habilitado !== false;
  $<HTMLInputElement>("set-codexAuth").value = codex.authJsonPath ?? "";
  $<HTMLInputElement>("set-codexTaskbar").checked = codex.mostraNaTaskbarWindows !== false;

  $<HTMLInputElement>("set-claudeHab").checked = claude.habilitado !== false;
  $<HTMLInputElement>("set-claudeOrg").value = claude.organizationId ?? "";
  $<HTMLInputElement>("set-claudeCookie").value = claude.cookie ?? "";
  $<HTMLInputElement>("set-claudeTaskbar").checked = claude.mostraNaTaskbarWindows !== false;

  $<HTMLSelectElement>("set-barraLado").value = barra.lado === "esquerda" ? "esquerda" : "direita";
  $<HTMLInputElement>("set-barraDesloc").value = String(barra.deslocamento ?? 0);
  $<HTMLInputElement>("set-barraFonte").value = String(barra.tamanhoFonte ?? 9);
  $<HTMLInputElement>("set-barraCor").value = barra.corFonte ?? "auto";
  $<HTMLSelectElement>("set-barraFormatoReset").value = barra.formatoReset === "exato" ? "exato" : "restante";
  $<HTMLSelectElement>("set-barraJanelas").value = normJanelas(barra.janelas);
  syncColorPicker();

  $<HTMLInputElement>("set-wdgHab").checked = !!widget?.habilitado;
  $<HTMLInputElement>("set-wdgClaude").checked = widget?.mostraClaude !== false;
  $<HTMLInputElement>("set-wdgCodex").checked = widget?.mostraCodex !== false;
  $<HTMLInputElement>("set-wdgTopo").checked = widget?.sempreNaFrente !== false;
  $<HTMLInputElement>("set-wdgFundo").value = widget?.fundo ?? "";
  $<HTMLSelectElement>("set-wdgJanelas").value = normJanelas(widget?.janelas);
  $<HTMLSelectElement>("set-wdgFormatoReset").value = widget?.formatoReset === "exato" ? "exato" : "restante";
  $<HTMLInputElement>("set-wdgOpac").value = String(widget?.opacidade ?? 90);
  syncOpacLabel();

  $<HTMLInputElement>("set-autostart").checked = !!data.autostart;
  if (data.autostartLabel) $("set-autostartLabel").textContent = data.autostartLabel;
}

function collect(): SaveSettings {
  let intervalo = parseInt($<HTMLInputElement>("set-intervalo").value, 10);
  if (!Number.isFinite(intervalo)) intervalo = 10;
  let deslocamento = parseInt($<HTMLInputElement>("set-barraDesloc").value, 10);
  if (!Number.isFinite(deslocamento)) deslocamento = 0;
  let fonte = parseInt($<HTMLInputElement>("set-barraFonte").value, 10);
  if (!Number.isFinite(fonte)) fonte = 9;
  let opacidade = parseInt($<HTMLInputElement>("set-wdgOpac").value, 10);
  if (!Number.isFinite(opacidade)) opacidade = 90;

  const config: AppConfig = {
    usuario: $<HTMLInputElement>("set-usuario").value.trim(),
    intervaloSegundos: intervalo,
    loki: { url: $<HTMLInputElement>("set-lokiUrl").value.trim() },
    providers: {
      codex: {
        habilitado: $<HTMLInputElement>("set-codexHab").checked,
        mostraNaTaskbarWindows: $<HTMLInputElement>("set-codexTaskbar").checked,
        authJsonPath: $<HTMLInputElement>("set-codexAuth").value.trim(),
      },
      claude: {
        habilitado: $<HTMLInputElement>("set-claudeHab").checked,
        mostraNaTaskbarWindows: $<HTMLInputElement>("set-claudeTaskbar").checked,
        organizationId: $<HTMLInputElement>("set-claudeOrg").value.trim(),
        cookie: $<HTMLInputElement>("set-claudeCookie").value.trim(),
      },
    },
    barraTarefas: {
      lado: $<HTMLSelectElement>("set-barraLado").value,
      deslocamento,
      tamanhoFonte: fonte,
      corFonte: $<HTMLInputElement>("set-barraCor").value.trim() || "auto",
      formatoReset: $<HTMLSelectElement>("set-barraFormatoReset").value,
      janelas: $<HTMLSelectElement>("set-barraJanelas").value,
    },
    widget: {
      habilitado: $<HTMLInputElement>("set-wdgHab").checked,
      mostraClaude: $<HTMLInputElement>("set-wdgClaude").checked,
      mostraCodex: $<HTMLInputElement>("set-wdgCodex").checked,
      fundo: $<HTMLInputElement>("set-wdgFundo").value.trim(),
      sempreNaFrente: $<HTMLInputElement>("set-wdgTopo").checked,
      opacidade,
      janelas: $<HTMLSelectElement>("set-wdgJanelas").value,
      formatoReset: $<HTMLSelectElement>("set-wdgFormatoReset").value,
    },
  };
  return { config, autostart: $<HTMLInputElement>("set-autostart").checked };
}

function syncColorPicker(): void {
  const v = $<HTMLInputElement>("set-barraCor").value.trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
    $<HTMLInputElement>("set-barraCorPicker").value = "#" + v.replace(/^#/, "");
  }
}

/// Reflete o valor do slider de opacidade no rótulo ao lado.
function syncOpacLabel(): void {
  $("set-wdgOpacVal").textContent = $<HTMLInputElement>("set-wdgOpac").value;
}

/// Normaliza a opção de janelas para um dos valores válidos do <select>.
function normJanelas(value: string | undefined): "ambos" | "sessao" | "semanal" {
  return value === "sessao" || value === "semanal" ? value : "ambos";
}

/// Abre o seletor de arquivo nativo (no backend) e joga o caminho escolhido no
/// campo de fundo. O valor só é persistido ao salvar.
async function pickBackground(): Promise<void> {
  try {
    const path = await invoke<string | null>("pick_widget_background");
    if (path) $<HTMLInputElement>("set-wdgFundo").value = path;
  } catch (e) {
    setMsg("Falha ao escolher arquivo: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}

function setMsg(text: string, kind?: "ok" | "err"): void {
  const node = $("settings-msg");
  node.textContent = text;
  node.className = "msg grow" + (kind ? " " + kind : "");
}

export async function loadSettings(): Promise<void> {
  setMsg("");
  try {
    const data = await invoke<SettingsData>("get_settings");
    fillForm(data);
    $("settings-loading").hidden = true;
    $("settings-form").hidden = false;
    $<HTMLButtonElement>("settings-save").disabled = false;
  } catch (e) {
    $("settings-loading").textContent = "Falha ao carregar configurações: " + (e instanceof Error ? e.message : String(e));
  }
}

async function saveSettings(): Promise<void> {
  const btn = $<HTMLButtonElement>("settings-save");
  btn.disabled = true;
  setMsg("Salvando…");
  try {
    const data = await invoke<SettingsData>("save_settings", { settings: collect() });
    fillForm(data);
    setMsg("Salvo. Aplicado em ~1s.", "ok");
  } catch (e) {
    setMsg("Erro ao salvar: " + (e instanceof Error ? e.message : String(e)), "err");
  } finally {
    btn.disabled = false;
  }
}

function activateTab(tab: string): void {
  document.querySelectorAll(".settings-tabs button").forEach((b) =>
    b.classList.toggle("on", (b as HTMLElement).dataset.stab === tab));
  document.querySelectorAll(".stab").forEach((s) =>
    s.classList.toggle("on", (s as HTMLElement).dataset.spanel === tab));
}

let initialized = false;

/// Liga os eventos da seção (uma vez) e carrega os valores atuais. Chamada na
/// primeira vez que o usuário abre a aba Configurações.
export function initSettings(): void {
  if (initialized) { void loadSettings(); return; }
  initialized = true;

  document.querySelectorAll(".settings-tabs button").forEach((b) =>
    b.addEventListener("click", () => activateTab((b as HTMLElement).dataset.stab ?? "geral")));

  $("set-cookieToggle").addEventListener("click", () => {
    const input = $<HTMLInputElement>("set-claudeCookie");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("set-cookieToggle").textContent = show ? "Ocultar" : "Mostrar";
  });
  $("set-barraCor").addEventListener("input", syncColorPicker);
  $("set-barraCorPicker").addEventListener("input", () => {
    $<HTMLInputElement>("set-barraCor").value = $<HTMLInputElement>("set-barraCorPicker").value;
  });

  $("set-wdgOpac").addEventListener("input", syncOpacLabel);
  $("set-wdgFundoPick").addEventListener("click", () => void pickBackground());
  $("set-wdgFundoClear").addEventListener("click", () => {
    $<HTMLInputElement>("set-wdgFundo").value = "";
  });

  $("settings-save").addEventListener("click", () => void saveSettings());
  $("settings-reload").addEventListener("click", () => void loadSettings());

  void loadSettings();
}