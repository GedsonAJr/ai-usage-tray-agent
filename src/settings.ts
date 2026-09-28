// Painel de configurações nativo (abas), renderizado na webview.
// Lê/grava o config.json + autostart pelos comandos IPC `get_settings` e
// `save_settings`. Antes era um formulário servido por HTTP no navegador.
import { invoke } from "@tauri-apps/api/core";
import { animaTrocaDeAba } from "./anima";
import { escapeHtml } from "./usage-format";

interface CodexConfig {
  habilitado: boolean;
  mostraNaTaskbarWindows: boolean;
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
/** Resultado da última reabertura automática de sessão (memória do backend) e a
 * conta vigiada agora (calculada a cada leitura). */
interface SessaoAutoStatus {
  ultimaTentativaEm?: string | null;
  ultimoOk?: boolean | null;
  ultimoErro?: string | null;
  emExecucao?: boolean;
  /// Apelido (senão e-mail) da conta cuja janela de 5h decide o disparo.
  contaVigiada?: string | null;
  /// A conta vigiada é a do login do CLI (e não só a única do app).
  contaDoCli?: boolean;
  /// Por que a reabertura está parada, quando não há conta para vigiar.
  aviso?: string | null;
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
  $<HTMLInputElement>("set-codexTaskbar").checked = codex.mostraNaTaskbarWindows !== false;

  $<HTMLInputElement>("set-claudeHab").checked = claude.habilitado !== false;
  $<HTMLInputElement>("set-claudeTaskbar").checked = claude.mostraNaTaskbarWindows !== false;
  syncBarraProvedores();
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
  syncWidgetProvedores();
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
      },
      claude: {
        habilitado: $<HTMLInputElement>("set-claudeHab").checked,
        mostraNaTaskbarWindows: $<HTMLInputElement>("set-claudeTaskbar").checked,
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

// Contas conectadas de cada provedor (abas Codex e Claude). O login é só pelo
// navegador, à parte do config.json: `codex_login`/`claude_login` adicionam uma
// conta, ou reconectam a existente quando é a mesma. A lista vem de
// `codex_auth_status`/`claude_auth_status`. A conta principal é a que o tray, a
// barra, o widget e o envio ao Loki usam.
type ProvedorConta = "codex" | "claude";

/// Espelha `contas::MAX_CONTAS_POR_PROVEDOR` (limite de design). O backend recusa a
/// conta a mais de qualquer forma; aqui só esconde o "Adicionar conta".
const MAX_CONTAS_POR_PROVEDOR = 2;
/// Espelha `contas::MAX_APELIDO` (caracteres). O backend corta o excedente de
/// qualquer forma; aqui o campo não deixa digitar além.
const MAX_APELIDO = 20;

interface ContaStatus {
  /// "<provedor>:<id>", estável entre reconexões.
  chave: string;
  principal: boolean;
  apelido: string | null;
  /// A conta aparece no widget (quando o provedor também está ligado lá).
  mostraNoWidget: boolean;
  /// É a conta que a barra de tarefas mostra no provedor (uma por provedor; a
  /// principal, sem escolha).
  naBarra: boolean;
  connected: boolean;
  needsReconnect: boolean;
  email: string | null;
}

interface ProvedorUi {
  nome: string;
  contas: ContaStatus[];
  /// Assinatura da última lista desenhada: o auto-refresh de 5s só redesenha quando
  /// algo mudou, para não tirar o foco do campo de apelido no meio da digitação.
  assinatura: string;
  /// Enquanto true, o auto-refresh não relê a lista (não atropela o "Aguardando…").
  loginEmAndamento: boolean;
  /// Status de uma conta que precisa reconectar (o motivo difere entre provedores).
  expirada: string;
}

const PROVEDORES: Record<ProvedorConta, ProvedorUi> = {
  codex: {
    nome: "Codex",
    contas: [],
    assinatura: "",
    loginEmAndamento: false,
    expirada: "Não foi possível renovar a sessão automaticamente. Reconecte.",
  },
  claude: {
    nome: "Claude",
    contas: [],
    assinatura: "",
    loginEmAndamento: false,
    expirada: "Sessão expirada. Reconecte para continuar a coleta.",
  },
};

/// Há ao menos uma conta que coleta (conectada e sem precisar reconectar)? Usado
/// pelos avisos de "sem credenciais".
function temContaAtiva(p: ProvedorConta): boolean {
  return PROVEDORES[p].contas.some((c) => c.connected && !c.needsReconnect);
}

function contaHtml(p: ProvedorConta, c: ContaStatus, varias: boolean): string {
  const ui = PROVEDORES[p];
  const ativa = c.connected && !c.needsReconnect;
  const status = !c.connected ? "Desconectada." : c.needsReconnect ? ui.expirada : "Conectada.";
  // Com uma conta só, "principal" não distingue nada: o selo e o botão aparecem a
  // partir da segunda.
  const selo = varias && c.principal ? ' <span class="conta-selo">Principal</span>' : "";
  const botao = (acao: string, texto: string): string =>
    `<button type="button" class="btn btn-sm" data-acao="${acao}">${texto}</button>`;
  return `<div class="conta" data-conta="${escapeHtml(c.chave)}">
    <div class="conta-info">
      <div class="conta-nome">${escapeHtml(c.email ?? "Conta sem e-mail")}${selo}</div>
      <div class="conta-status ${ativa ? "ok" : "warn"}">${status}</div>
    </div>
    <input type="text" class="conta-apelido" placeholder="Apelido" maxlength="${MAX_APELIDO}" value="${escapeHtml(c.apelido ?? "")}">
    <div class="conta-acoes">
      ${c.needsReconnect || !c.connected ? botao("reconectar", "Reconectar") : ""}
      ${varias && !c.principal ? botao("principal", "Tornar principal") : ""}
      ${botao("remover", "Remover")}
    </div>
  </div>`;
}

/// Desenha a lista de contas do provedor e ajusta o botão de login ("Conectar" sem
/// conta, "Adicionar conta" com ao menos uma, nenhum no limite) e o texto de status.
function renderContas(p: ProvedorConta): void {
  const ui = PROVEDORES[p];
  const varias = ui.contas.length > 1;
  const noLimite = ui.contas.length >= MAX_CONTAS_POR_PROVEDOR;
  $(`set-${p}Contas`).innerHTML = ui.contas.map((c) => contaHtml(p, c, varias)).join("");
  const loginBtn = $(`set-${p}Login`);
  loginBtn.textContent = ui.contas.length ? "Adicionar conta" : "Conectar com o navegador";
  loginBtn.hidden = ui.loginEmAndamento || noLimite;
  const statusEl = $(`set-${p}AuthStatus`);
  if (!ui.loginEmAndamento) {
    statusEl.textContent = noLimite
      ? `Limite de ${MAX_CONTAS_POR_PROVEDOR} contas. Remova uma para conectar outra.`
      : "Conecte sua conta para iniciar a coleta.";
    statusEl.hidden = ui.contas.length > 0 && !noLimite;
  }
  syncProviderHints();
  renderWidgetContas(p);
  renderBarraContas(p);
}

/// Nome da conta nas listas das abas Widget e Barra: apelido, com o e-mail embaixo
/// (sem apelido, o e-mail é o nome).
function nomeDaConta(c: ContaStatus): string {
  const nome = c.apelido ?? c.email ?? "Conta sem e-mail";
  const email = c.apelido && c.email ? `<span class="prov-conta-email">${escapeHtml(c.email)}</span>` : "";
  return `<span class="prov-conta-textos"><span class="prov-conta-nome">${escapeHtml(nome)}</span>${email}</span>`;
}

/// Aba Barra: a barra mostra uma conta por provedor. Com 2 ou mais contas, o cartão
/// do provedor lista as contas com um radio para escolher qual (a principal, sem
/// escolha). Ligar o provedor continua no switch de cima.
function renderBarraContas(p: ProvedorConta): void {
  const ui = PROVEDORES[p];
  const lista = $(`set-barra${ui.nome}Contas`);
  const varias = ui.contas.length > 1;
  lista.hidden = !varias;
  if (!varias) {
    lista.innerHTML = "";
    return;
  }
  lista.innerHTML = ui.contas.map((c) =>
    `<label class="prov-conta">${nomeDaConta(c)}` +
    `<input type="radio" class="prov-conta-radio" name="barra-${p}" data-conta="${escapeHtml(c.chave)}"${c.naBarra ? " checked" : ""}></label>`,
  ).join("");
}

/// Provedor desligado na aba Barra: as contas dele ficam apagadas e sem clique.
function syncBarraProvedores(): void {
  for (const nome of ["Claude", "Codex"]) {
    const ligado = $<HTMLInputElement>(`set-${nome.toLowerCase()}Taskbar`).checked;
    $(`set-barra${nome}Card`).classList.toggle("off", !ligado);
  }
}

async function salvarContaBarra(p: ProvedorConta, chave: string): Promise<void> {
  try {
    await invoke("set_conta_barra", { conta: chave });
    setSaved();
  } catch (e) {
    setMsg("Falha ao escolher a conta da barra: " + (e instanceof Error ? e.message : String(e)), "err");
  }
  // Com erro, a lista redesenhada devolve o radio ao valor gravado.
  await loadContas(p, true);
}

/// Aba Widget: com 2 ou mais contas, um switch por conta dentro do cartão do
/// provedor (apelido, com o e-mail embaixo). Com uma conta só, o switch do
/// provedor já basta. Ligar o provedor continua no switch de cima.
function renderWidgetContas(p: ProvedorConta): void {
  const ui = PROVEDORES[p];
  const lista = $(`set-wdg${ui.nome}Contas`);
  const varias = ui.contas.length > 1;
  lista.hidden = !varias;
  if (!varias) {
    lista.innerHTML = "";
    return;
  }
  lista.innerHTML = ui.contas.map((c) =>
    `<label class="prov-conta">${nomeDaConta(c)}` +
    `<span class="switch switch-sm"><input type="checkbox" data-conta="${escapeHtml(c.chave)}"${c.mostraNoWidget !== false ? " checked" : ""}>` +
    `<span class="switch-track"></span></span></label>`,
  ).join("");
}

/// Provedor desligado na aba Widget: as contas dele ficam apagadas e sem clique.
function syncWidgetProvedores(): void {
  for (const nome of ["Claude", "Codex"]) {
    $(`set-wdg${nome}Card`).classList.toggle("off", !$<HTMLInputElement>(`set-wdg${nome}`).checked);
  }
}

async function salvarContaWidget(p: ProvedorConta, chave: string, mostra: boolean): Promise<void> {
  try {
    await invoke("set_conta_widget", { conta: chave, mostra });
    setSaved();
  } catch (e) {
    setMsg("Falha ao salvar a conta do widget: " + (e instanceof Error ? e.message : String(e)), "err");
  }
  // Com erro, a lista redesenhada devolve o switch ao valor gravado.
  await loadContas(p, true);
}

/// Relê a lista de contas (sem rede). Sem `forcar`, só redesenha se mudou.
async function loadContas(p: ProvedorConta, forcar = false): Promise<void> {
  try {
    const contas = await invoke<ContaStatus[]>(`${p}_auth_status`);
    const assinatura = JSON.stringify(contas);
    const ui = PROVEDORES[p];
    if (!forcar && assinatura === ui.assinatura) return;
    ui.contas = contas;
    ui.assinatura = assinatura;
    renderContas(p);
  } catch {
    // transitório; mantém o estado atual
  }
}

/// Dispara o login pelo navegador (bloqueante no backend até o usuário concluir ou
/// cancelar). Enquanto aguarda, troca o botão de login pelo "Cancelar" (que no
/// Codex libera a porta 1455). No Claude, se a conta tiver mais de uma org, a
/// escolha acontece na própria janela de login (claude-org.html) e o comando só
/// volta depois dela.
async function contaLogin(p: ProvedorConta): Promise<void> {
  const ui = PROVEDORES[p];
  const cancelBtn = $(`set-${p}LoginCancel`);
  const statusEl = $(`set-${p}AuthStatus`);
  const outraConta = ui.contas.length > 0;
  const antes = new Set(ui.contas.map((c) => c.chave));
  let nova: string | null = null;
  ui.loginEmAndamento = true;
  $(`set-${p}Login`).hidden = true;
  cancelBtn.hidden = false;
  statusEl.hidden = false;
  // O navegador do sistema pode já estar logado na OpenAI. O backend pede a tela de
  // login mesmo assim, mas se ela não aparecer, a saída é sair da conta lá.
  statusEl.textContent =
    p === "codex" && outraConta
      ? "Aguardando o login no navegador… Se ele entrar direto na conta já conectada, saia dela no navegador e tente de novo."
      : "Aguardando o login no navegador…";
  try {
    const status = await invoke<{ chave?: string } | null>(`${p}_login`);
    setMsg(`${ui.nome} conectado.`, "ok");
    if (status?.chave && !antes.has(status.chave)) nova = status.chave;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Cancelamento é ação do usuário; não polui o topo com aviso.
    if (/cancel/i.test(msg)) setMsg("");
    else setMsg(`Falha no login do ${ui.nome}: ${msg}`, "err");
  } finally {
    ui.loginEmAndamento = false;
    cancelBtn.hidden = true;
    await loadContas(p, true);
  }
  const conta = ui.contas.find((c) => c.chave === nova);
  if (conta) await pedirApelido(p, conta);
}

/// Oferece o apelido de uma conta que acabou de ser ADICIONADA, num modal: no campo
/// da lista ele passava despercebido. É opcional ("Agora não", Esc ou clique fora
/// fecham sem gravar). Reconectar uma conta que já estava na lista não pergunta.
function pedirApelido(p: ProvedorConta, conta: ContaStatus): Promise<void> {
  return new Promise((resolve) => {
    const overlay = $("apelido-overlay");
    const form = $<HTMLFormElement>("apelido-form");
    const input = $<HTMLInputElement>("apelido-input");
    const salvar = $<HTMLButtonElement>("apelido-salvar");
    const pular = $<HTMLButtonElement>("apelido-pular");
    $("apelido-conta").innerHTML =
      `${PROVEDORES[p].nome} conectado como <b>${escapeHtml(conta.email ?? "conta sem e-mail")}</b>.`;
    input.maxLength = MAX_APELIDO;
    input.value = "";
    salvar.disabled = true;
    overlay.classList.remove("hide");
    input.focus();

    const onInput = (): void => { salvar.disabled = !input.value.trim(); };
    const fechar = (): void => {
      overlay.classList.add("hide");
      input.removeEventListener("input", onInput);
      form.removeEventListener("submit", onSubmit);
      pular.removeEventListener("click", fechar);
      overlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve();
    };
    const onSubmit = (e: SubmitEvent): void => {
      e.preventDefault();
      const apelido = input.value.trim();
      if (!apelido) return;
      fechar();
      void salvarApelido(p, conta.chave, apelido);
    };
    const onBackdrop = (e: MouseEvent): void => { if (e.target === overlay) fechar(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") fechar(); };
    input.addEventListener("input", onInput);
    form.addEventListener("submit", onSubmit);
    pular.addEventListener("click", fechar);
    overlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

/// Cancela um login em andamento (o contaLogin pendente rejeita e se recupera).
async function contaLoginCancel(p: ProvedorConta): Promise<void> {
  try {
    await invoke(`${p}_login_cancel`);
  } catch {
    // best-effort; o login pendente ainda expira sozinho no timeout
  }
}

async function tornarPrincipal(p: ProvedorConta, chave: string): Promise<void> {
  try {
    await invoke("set_conta_principal", { conta: chave });
    setSaved();
  } catch (e) {
    setMsg("Falha ao trocar a conta principal: " + (e instanceof Error ? e.message : String(e)), "err");
  }
  await loadContas(p, true);
}

async function removerConta(p: ProvedorConta, chave: string): Promise<void> {
  try {
    await invoke("remover_conta", { conta: chave });
    setMsg("Conta removida.", "ok");
  } catch (e) {
    setMsg("Falha ao remover a conta: " + (e instanceof Error ? e.message : String(e)), "err");
  }
  await loadContas(p, true);
}

async function salvarApelido(p: ProvedorConta, chave: string, apelido: string): Promise<void> {
  try {
    await invoke("set_conta_apelido", { conta: chave, apelido });
    setSaved();
  } catch (e) {
    setMsg("Falha ao salvar o apelido: " + (e instanceof Error ? e.message : String(e)), "err");
  }
  await loadContas(p);
}

/// Liga os eventos da lista de contas e dos botões de login de um provedor. A
/// lista é redesenhada por innerHTML, então os cliques são tratados por delegação.
function wireContas(p: ProvedorConta): void {
  $(`set-${p}Login`).addEventListener("click", () => void contaLogin(p));
  $(`set-${p}LoginCancel`).addEventListener("click", () => void contaLoginCancel(p));
  const lista = $(`set-${p}Contas`);
  lista.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-acao]");
    const chave = btn?.closest<HTMLElement>(".conta")?.dataset.conta;
    if (!btn || !chave) return;
    const acao = btn.dataset.acao;
    if (acao === "reconectar") {
      void contaLogin(p);
    } else if (acao === "principal") {
      void tornarPrincipal(p, chave);
    } else if (acao === "remover") {
      // Remover apaga as credenciais (voltar exige novo login): pede um segundo
      // clique no mesmo botão, que volta ao normal sozinho se não vier.
      if (btn.dataset.confirmar !== "1") {
        btn.dataset.confirmar = "1";
        btn.textContent = "Confirmar remoção";
        btn.classList.add("danger");
        window.setTimeout(() => {
          delete btn.dataset.confirmar;
          btn.textContent = "Remover";
          btn.classList.remove("danger");
        }, 3000);
        return;
      }
      void removerConta(p, chave);
    }
  });
  // Switch de uma conta na aba Widget: vai para o contas.json, à parte do auto-save
  // do formulário (que só cuida do config.json).
  $(`set-wdg${PROVEDORES[p].nome}Contas`).addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const chave = input.dataset.conta;
    if (!chave) return;
    e.stopPropagation();
    void salvarContaWidget(p, chave, input.checked);
  });
  // Radio da conta na aba Barra: também vai para o contas.json, fora do auto-save.
  $(`set-barra${PROVEDORES[p].nome}Contas`).addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const chave = input.dataset.conta;
    if (!chave || !input.checked) return;
    e.stopPropagation();
    void salvarContaBarra(p, chave);
  });
  // O apelido é gravado à parte do auto-save do formulário (que só cuida do
  // config.json): stopPropagation evita o save_settings geral.
  lista.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches(".conta-apelido")) return;
    e.stopPropagation();
    const chave = input.closest<HTMLElement>(".conta")?.dataset.conta;
    if (chave) void salvarApelido(p, chave, input.value);
  });
}

export async function loadSettings(): Promise<void> {
  setMsg("");
  try {
    const data = await invoke<SettingsData>("get_settings");
    fillForm(data);
    void loadEnvioToggles();
    void loadContas("codex");
    void loadContas("claude");
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

/// Reflete o estado de cada provedor: desabilita os campos quando desligado. O
/// estado da conexão já aparece no status do bloco de login de cada um.
function syncProviderHints(): void {
  setBodyEnabled("set-codexBody", $<HTMLInputElement>("set-codexHab").checked);
  setBodyEnabled("set-claudeBody", $<HTMLInputElement>("set-claudeHab").checked);
  syncProviderNotes();
}

/// Caminho do Claude Code CLI vindo do config.json. A UI não edita (é um escape
/// para instalações fora do PATH), mas precisa devolvê-lo no save: o painel manda
/// o bloco `providers` inteiro, então omitir o campo apagaria o valor do disco.
let claudeSessaoAutoCliPath = "";

/// Último status conhecido da reabertura automática. Chega no `get_settings` e na
/// releitura de 5s (`get_sessao_auto_status`), então é preservado entre os `sync`
/// disparados pelo próprio toggle.
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
/// Relê o status da reabertura automática (última tentativa e conta vigiada) sem
/// recarregar o formulário inteiro.
async function loadSessaoAutoStatus(): Promise<void> {
  try {
    syncSessaoAuto(await invoke<SessaoAutoStatus>("get_sessao_auto_status"));
  } catch {
    // transitório; mantém o último status
  }
}

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

  const st = lastSessaoAutoStatus;
  // Qual conta decide o disparo: a do login do CLI, que é onde o `claude -p` abre
  // a janela. Sem ela, o aviso diz por que a reabertura está parada.
  const conta = $("set-claudeSessaoAutoConta") as HTMLElement;
  conta.classList.toggle("warn", !!st?.aviso);
  if (st?.aviso) {
    conta.textContent = st.aviso;
  } else if (st?.contaVigiada) {
    conta.textContent = st.contaDoCli
      ? `Vigiando a conta ${st.contaVigiada}, a mesma em que o CLI está logado.`
      : `Vigiando a conta ${st.contaVigiada}.`;
  } else {
    conta.textContent = "";
  }
  conta.hidden = conta.textContent === "";

  const el = $("set-claudeSessaoAutoStatus") as HTMLElement;
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
  const codexCfg = temContaAtiva("codex");
  const claudeOn = $<HTMLInputElement>("set-claudeHab").checked;
  const claudeCfg = temContaAtiva("claude");
  setNotes(["envio-codex-note"], providerNote(codexOn, codexCfg));
  setNotes(["envio-claude-note"], providerNote(claudeOn, claudeCfg));
  setNotes(["barra-codex-note", "wdg-codex-note"], providerNote(codexOn, codexCfg));
  setNotes(["barra-claude-note", "wdg-claude-note"], providerNote(claudeOn, claudeCfg));
}

/// Troca a aba levando o formulário da altura antiga até a nova e dando o fade de
/// entrada no painel escolhido (ver anima.ts) — sem isso o painel salta de
/// tamanho, já que cada aba tem uma quantidade diferente de campos.
function activateTab(tab: string): void {
  const painel = document.querySelector<HTMLElement>('.stab[data-spanel="' + tab + '"]');
  // Reclicar a aba que já está aberta não pode refazer nada: sem conteúdo novo
  // para revelar, o fade de entrada tocaria de novo e a aba piscaria à toa. Aqui
  // a aba atual mora no DOM (não há variável de estado), então quem responde é o
  // próprio painel.
  if (!painel || painel.classList.contains("on")) return;
  animaTrocaDeAba(
    $("settings-form"),
    () => {
      document.querySelectorAll(".settings-tabs button").forEach((b) =>
        b.classList.toggle("on", (b as HTMLElement).dataset.stab === tab));
      document.querySelectorAll(".stab").forEach((s) =>
        s.classList.toggle("on", (s as HTMLElement).dataset.spanel === tab));
    },
    painel,
  );
}

let initialized = false;

/// Liga os eventos da seção (uma vez) e carrega os valores atuais. Chamada na
/// primeira vez que o usuário abre a aba Configurações.
export function initSettings(): void {
  if (initialized) { void loadSettings(); return; }
  initialized = true;

  document.querySelectorAll(".settings-tabs button").forEach((b) =>
    b.addEventListener("click", () => activateTab((b as HTMLElement).dataset.stab ?? "geral")));

  $("set-srvPinToggle").addEventListener("click", () => {
    const input = $<HTMLInputElement>("set-srvPin");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("set-srvPinToggle").textContent = show ? "Ocultar" : "Mostrar";
  });
  $("set-srvHab").addEventListener("change", syncServerPinHint);
  $("set-srvPin").addEventListener("input", syncServerPinHint);
  $("set-codexHab").addEventListener("change", syncProviderHints);
  $("set-wdgClaude").addEventListener("change", syncWidgetProvedores);
  $("set-wdgCodex").addEventListener("change", syncWidgetProvedores);
  $("set-claudeTaskbar").addEventListener("change", syncBarraProvedores);
  $("set-codexTaskbar").addEventListener("change", syncBarraProvedores);
  wireContas("codex");
  $("set-claudeHab").addEventListener("change", syncProviderHints);
  wireContas("claude");
  // Ao ligar, já mostra a conta vigiada, sem esperar a releitura de 5s.
  $("set-claudeSessaoAuto").addEventListener("change", () => {
    syncSessaoAuto();
    void loadSessaoAutoStatus();
  });
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

  // Auto-refresh das contas: enquanto a tela Configurações está visível, relê a
  // lista a cada 5s para refletir mudanças externas (ex.: sessão/token expirou e a
  // coleta marcou "Reconectar"). Só redesenha a lista quando ela muda, sem tocar
  // nos campos; pula durante um login em andamento. A janela é destruída ao
  // fechar, então o timer não vaza entre reaberturas.
  window.setInterval(() => {
    const visivel = document.getElementById("view-settings")?.classList.contains("on");
    if (!visivel) return;
    for (const p of ["codex", "claude"] as const) {
      if (!PROVEDORES[p].loginEmAndamento) void loadContas(p);
    }
    // A conta do CLI muda por fora (`claude /login`): relê a conta vigiada.
    if ($<HTMLInputElement>("set-claudeSessaoAuto").checked) void loadSessaoAutoStatus();
  }, 5000);

  void loadSettings();
}