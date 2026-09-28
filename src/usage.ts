// Tela "Uso atual": mostra o uso de sessão (5h) e semanal (7d) das contas do
// Claude e do Codex (um card por provedor; com mais de uma conta, as setas do
// cabeçalho alternam entre elas), com barra de progresso, tempo restante
// para o reset (contagem ao vivo) e a data/hora exata do reset. O subtítulo da página traz o "Atualizado há…" do
// dado em cache. Os dados vêm do comando IPC `get_usage`, que lê o mesmo snapshot
// usado pelo tray e pela barra de tarefas (sem rede); a tela rebusca sozinha a
// cada poucos segundos (não há mais botão de atualização manual).
import { invoke, isTauri } from "./ipc";
import { placeFixed } from "./chart-utils";
import {
  barColor,
  escapeHtml,
  fmtExact,
  fmtRemaining,
  fmtTime,
  ICON_CLAUDE,
  iconCodex,
  pctText,
  type UsageMetric,
} from "./usage-format";

/// Um ponto do histórico de uso: instante (ISO) + % naquele momento.
export interface HistPoint {
  t: string;
  pct: number;
}
/// Séries de histórico de uma conta: sessão (5h) e semanal (7d). Ambas cobrem as
/// últimas ~5h (o backend só mantém essa janela, em memória).
export interface ProviderHistory {
  session: HistPoint[];
  weekly: HistPoint[];
}

/// Um card: uma conta conectada, ou o provedor sem conta (chave = a do provedor),
/// que mostra "não conectado"/"desabilitado" como antes.
export interface ContaUso {
  /// "<provedor>:<id>" (ou só "<provedor>" no card do provedor sem conta).
  chave: string;
  provedor: "claude" | "codex";
  /// Apelido, senão o e-mail. Nulo no card do provedor sem conta.
  rotulo: string | null;
  principal: boolean;
  habilitado: boolean;
  metric: UsageMetric | null;
  history: ProviderHistory;
}

export interface Usage {
  paused: boolean;
  lastError: string | null;
  /// Exibir o mini gráfico (toggle da própria tela). Ausente = tratar como true.
  chartEnabled?: boolean;
  /// Mostrar o aviso de perda de dados ao desabilitar. Ausente = tratar como true.
  chartWarnOnDisable?: boolean;
  /// Cards já na ordem de exibição (a ordem salva vem aplicada pelo backend).
  contas: ContaUso[];
}

let DATA: Usage | null = null;
let initialized = false;
let tickCount = 0;
/// Coordenadas já calculadas de cada mini-gráfico (chave = "claude-session"…),
/// para o hover localizar o ponto sem recalcular. Repovoado a cada render().
const CHARTS = new Map<string, { pts: { x: number; y: number; p: HistPoint }[]; label: string }>();
/// Assinatura do último snapshot renderizado; evita reconstruir os cards (e
/// resetar o hover do gráfico) quando os dados não mudaram entre os reloads de 2s.
let lastSig = "";
/// Modo "reordenar" (ligado pelo botão do cabeçalho): torna os cards arrastáveis.
let reordering = false;

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const isActive = (): boolean => !!el("view-usage")?.classList.contains("on");

/// Quão recente é o dado coletado: "atualizado agora", "há 12s", "há 3min"…
function fmtFresh(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s)) return "";
  if (s < 2) return "Atualizado agora";
  if (s < 60) return `Atualizado há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Atualizado há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Atualizado há ${h}h`;
  return `Atualizado há ${Math.floor(h / 24)}d`;
}

/// Bloco de uma janela (sessão ou semanal): % + barra + reset (tempo e data).
/// `timeOnly` (sessão 5h): mostra "Horário: 14:29" (hora em branco) no lugar da
/// data completa, já que o reset é no mesmo dia.
function windowBlock(
  label: string,
  pct: number | undefined,
  resetIso: string | null | undefined,
  timeOnly: boolean,
  series: HistPoint[],
  key: string,
  wide = false,
): string {
  if (pct === undefined || pct === null) {
    return `<div class="uwin">
      <div class="uwin-top"><span class="uwin-label">${label}</span><span class="uwin-pct muted">—</span></div>
      <div class="uwin-na">Sem dados desta janela.</div>
    </div>`;
  }
  const width = Math.max(0, Math.min(100, pct));
  let reset: string;
  if (resetIso) {
    // A janela de 5h reseta sempre no mesmo dia, então só o horário basta; a
    // semanal pode cair em qualquer dia e leva a data junto.
    const quando = timeOnly
      ? `<span class="ur-k">Horário:</span> <span class="u-time">${fmtTime(resetIso)}</span>`
      : `<span class="ur-k">Quando:</span> <span class="u-time">${fmtExact(resetIso)}</span>`;
    // O ponto é um item da linha, entre os dois blocos — não parte de um deles.
    reset =
      `<div class="ur-line"><span class="ur-k">Reset em</span> <span class="u-remain" data-reset="${escapeHtml(resetIso)}">${fmtRemaining(resetIso)}</span></div>` +
      `<span class="ur-dot" aria-hidden="true"></span>` +
      `<div class="ur-line ur-when">${quando}</div>`;
  } else {
    reset = `<div class="ur-line ur-k">Sem horário de reset.</div>`;
  }
  return `<div class="uwin">
    <div class="uwin-top"><span class="uwin-label">${label}</span><span class="uwin-pct">${pctText(pct)}%</span></div>
    <div class="ubar"><div class="ubar-fill" style="width:${width}%;background:${barColor(pct)}"></div></div>
    ${sparkline(series, barColor(pct), key, label, wide)}
    <div class="uwin-reset">${reset}</div>
  </div>`;
}

// Dimensões (em unidades de viewBox) do mini-gráfico. O SVG escala uniforme via
// CSS (width:100%; height:auto), então as coordenadas abaixo são as usadas tanto
// para desenhar quanto para o hover (que mapeia o cursor por getBoundingClientRect).
const SPARK = { W: 300, H: 64, padY: 6, padL: 22 };
/// Largura do viewBox quando a janela ocupa o card inteiro (`.uwins.single`): ~o
/// dobro das duas colunas + o vão, para o gráfico manter a altura da meia coluna
/// em vez de crescer junto com a largura.
const SPARK_WIDE_W = 614;

/// Rótulo do início da série (ponta esquerda do gráfico): quão atrás está o ponto
/// mais antigo, em relação a agora. Compacto: "-40min", "-4h", "-4h20min". Cresce
/// até ~-5h conforme o histórico (anel de 5h) enche.
function spanLabel(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `-${min}min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `-${h}h${rem}min` : `-${h}h`;
}

/// Mini gráfico de linha da % ao longo das últimas ~5h (eixo Y fixo 0–100).
/// Registra as coordenadas em `CHARTS[key]` (para o hover) e devolve o HTML do
/// SVG. `accent` colore a linha/área (segue a cor da barra do bloco). Com menos de
/// dois pontos, mostra um aviso de "coletando" no lugar do gráfico.
function sparkline(series: HistPoint[], accent: string, key: string, label: string, wide = false): string {
  if (series.length < 2) {
    return `<div class="uchart-na">Coletando histórico… (aparece após algumas coletas)</div>`;
  }
  const { H, padY, padL } = SPARK;
  const W = wide ? SPARK_WIDE_W : SPARK.W;
  const ih = H - padY * 2;
  const plotW = W - padL;
  const t0 = new Date(series[0].t).getTime();
  const t1 = new Date(series[series.length - 1].t).getTime();
  const span = Math.max(1, t1 - t0);
  const xOf = (t: string) => padL + ((new Date(t).getTime() - t0) / span) * plotW;
  const yOf = (p: number) => padY + (1 - Math.max(0, Math.min(100, p)) / 100) * ih;
  const pts = series.map((p) => ({ x: xOf(p.t), y: yOf(p.pct), p }));
  CHARTS.set(key, { pts, label });

  const line = pts.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const y0 = yOf(0).toFixed(1);
  const area = `${padL},${y0} ${line} ${W.toFixed(1)},${y0}`;
  // Régua Y: 0% (base) e 100% (topo) reforçados; 50% como guia fraca. Cada linha
  // ganha um rótulo à esquerda, deixando explícito o intervalo do eixo.
  let grid = "";
  let ylab = "";
  for (const g of [0, 50, 100]) {
    const gy = yOf(g);
    const strong = g === 0 || g === 100;
    grid += `<line x1="${padL}" x2="${W}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${strong ? "#4d493f" : "#34322d"}" stroke-width="1"/>`;
    ylab += `<text class="uchart-ylab" x="${padL - 5}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${g}</text>`;
  }
  return `<div class="uchart" data-key="${key}">
    <svg class="uchart-svg" viewBox="0 0 ${W} ${H}">
      ${grid}${ylab}
      <polyline points="${area}" fill="${accent}22" stroke="none"/>
      <polyline points="${line}" fill="none" stroke="${accent}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
      <line class="uchart-guide" y1="${padY}" y2="${H - padY}" stroke="${accent}" stroke-width="1" visibility="hidden"/>
      <circle class="uchart-dot" r="2.6" fill="${accent}" stroke="#232220" stroke-width="1" visibility="hidden"/>
    </svg>
    <div class="uchart-x"><span>${spanLabel(series[0].t)}</span><span>agora</span></div>
  </div>`;
}

const NOMES: Record<ContaUso["provedor"], string> = { claude: "Claude", codex: "Codex" };

/// As contas de um provedor, na ordem dos cards. Um card por provedor; com mais de
/// uma conta, as setas do cabeçalho alternam entre elas.
interface Grupo {
  provedor: ContaUso["provedor"];
  contas: ContaUso[];
}

/// Conta mostrada no card de cada provedor. Sobrevive aos re-renders; sem escolha
/// (ou se a conta sumiu), vale a principal.
const selecionada = new Map<ContaUso["provedor"], string>();
/// Há uma troca de conta animando: o render periódico espera ela acabar, senão
/// reconstruiria o card no meio do movimento.
let trocando = false;

/// Agrupa as contas por provedor, na ordem em que o primeiro card de cada um vem.
function agrupa(contas: ContaUso[]): Grupo[] {
  const grupos: Grupo[] = [];
  for (const c of contas) {
    let g = grupos.find((x) => x.provedor === c.provedor);
    if (!g) {
      g = { provedor: c.provedor, contas: [] };
      grupos.push(g);
    }
    g.contas.push(c);
  }
  return grupos;
}

function contaAtual(g: Grupo): ContaUso {
  const chave = selecionada.get(g.provedor);
  return g.contas.find((c) => c.chave === chave) ?? g.contas.find((c) => c.principal) ?? g.contas[0];
}

const rotuloDe = (c: ContaUso): string => c.rotulo ?? "Conta sem e-mail";

/// Corpo do card de uma conta e o estado dela (classe do card e selo do
/// cabeçalho), cobrindo: desabilitado, sem dado ainda, erro de coleta, ou as duas
/// janelas (sessão e semanal). `nota`: o corpo é só um aviso de texto, sem as
/// janelas (ver o `.painel` de `renderCard`).
function corpoConta(prov: ContaUso): { estado: string; selo: string; html: string; nota: boolean } {
  const label = NOMES[prov.provedor];
  if (!prov.habilitado) {
    return {
      estado: "disabled",
      selo: '<span class="ubadge muted">desabilitado</span>',
      html: `<div class="uprov-note">Habilite ${label} nas Configurações para coletar o uso.</div>`,
      nota: true,
    };
  }
  const m = prov.metric;
  if (!m) return { estado: "", selo: "", html: '<div class="uprov-note">Coletando dados…</div>', nota: true };
  if (m.status === "erro" || m.erro) {
    // Sem selo: a mensagem em vermelho já diz que é erro.
    return {
      estado: "error",
      selo: "",
      html: `<div class="uprov-note err">${escapeHtml(m.erro ?? "Falha na coleta.")}</div>`,
      nota: true,
    };
  }
  // O "atualizado há…" foi para o subtítulo da página (renderSub); o card não o repete.
  const hist = prov.history;
  const chartKey = prov.chave;
  const hasSession = m.uso_percentual !== undefined && m.uso_percentual !== null;
  const hasWeekly = m.uso_percentual_7d !== undefined && m.uso_percentual_7d !== null;
  // Só uma janela com dado (ex.: o Codex deixou de expor a sessão): o bloco vazio
  // some e o que tem dado ocupa o card inteiro. Sem nenhuma, mantém os dois "—".
  const single = hasSession !== hasWeekly;
  const session = windowBlock("Sessão", m.uso_percentual, m.reset_em, true, hist?.session ?? [], chartKey + "-session", single);
  const weekly = windowBlock("Semanal", m.uso_percentual_7d, m.reset_em_7d, false, hist?.weekly ?? [], chartKey + "-weekly", single);
  const wins = !single ? session + weekly : hasSession ? session : weekly;
  // Com as duas janelas, elas dividem um container só, com um divisor no meio.
  const classe = single ? " single" : " juntas";
  return { estado: "", selo: "", html: `<div class="uwins${classe}">${wins}</div>`, nota: false };
}

/// Contas do grupo na ordem das colunas: a principal à esquerda, a outra à direita.
function colunas(g: Grupo): ContaUso[] {
  return [...g.contas].sort((a, b) => Number(b.principal) - Number(a.principal));
}

/// Lado direito do cabeçalho: o apelido (senão o e-mail) da conta mostrada e, com
/// mais de uma conta, as setas "‹ Apelido ›". Os rótulos de todas as contas ficam
/// empilhados na mesma célula, com só o atual visível: a largura é a do maior, e as
/// setas não mudam de lugar ao alternar. As setas não dão a volta: na conta da
/// esquerda só a direita vale, na da direita só a esquerda.
function seletorConta(g: Grupo, atual: ContaUso): string {
  // O card do provedor sem conta (desabilitado ou não conectado) não tem rótulo.
  if (!atual.rotulo && g.contas.length < 2) return "";
  if (g.contas.length < 2) return `<span class="uprov-conta">${escapeHtml(rotuloDe(atual))}</span>`;
  const ordem = colunas(g);
  const i = ordem.indexOf(atual);
  const rotulos = ordem
    .map((c) => `<span class="uprov-conta${c === atual ? " on" : ""}" data-conta="${escapeHtml(c.chave)}">${escapeHtml(rotuloDe(c))}</span>`)
    .join("");
  const seta = (dir: -1 | 1, titulo: string, d: string, ativa: boolean): string =>
    `<button type="button" class="uconta-seta" data-dir="${dir}" aria-label="${titulo}" title="${titulo}"${ativa ? "" : " disabled"}>` +
    `<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  return `<div class="uconta-nav">${seta(-1, "Conta anterior", "M7.5 3 4.5 6 7.5 9", i > 0)}` +
    `<span class="uconta-rotulos" aria-live="polite">${rotulos}</span>` +
    `${seta(1, "Próxima conta", "M4.5 3 7.5 6 4.5 9", i < ordem.length - 1)}</div>`;
}

/// Anéis concêntricos do resumo, na geometria do modo "Anel duplo" do widget
/// (widget-modos.ts): sessão no anel externo, semanal no interno. Com uma janela
/// só, fica só o anel interno, num desenho menor. O viewBox é o do widget; o
/// tamanho na tela vem do CSS (`.ures-aneis svg`).
const ANEL_EXT = { r: 31, circ: 194.78 };
const ANEL_INT = { r: 22, circ: 138.23 };

function aneis(wins: { pct: number; anel: { r: number; circ: number } }[]): string {
  const lado = wins.length === 1 ? 54 : 76;
  const c = lado / 2;
  const circulo = (r: number, extra: string): string =>
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="6" ${extra}/>`;
  const fundo = wins.map((w) => circulo(w.anel.r, 'stroke="#1c1b18"')).join("");
  const frente = wins.map((w) => {
    const feito = ((Math.max(0, Math.min(100, w.pct)) / 100) * w.anel.circ).toFixed(2);
    return circulo(w.anel.r, `stroke="${barColor(w.pct)}" stroke-linecap="round" stroke-dasharray="${feito} ${w.anel.circ}"`);
  }).join("");
  // Gira -90° para o progresso começar no topo, como no widget.
  return `<svg class="${wins.length === 1 ? "um" : "dois"}" viewBox="0 0 ${lado} ${lado}" style="transform:rotate(-90deg)" aria-hidden="true">${fundo}${frente}</svg>`;
}

/// Resumo de uma conta, na coluna estreita ao lado da conta mostrada, no formato do
/// "Anel duplo" do widget: o rótulo, os anéis e a % de cada janela, sem gráfico nem
/// reset (eles ficam na conta completa). Baixo o bastante para não passar da altura
/// dos blocos da conta completa com o gráfico desligado. Cobre o erro de coleta, a
/// conta ainda sem dado e a que só tem uma das janelas (ex.: o Codex só com a
/// semanal): a janela sem dado simplesmente não aparece.
function resumoConta(prov: ContaUso): string {
  const nome = `<div class="ures-nome">${escapeHtml(rotuloDe(prov))}</div>`;
  const m = prov.metric;
  if (!prov.habilitado || !m) {
    const texto = prov.habilitado ? "Coletando dados…" : "Desabilitado.";
    return `<div class="ures ucol-resumo">${nome}<div class="ures-note">${texto}</div></div>`;
  }
  if (m.status === "erro" || m.erro) {
    return `<div class="ures ucol-resumo error">${nome}` +
      `<div class="ures-note err">${escapeHtml(m.erro ?? "Falha na coleta.")}</div></div>`;
  }
  type Win = { pct: number; anel: { r: number; circ: number }; titulo: string; reset: string | null | undefined; quando: string };
  const wins: Win[] = [];
  if (m.uso_percentual != null) {
    // A sessão reseta no mesmo dia: só o horário basta (como no bloco completo).
    const quando = m.reset_em ? `Horário: ${fmtTime(m.reset_em)}` : "";
    wins.push({ pct: m.uso_percentual, anel: ANEL_EXT, titulo: "Sessão", reset: m.reset_em, quando });
  }
  if (m.uso_percentual_7d != null) {
    const quando = m.reset_em_7d ? `Quando: ${fmtExact(m.reset_em_7d)}` : "";
    wins.push({ pct: m.uso_percentual_7d, anel: ANEL_INT, titulo: "Semanal", reset: m.reset_em_7d, quando });
  }
  if (!wins.length) return `<div class="ures ucol-resumo">${nome}<div class="ures-note">Sem dados das janelas.</div></div>`;
  if (wins.length === 1) wins[0].anel = ANEL_INT;
  const ponto = (w: Win): string => `<span class="ures-dot" style="background:${barColor(w.pct)}"></span>`;
  // A ordem das linhas (sessão, semanal) casa com a dos anéis (externo, interno);
  // o nome da janela fica no tooltip.
  const legenda = wins.map((w) =>
    `<div class="ures-leg" title="${w.titulo}">${ponto(w)}<b style="color:${barColor(w.pct)}">${pctText(w.pct)}%</b></div>`).join("");
  // Complemento para quando o gráfico está ligado: a conta completa fica alta, e o
  // resumo mostra o reset de cada janela no espaço que sobraria vazio. Com o
  // gráfico desligado ele encolhe junto com os gráficos (ver `.ures-extra` no CSS).
  // Uma linha por janela, para não passar da altura dos blocos com gráfico; o
  // horário/data exatos ficam no tooltip dela.
  const extra = wins.map((w) => {
    const reset = w.reset
      ? `<div class="ures-det-l" title="${escapeHtml(w.quando)}">Reset em <span class="u-remain" data-reset="${escapeHtml(w.reset)}">${fmtRemaining(w.reset)}</span></div>`
      : '<div class="ures-det-l">Sem horário de reset.</div>';
    return `<div class="ures-det"><div class="ures-det-t">${ponto(w)}${w.titulo}</div>${reset}</div>`;
  }).join("");
  return `<div class="ures ucol-resumo">${nome}<div class="ures-aneis">${aneis(wins)}<div class="ures-legs">${legenda}</div></div>` +
    `<div class="ures-extra">${extra}</div></div>`;
}

/// Card de um provedor. Com uma conta, o corpo é o dela, como sempre. Com duas, o
/// corpo tem duas colunas fixas (a principal à esquerda, a outra à direita), e cada
/// uma traz as duas formas da conta: a completa e o resumo. A conta mostrada fica
/// com a coluna larga e a forma completa; a outra, com a estreita e o resumo.
/// Trocar de conta só inverte as larguras (ver `trocaConta`). O ícone do cabeçalho
/// é o do provedor (Claude = spark; Codex = logo do Codex).
function renderCard(g: Grupo): string {
  const atual = contaAtual(g);
  const corpo = corpoConta(atual);
  const label = NOMES[g.provedor];
  const icon = g.provedor === "codex" ? iconCodex() : ICON_CLAUDE;
  // No modo reordenar, o card fica arrastável e ganha uma alça no cabeçalho.
  const grip = reordering ? '<span class="uprov-grip" aria-hidden="true">⠿</span>' : "";
  let conteudo = corpo.html;
  if (g.contas.length > 1) {
    const ordem = colunas(g);
    // Conta cujo corpo é só um aviso (erro, sem dado): a moldura passa a ser a
    // própria coluna (`.painel`), e não cada forma. Assim, na troca, é o mesmo
    // container que cresce ou encolhe com a coluna, e só o conteúdo dele se cruza
    // (resumo ↔ aviso completo), em vez de um bloco apagar e outro surgir.
    const cols = ordem.map((c) => {
      const cc = corpoConta(c);
      const painel = cc.nota ? ` painel${cc.estado === "error" ? " error" : ""}` : "";
      return `<div class="ucol${c === atual ? " larga" : ""}${painel}" data-conta="${escapeHtml(c.chave)}">` +
        `<div class="ucol-full">${cc.html}</div>${resumoConta(c)}</div>`;
    }).join("");
    conteudo = `<div class="ucontas">${cols}</div>`;
  }
  return `<div class="uprov${corpo.estado ? " " + corpo.estado : ""}" data-provedor="${g.provedor}"${reordering ? ' draggable="true"' : ""}>
    <div class="uprov-head">
      <div class="uprov-name">${grip}${icon} ${label}</div>
      <div class="uprov-meta"><span class="uprov-selo">${corpo.selo}</span>${seletorConta(g, atual)}</div>
    </div>
    <div class="uprov-corpo">${conteudo}</div>
  </div>`;
}

/// O apelido do cabeçalho acompanha o sentido da troca: indo para a direita, o
/// novo entra pela direita e o antigo sai pela esquerda (e o contrário). A caixa
/// dos rótulos recorta os dois, que não passam por cima das setas. O antigo já
/// está com `visibility: hidden` pelo CSS; a animação o mantém visível enquanto sai.
function animaRotulos(
  card: HTMLElement,
  sai: HTMLElement | null,
  entra: HTMLElement | null,
  dir: -1 | 1,
  opts: KeyframeAnimationOptions,
): Animation[] {
  const caixa = card.querySelector<HTMLElement>(".uconta-rotulos");
  if (!caixa || !sai || !entra || sai === entra) return [];
  const d = caixa.offsetWidth;
  return [
    sai.animate([
      { visibility: "visible", opacity: 1, transform: "none" },
      { visibility: "visible", opacity: 0, transform: `translateX(${-dir * d}px)` },
    ], opts),
    entra.animate([
      { opacity: 0, transform: `translateX(${dir * d}px)` },
      { opacity: 1, transform: "none" },
    ], opts),
  ];
}

/// Duração e curva da troca de conta. A mesma curva da pílula das abas.
const TROCA_MS = 420;
const TROCA_EASE = "cubic-bezier(.32,.72,.35,1)";

/// Leva o card para a conta da esquerda (`-1`) ou da direita (`1`). Sem render
/// geral: as duas contas já estão no card, então basta inverter as larguras das
/// colunas e animar a passagem:
/// - a largura de cada coluna, medida antes e depois: a divisória anda, a coluna
///   que cresce revela a forma completa e a que encolhe a recorta;
/// - as formas: a que sai apaga na primeira metade, a que entra acende na segunda,
///   sem as duas ficarem meio transparentes uma sobre a outra;
/// - a altura, que muda quando as contas têm corpos de tamanhos diferentes (ex.:
///   erro vs. as duas janelas).
/// É por JS, e não por transição de CSS, porque a transição de largura de trilho
/// do grid não anima em todo WebView: as colunas trocavam de uma vez.
function trocaConta(card: HTMLElement, dir: -1 | 1): void {
  if (!DATA || trocando) return;
  const g = agrupa(DATA.contas).find((x) => x.provedor === card.dataset.provedor);
  if (!g || g.contas.length < 2) return;
  const ordem = colunas(g);
  const j = ordem.indexOf(contaAtual(g)) + dir;
  if (j < 0 || j >= ordem.length) return;
  const nova = ordem[j];
  selecionada.set(g.provedor, nova.chave);
  const corpo = corpoConta(nova);

  // Cabeçalho: estado do card, selo, rótulo e quais setas valem.
  card.classList.remove("error", "disabled");
  if (corpo.estado) card.classList.add(corpo.estado);
  (card.querySelector(".uprov-selo") as HTMLElement).innerHTML = corpo.selo;
  const rotulos = [...card.querySelectorAll<HTMLElement>(".uprov-conta[data-conta]")];
  const rotuloSai = rotulos.find((r) => r.classList.contains("on")) ?? null;
  const rotuloEntra = rotulos.find((r) => r.dataset.conta === nova.chave) ?? null;
  rotulos.forEach((r) => r.classList.toggle("on", r === rotuloEntra));
  card.querySelectorAll<HTMLButtonElement>(".uconta-seta").forEach((b) => {
    b.disabled = b.dataset.dir === "-1" ? j === 0 : j === ordem.length - 1;
  });
  // A seta clicada fica desabilitada e perde o foco: ele passa para a outra, que
  // é a próxima ação possível.
  card.querySelector<HTMLButtonElement>(".uconta-seta:not(:disabled)")?.focus();

  const grade = card.querySelector(".ucontas") as HTMLElement;
  const cols = [...grade.querySelectorAll<HTMLElement>(".ucol")];
  // As formas visíveis agora: são as que vão sair.
  const visiveis = (): HTMLElement[] =>
    cols.map((col) => col.querySelector<HTMLElement>(col.classList.contains("larga") ? ".ucol-full" : ".ucol-resumo")!);
  const saem = visiveis();
  const h0 = grade.offsetHeight;
  const w0 = cols.map((col) => col.offsetWidth);
  cols.forEach((col) => col.classList.toggle("larga", col.dataset.conta === nova.chave));
  const entram = visiveis();
  const h1 = grade.offsetHeight;
  const w1 = cols.map((col) => col.offsetWidth);

  // "Reduzir movimento" do sistema: a troca fica instantânea. A regra global do CSS
  // não alcança animações feitas por JS (Web Animations).
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  trocando = true;
  const opts: KeyframeAnimationOptions = { duration: TROCA_MS, easing: TROCA_EASE };
  const animacoes = [
    grade.animate([{ height: `${h0}px` }, { height: `${h1}px` }], opts),
    ...cols.map((col, k) => col.animate([{ width: `${w0[k]}px` }, { width: `${w1[k]}px` }], opts)),
    // O CSS já deixou quem sai invisível e quem entra visível: as animações partem
    // do estado anterior no mesmo quadro, então nada pisca. `backwards` segura quem
    // entra apagado durante o atraso.
    ...saem.map((f) => f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TROCA_MS * 0.45, easing: "ease-out" })),
    ...entram.map((f) => f.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: TROCA_MS * 0.55, delay: TROCA_MS * 0.35, easing: "ease-in-out", fill: "backwards",
    })),
    ...animaRotulos(card, rotuloSai, rotuloEntra, dir, opts),
  ];
  const fim = (): void => {
    trocando = false;
    // Um render que chegou durante a troca foi adiado: aplica agora.
    render();
  };
  void Promise.all(animacoes.map((a) => a.finished)).then(fim, fim);
}

/// Timestamp de coleta mais recente entre as contas habilitadas com dado válido
/// (todas coletam no mesmo ciclo, então normalmente coincidem). `null` quando
/// nenhuma conta tem dado coletado ainda.
function freshestCollected(): string | null {
  if (!DATA) return null;
  let best: string | null = null;
  for (const prov of DATA.contas) {
    const m = prov.metric;
    if (!prov.habilitado || !m || m.status === "erro" || m.erro || !m.coletado_em) continue;
    if (best === null || new Date(m.coletado_em).getTime() > new Date(best).getTime()) {
      best = m.coletado_em;
    }
  }
  return best;
}

/// Subtítulo da página: "atualizado há…" do dado em cache (antes ficava em cada
/// card). Vazio quando ainda não há coleta válida.
function renderSub(): void {
  const iso = freshestCollected();
  el("usage-sub").innerHTML = iso
    ? `<span class="u-fresh" data-collected="${escapeHtml(iso)}">${fmtFresh(iso)}</span>`
    : "";
}

/// Atualiza só os textos dependentes do tempo (contagem regressiva e frescor),
/// sem reconstruir os cards — chamado a cada segundo.
function tick(): void {
  el("view-usage").querySelectorAll<HTMLElement>(".u-remain[data-reset]").forEach((n) => {
    n.textContent = fmtRemaining(n.dataset.reset as string);
  });
  el("view-usage").querySelectorAll<HTMLElement>(".u-fresh[data-collected]").forEach((n) => {
    n.textContent = fmtFresh(n.dataset.collected as string);
  });
}

/// Assinatura barata do snapshot para decidir se vale reconstruir os cards.
/// Cobre o que muda o desenho: pausa, a ordem e o rótulo dos cards, habilitado,
/// a métrica de cada conta e o tamanho/última amostra de cada série do histórico.
function signature(d: Usage): string {
  const m = (x: UsageMetric | null): string =>
    x ? `${x.coletado_em}|${x.uso_percentual ?? ""}|${x.uso_percentual_7d ?? ""}|${x.status}|${x.erro ?? ""}` : "none";
  const h = (s?: HistPoint[]): string => (s && s.length ? `${s.length}:${s[s.length - 1].t}` : "0");
  return [
    d.paused, d.chartEnabled !== false, reordering,
    ...d.contas.map((c) =>
      [c.chave, c.rotulo ?? "", c.habilitado, m(c.metric), h(c.history?.session), h(c.history?.weekly)].join("|")),
  ].join("~");
}

/// Liga o hover de cada mini-gráfico: um guia vertical + ponto no valor mais
/// próximo do cursor e o tooltip global (#tip). Reutiliza `placeFixed` dos
/// dashboards. Chamado após cada reconstrução dos cards.
function wireCharts(): void {
  const tip = el("tip");
  el("usage-cards").querySelectorAll<SVGSVGElement>(".uchart-svg").forEach((svg) => {
    const host = svg.closest(".uchart") as HTMLElement | null;
    const info = host?.dataset.key ? CHARTS.get(host.dataset.key) : undefined;
    if (!info || info.pts.length === 0) return;
    const guide = svg.querySelector<SVGLineElement>(".uchart-guide");
    const dot = svg.querySelector<SVGCircleElement>(".uchart-dot");
    svg.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      // Cursor → x em unidades do viewBox; acha o ponto mais próximo por |x| (a
      // área de plotagem começa após a régua Y, então comparar por x é o correto).
      const ux = rect.width ? ((e.clientX - rect.left) / rect.width) * svg.viewBox.baseVal.width : 0;
      let i = 0;
      let best = Infinity;
      for (let k = 0; k < info.pts.length; k++) {
        const d = Math.abs(info.pts[k].x - ux);
        if (d < best) { best = d; i = k; }
      }
      const c = info.pts[i];
      guide?.setAttribute("x1", String(c.x));
      guide?.setAttribute("x2", String(c.x));
      guide?.setAttribute("visibility", "visible");
      dot?.setAttribute("cx", String(c.x));
      dot?.setAttribute("cy", String(c.y));
      dot?.setAttribute("visibility", "visible");
      tip.innerHTML =
        `<div class="th">${escapeHtml(info.label)} · ${fmtTime(c.p.t)}</div>` +
        `<div class="tr"><span class="dot" style="background:${barColor(c.p.pct)}"></span>Uso<b>${pctText(c.p.pct)}%</b></div>`;
      tip.classList.remove("hide");
      placeFixed(tip, e.clientX, e.clientY);
    });
    svg.addEventListener("mouseleave", () => {
      tip.classList.add("hide");
      guide?.setAttribute("visibility", "hidden");
      dot?.setAttribute("visibility", "hidden");
    });
  });
}

/// Verdadeiro enquanto o aviso de desligar o gráfico está na tela. Nesse intervalo
/// o switch mostra a INTENÇÃO do usuário (desligado) e o `render()` periódico não
/// pode reescrevê-lo com o estado ainda salvo no config — era o que o fazia voltar
/// sozinho para ligado, segundos depois do clique, com o diálogo ainda aberto.
/// Quem o devolve para ligado é o cancelamento.
let confirmandoGrafico = false;

/// Mostra ou esconde os mini-gráficos. A classe mora no contêiner dos cards
/// justamente porque ele sobrevive ao re-render: é assim que a transição roda ao
/// trocar o switch sem que nada anime quando os cards são reconstruídos.
function aplicaGrafico(): void {
  el("usage-cards").classList.toggle("sem-grafico", DATA?.chartEnabled === false);
}

function render(): void {
  if (!DATA) return;
  // Sincroniza o toggle do cabeçalho com o estado atual (antes da guarda, para
  // refletir mudanças de config feitas por fora também).
  const cb = document.getElementById("usage-chart-toggle") as HTMLInputElement | null;
  if (cb && !confirmandoGrafico) cb.checked = DATA.chartEnabled !== false;
  // Antes do innerHTML abaixo: os cards novos já nascem no estado certo, em vez
  // de nascerem abertos e fechar num segundo momento.
  aplicaGrafico();
  // Uma troca de conta animando: reconstruir agora cortaria o movimento. Ela chama
  // o render de novo ao terminar.
  if (trocando) return;
  // Reconstrói os cards só quando os dados mudam; entre reloads iguais (a cada 2s)
  // apenas roda o tick, preservando o hover do gráfico e poupando trabalho.
  const sig = signature(DATA);
  if (sig === lastSig) { tick(); return; }
  lastSig = sig;

  el("usage-banner").innerHTML = DATA.paused
    ? '<div class="ubanner">⏸ Envio ao Loki pausado. Os dados continuam sendo coletados e exibidos aqui; retome o envio na tela "Envio de dados" ou no menu do tray.</div>'
    : "";
  CHARTS.clear();
  el("usage-cards").classList.toggle("reordering", reordering);
  el("usage-cards").innerHTML = agrupa(DATA.contas).map(renderCard).join("");
  renderSub();
  el("usage-foot").textContent = "";
  wireCharts();
  tick();
}

/// Só no `npm run tauri dev`: troca os dados pelos do cenário de simulação escolhido
/// no cabeçalho (ver usage-sim.ts). Nulo no build de release.
let simula: ((dados: Usage) => Usage) | null = null;
let simulando: (() => boolean) | null = null;

/// Busca o snapshot pelo IPC e re-renderiza. Barata (sem rede no backend).
export async function loadUsage(): Promise<void> {
  try {
    DATA = await invoke<Usage>("get_usage");
    if (simula) DATA = simula(DATA);
  } catch (e) {
    el("usage-foot").textContent = "Falha ao carregar uso: " + (e instanceof Error ? e.message : String(e));
    return;
  }
  render();
}

/// Abre o modal de confirmação (aviso de perda de dados). Resolve com
/// `{ dontAskAgain }` ao confirmar, ou `null` ao cancelar (botão, backdrop ou Esc).
function confirmDisableChart(): Promise<{ dontAskAgain: boolean } | null> {
  return new Promise((resolve) => {
    const overlay = el("modal-overlay");
    const dontask = document.getElementById("modal-dontask") as HTMLInputElement;
    const btnOk = document.getElementById("modal-confirm") as HTMLButtonElement;
    const btnCancel = document.getElementById("modal-cancel") as HTMLButtonElement;
    dontask.checked = false;
    overlay.classList.remove("hide");
    const done = (result: { dontAskAgain: boolean } | null): void => {
      overlay.classList.add("hide");
      btnOk.removeEventListener("click", onOk);
      btnCancel.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = (): void => done({ dontAskAgain: dontask.checked });
    const onCancel = (): void => done(null);
    const onBackdrop = (e: MouseEvent): void => { if (e.target === overlay) done(null); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") done(null); };
    btnOk.addEventListener("click", onOk);
    btnCancel.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

/// Liga o toggle do gráfico (cabeçalho da tela). No navegador (dashboards
/// read-only) o comando é bloqueado, então o controle fica escondido. No app,
/// alternar persiste em `config.usoAtual.grafico` e reflete na hora: mostra/esconde
/// o gráfico e, ao desligar, o backend limpa o histórico em memória. Ao desligar,
/// se o aviso estiver ativo, confirma antes (com "Não perguntar novamente").
function bindChartToggle(): void {
  const label = document.getElementById("usage-chart-label");
  const cb = document.getElementById("usage-chart-toggle") as HTMLInputElement | null;
  if (!label || !cb) return;
  if (!isTauri) { label.style.display = "none"; return; }
  cb.addEventListener("change", async () => {
    const enabling = cb.checked;
    try {
      if (!enabling && DATA?.chartWarnOnDisable !== false) {
        confirmandoGrafico = true;
        let res: { dontAskAgain: boolean } | null;
        try {
          res = await confirmDisableChart();
        } finally {
          confirmandoGrafico = false;
        }
        if (!res) { cb.checked = true; return; } // cancelado: reverte o toggle
        DATA = await invoke<Usage>("set_usage_chart", { enabled: false, dontAskAgain: res.dontAskAgain });
      } else {
        DATA = await invoke<Usage>("set_usage_chart", { enabled: enabling });
      }
      // Sem reconstruir os cards aqui: o gráfico que está saindo precisa continuar
      // no DOM para poder encolher, e ao desligar o backend já limpou o histórico
      // — um re-render agora o trocaria pelo aviso de "coletando", de um quadro
      // para o outro. A reconstrução vem na próxima coleta e já encontra tudo no
      // estado certo (`chartEnabled` faz parte da assinatura).
      aplicaGrafico();
    } catch (e) {
      cb.checked = DATA?.chartEnabled !== false; // reverte o visual em caso de erro
      el("usage-foot").textContent =
        "Falha ao alterar o gráfico: " + (e instanceof Error ? e.message : String(e));
    }
  });
}

/// Liga o botão "Reordenar" (cabeçalho, junto do switch) e o arrastar-e-soltar dos
/// cards. Só no app (no navegador o comando é bloqueado, então o botão some).
/// Ativar o modo torna os cards arrastáveis; ao soltar, persiste a nova ordem —
/// uma config que também reordena o widget e a barra de tarefas.
function bindReorder(): void {
  const btn = document.getElementById("usage-reorder-btn");
  const cards = document.getElementById("usage-cards");
  if (!btn || !cards) return;
  if (!isTauri) { btn.style.display = "none"; return; }

  btn.addEventListener("click", () => {
    reordering = !reordering;
    btn.classList.toggle("on", reordering);
    lastSig = "";
    render();
  });

  let draggedKey: string | null = null;
  const clearMarks = (): void => {
    cards.querySelectorAll(".uprov.dragging, .uprov.drop-target")
      .forEach((n) => n.classList.remove("dragging", "drop-target"));
  };
  const cardAt = (e: Event): HTMLElement | null =>
    (e.target as HTMLElement).closest(".uprov") as HTMLElement | null;

  cards.addEventListener("dragstart", (e) => {
    if (!reordering) return;
    const card = cardAt(e);
    if (!card) return;
    draggedKey = card.dataset.provedor ?? null;
    card.classList.add("dragging");
    (e as DragEvent).dataTransfer?.setData("text/plain", draggedKey ?? "");
  });
  cards.addEventListener("dragover", (e) => {
    if (!reordering || !draggedKey) return;
    e.preventDefault(); // habilita o drop
    const card = cardAt(e);
    cards.querySelectorAll(".uprov.drop-target").forEach((n) => n.classList.remove("drop-target"));
    if (card && card.dataset.provedor !== draggedKey) card.classList.add("drop-target");
  });
  cards.addEventListener("dragend", clearMarks);
  cards.addEventListener("drop", (e) => {
    if (!reordering || !draggedKey || !DATA) return;
    e.preventDefault();
    const targetKey = cardAt(e)?.dataset.provedor;
    const dragged = draggedKey;
    draggedKey = null;
    clearMarks();
    if (!targetKey || targetKey === dragged) return;
    if (simulando?.()) {
      el("usage-foot").textContent = "Reordenar não grava durante a simulação.";
      return;
    }
    // Move o provedor arrastado para a posição do alvo, usando os índices da ordem
    // ORIGINAL (remove na origem e insere no índice do alvo). Para 2 itens vira uma
    // troca; para N, uma reordenação correta nos dois sentidos.
    const grupos = agrupa(DATA.contas);
    const provedores = grupos.map((g) => g.provedor as string);
    const from = provedores.indexOf(dragged);
    const to = provedores.indexOf(targetKey);
    if (from < 0 || to < 0 || from === to) return;
    const [movido] = grupos.splice(from, 1);
    grupos.splice(to, 0, movido);
    // A ordem salva é por conta: cada provedor leva as contas dele juntas, na ordem
    // em que já estavam (a das setas).
    void applyOrder(grupos.flatMap((g) => g.contas.map((c) => c.chave)));
  });
}

/// Persiste a nova ordem no backend e re-renderiza.
async function applyOrder(order: string[]): Promise<void> {
  try {
    DATA = await invoke<Usage>("set_contas_ordem", { order });
    lastSig = "";
    render();
  } catch (err) {
    el("usage-foot").textContent =
      "Falha ao reordenar: " + (err instanceof Error ? err.message : String(err));
  }
}

/// Liga os eventos (uma vez), inicia o tick de 1s e dispara o primeiro load.
export function initUsage(): void {
  if (initialized) { void loadUsage(); return; }
  initialized = true;

  bindChartToggle();
  bindReorder();
  // Simulação de contas para avaliar o layout. `import.meta.env.DEV` é falso no
  // build de release: o Vite descarta este ramo e o módulo nem entra no pacote.
  if (import.meta.env.DEV) {
    void import("./usage-sim").then((sim) => {
      simula = sim.aplica;
      simulando = sim.ativa;
      sim.montaSeletor(() => {
        selecionada.clear();
        void loadUsage();
      });
      void loadUsage();
    });
  }
  // Setas "‹ Apelido ›" do cabeçalho: alternam a conta do card. Valem também no
  // navegador, onde o reordenar não existe.
  el("usage-cards").addEventListener("click", (e) => {
    const seta = (e.target as HTMLElement).closest<HTMLElement>(".uconta-seta");
    const card = seta?.closest<HTMLElement>(".uprov");
    if (seta && card) trocaConta(card, seta.dataset.dir === "-1" ? -1 : 1);
  });

  // A cada 1s atualiza a contagem regressiva e o frescor (do dado em cache); a
  // cada 2s rebusca o snapshot. O rebusque precisa ser mais frequente que o
  // intervalo de coleta (mín. 5s) para o "atualizado há" subir de forma limpa e
  // zerar a cada coleta real, em vez de saltar de forma errática. Só roda quando
  // a tela está ativa, para não trabalhar à toa. get_usage é barato (sem rede).
  setInterval(() => {
    if (!isActive()) return;
    tick();
    if (++tickCount % 2 === 0) void loadUsage();
  }, 1000);

  void loadUsage();
}