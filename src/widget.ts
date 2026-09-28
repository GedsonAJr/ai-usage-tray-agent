// Widget flutuante da área de trabalho (janela `widget`, sem moldura, sempre na
// frente). Mostra um card compacto por provedor (Claude/Codex), com uma conta por
// vez quando há mais de uma (o botão ⇄ alterna; no modo mínimo, uma linha por
// conta), conforme as preferências da aba "Widget" das Configurações. Os dados vêm do comando
// `get_widget_state` (mesmo snapshot do tray/“Uso atual”, sem rede). O fundo
// (imagem/gif) é lido sob demanda via `read_widget_background` e aplicado como
// background do painel; a opacidade controla o quanto o fundo aparece.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  barColor,
  escapeHtml,
  fmtRemaining,
  fmtResetClock,
  ICON_CLAUDE,
  iconCodex,
  pctText,
  type ProviderUsage,
} from "./usage-format";
import {
  botaoTroca,
  linhaConta,
  parseResetMode,
  renderProviderAnelDuplo,
  renderProviderMinimo,
  type AlternaConta,
  type ResetMode,
} from "./widget-modos";

const WIDGET_WIDTH = 320;

/// Uma conta (ou o card do provedor sem conta), na ordem da tela "Uso atual".
interface ContaWidget {
  chave: string;
  provedor: "claude" | "codex";
  rotulo: string | null;
  principal: boolean;
  habilitado: boolean;
  /// O provedor ligado no widget E a conta ligada (aba Widget).
  mostra: boolean;
  metric: ProviderUsage["metric"];
}

interface WidgetState {
  /// Todas as contas, na ordem da tela "Uso atual" (os provedores agrupados).
  contas?: ContaWidget[];
  habilitado: boolean;
  fundo: string;
  opacidade: number;
  janelas: string;
  formatoReset: string;
  modo: string;
  sempreNaFrente: boolean;
  paused: boolean;
}

/// "sessao" → só 5h; "semanal" → só 7d; resto (inclusive "ambos") → as duas.
function parseJanelas(value: string): { sessao: boolean; semanal: boolean } {
  const v = (value ?? "").trim().toLowerCase();
  // Aceita os mesmos sinônimos do backend (parse_janelas em lib.rs).
  if (v === "sessao" || v === "sessão" || v === "session" || v === "5h") return { sessao: true, semanal: false };
  if (v === "semanal" || v === "semana" || v === "weekly" || v === "7d") return { sessao: false, semanal: true };
  return { sessao: true, semanal: true };
}

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let lastFundo: string | null = null;

/// Bloco compacto de uma janela (sessão 5h ou semanal 7d): rótulo curto + % +
/// barra fina + reset. Com `mode === "exato"`, mostra a hora/data exata do reset
/// (estática); "restante" mostra o tempo restante (conta ao vivo); "nenhum"
/// omite a linha de reset. Omitido por completo quando não há dados.
function windowBlock(
  label: string,
  pct: number | undefined | null,
  resetIso: string | null | undefined,
  mode: ResetMode,
): string {
  if (pct === undefined || pct === null) return "";
  const width = Math.max(0, Math.min(100, pct));
  let reset = "";
  if (resetIso && mode !== "nenhum") {
    reset = mode === "exato"
      ? `<div class="wwin-reset">reset ${fmtResetClock(resetIso)}</div>`
      : `<div class="wwin-reset">reset em <span class="w-remain" data-reset="${escapeHtml(resetIso)}">${fmtRemaining(resetIso)}</span></div>`;
  }
  return `<div class="wwin">
    <div class="wwin-top"><span class="wwin-label">${label}</span><span class="wwin-pct">${pctText(pct)}%</span></div>
    <div class="wbar"><div class="wbar-fill" style="width:${width}%;background:${barColor(pct)}"></div></div>
    ${reset}
  </div>`;
}

/// Card compacto de uma conta (modo "completo"). `null` quando não deve aparecer
/// (provedor desabilitado ou escondido do widget). `janelas` escolhe quais janelas
/// (sessão 5h / semanal 7d) renderizar. `alterna`: o provedor tem mais de uma conta
/// visível (botão ⇄ e a linha da conta abaixo do card).
function renderProvider(
  label: string,
  prov: ProviderUsage,
  mostra: boolean,
  janelas: { sessao: boolean; semanal: boolean },
  mode: ResetMode,
  alterna?: AlternaConta,
): string | null {
  if (!mostra || !prov.habilitado) return null;
  const icon = label === "Codex" ? iconCodex() : ICON_CLAUDE;
  const head = `<div class="wprov-head">${icon}<span class="wprov-name">${label}</span></div>`;

  const m = prov.metric;
  if (!m || m.status === "erro" || m.erro) {
    const nota = !m ? '<div class="wprov-note">Coletando…</div>' : '<div class="wprov-note err">erro na coleta</div>';
    // Blocos invisíveis das janelas escolhidas por baixo do aviso: o card fica da
    // mesma altura do normal, e alternar entre uma conta com erro e outra com dados
    // não faz o widget pular.
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const fantasma = [
      janelas.sessao ? windowBlock("Sessão 5h", 0, reset, mode) : "",
      janelas.semanal ? windowBlock("Semanal 7d", 0, reset, mode) : "",
    ].join("");
    return `<div class="wprov${m ? " error" : ""}">${head}` +
      `<div class="wprov-nota-box"><div class="wwins wfantasma" aria-hidden="true">${fantasma}</div>${nota}</div>` +
      `${botaoTroca(alterna)}</div>${linhaConta(alterna)}`;
  }
  const blocks = [
    janelas.sessao ? windowBlock("Sessão 5h", m.uso_percentual, m.reset_em, mode) : "",
    janelas.semanal ? windowBlock("Semanal 7d", m.uso_percentual_7d, m.reset_em_7d, mode) : "",
  ].join("");
  return `<div class="wprov">${head}
    <div class="wwins">${blocks}</div>${botaoTroca(alterna)}
  </div>${linhaConta(alterna)}`;
}

const NOMES: Record<ContaWidget["provedor"], string> = { claude: "Claude", codex: "Codex" };

/// Modo "mínimo" com várias contas: uma linha por conta visível, agrupadas pela
/// conta, e não pelo provedor. Primeiro as principais de cada provedor, sob o
/// título "Principal"; depois as secundárias, sob "Secundário". Sem nenhuma
/// secundária visível, fica como antes: as linhas, sem títulos. Seção vazia não
/// aparece (ex.: a principal do Claude desligada e a secundária ligada). Dentro de
/// cada seção, os provedores seguem a ordem da tela "Uso atual".
function minimoPorConta(
  contas: ContaWidget[],
  janelas: { sessao: boolean; semanal: boolean },
  mode: ResetMode,
): string[] {
  const linha = (c: ContaWidget): string | null =>
    renderProviderMinimo(NOMES[c.provedor], { habilitado: c.habilitado, metric: c.metric }, c.mostra, janelas, mode);
  const linhas = (lista: ContaWidget[]): string[] =>
    lista.map(linha).filter((l): l is string => l !== null);
  const principais = linhas(contas.filter((c) => c.principal));
  const secundarias = linhas(contas.filter((c) => !c.principal));
  if (!secundarias.length) return principais;
  const titulo = (texto: string): string => `<div class="wgrupo">${texto}</div>`;
  return [
    ...(principais.length ? [titulo("Principal"), ...principais] : []),
    titulo("Secundário"),
    ...secundarias,
  ];
}

/// Conta mostrada no card de cada provedor (modos "completo" e "anel duplo"; o
/// botão ⇄ alterna). Vale enquanto o widget estiver aberto; sem escolha (ou se a
/// conta sumiu), a principal.
const contaNoCard = new Map<string, string>();
/// Uma troca de conta animando: a recarga periódica espera, senão reconstruiria o
/// card no meio do movimento.
let trocando = false;
/// Último estado desenhado: a troca redesenha a partir dele, sem esperar o IPC.
let ultimoEstado: WidgetState | null = null;

/// Contas visíveis de um provedor no widget, a principal primeiro.
function visiveisDo(contas: ContaWidget[], provedor: string): ContaWidget[] {
  return contas
    .filter((c) => c.provedor === provedor && c.mostra && c.habilitado)
    .sort((a, b) => Number(b.principal) - Number(a.principal));
}

/// Desenha o card de uma conta num modo ("completo" ou "anel duplo").
type DesenhaCard = (
  label: string,
  prov: ProviderUsage,
  mostra: boolean,
  janelas: { sessao: boolean; semanal: boolean },
  mode: ResetMode,
  alterna?: AlternaConta,
) => string | null;

/// Modos "completo" e "anel duplo": um card por provedor, com a conta escolhida.
/// Com mais de uma conta visível, o card tem o botão ⇄, que alterna entre elas e só
/// aparece com o mouse sobre ele (ver `marcaCardSobMouse`), e, abaixo dele, os
/// pontinhos e o rótulo da conta na tela. Provedores na ordem da tela "Uso atual".
function cardsPorConta(
  contas: ContaWidget[],
  janelas: { sessao: boolean; semanal: boolean },
  mode: ResetMode,
  desenha: DesenhaCard,
): string[] {
  const provedores = [...new Set(contas.map((c) => c.provedor))];
  return provedores
    .map((p) => {
      const lista = visiveisDo(contas, p);
      if (!lista.length) return null;
      const indice = Math.max(0, lista.findIndex((c) => c.chave === contaNoCard.get(p)));
      const conta = lista[indice];
      const alterna = lista.length > 1
        ? { provedor: p, indice, total: lista.length, rotulo: conta.rotulo ?? "Conta sem e-mail" }
        : undefined;
      return desenha(NOMES[p], { habilitado: conta.habilitado, metric: conta.metric }, true, janelas, mode, alterna);
    })
    .filter((c): c is string => c !== null);
}

/// Duração da troca de conta.
const TROCA_MS = 420;

/// Leva o card do provedor para a próxima conta visível e anima a passagem: os
/// arcos (anel duplo) e as barras (completo) vão do valor da conta anterior ao da
/// nova, quando as duas têm as mesmas janelas; os textos e o rótulo da conta entram
/// com um fade.
function alternaConta(provedor: string): void {
  if (!ultimoEstado || trocando) return;
  const lista = visiveisDo(ultimoEstado.contas ?? [], provedor);
  if (lista.length < 2) return;
  const indice = Math.max(0, lista.findIndex((c) => c.chave === contaNoCard.get(provedor)));
  const card = (): HTMLElement | null =>
    el("wdg-cards").querySelector<HTMLElement>(`.wtroca[data-provedor="${provedor}"]`)?.closest(".wprov") ?? null;
  const arcosDe = (c: HTMLElement | null): SVGCircleElement[] => [...(c?.querySelectorAll<SVGCircleElement>(".wduplo-arco") ?? [])];
  const barrasDe = (c: HTMLElement | null): HTMLElement[] => [...(c?.querySelectorAll<HTMLElement>(".wwins:not(.wfantasma) .wbar-fill") ?? [])];
  const antes = card();
  const arcosAntes = arcosDe(antes).map((a) => a.getAttribute("stroke-dasharray") ?? "");
  const barrasAntes = barrasDe(antes).map((b) => b.style.width);

  contaNoCard.set(provedor, lista[(indice + 1) % lista.length].chave);
  render(ultimoEstado);

  const novo = card();
  if (!novo || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const opts: KeyframeAnimationOptions = { duration: TROCA_MS, easing: "cubic-bezier(.32,.72,.35,1)" };
  const animacoes: Animation[] = [];
  const arcos = arcosDe(novo);
  if (arcos.length && arcos.length === arcosAntes.length) {
    arcos.forEach((a, i) => {
      const depois = a.getAttribute("stroke-dasharray") ?? "";
      animacoes.push(a.animate([{ strokeDasharray: arcosAntes[i] }, { strokeDasharray: depois }], opts));
    });
  }
  const barras = barrasDe(novo);
  if (barras.length && barras.length === barrasAntes.length) {
    barras.forEach((b, i) => animacoes.push(b.animate([{ width: barrasAntes[i] }, { width: b.style.width }], opts)));
  }
  const apelido = novo.nextElementSibling?.querySelector<HTMLElement>(".wconta-apelido") ?? null;
  const textos = [...novo.querySelectorAll<HTMLElement>(".wduplo-info, .wwin-top, .wwin-reset, .wprov-nota-box > .wprov-note"), apelido];
  for (const alvo of textos) {
    if (!alvo) continue;
    animacoes.push(alvo.animate(
      [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }],
      { duration: TROCA_MS * 0.7, easing: "ease-out" },
    ));
  }
  if (!animacoes.length) return;
  trocando = true;
  const fim = (): void => { trocando = false; };
  void Promise.all(animacoes.map((a) => a.finished)).then(fim, fim);
}

/// Atualiza só a contagem regressiva, sem reconstruir os cards (a cada 1s).
function tick(): void {
  document.querySelectorAll<HTMLElement>(".w-remain[data-reset]").forEach((n) => {
    n.textContent = fmtRemaining(n.dataset.reset as string);
  });
}

// Auto-ajuste da altura ao conteúdo **só até o usuário redimensionar**. Depois
// que o usuário escolhe um tamanho (marcado em localStorage), respeitamos e o
// window-state cuida de salvar/restaurar; o auto-ajuste não age mais.
const PADDING = 24; // padding vertical do .wdg (12px topo + 12px base)
let userSized = localStorage.getItem("wdg-sized") === "1";
let selfResizing = false;
let lastHeight = 0;

const win = getCurrentWindow();
// Marca como "dimensionado pelo usuário" quando o resize não foi nosso.
void win.onResized(() => {
  if (selfResizing) return;
  userSized = true;
  localStorage.setItem("wdg-sized", "1");
});

/// Ajusta a altura da janela ao conteúdo (mede o .wdg-cards, não o .wdg, que é
/// clampado por min-height). Largura mantém o padrão. No-op após o usuário
/// redimensionar.
function fitToContent(): void {
  if (userSized) return;
  const h = Math.ceil(el("wdg-cards").getBoundingClientRect().height) + PADDING;
  if (h <= 0 || Math.abs(h - lastHeight) < 2) return;
  lastHeight = h;
  selfResizing = true;
  void win
    .setSize(new LogicalSize(WIDGET_WIDTH, h))
    .catch(() => {})
    .finally(() => setTimeout(() => { selfResizing = false; }, 120));
}

/// Aplica a imagem/gif de fundo só quando o caminho muda (ler/codificar é caro
/// para gifs grandes). Caminho vazio remove o fundo.
async function applyBackground(fundo: string): Promise<void> {
  if (fundo === lastFundo) return;
  lastFundo = fundo;
  const wdg = el("wdg");
  if (!fundo) {
    wdg.style.backgroundImage = "";
    return;
  }
  try {
    const dataUrl = await invoke<string | null>("read_widget_background");
    // Imagem + overlay escuro numa única camada de background: assim o recorte
    // dos cantos (border-radius + overflow: hidden) acontece uma só vez e não
    // sobra a borda clara que aparecia quando a imagem e o overlay estavam em
    // camadas separadas. O alpha do overlay segue --wdg-alpha (atualiza sozinho
    // quando a opacidade muda, sem reaplicar a imagem).
    wdg.style.backgroundImage = dataUrl
      ? `linear-gradient(rgba(26, 25, 21, var(--wdg-alpha)), rgba(26, 25, 21, var(--wdg-alpha))), url("${dataUrl}")`
      : "";
  } catch {
    wdg.style.backgroundImage = "";
  }
}

function render(state: WidgetState): void {
  ultimoEstado = state;
  // Opacidade do painel: 0..100 → alpha do fundo escuro do card.
  const alpha = Math.max(0, Math.min(100, state.opacidade)) / 100;
  el("wdg").style.setProperty("--wdg-alpha", String(alpha));

  const janelas = parseJanelas(state.janelas);
  const mode = parseResetMode(state.formatoReset);
  // Modo de exibição: "completo" (cards com barras), "minimo" (uma linha por
  // conta, agrupadas em principal/secundária) ou "anelduplo" (anéis concêntricos).
  // Default: "completo". A ordem dos provedores é a da tela "Uso atual", que já
  // vem aplicada na lista de contas.
  const modo = (state.modo ?? "completo").trim().toLowerCase();
  const contas = state.contas ?? [];
  const cards = modo === "minimo"
    ? minimoPorConta(contas, janelas, mode)
    : cardsPorConta(contas, janelas, mode, modo === "anelduplo" ? renderProviderAnelDuplo : renderProvider);

  el("wdg-cards").innerHTML = cards.length
    ? cards.join("")
    : `<div class="wprov-note">Nenhum provedor selecionado.<br>Ative nas Configurações → Widget.</div>`;

  void applyBackground(state.fundo ?? "");
  marcaCardSobMouse();
  tick();
  // Espera o layout para medir a altura real e casar a janela ao conteúdo.
  requestAnimationFrame(fitToContent);
}

/// Busca o estado pelo IPC e re-renderiza. Barata (sem rede no backend).
async function load(): Promise<void> {
  if (trocando) return;
  try {
    const state = await invoke<WidgetState>("get_widget_state");
    render(state);
  } catch {
    // Janela pode estar fechando; ignora.
  }
}

// A cada 1s atualiza a contagem regressiva; a cada 2s rebusca o estado (mesmo
// esquema da tela "Uso atual"). get_widget_state é barato e sem rede. Com a
// janela oculta não há o que atualizar: pula o ciclo (poupa o IPC).
let tickCount = 0;
setInterval(() => {
  if (document.hidden) return;
  tick();
  if (++tickCount % 2 === 0) void load();
}, 1000);

// Botão ⇄: alterna a conta do card. É o único ponto do card que recebe o mouse; o
// resto continua sendo área de arraste.
document.addEventListener("click", (e) => {
  const provedor = (e.target as HTMLElement).closest<HTMLElement>(".wtroca")?.dataset.provedor;
  if (provedor) alternaConta(provedor);
});

// O botão só aparece com o mouse sobre o card dele. Os cards não recebem o mouse
// (são área de arraste, com `pointer-events: none`), então o `:hover` do CSS não
// os alcança: o card sob o cursor é achado pela posição e marcado com `.sob-mouse`.
// A última posição fica guardada para remarcar o card depois de cada recarga, que
// reconstrói os cards.
let mouse: { x: number; y: number } | null = null;
function marcaCardSobMouse(): void {
  el("wdg-cards").querySelectorAll<HTMLElement>(".wprov").forEach((card) => {
    const r = card.getBoundingClientRect();
    const dentro = !!mouse && mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom;
    card.classList.toggle("sob-mouse", dentro);
  });
}
document.addEventListener("mousemove", (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  marcaCardSobMouse();
});
document.documentElement.addEventListener("mouseleave", () => {
  mouse = null;
  marcaCardSobMouse();
});

// Clique direito em qualquer ponto do widget abre o menu do app (mesmos itens
// do tray), em vez do menu de contexto padrão do WebView.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void invoke("show_app_menu");
});

void load();