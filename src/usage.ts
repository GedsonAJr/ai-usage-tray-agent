// Tela "Uso atual": mostra o uso de sessão (5h) e semanal (7d) do Claude e do
// Codex, com barra de progresso, tempo restante para o reset (contagem ao vivo)
// e a data/hora exata do reset. O subtítulo da página traz o "Atualizado há…" do
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
  type ProviderUsage,
  type UsageMetric,
} from "./usage-format";

/// Um ponto do histórico de uso: instante (ISO) + % naquele momento.
interface HistPoint {
  t: string;
  pct: number;
}
/// Séries de histórico de um provedor: sessão (5h) e semanal (7d). Ambas cobrem
/// as últimas ~5h (o backend só mantém essa janela, em memória).
interface ProviderHistory {
  session: HistPoint[];
  weekly: HistPoint[];
}

interface Usage {
  paused: boolean;
  lastError: string | null;
  /// Exibir o mini gráfico (toggle da própria tela). Ausente = tratar como true.
  chartEnabled?: boolean;
  /// Mostrar o aviso de perda de dados ao desabilitar. Ausente = tratar como true.
  chartWarnOnDisable?: boolean;
  /// Ordem de exibição dos provedores (chaves). Ausente = ordem canônica.
  ordem?: string[];
  claude: ProviderUsage;
  codex: ProviderUsage;
  history?: { claude: ProviderHistory; codex: ProviderHistory };
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
    ${sparkline(series, barColor(pct), key, label)}
    <div class="uwin-reset">${reset}</div>
  </div>`;
}

// Dimensões (em unidades de viewBox) do mini-gráfico. O SVG escala uniforme via
// CSS (width:100%; height:auto), então as coordenadas abaixo são as usadas tanto
// para desenhar quanto para o hover (que mapeia o cursor por getBoundingClientRect).
const SPARK = { W: 300, H: 64, padY: 6, padL: 22 };

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
function sparkline(series: HistPoint[], accent: string, key: string, label: string): string {
  if (series.length < 2) {
    return `<div class="uchart-na">Coletando histórico… (aparece após algumas coletas)</div>`;
  }
  const { W, H, padY, padL } = SPARK;
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

/// Card de um provider, cobrindo os estados: desabilitado, sem dado ainda, erro
/// de coleta, ou as duas janelas (sessão e semanal). O ícone do cabeçalho é o do
/// provedor (Claude = spark; Codex = logo do Codex).
function renderProvider(label: string, provKey: "claude" | "codex", prov: ProviderUsage): string {
  const icon = label === "Codex" ? iconCodex() : ICON_CLAUDE;
  // No modo reordenar, o card fica arrastável e ganha uma alça no cabeçalho.
  const grip = reordering ? '<span class="uprov-grip" aria-hidden="true">⠿</span>' : "";
  const open = (cls: string): string =>
    `<div class="${cls}" data-prov="${provKey}"${reordering ? ' draggable="true"' : ""}>`;
  const head = (meta: string): string =>
    `<div class="uprov-head"><div class="uprov-name">${grip}${icon} ${label}</div><div class="uprov-meta">${meta}</div></div>`;

  if (!prov.habilitado) {
    return `${open("uprov disabled")}${head('<span class="ubadge muted">desabilitado</span>')}
      <div class="uprov-note">Habilite ${label} nas Configurações para coletar o uso.</div></div>`;
  }
  const m = prov.metric;
  if (!m) {
    return `${open("uprov")}${head("")}<div class="uprov-note">Coletando dados…</div></div>`;
  }
  if (m.status === "erro" || m.erro) {
    return `${open("uprov error")}${head('<span class="ubadge err">erro</span>')}
      <div class="uprov-note err">${escapeHtml(m.erro ?? "Falha na coleta.")}</div></div>`;
  }
  // O "atualizado há…" foi para o subtítulo da página (renderSub); o card não o repete.
  const hist = DATA?.history?.[provKey];
  return `${open("uprov")}${head("")}
    <div class="uwins">
      ${windowBlock("Sessão (5h)", m.uso_percentual, m.reset_em, true, hist?.session ?? [], provKey + "-session")}
      ${windowBlock("Semanal (7d)", m.uso_percentual_7d, m.reset_em_7d, false, hist?.weekly ?? [], provKey + "-weekly")}
    </div>
  </div>`;
}

const PROVIDER_KEYS = ["claude", "codex"] as const;
type ProviderKey = (typeof PROVIDER_KEYS)[number];

/// Ordem dos provedores vinda do backend, saneada para conter exatamente as chaves
/// conhecidas (fallback à ordem canônica). Espelha `normalize_provider_order`.
function providerOrder(d: Usage): ProviderKey[] {
  const from = (d.ordem ?? []).filter((k): k is ProviderKey => (PROVIDER_KEYS as readonly string[]).includes(k));
  for (const k of PROVIDER_KEYS) if (!from.includes(k)) from.push(k);
  return from;
}

/// Timestamp de coleta mais recente entre os provedores habilitados com dado
/// válido (ambos coletam no mesmo ciclo, então normalmente coincidem). `null`
/// quando nenhum provedor tem dado coletado ainda.
function freshestCollected(): string | null {
  if (!DATA) return null;
  let best: string | null = null;
  for (const prov of [DATA.claude, DATA.codex]) {
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
/// Cobre o que muda o desenho: pausa, habilitado, métricas de cada provedor e o
/// tamanho/última amostra de cada série do histórico.
function signature(d: Usage): string {
  const m = (x: UsageMetric | null): string =>
    x ? `${x.coletado_em}|${x.uso_percentual ?? ""}|${x.uso_percentual_7d ?? ""}|${x.status}|${x.erro ?? ""}` : "none";
  const h = (s?: HistPoint[]): string => (s && s.length ? `${s.length}:${s[s.length - 1].t}` : "0");
  const hi = d.history;
  return [
    d.paused, d.chartEnabled !== false, reordering, providerOrder(d).join(","),
    d.claude.habilitado, m(d.claude.metric), d.codex.habilitado, m(d.codex.metric),
    h(hi?.claude.session), h(hi?.claude.weekly), h(hi?.codex.session), h(hi?.codex.weekly),
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
      const ux = rect.width ? ((e.clientX - rect.left) / rect.width) * SPARK.W : 0;
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
  // Reconstrói os cards só quando os dados mudam; entre reloads iguais (a cada 2s)
  // apenas roda o tick, preservando o hover do gráfico e poupando trabalho.
  const sig = signature(DATA);
  if (sig === lastSig) { tick(); return; }
  lastSig = sig;

  el("usage-banner").innerHTML = DATA.paused
    ? '<div class="ubanner">⏸ Envio ao Loki pausado. Os dados continuam sendo coletados e exibidos aqui; retome o envio na tela "Envio de dados" ou no menu do tray.</div>'
    : "";
  CHARTS.clear();
  const labels: Record<ProviderKey, string> = { claude: "Claude", codex: "Codex" };
  el("usage-cards").classList.toggle("reordering", reordering);
  el("usage-cards").innerHTML = providerOrder(DATA)
    .map((k) => renderProvider(labels[k], k, (DATA as Usage)[k]))
    .join("");
  renderSub();
  el("usage-foot").textContent = "";
  wireCharts();
  tick();
}

/// Busca o snapshot pelo IPC e re-renderiza. Barata (sem rede no backend).
export async function loadUsage(): Promise<void> {
  try {
    DATA = await invoke<Usage>("get_usage");
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
    draggedKey = card.dataset.prov ?? null;
    card.classList.add("dragging");
    (e as DragEvent).dataTransfer?.setData("text/plain", draggedKey ?? "");
  });
  cards.addEventListener("dragover", (e) => {
    if (!reordering || !draggedKey) return;
    e.preventDefault(); // habilita o drop
    const card = cardAt(e);
    cards.querySelectorAll(".uprov.drop-target").forEach((n) => n.classList.remove("drop-target"));
    if (card && card.dataset.prov !== draggedKey) card.classList.add("drop-target");
  });
  cards.addEventListener("dragend", clearMarks);
  cards.addEventListener("drop", (e) => {
    if (!reordering || !draggedKey || !DATA) return;
    e.preventDefault();
    const targetKey = cardAt(e)?.dataset.prov;
    const dragged = draggedKey;
    draggedKey = null;
    clearMarks();
    if (!targetKey || targetKey === dragged) return;
    // Move o arrastado para a posição do alvo, usando os índices da ordem ORIGINAL
    // (remove na origem e insere no índice do alvo). Para 2 itens vira uma troca;
    // para N, uma reordenação correta nos dois sentidos.
    const order: string[] = providerOrder(DATA);
    const from = order.indexOf(dragged);
    const to = order.indexOf(targetKey);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, dragged);
    void applyOrder(order);
  });
}

/// Persiste a nova ordem no backend e re-renderiza.
async function applyOrder(order: string[]): Promise<void> {
  try {
    DATA = await invoke<Usage>("set_providers_order", { order });
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