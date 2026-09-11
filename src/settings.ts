// Painel de configurações nativo (abas), renderizado na webview.
// Lê/grava o config.json + autostart pelos comandos IPC `get_settings` e
// `save_settings`. Antes era um formulário servido por HTTP no navegador.
import { invoke } from "@tauri-apps/api/core";

interface CodexConfig {
  habilitado: boolean;
  mostraNaTaskbarWindows: boolean;
  authJsonPath: string;
  authMode: string;
}
interface SessaoAutoConfig {
  habilitado: boolean;
  /** `"automatico"` (assim que a janela expira) ou `"agendado"` (só nos horários). */
  modo: string;
  /** Horários do modo agendado, em `"HH:MM"` de hora local, válidos todos os dias. */
  horarios: string[];
  /** Só editável pelo config.json; a UI apenas repassa para não zerar o valor. */
  caminhoCli: string;
}
interface ClaudeConfig {
  habilitado: boolean;
  mostraNaTaskbarWindows: boolean;
  organizationId: string;
  cookie: string;
  authMode: string;
  sessaoAuto: SessaoAutoConfig;
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
  modo: string;
}
interface ServerConfig {
  habilitado: boolean;
  host: string;
  porta: number;
  pin: string;
}
interface AppConfig {
  usuario: string;
  intervaloSegundos: number;
  loki: { url: string };
  providers: { codex: CodexConfig; claude: ClaudeConfig };
  barraTarefas: BarraConfig;
  widget: WidgetConfig;
  servidor: ServerConfig;
}
/** Resultado da última reabertura automática de sessão (memória do backend). */
interface SessaoAutoStatus {
  ultimaTentativaEm?: string | null;
  ultimoOk?: boolean | null;
  ultimoErro?: string | null;
  emExecucao?: boolean;
}
interface SettingsData {
  autostart: boolean;
  os: string;
  autostartLabel: string;
  appVersion: string;
  config: AppConfig;
  sessaoAutoStatus?: SessaoAutoStatus;
}
interface SaveSettings {
  config: AppConfig;
  autostart: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// Segmented control (radio group): le' a opcao marcada e marca uma opcao por valor.
const radioValue = (name: string): string | undefined =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
const setRadio = (name: string, value: string): void => {
  const el = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
};

function fillForm(data: SettingsData): void {
  const c = data.config;
  const codex = c.providers.codex;
  const claude = c.providers.claude;
  const barra = c.barraTarefas;
  const widget = c.widget;
  const servidor = c.servidor;

  $<HTMLInputElement>("set-usuario").value = c.usuario ?? "";
  $<HTMLInputElement>("set-intervalo").value = String(c.intervaloSegundos ?? 10);
  $<HTMLInputElement>("set-lokiUrl").value = c.loki?.url ?? "";

  $<HTMLInputElement>("set-codexHab").checked = codex.habilitado !== false;
  $<HTMLInputElement>("set-codexAuth").value = codex.authJsonPath ?? "";
  setRadio("codexAuthMode", codex.authMode === "navegador" ? "navegador" : "arquivo");
  syncCodexAuthMode();
  $<HTMLInputElement>("set-codexTaskbar").checked = codex.mostraNaTaskbarWindows !== false;

  $<HTMLInputElement>("set-claudeHab").checked = claude.habilitado !== false;
  $<HTMLInputElement>("set-claudeOrg").value = claude.organizationId ?? "";
  $<HTMLInputElement>("set-claudeCookie").value = claude.cookie ?? "";
  setRadio("claudeAuthMode", claude.authMode === "navegador" ? "navegador" : "manual");
  syncClaudeAuthMode();
  $<HTMLInputElement>("set-claudeTaskbar").checked = claude.mostraNaTaskbarWindows !== false;
  // Guarda o caminho do CLI (editável só pelo config.json) para devolvê-lo no save
  // — o painel manda o bloco `providers` inteiro, então omitir zeraria o valor.
  claudeSessaoAutoCliPath = claude.sessaoAuto?.caminhoCli ?? "";
  $<HTMLInputElement>("set-claudeSessaoAuto").checked = !!claude.sessaoAuto?.habilitado;
  setRadio("claudeSessaoAutoModo", claude.sessaoAuto?.modo === "agendado" ? "agendado" : "automatico");
  claudeSessaoAutoHorarios = [...(claude.sessaoAuto?.horarios ?? [])];
  renderSessaoAutoHorarios();
  syncSessaoAuto(data.sessaoAutoStatus);

  $<HTMLSelectElement>("set-barraLado").value = barra.lado === "esquerda" ? "esquerda" : "direita";
  $<HTMLInputElement>("set-barraDesloc").value = String(barra.deslocamento ?? 0);
  $<HTMLInputElement>("set-barraFonte").value = String(barra.tamanhoFonte ?? 9);
  $<HTMLInputElement>("set-barraCor").value = barra.corFonte ?? "auto";
  $<HTMLSelectElement>("set-barraFormatoReset").value = barra.formatoReset === "exato" ? "exato" : "restante";
  $<HTMLSelectElement>("set-barraJanelas").value = normJanelas(barra.janelas);
  syncColorPicker();

  $<HTMLInputElement>("set-wdgClaude").checked = widget?.mostraClaude !== false;
  $<HTMLInputElement>("set-wdgCodex").checked = widget?.mostraCodex !== false;
  $<HTMLInputElement>("set-wdgTopo").checked = widget?.sempreNaFrente !== false;
  $<HTMLInputElement>("set-wdgFundo").value = widget?.fundo ?? "";
  $<HTMLSelectElement>("set-wdgJanelas").value = normJanelas(widget?.janelas);
  $<HTMLSelectElement>("set-wdgFormatoReset").value = normResetMode(widget?.formatoReset);
  setWdgModo(widget?.modo);
  $<HTMLInputElement>("set-wdgOpac").value = String(widget?.opacidade ?? 90);
  syncOpacLabel();

  $<HTMLInputElement>("set-srvHab").checked = !!servidor?.habilitado;
  $<HTMLSelectElement>("set-srvHost").value = servidor?.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  $<HTMLInputElement>("set-srvPorta").value = String(servidor?.porta ?? 8770);
  $<HTMLInputElement>("set-srvPin").value = servidor?.pin ?? "";
  syncServerPinHint();
  syncProviderHints();

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
  let srvPorta = parseInt($<HTMLInputElement>("set-srvPorta").value, 10);
  if (!Number.isFinite(srvPorta) || srvPorta < 1 || srvPorta > 65535) srvPorta = 8770;

  const config: AppConfig = {
    usuario: $<HTMLInputElement>("set-usuario").value.trim(),
    intervaloSegundos: intervalo,
    loki: { url: $<HTMLInputElement>("set-lokiUrl").value.trim() },
    providers: {
      codex: {
        habilitado: $<HTMLInputElement>("set-codexHab").checked,
        mostraNaTaskbarWindows: $<HTMLInputElement>("set-codexTaskbar").checked,
        authJsonPath: $<HTMLInputElement>("set-codexAuth").value.trim(),
        authMode: codexAuthMode(),
      },
      claude: {
        habilitado: $<HTMLInputElement>("set-claudeHab").checked,
        mostraNaTaskbarWindows: $<HTMLInputElement>("set-claudeTaskbar").checked,
        organizationId: $<HTMLInputElement>("set-claudeOrg").value.trim(),
        cookie: $<HTMLInputElement>("set-claudeCookie").value.trim(),
        authMode: claudeAuthMode(),
        sessaoAuto: {
          habilitado: $<HTMLInputElement>("set-claudeSessaoAuto").checked,
          modo: sessaoAutoModo(),
          horarios: claudeSessaoAutoHorarios,
          caminhoCli: claudeSessaoAutoCliPath,
        },
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
      // O widget aparece quando ao menos um provedor esta marcado; nao ha mais
      // um checkbox separado de "mostrar widget".
      habilitado: $<HTMLInputElement>("set-wdgClaude").checked || $<HTMLInputElement>("set-wdgCodex").checked,
      mostraClaude: $<HTMLInputElement>("set-wdgClaude").checked,
      mostraCodex: $<HTMLInputElement>("set-wdgCodex").checked,
      fundo: $<HTMLInputElement>("set-wdgFundo").value.trim(),
      sempreNaFrente: $<HTMLInputElement>("set-wdgTopo").checked,
      opacidade,
      janelas: $<HTMLSelectElement>("set-wdgJanelas").value,
      formatoReset: $<HTMLSelectElement>("set-wdgFormatoReset").value,
      modo: getWdgModo(),
    },
    servidor: {
      habilitado: $<HTMLInputElement>("set-srvHab").checked,
      host: $<HTMLSelectElement>("set-srvHost").value,
      porta: srvPorta,
      pin: $<HTMLInputElement>("set-srvPin").value.trim(),
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

/// Normaliza o formato do reset para um valor do <select> (default "restante").
function normResetMode(value: string | undefined): "restante" | "exato" | "nenhum" {
  return value === "exato" || value === "nenhum" ? value : "restante";
}

/// Normaliza o modo de exibição do widget para um valor do <select>
/// (default "completo").
function normModo(value: string | undefined): "completo" | "minimo" | "anelduplo" {
  return value === "minimo" || value === "anelduplo" ? value : "completo";
}

/// Lê/grava o modo de exibição do widget pelo grupo de radios das miniaturas
/// (cada miniatura desenha o widget no respectivo modo e seleciona ao clicar).
function getWdgModo(): string {
  const checked = document.querySelector<HTMLInputElement>('input[name="wdgModo"]:checked');
  return normModo(checked?.value);
}
function setWdgModo(value: string | undefined): void {
  const mode = normModo(value);
  document.querySelectorAll<HTMLInputElement>('input[name="wdgModo"]').forEach((radio) => {
    radio.checked = radio.value === mode;
  });
}

/// Abre o seletor de arquivo nativo (no backend) e joga o caminho escolhido no
/// campo de fundo. Como o campo é alterado por código (não dispara "change"),
/// agenda o auto-save explicitamente.
async function pickBackground(): Promise<void> {
  try {
    const path = await invoke<string | null>("pick_widget_background");
    if (path) {
      $<HTMLInputElement>("set-wdgFundo").value = path;
      scheduleAutoSave();
    }
  } catch (e) {
    setMsg("Falha ao escolher arquivo: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}

/// Abre o seletor de arquivo nativo para escolher o auth.json do Codex e joga o
/// caminho no campo. Como o campo é alterado por código (não dispara "input"),
/// atualiza os avisos e agenda o auto-save explicitamente.
async function pickCodexAuthFile(): Promise<void> {
  try {
    const path = await invoke<string | null>("pick_codex_auth_file");
    if (path) {
      $<HTMLInputElement>("set-codexAuth").value = path;
      syncProviderHints();
      scheduleAutoSave();
    }
  } catch (e) {
    setMsg("Falha ao escolher arquivo: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}

function setMsg(text: string, kind?: "ok" | "err"): void {
  // Só exibimos erros no topo — coisas que o usuário talvez não perceba (ex.: falha
  // ao salvar). Confirmações de ações que ele mesmo disparou (conectar/desconectar)
  // são redundantes e limpam a área em vez de exibir. A exceção é o auto-save, que
  // ninguém dispara conscientemente: ele avisa por setSaved().
  const node = document.getElementById("settings-msg");
  if (!node) return;
  cancelMsgFade(node);
  if (kind === "err" && text) {
    node.textContent = text;
    node.className = "msg err";
  } else {
    node.textContent = "";
    node.className = "msg";
  }
}

/// Quanto tempo o "Configuração salva" fica legível antes de começar a sumir, e a
/// duração do esmaecimento (casada com a transição do .msg no styles.css).
const MSG_HOLD_MS = 2500;
const MSG_FADE_MS = 300;

// Timers do aviso efêmero "Configuração salva": um esmaece, o outro limpa. Ficam
// no módulo para que um aviso novo (ou um erro) cancele o sumiço do anterior.
let msgFadeTimer: number | undefined;
let msgClearTimer: number | undefined;

/// Cancela o sumiço programado e tira o nó do estado esmaecido, para que a próxima
/// mensagem apareça opaca e pelo tempo inteiro.
function cancelMsgFade(node: HTMLElement): void {
  if (msgFadeTimer !== undefined) {
    clearTimeout(msgFadeTimer);
    msgFadeTimer = undefined;
  }
  if (msgClearTimer !== undefined) {
    clearTimeout(msgClearTimer);
    msgClearTimer = undefined;
  }
  node.classList.remove("is-fading");
}

/// Confirma a gravação do config no lado oposto ao título ("Configurações"). O
/// save é automático e silencioso: sem esse aviso o usuário não tem como saber que
/// a alteração foi para o disco. Some sozinho para não virar ruído permanente.
function setSaved(): void {
  const node = document.getElementById("settings-msg");
  if (!node) return;
  cancelMsgFade(node);
  node.textContent = "Configuração salva";
  node.className = "msg ok";
  msgFadeTimer = window.setTimeout(() => {
    msgFadeTimer = undefined;
    node.classList.add("is-fading");
    msgClearTimer = window.setTimeout(() => {
      msgClearTimer = undefined;
      node.textContent = "";
      node.className = "msg";
    }, MSG_FADE_MS);
  }, MSG_HOLD_MS);
}

// O bloco `envio` (Enviar ao Loki por provedor) NÃO faz parte do save_settings
// (o backend o preserva relendo do disco). Os toggles nas abas Codex/Claude leem
// de `get_envio_state` e gravam via `set_envio_provider`, à parte do auto-save.
interface EnvioToggles {
  claude: { enviar: boolean };
  codex: { enviar: boolean };
}

/// Reflete nos checkboxes "Enviar ao Loki" o estado atual de envio por provedor.
async function loadEnvioToggles(): Promise<void> {
  try {
    const st = await invoke<EnvioToggles>("get_envio_state");
    $<HTMLInputElement>("set-codexEnviar").checked = !!st.codex?.enviar;
    $<HTMLInputElement>("set-claudeEnviar").checked = !!st.claude?.enviar;
  } catch {
    // transitório; mantém o estado atual dos checkboxes
  }
}

/// Persiste o envio de um provedor direto via set_envio_provider.
async function setEnvioProvider(ferramenta: "codex" | "claude", enviar: boolean): Promise<void> {
  try {
    await invoke("set_envio_provider", { ferramenta, enviar });
    setSaved();
  } catch (e) {
    setMsg("Falha ao salvar o envio do provedor: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}

// Autenticação do Codex: o modo ("arquivo" | "navegador") é parte do config.json
// (auto-save), mas o login/logout pelo navegador é feito à parte, via os comandos
// codex_login/codex_logout, e o status vem de codex_auth_status.
interface CodexAuthStatus {
  connected: boolean;
  needsReconnect: boolean;
  email: string | null;
  expiresAt: number | null;
}
// Reflete o último status conhecido; usado pelos avisos de "sem credenciais".
let codexConnected = false;
// Enquanto true, o auto-refresh não relê o status (não atropela o "Aguardando…").
let codexLoginInProgress = false;

/// Mostra a seção do modo escolhido (caminho do auth.json ou login pelo navegador).
function codexAuthMode(): "arquivo" | "navegador" {
  return radioValue("codexAuthMode") === "navegador" ? "navegador" : "arquivo";
}
function syncCodexAuthMode(): void {
  const mode = codexAuthMode();
  ($("set-codexFileAuth") as HTMLElement).hidden = mode !== "arquivo";
  ($("set-codexBrowserAuth") as HTMLElement).hidden = mode !== "navegador";
}

/// Reflete o status do login pelo navegador na UI (texto, botões) e nos avisos.
/// - Conectado e saudável: só status + Desconectar (sem botão de conectar).
/// - Conectado mas com falha de renovação automática: mostra "Reconectar".
/// - Não conectado: mostra "Conectar com o navegador".
function applyCodexAuthStatus(st: CodexAuthStatus): void {
  // Para os avisos de coleta, uma sessão que precisa reconectar conta como "sem
  // credenciais" (a coleta não vai funcionar até reconectar).
  codexConnected = !!st.connected && !st.needsReconnect;
  const statusEl = $("set-codexAuthStatus");
  const loginBtn = $("set-codexLogin") as HTMLElement;
  const logoutBtn = $("set-codexLogout") as HTMLElement;

  statusEl.classList.remove("ok", "warn");
  if (st.connected && !st.needsReconnect) {
    statusEl.textContent = st.email ? `Conectado como ${st.email}.` : "Conectado.";
    statusEl.classList.add("ok");
    loginBtn.hidden = true;
    logoutBtn.hidden = false;
  } else if (st.connected && st.needsReconnect) {
    statusEl.textContent = "Não foi possível renovar a sessão automaticamente. Reconecte.";
    statusEl.classList.add("warn");
    loginBtn.hidden = false;
    loginBtn.textContent = "Reconectar";
    logoutBtn.hidden = false;
  } else {
    statusEl.textContent = "Conecte sua conta para iniciar a coleta.";
    loginBtn.hidden = false;
    loginBtn.textContent = "Conectar com o navegador";
    logoutBtn.hidden = true;
  }
  syncProviderHints();
}

/// Lê o status do login pelo navegador (sem rede). Chamado ao abrir a tela.
async function loadCodexAuthStatus(): Promise<void> {
  try {
    applyCodexAuthStatus(await invoke<CodexAuthStatus>("codex_auth_status"));
  } catch {
    // transitório; mantém o estado atual
  }
}

/// Dispara o login pelo navegador (bloqueante no backend até o usuário concluir ou
/// cancelar). Enquanto aguarda, mostra o botão "Cancelar" (que libera a porta 1455
/// e faz o comando retornar sem esperar o timeout).
async function codexLogin(): Promise<void> {
  const btn = $("set-codexLogin") as HTMLElement;
  const cancelBtn = $("set-codexLoginCancel") as HTMLElement;
  // Enquanto aguarda, esconde o "Conectar" e mostra o "Cancelar" no lugar.
  btn.hidden = true;
  cancelBtn.hidden = false;
  codexLoginInProgress = true;
  $("set-codexAuthStatus").textContent = "Aguardando o login no navegador…";
  try {
    applyCodexAuthStatus(await invoke<CodexAuthStatus>("codex_login"));
    setMsg("Codex conectado.", "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/cancel/i.test(msg)) {
      setMsg(""); // cancelamento é ação do usuário; não polui o topo com aviso
    } else {
      setMsg("Falha no login do Codex: " + msg, "err");
    }
    // Reavalia o estado (mostra "Conectar"/"Reconectar" conforme o caso).
    await loadCodexAuthStatus();
  } finally {
    // A visibilidade do "Conectar/Reconectar" é decidida por applyCodexAuthStatus;
    // aqui só escondemos o "Cancelar".
    codexLoginInProgress = false;
    cancelBtn.hidden = true;
  }
}

/// Cancela um login em andamento (o codexLogin pendente rejeita e se recupera).
async function codexLoginCancel(): Promise<void> {
  try {
    await invoke("codex_login_cancel");
  } catch {
    // best-effort; o login pendente ainda expira sozinho no timeout
  }
}

/// Remove as credenciais do login pelo navegador.
async function codexLogout(): Promise<void> {
  try {
    await invoke("codex_logout");
    applyCodexAuthStatus({ connected: false, needsReconnect: false, email: null, expiresAt: null });
    setMsg("Codex desconectado.", "ok");
  } catch (e) {
    setMsg("Falha ao desconectar: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}

// Autenticação do Claude: o modo ("manual" | "navegador") é parte do config.json
// (auto-save); o login/logout pelo navegador é feito à parte, pelos comandos
// claude_login/claude_logout, e o status vem de claude_auth_status.
interface ClaudeAuthStatus {
  connected: boolean;
  needsReconnect: boolean;
  email: string | null;
  organizationId: string | null;
}
// Uma org candidata quando a conta tem mais de uma com "chat" (o backend pede escolha).
interface ClaudeOrgCandidate {
  uuid: string;
  name: string | null;
  utilization: number | null;
}
// Retorno do claude_login: ou já conectou (status), ou precisa escolher a org.
interface ClaudeLoginResult {
  needsSelection: boolean;
  status?: ClaudeAuthStatus;
  email?: string | null;
  organizations?: ClaudeOrgCandidate[];
}
// Último status conhecido do login pelo navegador; usado nos avisos "sem credenciais".
let claudeConnected = false;
// Enquanto true, o auto-refresh não relê o status (não atropela o "Aguardando…").
let claudeLoginInProgress = false;
// Enquanto o seletor de org está aberto, o auto-refresh não relê o status.
let claudeOrgPickerOpen = false;

function claudeAuthMode(): "manual" | "navegador" {
  return radioValue("claudeAuthMode") === "navegador" ? "navegador" : "manual";
}
/// Mostra a seção do modo escolhido (campos manuais ou login pelo navegador).
function syncClaudeAuthMode(): void {
  const mode = claudeAuthMode();
  ($("set-claudeManualAuth") as HTMLElement).hidden = mode !== "manual";
  ($("set-claudeBrowserAuth") as HTMLElement).hidden = mode !== "navegador";
}

/// Reflete o status do login pelo navegador na UI (texto, botões) e nos avisos.
function applyClaudeAuthStatus(st: ClaudeAuthStatus): void {
  hideClaudeOrgPicker();
  // Sessão que precisa reconectar conta como "sem credenciais" nos avisos.
  claudeConnected = !!st.connected && !st.needsReconnect;
  const statusEl = $("set-claudeAuthStatus");
  const loginBtn = $("set-claudeLogin") as HTMLElement;
  const logoutBtn = $("set-claudeLogout") as HTMLElement;
  statusEl.classList.remove("ok", "warn");
  if (st.connected && !st.needsReconnect) {
    statusEl.textContent = st.email ? `Conectado como ${st.email}.` : "Conectado.";
    statusEl.classList.add("ok");
    loginBtn.hidden = true;
    logoutBtn.hidden = false;
  } else if (st.connected && st.needsReconnect) {
    statusEl.textContent = "Sessão expirada. Reconecte sua conta para continuar a coleta.";
    statusEl.classList.add("warn");
    loginBtn.hidden = false;
    loginBtn.textContent = "Reconectar";
    logoutBtn.hidden = false;
  } else {
    statusEl.textContent = "Conecte sua conta para iniciar a coleta.";
    loginBtn.hidden = false;
    loginBtn.textContent = "Conectar com o navegador";
    logoutBtn.hidden = true;
  }
  syncProviderHints();
}

async function loadClaudeAuthStatus(): Promise<void> {
  try {
    applyClaudeAuthStatus(await invoke<ClaudeAuthStatus>("claude_auth_status"));
  } catch {
    // transitório; mantém o estado atual
  }
}

/// Dispara o login pelo navegador (abre a claude.ai; o backend captura o cookie).
/// Enquanto aguarda, esconde "Conectar" e mostra "Cancelar".
async function claudeLogin(): Promise<void> {
  const btn = $("set-claudeLogin") as HTMLElement;
  const cancelBtn = $("set-claudeLoginCancel") as HTMLElement;
  btn.hidden = true;
  cancelBtn.hidden = false;
  claudeLoginInProgress = true;
  hideClaudeOrgPicker();
  $("set-claudeAuthStatus").textContent = "Aguardando o login no navegador…";
  try {
    const res = await invoke<ClaudeLoginResult>("claude_login");
    cancelBtn.hidden = true;
    if (res.needsSelection && res.organizations && res.organizations.length) {
      // Mantém "in progress" para o auto-refresh não sobrescrever enquanto escolhe.
      showClaudeOrgPicker(res.organizations);
      return;
    }
    if (res.status) applyClaudeAuthStatus(res.status);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/cancel/i.test(msg)) setMsg("Falha no login do Claude: " + msg, "err");
    await loadClaudeAuthStatus();
  } finally {
    if (!claudeOrgPickerOpen) claudeLoginInProgress = false;
    cancelBtn.hidden = true;
  }
}

/// Mostra o seletor de org (conta com mais de uma org "chat"), com o uso atual de cada
/// uma para ajudar a identificar a certa. O login só conclui ao confirmar.
function showClaudeOrgPicker(orgs: ClaudeOrgCandidate[]): void {
  const picker = $("set-claudeOrgPicker") as HTMLElement;
  const select = $<HTMLSelectElement>("set-claudeOrgSelect");
  select.innerHTML = "";
  for (const org of orgs) {
    const opt = document.createElement("option");
    opt.value = org.uuid;
    const uso = org.utilization != null ? `${Math.round(org.utilization)}% (5h)` : "uso indisponível";
    opt.textContent = `${org.name ?? org.uuid} — ${uso}`;
    select.appendChild(opt);
  }
  ($("set-claudeLogin") as HTMLElement).hidden = true;
  picker.hidden = false;
  claudeOrgPickerOpen = true;
  claudeLoginInProgress = true;
  const statusEl = $("set-claudeAuthStatus");
  statusEl.classList.remove("ok", "warn");
  statusEl.textContent = "Selecione a organização para concluir o login.";
}

function hideClaudeOrgPicker(): void {
  ($("set-claudeOrgPicker") as HTMLElement).hidden = true;
  claudeOrgPickerOpen = false;
}

/// Grava a org escolhida e conclui o login pelo navegador.
async function claudeSelectOrg(): Promise<void> {
  const organizationId = $<HTMLSelectElement>("set-claudeOrgSelect").value;
  if (!organizationId) return;
  try {
    const status = await invoke<ClaudeAuthStatus>("claude_select_org", { organizationId });
    hideClaudeOrgPicker();
    claudeLoginInProgress = false;
    applyClaudeAuthStatus(status);
  } catch (e) {
    setMsg("Falha ao selecionar a organização: " + (e instanceof Error ? e.message : String(e)), "err");
    hideClaudeOrgPicker();
    claudeLoginInProgress = false;
    await loadClaudeAuthStatus();
  }
}

async function claudeLoginCancel(): Promise<void> {
  try {
    await invoke("claude_login_cancel");
  } catch {
    // best-effort; o login pendente ainda expira sozinho no timeout
  }
}

async function claudeLogout(): Promise<void> {
  try {
    await invoke("claude_logout");
    applyClaudeAuthStatus({ connected: false, needsReconnect: false, email: null, organizationId: null });
  } catch (e) {
    setMsg("Falha ao desconectar: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}

export async function loadSettings(): Promise<void> {
  setMsg("");
  try {
    const data = await invoke<SettingsData>("get_settings");
    fillForm(data);
    void loadEnvioToggles();
    void loadCodexAuthStatus();
    void loadClaudeAuthStatus();
    $("settings-loading").hidden = true;
    $("settings-form").hidden = false;
  } catch (e) {
    $("settings-loading").textContent = "Falha ao carregar configurações: " + (e instanceof Error ? e.message : String(e));
  }
}

let saveTimer: number | undefined;
// Cresce a cada agendamento; a resposta de um save só re-preenche o formulário
// se nenhuma mudança nova ocorreu nesse meio-tempo (evita sobrescrever o que o
// usuário acabou de alterar enquanto o save anterior estava em voo).
let saveSeq = 0;

/// Há um campo de texto/número em foco? Nesse caso o auto-save não deve
/// re-preencher o formulário (sobrescreveria o que está sendo digitado). Para
/// checkbox/select/range re-preencher é inofensivo (o valor já bate).
function isEditingField(): boolean {
  const a = document.activeElement as HTMLInputElement | null;
  if (!a || a.tagName !== "INPUT") return false;
  return a.type === "text" || a.type === "number" || a.type === "password";
}

/// Agenda um save com debounce: alterações em rajada (vários toggles, digitação)
/// são unificadas num único envio. Substitui o antigo botão "Salvar".
function scheduleAutoSave(): void {
  saveSeq++;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void autoSave();
  }, 400);
}

async function autoSave(): Promise<void> {
  const seq = saveSeq;
  try {
    const data = await invoke<SettingsData>("save_settings", { settings: collect() });
    // Só reflete a normalização (clamp de intervalo/fonte, validação de cor) se
    // não houve mudança nova e nada está sendo digitado.
    if (seq === saveSeq && !isEditingField()) fillForm(data);
    setSaved();
  } catch (e) {
    setMsg("Erro ao salvar: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}

/// Mostra o aviso de PIN obrigatório quando o servidor está habilitado mas sem
/// PIN — deixa claro que, sem PIN, ele não inicia.
function syncServerPinHint(): void {
  const habilitado = $<HTMLInputElement>("set-srvHab").checked;
  setBodyEnabled("set-srvBody", habilitado);
  const semPin = $<HTMLInputElement>("set-srvPin").value.trim() === "";
  ($("set-srvPinWarn") as HTMLElement).hidden = !(habilitado && semPin);
}

/// Habilita/desabilita (e esmaece) o corpo de campos de um provedor conforme ele
/// esteja ligado. Os valores continuam legíveis para o save; só não são editáveis.
function setBodyEnabled(bodyId: string, on: boolean): void {
  const body = $(bodyId);
  body.classList.toggle("is-off", !on);
  body.querySelectorAll("input, button").forEach((el) => {
    (el as HTMLInputElement | HTMLButtonElement).disabled = !on;
  });
}

/// Reflete o estado de cada provedor: desabilita os campos quando desligado e, se
/// ligado, avisa que faltam os campos obrigatórios para a coleta acontecer
/// (Codex: auth.json; Claude: organization id + cookie).
function syncProviderHints(): void {
  const codexOn = $<HTMLInputElement>("set-codexHab").checked;
  setBodyEnabled("set-codexBody", codexOn);

  const claudeOn = $<HTMLInputElement>("set-claudeHab").checked;
  setBodyEnabled("set-claudeBody", claudeOn);
  // No login pelo navegador o estado já aparece no status do bloco; o aviso amarelo
  // só é usado no modo manual (org + cookie).
  if (claudeAuthMode() === "navegador") {
    ($("set-claudeWarn") as HTMLElement).hidden = true;
  } else {
    const claudeFalta =
      $<HTMLInputElement>("set-claudeOrg").value.trim() === "" ||
      $<HTMLInputElement>("set-claudeCookie").value.trim() === "";
    ($("set-claudeWarn") as HTMLElement).hidden = !(claudeOn && claudeFalta);
  }

  syncProviderNotes();
}

/// Caminho do Claude Code CLI vindo do config.json. A UI não edita (é um escape
/// para instalações fora do PATH), mas precisa devolvê-lo no save: o painel manda
/// o bloco `providers` inteiro, então omitir o campo apagaria o valor do disco.
let claudeSessaoAutoCliPath = "";

/// Último status conhecido da reabertura automática. Só chega no `get_settings`
/// (o backend guarda em memória), então é preservado entre os `sync` disparados
/// pelo próprio toggle.
let lastSessaoAutoStatus: SessaoAutoStatus | undefined;

/// Horários do modo agendado ("HH:MM", ordenados). Fonte da verdade da lista
/// enquanto o painel está aberto: os chips e o save leem daqui, porque não há um
/// campo de formulário que caiba uma lista.
let claudeSessaoAutoHorarios: string[] = [];

const sessaoAutoModo = (): "automatico" | "agendado" =>
  radioValue("claudeSessaoAutoModo") === "agendado" ? "agendado" : "automatico";

/// Minuto do dia de um "HH:MM" já normalizado (usado só para achar o próximo).
const horarioEmMinutos = (horario: string): number => {
  const [hora, minuto] = horario.split(":");
  return Number(hora) * 60 + Number(minuto);
};

/// "HH:MM" a partir do valor do `input[type=time]`, que pode vir vazio ou com
/// segundos. O backend revalida (e descarta o que não presta); aqui é só para o
/// chip não nascer torto.
function normHorario(valor: string): string | null {
  const partes = /^(\d{1,2}):([0-5]\d)/.exec(valor.trim());
  if (!partes) return null;
  const hora = Number(partes[1]);
  if (hora > 23) return null;
  return `${String(hora).padStart(2, "0")}:${partes[2]}`;
}

/// Desenha um chip por horário salvo, cada um com o botão de remover. Recriado
/// inteiro a cada mudança: a lista é curta e assim não sobra listener velho.
function renderSessaoAutoHorarios(): void {
  const lista = $("set-claudeSessaoAutoLista");
  lista.textContent = "";
  claudeSessaoAutoHorarios.forEach((horario) => {
    const chip = document.createElement("span");
    chip.className = "horario";
    chip.append(horario);
    const remover = document.createElement("button");
    remover.type = "button";
    remover.textContent = "✕";
    remover.title = `Remover ${horario}`;
    remover.setAttribute("aria-label", `Remover ${horario}`);
    remover.addEventListener("click", () => {
      claudeSessaoAutoHorarios = claudeSessaoAutoHorarios.filter((h) => h !== horario);
      renderSessaoAutoHorarios();
      syncSessaoAuto();
      scheduleAutoSave();
    });
    chip.append(remover);
    lista.append(chip);
  });
}

/// Adiciona o horário do campo à lista (ordenada, sem repetir) e salva. Ordenar
/// "HH:MM" como texto já dá a ordem cronológica (as horas são zero-padded).
function addSessaoAutoHorario(): void {
  const input = $<HTMLInputElement>("set-claudeSessaoAutoHora");
  const horario = normHorario(input.value);
  if (!horario) return;
  input.value = "";
  if (claudeSessaoAutoHorarios.includes(horario)) return;
  claudeSessaoAutoHorarios = [...claudeSessaoAutoHorarios, horario].sort();
  renderSessaoAutoHorarios();
  syncSessaoAuto();
  scheduleAutoSave();
}

/// Explica o modo escolhido. No agendado, mostra qual é o próximo horário — é o
/// jeito mais rápido de o usuário confirmar que a lista faz o que ele espera.
function sessaoAutoModoDesc(): string {
  if (sessaoAutoModo() !== "agendado") {
    return "Assim que a janela de 5h expira, o app abre a próxima sozinho.";
  }
  if (claudeSessaoAutoHorarios.length === 0) return "A sessão só é aberta nos horários que você escolher.";
  const agora = new Date();
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
  const proximo = claudeSessaoAutoHorarios.find((h) => horarioEmMinutos(h) > minutosAgora);
  return proximo
    ? `Próximo horário: hoje às ${proximo}.`
    : `Próximo horário: amanhã às ${claudeSessaoAutoHorarios[0]}.`;
}

/// Mostra o resultado da última tentativa abaixo do toggle — é onde o usuário
/// descobre que o CLI não está instalado ou que o login dele expirou — e revela
/// as opções de modo/horários só quando a reabertura está ligada.
function syncSessaoAuto(status?: SessaoAutoStatus): void {
  if (status !== undefined) lastSessaoAutoStatus = status;

  const ligado = $<HTMLInputElement>("set-claudeSessaoAuto").checked;
  const agendado = sessaoAutoModo() === "agendado";
  ($("set-claudeSessaoAutoBody") as HTMLElement).hidden = !ligado;
  ($("set-claudeSessaoAutoHorariosField") as HTMLElement).hidden = !agendado;
  // Agendado sem horário nenhum não reabre nada: avisa em vez de fingir que está
  // funcionando.
  ($("set-claudeSessaoAutoWarn") as HTMLElement).hidden =
    !(ligado && agendado && claudeSessaoAutoHorarios.length === 0);
  $("set-claudeSessaoAutoModoDesc").textContent = sessaoAutoModoDesc();

  const el = $("set-claudeSessaoAutoStatus") as HTMLElement;
  const st = lastSessaoAutoStatus;
  if (!st?.ultimaTentativaEm) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.classList.remove("ok", "warn");
  if (st.emExecucao) {
    el.textContent = "Enviando o “Oi”… (o CLI leva alguns segundos)";
    return;
  }
  const quando = new Date(st.ultimaTentativaEm).toLocaleString();
  if (st.ultimoOk) {
    el.classList.add("ok");
    el.textContent = `Última reabertura em ${quando}`;
  } else {
    el.classList.add("warn");
    // O motivo pode faltar (falha sem mensagem do CLI); nesse caso não deixa um
    // traço solto no fim.
    el.textContent = `Falha ao reabrir em ${quando}${st.ultimoErro ? ` - ${st.ultimoErro}` : ""}`;
  }
}

/// Aviso por provedor (abas Envio, Barra de tarefas e Widget): se o provedor está
/// desativado ou sem credenciais, avisa — mas o toggle segue operável.
function providerNote(habilitado: boolean, configurado: boolean): string {
  if (!habilitado) return "Provedor desativado";
  if (!configurado) return "Sem credenciais";
  return "";
}
function setNotes(ids: string[], msg: string): void {
  ids.forEach((id) => {
    const note = document.getElementById(id);
    if (!note) return;
    note.textContent = msg;
    (note as HTMLElement).hidden = msg === "";
  });
}
function syncProviderNotes(): void {
  const codexOn = $<HTMLInputElement>("set-codexHab").checked;
  const codexCfg = codexAuthMode() === "navegador"
    ? codexConnected
    : $<HTMLInputElement>("set-codexAuth").value.trim() !== "";
  const claudeOn = $<HTMLInputElement>("set-claudeHab").checked;
  const claudeCfg = claudeAuthMode() === "navegador"
    ? claudeConnected
    : $<HTMLInputElement>("set-claudeOrg").value.trim() !== "" &&
      $<HTMLInputElement>("set-claudeCookie").value.trim() !== "";
  setNotes(["envio-codex-note"], providerNote(codexOn, codexCfg));
  setNotes(["envio-claude-note"], providerNote(claudeOn, claudeCfg));
  setNotes(["barra-codex-note", "wdg-codex-note"], providerNote(codexOn, codexCfg));
  setNotes(["barra-claude-note", "wdg-claude-note"], providerNote(claudeOn, claudeCfg));
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
  $("set-srvPinToggle").addEventListener("click", () => {
    const input = $<HTMLInputElement>("set-srvPin");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("set-srvPinToggle").textContent = show ? "Ocultar" : "Mostrar";
  });
  $("set-srvHab").addEventListener("change", syncServerPinHint);
  $("set-srvPin").addEventListener("input", syncServerPinHint);
  $("set-codexHab").addEventListener("change", syncProviderHints);
  $("set-codexAuth").addEventListener("input", syncProviderHints);
  $("set-codexAuthMode").addEventListener("change", () => {
    syncCodexAuthMode();
    syncProviderHints();
  });
  $("set-codexAuthPick").addEventListener("click", () => void pickCodexAuthFile());
  $("set-codexLogin").addEventListener("click", () => void codexLogin());
  $("set-codexLoginCancel").addEventListener("click", () => void codexLoginCancel());
  $("set-codexLogout").addEventListener("click", () => void codexLogout());
  $("set-claudeHab").addEventListener("change", syncProviderHints);
  $("set-claudeOrg").addEventListener("input", syncProviderHints);
  $("set-claudeCookie").addEventListener("input", syncProviderHints);
  $("set-claudeAuthMode").addEventListener("change", () => {
    syncClaudeAuthMode();
    syncProviderHints();
  });
  $("set-claudeSessaoAuto").addEventListener("change", () => syncSessaoAuto());
  $("set-claudeSessaoAutoModo").addEventListener("change", () => syncSessaoAuto());
  $("set-claudeSessaoAutoAdd").addEventListener("click", addSessaoAutoHorario);
  // Enter no campo de hora adiciona, em vez de nada acontecer.
  $("set-claudeSessaoAutoHora").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Enter") return;
    e.preventDefault();
    addSessaoAutoHorario();
  });
  // Escolher uma hora no campo não muda o config (só entra na lista pelo
  // "Adicionar"), então o "change" dele não deve chegar ao auto-save.
  $("set-claudeSessaoAutoHora").addEventListener("change", (e) => e.stopPropagation());
  $("set-claudeLogin").addEventListener("click", () => void claudeLogin());
  $("set-claudeLoginCancel").addEventListener("click", () => void claudeLoginCancel());
  $("set-claudeLogout").addEventListener("click", () => void claudeLogout());
  $("set-claudeOrgConfirm").addEventListener("click", () => void claudeSelectOrg());
  $("set-barraCor").addEventListener("input", syncColorPicker);
  $("set-barraCorPicker").addEventListener("input", () => {
    $<HTMLInputElement>("set-barraCor").value = $<HTMLInputElement>("set-barraCorPicker").value;
  });

  $("set-wdgOpac").addEventListener("input", syncOpacLabel);
  $("set-wdgFundoPick").addEventListener("click", () => void pickBackground());
  $("set-wdgFundoClear").addEventListener("click", () => {
    $<HTMLInputElement>("set-wdgFundo").value = "";
    scheduleAutoSave();
  });

  // "Enviar ao Loki" por provedor: persistido via set_envio_provider, à parte do
  // auto-save (stopPropagation evita o save_settings geral, que apenas preservaria
  // o bloco `envio` de qualquer forma).
  const wireEnvio = (id: string, ferramenta: "codex" | "claude"): void => {
    $(id).addEventListener("change", (e) => {
      e.stopPropagation();
      void setEnvioProvider(ferramenta, $<HTMLInputElement>(id).checked);
    });
  };
  wireEnvio("set-codexEnviar", "codex");
  wireEnvio("set-claudeEnviar", "claude");

  // Auto-save: qualquer alteração nos controles (toggle, select, slider, ou ao
  // sair de um campo de texto) persiste sozinha. O evento "change" borbulha, então
  // um único listener no formulário cobre todos os campos. Setar valores por
  // código (fillForm, picker de cor/fundo) não dispara "change", logo não há laço.
  $("settings-form").addEventListener("change", () => scheduleAutoSave());

  // Auto-refresh do status do login pelo navegador: enquanto a tela Configurações
  // está visível, relê o status a cada 5s para refletir mudanças externas (ex.:
  // sessão/token expirou e a coleta marcou "Reconectar"). Só relê o status
  // (texto/botões), sem tocar nos campos; pula durante um login em andamento. A
  // janela é destruída ao fechar, então o timer não vaza entre reaberturas.
  window.setInterval(() => {
    const visivel = document.getElementById("view-settings")?.classList.contains("on");
    if (!visivel) return;
    if (codexAuthMode() === "navegador" && !codexLoginInProgress) void loadCodexAuthStatus();
    if (claudeAuthMode() === "navegador" && !claudeLoginInProgress && !claudeOrgPickerOpen) void loadClaudeAuthStatus();
  }, 5000);

  void loadSettings();
}