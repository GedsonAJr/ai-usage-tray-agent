// Dashboard de uso do Codex, renderizado na webview nativa. Espelha a estrutura
// da "Dashboard Claude" (cards + gráfico de barras empilhadas + tooltip), mas os
// dados vêm de uma chamada de rede (analytics do backend do ChatGPT) pelo comando
// IPC `get_codex_stats`, e a unidade é PERCENTUAL de uso diário (não tokens).
// A tela carrega ao abrir e refaz a chamada ao trocar o período (30d/7d).
import { animaTrocaDeAba } from "./anima";
import { invoke } from "./ipc";
import { escapeHtml } from "./usage-format";
import { CUSTOM_LABEL, dkey, dayLabel, fmtShort, normalizeRange, placeFixed, setOn } from "./chart-utils";

interface ModelUsage {
  model: string;
  speed: string;
  credits: number;
}
interface CodexDay {
  date: string;
  product_surface_usage_values: Record<string, number>;
  models: ModelUsage[];
}
interface CodexStats {
  units?: string;
  groupBy?: string;
  days: CodexDay[];
  generatedAt: string;
  error?: string;
}
interface Segment {
  key: string;
  label: string;
  color: string;
  val: number;
}
interface Series {
  date: string;
  segments: Segment[];
}

// Geometria do gráfico. O <svg> tem viewBox próprio, então estes valores são
// unidades de usuário, não pixels: ele escala junto com a largura do painel.
const W = 820, H = 260, padL = 52, padB = 26, padT = 10;
const SVGNS = "http://www.w3.org/2000/svg";

const PALETTE = ["#10a37f", "#2f6fed", "#5b8df2", "#86abf6", "#f2a35b", "#c77dff", "#8b949e", "#e06c75", "#56b6c2", "#d19a66", "#98c379", "#6e7681"];

// Rótulos amigáveis das origens (product surfaces) retornadas pela API.
const SURFACE_LABELS: Record<string, string> = {
  cli: "CLI", vscode: "VS Code", web: "Web", slack: "Slack", linear: "Linear",
  jetbrains: "JetBrains", sdk: "SDK", exec: "Exec", github: "GitHub",
  desktop_app: "Desktop", github_code_review: "Code Review",
  agent_identity: "Agent", unknown: "Outros",
};

let DATA: CodexStats | null = null;
let days = 30; // janela do preset (refaz a chamada ao trocar)
let customFrom = "";
let customTo = "";
let customActive = false; // range personalizado aplicado (envia start/end)
let customOpen = false; // popover de datas aberto
let tab = "geral"; // geral | surfaces | modelos
/// Cresce a cada pedido de carga. A resposta só vale se ainda for a do pedido
/// mais recente: assim um pedido novo (trocar de período) nunca é recusado por
/// haver outro em voo — quem se descarta é a resposta velha, que chegou tarde.
let loadSeq = 0;
let CHART_SERIES: Series[] = [];

const MAX_DAYS = 90; // limite da API do Codex

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function surfaceLabel(key: string): string {
  return SURFACE_LABELS[key] ?? key;
}
function modelLabel(m: ModelUsage): string {
  const name = m.model.replace(/^gpt-/, "GPT-").replace(/^codex-/, "Codex ");
  return m.speed && m.speed !== "standard" ? `${name} (${m.speed})` : name;
}
function pct(n: number): string {
  if (n <= 0) return "0%";
  return (n < 10 ? n.toFixed(1) : Math.round(n).toString()) + "%";
}
const dayTotal = (s: Series) => s.segments.reduce((t, seg) => t + seg.val, 0);

// ----- construção das séries por aba -----
// `forTab` permite construir as séries de uma aba específica (usado pelos cards
// de "predominantes") sem mexer no estado global `tab`; o padrão é a aba atual.
function buildSeries(forTab: string = tab): Series[] {
  if (!DATA) return [];
  if (forTab === "modelos") {
    const colorByKey = new Map<string, string>();
    let next = 0;
    return DATA.days.map((d) => ({
      date: d.date,
      segments: (d.models ?? [])
        .filter((m) => m.credits > 0)
        .map((m) => {
          const key = m.model + "|" + m.speed;
          if (!colorByKey.has(key)) colorByKey.set(key, PALETTE[next++ % PALETTE.length]);
          return { key, label: modelLabel(m), color: colorByKey.get(key)!, val: m.credits };
        })
        .sort((a, b) => b.val - a.val),
    }));
  }
  if (forTab === "surfaces") {
    // cor estável por surface (ordem fixa da PALETTE pela ordem de SURFACE_LABELS)
    const order = Object.keys(SURFACE_LABELS);
    const colorByKey = (k: string) => PALETTE[Math.max(0, order.indexOf(k)) % PALETTE.length];
    return DATA.days.map((d) => ({
      date: d.date,
      segments: Object.entries(d.product_surface_usage_values ?? {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({ key: k, label: surfaceLabel(k), color: colorByKey(k), val: v }))
        .sort((a, b) => b.val - a.val),
    }));
  }
  // geral: total diário em um único segmento
  return DATA.days.map((d) => {
    const total = (d.models ?? []).reduce((t, m) => t + m.credits, 0);
    return {
      date: d.date,
      segments: total > 0 ? [{ key: "total", label: "Uso", color: PALETTE[0], val: total }] : [],
    };
  });
}

// agregados por chave (legenda + predominante)
function aggregate(series: Series[]): { key: string; label: string; color: string; total: number }[] {
  const acc = new Map<string, { label: string; color: string; total: number }>();
  for (const s of series) for (const seg of s.segments) {
    const e = acc.get(seg.key) ?? { label: seg.label, color: seg.color, total: 0 };
    e.total += seg.val;
    acc.set(seg.key, e);
  }
  return [...acc.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.total - a.total);
}

function renderCards(series: Series[]): void {
  const totals = series.map(dayTotal);
  const active = totals.filter((t) => t > 0);
  const activeDays = active.length;
  const sum = totals.reduce((a, b) => a + b, 0);
  const avg = activeDays ? sum / activeDays : 0;
  let peakIdx = -1, peakVal = 0;
  totals.forEach((t, i) => { if (t > peakVal) { peakVal = t; peakIdx = i; } });

  // predominantes por surface e por modelo (independente da aba atual)
  const topSurface = aggregate(buildSeries("surfaces"))[0];
  const topModel = aggregate(buildSeries("modelos"))[0];

  const cards: [string, string][] = [
    ["Dias ativos", String(activeDays)],
    ["Uso médio/dia", pct(avg)],
    ["Dia de pico", peakIdx >= 0 ? dayLabel(series[peakIdx].date) : "–"],
    ["Maior uso", pct(peakVal)],
    ["Origem principal", escapeHtml(topSurface?.label ?? "–")],
    ["Modelo principal", escapeHtml(topModel?.label ?? "–")],
  ];
  el("codex-cards").innerHTML = cards
    .map(([l, v]) => '<div class="card"><div class="lbl">' + l + '</div><div class="val">' + v + "</div></div>")
    .join("");
}

/// Painel que envolve o conteúdo: é a altura dele que acompanha a troca de aba
/// e a de período.
const painelCodex = (): HTMLElement => document.querySelector("#view-codex-dashboard > .panel") as HTMLElement;

/// Duração da transição das barras. Casada com a regra de #codex-barras no CSS:
/// serve para saber quando uma barra que saiu de cena já pode ser removida.
const BARRA_MS = 300;

/// Barras em cena, indexadas pela POSIÇÃO na pilha ("dia:índice do segmento").
/// É o que permite reaproveitá-las entre renders em vez de recriar o gráfico.
let barras = new Map<string, SVGRectElement>();

/// Monta o <svg> vazio e liga os eventos do tooltip. Só roda quando não há
/// gráfico na tela: na primeira carga e depois do skeleton ou de uma mensagem de
/// vazio/erro, que substituem o conteúdo inteiro de #codex-chart.
function criaChart(): void {
  // O eixo Y não se move nunca: cada marca vale uma fração de maxY, então fica
  // sempre a 1/4, 2/4... da área útil, seja qual for a escala. De um render para
  // outro mudam só os rótulos.
  let grade = "";
  for (let t = 1; t <= 4; t++) {
    const y = H - padB - (t / 4) * (H - padB - padT);
    grade += '<rect x="' + padL + '" y="' + y + '" width="' + (W - padL) + '" height="1" fill="#34322d"/>' +
      '<text class="ytick" x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end"></text>';
  }
  el("codex-chart").innerHTML =
    '<svg id="codex-chartsvg" viewBox="0 0 ' + W + " " + H + '" style="width:100%;margin-top:14px">' +
    '<g id="codex-grade">' + grade + '</g><g id="codex-dias"></g>' +
    '<rect id="codex-hl" fill="rgba(255,255,255,0.06)" rx="3" visibility="hidden"/>' +
    '<g id="codex-barras"></g><g id="codex-faixas"></g></svg>';
  barras = new Map();

  const svg = el("codex-chartsvg");
  const hl = el("codex-hl");
  const tip = el("tip");
  svg.addEventListener("mousemove", (e) => {
    const band = (e.target as HTMLElement).closest(".band");
    if (!band) { tip.classList.add("hide"); hl.setAttribute("visibility", "hidden"); return; }
    const i = Number((band as HTMLElement).dataset.i);
    const s = CHART_SERIES[i];
    hl.setAttribute("x", band.getAttribute("x")!);
    hl.setAttribute("y", band.getAttribute("y")!);
    hl.setAttribute("width", band.getAttribute("width")!);
    hl.setAttribute("height", band.getAttribute("height")!);
    hl.setAttribute("visibility", "visible");
    tip.innerHTML = '<div class="th">' + dayLabel(s.date) + "</div>" +
      s.segments.map((seg) => '<div class="tr"><span class="dot" style="background:' + seg.color + '"></span>' +
        escapeHtml(seg.label) + "<b>" + pct(seg.val) + "</b></div>").join("");
    tip.classList.remove("hide");
    placeFixed(tip, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => { tip.classList.add("hide"); hl.setAttribute("visibility", "hidden"); });
}

/// Escreve a geometria e a cor de uma barra. São atributos de apresentação, que
/// o CSS enxerga como propriedades — é por isso que a transição pega neles.
function poeBarra(r: SVGRectElement, x: number, y: number, w: number, h: number, cor: string): void {
  r.setAttribute("x", String(x));
  r.setAttribute("y", String(y));
  r.setAttribute("width", String(w));
  r.setAttribute("height", String(h));
  r.setAttribute("fill", cor);
}

/// Leva as barras em cena até o estado novo. A chave é a POSIÇÃO na pilha, não a
/// identidade do segmento: assim a fatia de baixo do dia 3 vira a fatia de baixo
/// nova, em vez de as duas se cruzarem no caminho.
function desenhaBarras(series: Series[], maxY: number, step: number, bw: number, semAnimar: boolean): void {
  const grupo = el("codex-barras");
  const vivas = new Set<string>();
  series.forEach((s, i) => {
    let y = H - padB;
    const x = padL + i * step + (step - bw) / 2;
    let j = 0;
    for (const seg of s.segments) {
      if (seg.val <= 0) continue;
      const h = (seg.val / maxY) * (H - padB - padT);
      y -= h;
      const chave = i + ":" + j++;
      vivas.add(chave);
      let r = barras.get(chave);
      if (!r) {
        r = document.createElementNS(SVGNS, "rect");
        r.setAttribute("rx", "1.5");
        // Nasce rente à linha de base e sem altura, para CRESCER até o lugar. O
        // reflow fixa esse estado de partida; sem ele o navegador só enxergaria
        // o estado final e a barra apareceria pronta.
        poeBarra(r, x, H - padB, bw, 0, seg.color);
        grupo.appendChild(r);
        barras.set(chave, r);
        if (!semAnimar) void r.getBoundingClientRect();
      }
      poeBarra(r, x, y, bw, h, seg.color);
    }
  });
  // Sobras (a aba nova reparte o dia em menos fatias): encolhem até a base e só
  // então saem do DOM.
  for (const [chave, r] of barras) {
    if (vivas.has(chave)) continue;
    barras.delete(chave);
    r.setAttribute("y", String(H - padB));
    r.setAttribute("height", "0");
    window.setTimeout(() => r.remove(), BARRA_MS + 60);
  }
}

/// Redesenha o gráfico NO MESMO <svg> sempre que já houver um em cena: as barras
/// são reaproveitadas e levadas por transição até os valores novos. Recriar a
/// marcação a cada troca de aba apagava o gráfico inteiro num quadro e o novo
/// nascia pronto — sem nada se movendo entre os dois estados, isso se lê como uma
/// piscada. Trocar de aba não mexe no período, então as colunas seguem no mesmo
/// x e o que a transição mostra é exatamente o que mudou: como cada dia se
/// reparte entre origens ou entre modelos.
function renderChart(series: Series[]): void {
  CHART_SERIES = series;
  const primeiro = !document.getElementById("codex-chartsvg");
  if (primeiro) criaChart();

  const maxY = Math.max(1, ...series.map(dayTotal));
  const innerW = W - padL - 8;
  const step = innerW / Math.max(1, series.length);
  const bw = Math.max(2, Math.min(22, step - 3));

  document.querySelectorAll("#codex-grade .ytick").forEach((n, i) => {
    n.textContent = Math.round((maxY / 4) * (i + 1)) + "%";
  });

  // Eixo X (~6 rótulos) e faixas de hover dependem só do período, que a troca de
  // aba não altera — recriá-los não produz diferença visível.
  const every = Math.max(1, Math.floor(series.length / 6));
  el("codex-dias").innerHTML = series.map((s, i) =>
    i % every !== 0 ? "" :
      '<text x="' + (padL + i * step) + '" y="' + (H - 8) + '">' + dayLabel(s.date) + "</text>").join("");
  el("codex-faixas").innerHTML = series.map((s, i) =>
    dayTotal(s) <= 0 ? "" :
      '<rect class="band" data-i="' + i + '" x="' + (padL + i * step) + '" y="' + padT +
      '" width="' + step + '" height="' + (H - padT - padB) + '" fill="transparent"/>').join("");

  desenhaBarras(series, maxY, step, bw, primeiro);

  // legenda (oculta na visão geral, que tem só um segmento)
  const legend = el("codex-legend");
  if (tab === "geral") { legend.innerHTML = ""; return; }
  const agg = aggregate(series);
  const grand = agg.reduce((a, b) => a + b.total, 0) || 1;
  legend.innerHTML = agg.map((a) =>
    '<div class="lrow"><div class="dot" style="background:' + a.color + '"></div>' +
    "<div>" + escapeHtml(a.label) + "</div>" +
    '<div class="io">' + pct(a.total) + " acum.</div>" +
    '<div class="pct">' + ((a.total / grand) * 100).toFixed(1) + "%</div></div>"
  ).join("");
}

function render(): void {
  if (!DATA) return;
  el("codex-foot").textContent = "Atualizado " + new Date(DATA.generatedAt).toLocaleTimeString("pt-BR");
  // A API devolve dias zerados quando não houve uso; mostra um estado vazio
  // amigável em vez de um gráfico achatado.
  const hasUsage = DATA.days.some((d) =>
    (d.models ?? []).some((m) => m.credits > 0) ||
    Object.values(d.product_surface_usage_values ?? {}).some((v) => v > 0));
  el("codex-view-geral").classList.toggle("hide", tab !== "geral");
  if (!hasUsage) {
    renderMessage("Nenhum uso do Codex neste período.");
    return;
  }
  const series = buildSeries();
  if (tab === "geral") renderCards(series);
  renderChart(series);
}

// ----- range de data personalizado (popover) -----
function setCustomOpen(open: boolean): void {
  customOpen = open;
  el("codex-range-custom").classList.toggle("hide", !open);
}
// Range normalizado lendo o estado deste módulo; a lógica pura vive em
// chart-utils (normalizeRange).
function customRange(): { from: string; to: string } {
  return normalizeRange(customFrom, customTo);
}
// Pré-preenche os campos (últimos 30 dias) e limita o seletor à janela suportada
// pelo Codex: dos últimos 90 dias até hoje.
function prefillCustomInputs(): void {
  const from = el("codex-range-from") as HTMLInputElement;
  const to = el("codex-range-to") as HTMLInputElement;
  const minD = new Date(); minD.setDate(minD.getDate() - (MAX_DAYS - 1));
  const min = dkey(minD), max = dkey(new Date());
  from.min = to.min = min;
  from.max = to.max = max;
  if (!to.value) to.value = max;
  if (!from.value) {
    const d = new Date(); d.setDate(d.getDate() - 29);
    let f = dkey(d);
    if (f < min) f = min;
    from.value = f;
  }
}
function updateApplyState(): void {
  const from = el("codex-range-from") as HTMLInputElement;
  const to = el("codex-range-to") as HTMLInputElement;
  (el("codex-range-apply") as HTMLButtonElement).disabled = !(from.value && to.value);
}

// Skeleton (shimmer) enquanto a chamada de rede não volta — substitui o antigo
// texto "Carregando…" no rodapé.
function renderLoading(): void {
  el("codex-cards").innerHTML = Array.from({ length: 6 }, () =>
    '<div class="card skel"><div class="skel-line lbl"></div><div class="skel-line val"></div></div>').join("");
  el("codex-chart").innerHTML = '<div class="codex-skel-chart"></div>';
  el("codex-legend").innerHTML = "";
}

// Mensagem ocupando a área do conteúdo (vazio ou erro).
function renderMessage(text: string, isError = false): void {
  el("codex-cards").innerHTML = "";
  el("codex-legend").innerHTML = "";
  el("codex-chart").innerHTML = '<div class="codex-empty' + (isError ? " err" : "") + '">' + escapeHtml(text) + "</div>";
}

/// Busca os dados pelo IPC (chamada de rede) e re-renderiza. Mostra um skeleton
/// durante a chamada porque, diferente do Claude, aqui há latência de rede.
///
/// Pedidos simultâneos são resolvidos por `loadSeq`, e não recusados. Recusar
/// enquanto havia outro em voo descartava em silêncio justamente o pedido novo:
/// o botão do período já tinha trocado de estado no clique, então a tela ficava
/// mostrando um período e os dados de outro, até alguma carga seguinte acertar.
/// E nem sempre havia um pedido visível para culpar — a janela recarrega a seção
/// ativa ao ganhar foco, sem skeleton, então bastava voltar para o app e clicar.
export async function loadCodexDashboard(opts?: { skeleton?: boolean }): Promise<void> {
  const seq = ++loadSeq;
  // Quem passa `skeleton` explícito é uma troca de período pedida pelo usuário, e
  // é só nela que a altura do painel acompanha — nos DOIS saltos, o conteúdo
  // dando lugar ao skeleton e o skeleton dando lugar aos dados novos. Na 1ª carga
  // não há de onde partir, e o refresh de fundo (foco da janela) não deveria
  // mexer na tela. Sem fade em nenhum caso: a aba continua a mesma.
  const anima = opts?.skeleton === true;
  const passo = (fn: () => void): void => {
    if (anima) animaTrocaDeAba(painelCodex(), fn);
    else fn();
  };

  // Skeleton só na 1ª carga ou em ação explícita (troca de período/aplicar range).
  // Em refresh de fundo (foco/resize da janela) mantém o conteúdo atual para não
  // piscar o skeleton.
  if (opts?.skeleton ?? !DATA) {
    passo(() => {
      renderLoading();
      el("codex-foot").textContent = "";
    });
  }
  // Os argumentos saem do estado do módulo AGORA, antes do await: o clique que
  // pediu esta carga já gravou o período nele.
  let dados: CodexStats;
  try {
    const range = customRange();
    const args = customActive ? { days, start: range.from, end: range.to } : { days };
    dados = await invoke<CodexStats>("get_codex_stats", args);
  } catch (e) {
    // Uma falha que chegou tarde não pode apagar o que o pedido novo já pintou.
    if (seq !== loadSeq) return;
    const falha = "Falha ao carregar dados: " + (e instanceof Error ? e.message : String(e));
    passo(() => renderMessage(falha, true));
    return;
  }
  if (seq !== loadSeq) return;
  DATA = dados;
  const erro = dados.error;
  if (erro) {
    passo(() => renderMessage(erro, true));
    return;
  }
  passo(render);
}

let initialized = false;

/// Troca a aba animando a altura do painel e o fade do painel que entra.
/// Diferente das outras telas, aqui quase nada aparece ou some: só os cards da
/// Visão Geral. O gráfico fica sempre no lugar e se transforma (ver renderChart),
/// e a legenda é texto trocado no lugar — nenhum dos dois leva fade, que só faria
/// apagar conteúdo que já estava na tela.
function trocaAba(nova: string, alvo: EventTarget | null): void {
  // Reclicar a aba que já está aberta não pode refazer nada: sem conteúdo novo
  // para revelar, o fade de entrada tocaria de novo e a aba piscaria à toa.
  if (nova === tab) return;
  animaTrocaDeAba(painelCodex(), () => {
    tab = nova;
    setOn(".codex-tabs", alvo);
    render();
  }, nova === "geral" ? el("codex-view-geral") : null);
}

/// Liga os eventos da view (uma vez) e dispara o primeiro load.
export function initCodexDashboard(): void {
  if (initialized) { void loadCodexDashboard(); return; }
  initialized = true;

  el("codex-tab-geral").onclick = (e) => { trocaAba("geral", e.target); };
  el("codex-tab-surfaces").onclick = (e) => { trocaAba("surfaces", e.target); };
  el("codex-tab-modelos").onclick = (e) => { trocaAba("modelos", e.target); };
  const customBtn = document.querySelector('.codex-ranges button[data-d="custom"]') as HTMLButtonElement;

  document.querySelectorAll(".codex-ranges button").forEach((b) =>
    ((b as HTMLButtonElement).onclick = () => {
      const d = (b as HTMLElement).dataset.d!;
      // "Personalizado" só abre/fecha o popover; o filtro vale ao "Aplicar".
      if (d === "custom") {
        prefillCustomInputs();
        updateApplyState();
        setCustomOpen(!customOpen);
        return;
      }
      // Preset (30d/7d): desaplica o range personalizado e restaura o rótulo.
      const novo = Number(d) || 30;
      // Reclicar o período já aplicado não faz nada. Um range personalizado ativo
      // conta como período diferente, mesmo que tenha o mesmo número de dias: o
      // clique existe justamente para desaplicá-lo.
      if (novo === days && !customActive) return;
      days = novo;
      customActive = false;
      customBtn.textContent = CUSTOM_LABEL;
      setOn(".codex-ranges", b);
      setCustomOpen(false);
      void loadCodexDashboard({ skeleton: true });
    }));

  const from = el("codex-range-from") as HTMLInputElement;
  const to = el("codex-range-to") as HTMLInputElement;
  from.oninput = updateApplyState;
  to.oninput = updateApplyState;

  (el("codex-range-apply") as HTMLButtonElement).onclick = () => {
    if (!(from.value && to.value)) return;
    customFrom = from.value;
    customTo = to.value;
    customActive = true;
    const { from: f, to: t } = customRange();
    customBtn.textContent = fmtShort(f) + " – " + fmtShort(t);
    setOn(".codex-ranges", customBtn);
    setCustomOpen(false);
    void loadCodexDashboard({ skeleton: true });
  };

  // Fecha o popover ao clicar fora (exceto no botão "Personalizado") ou com Esc.
  document.addEventListener("mousedown", (e) => {
    if (!customOpen) return;
    const t = e.target as Node;
    const pop = el("codex-range-custom");
    if (pop.contains(t) || customBtn.contains(t)) return;
    setCustomOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && customOpen) setCustomOpen(false);
  });

  void loadCodexDashboard();
}
