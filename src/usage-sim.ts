// Simulação de contas da tela "Uso atual", SÓ para o `npm run tauri dev`: troca os
// dados que a tela desenha por cenários prontos (uma conta por provedor, duas contas
// com as duas janelas, uma com erro, só a semanal, coletando, e-mail longo), para avaliar o layout de
// duas contas sem ter duas contas pagas de cada provedor. Nada é gravado nem
// enviado: é só o que a tela desenha.
//
// `usage.ts` importa este módulo dentro de `if (import.meta.env.DEV)`; no build de
// release a condição é falsa, o Vite descarta o ramo e o módulo nem entra no pacote.
import type { ContaUso, HistPoint, Usage } from "./usage";
import type { UsageMetric } from "./usage-format";

type Cenario = "" | "uma" | "janelas" | "erro" | "semanal" | "coletando" | "email";

const CENARIOS: [Cenario, string][] = [
  ["", "Simular: desligado"],
  ["uma", "Simular: uma conta"],
  ["janelas", "Simular: duas janelas"],
  ["erro", "Simular: conta com erro"],
  ["semanal", "Simular: só semanal"],
  ["coletando", "Simular: coletando"],
  ["email", "Simular: e-mail longo"],
];

/// O cenário sobrevive ao recarregar da janela (o HMR recarrega a página inteira ao
/// mudar certos arquivos). O acesso ao storage pode falhar; aí vale "desligado".
const CHAVE = "aiusage.simulacao";
const ler = (): Cenario => {
  try {
    const valor = localStorage.getItem(CHAVE) ?? "";
    return CENARIOS.some(([c]) => c === valor) ? (valor as Cenario) : "";
  } catch {
    return "";
  }
};
let cenario: Cenario = ler();
/// Instante de referência dos dados simulados. Fixo por cenário: com ele fixo, os
/// dados não mudam entre as recargas de 2s e a tela não reconstrói os cards à toa.
let inicio = Date.now();

const iso = (ms: number): string => new Date(inicio + ms).toISOString();
const MIN = 60_000;

/// Histórico da última hora, subindo de `de` a `ate` com uma ondulação leve.
function serie(de: number, ate: number): HistPoint[] {
  const n = 40;
  return Array.from({ length: n }, (_, i) => {
    const pct = de + (ate - de) * (i / (n - 1)) + Math.sin(i / 3) * 1.5;
    return { t: iso(-(n - 1 - i) * 1.5 * MIN), pct: Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10 };
  });
}

/// Métrica de uma conta. `null` numa janela = a conta não tem essa janela.
function metrica(provedor: string, sessao: number | null, semanal: number | null, erro?: string): UsageMetric {
  return {
    ferramenta: provedor,
    status: erro ? "erro" : "ok",
    coletado_em: iso(0),
    erro: erro ?? null,
    reset_em: sessao !== null && !erro ? iso(88 * MIN) : null,
    ...(sessao !== null && !erro ? { uso_percentual: sessao, restante_percentual: 100 - sessao } : {}),
    ...(semanal !== null && !erro ? { uso_percentual_7d: semanal, reset_em_7d: iso(3 * 24 * 60 * MIN + 5 * 60 * MIN) } : {}),
  };
}

function conta(
  provedor: ContaUso["provedor"],
  id: string,
  rotulo: string,
  principal: boolean,
  metric: UsageMetric | null,
  sessao: HistPoint[],
  semanal: HistPoint[],
): ContaUso {
  return { chave: `${provedor}:sim-${id}`, provedor, rotulo, principal, habilitado: true, metric, history: { session: sessao, weekly: semanal } };
}

/// A segunda conta de cada provedor, conforme o cenário.
function secundaria(p: ContaUso["provedor"]): ContaUso {
  switch (cenario) {
    case "erro":
      return conta(p, "pessoal", "Pessoal (sim.)", false,
        metrica(p, null, null, "five_hour nao foi encontrado na resposta do Claude."), [], []);
    case "semanal":
      return conta(p, "pessoal", "Pessoal (sim.)", false, metrica(p, null, 12), [], serie(8, 12));
    case "coletando":
      return conta(p, "pessoal", "Pessoal (sim.)", false, null, [], []);
    case "email":
      return conta(p, "pessoal", "nome.sobrenome.bem.comprido@empresa-de-exemplo.com.br", false,
        metrica(p, 72, 91), serie(40, 72), serie(85, 91));
    default:
      return conta(p, "pessoal", "Pessoal (sim.)", false, metrica(p, 72, 91), serie(40, 72), serie(85, 91));
  }
}

/// Há um cenário ligado. O reordenar consulta isto para não gravar no
/// `contas.json` a ordem das contas simuladas.
export const ativa = (): boolean => cenario !== "";

/// Os dados que a tela desenha: os reais, ou os do cenário escolhido. Mantém a
/// ordem dos provedores dos dados reais e o resto do estado (pausa, gráfico).
export function aplica(dados: Usage): Usage {
  if (!cenario) return dados;
  const reais = [...new Set(dados.contas.map((c) => c.provedor))];
  const provedores = reais.length ? reais : (["claude", "codex"] as const);
  const contas = provedores.flatMap((p) => {
    const principal = conta(p, "trabalho", "Trabalho (sim.)", true, metrica(p, 34, 58), serie(20, 34), serie(55, 58));
    // "Uma conta": só a principal de cada provedor, o card sem as setas.
    return cenario === "uma" ? [principal] : [principal, secundaria(p)];
  });
  return { ...dados, contas };
}

/// Põe o seletor de cenário no cabeçalho da tela, antes do "Reordenar". O estilo
/// vai inline para não levar CSS de desenvolvimento ao build de release.
export function montaSeletor(aoMudar: () => void): void {
  const acoes = document.querySelector(".usage-head-actions");
  if (!acoes || acoes.querySelector(".usage-sim")) return;
  const sel = document.createElement("select");
  sel.className = "usage-sim";
  sel.title = "Simulação de contas (só no npm run tauri dev)";
  Object.assign(sel.style, { width: "auto", padding: "4px 28px 4px 10px", fontSize: "12.5px", borderRadius: "999px" });
  for (const [valor, texto] of CENARIOS) sel.add(new Option(texto, valor, false, valor === cenario));
  sel.onchange = () => {
    cenario = sel.value as Cenario;
    inicio = Date.now();
    try {
      localStorage.setItem(CHAVE, cenario);
    } catch {
      // sem storage: o cenário vale até recarregar a janela
    }
    aoMudar();
  };
  const divisor = document.createElement("span");
  divisor.className = "usage-divider";
  divisor.setAttribute("aria-hidden", "true");
  acoes.prepend(sel, divisor);
}
