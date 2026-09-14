// Pílula deslizante das barras de seleção: as de aba (Dashboard Claude,
// Dashboard Codex e Configurações) e as de período (30d/7d/Personalizado dos dois
// dashboards). Em vez de o fundo do estado selecionado sumir de um botão e
// aparecer no outro, existe UM fundo por barra que anda até o botão clicado.
//
// O módulo não conhece quem troca a seleção: cada barra observa a classe `on` dos
// seus próprios botões (MutationObserver), então funciona com os handlers
// existentes sem alterá-los. Um ResizeObserver reposiciona a pílula quando a
// barra muda de largura (janela redimensionada, abas que quebram em duas linhas)
// e quando ela reaparece — as barras vivem dentro de telas escondidas com
// `display: none`, onde não há medida nenhuma para ler.
//
// É um aprimoramento progressivo: sem o JS (ou antes da primeira medida) a aba
// selecionada mantém o fundo próprio do CSS, e a tela continua correta.

/// Instala a pílula em todas as barras de seleção da página.
export function initTabSliders(): void {
  document.querySelectorAll<HTMLElement>(".tabs, .ranges").forEach(initTabSlider);
}

function initTabSlider(bar: HTMLElement): void {
  const pill = document.createElement("span");
  pill.className = "tab-pill";
  pill.setAttribute("aria-hidden", "true");
  bar.prepend(pill);

  // Enquanto false, a pílula está escondida e a próxima medida é aplicada sem
  // animação — para ela surgir já no lugar, em vez de deslizar desde o canto.
  let posicionada = false;

  const mover = (): void => {
    const ativo = bar.querySelector<HTMLElement>(":scope > button.on");
    // Barra escondida (a tela dona não está ativa) ou sem seleção: não há o que
    // medir. Some e espera o ResizeObserver avisar que reapareceu.
    if (!ativo || ativo.offsetWidth === 0) {
      bar.classList.remove("pill-ready");
      posicionada = false;
      return;
    }
    pill.style.width = ativo.offsetWidth + "px";
    pill.style.height = ativo.offsetHeight + "px";
    // offsetLeft/Top são relativos à barra (ela é position: relative no CSS).
    // O offsetTop cobre as Configurações, cujas abas quebram em duas linhas.
    pill.style.transform = "translate(" + ativo.offsetLeft + "px, " + ativo.offsetTop + "px)";
    if (posicionada) return;
    posicionada = true;
    // Força o cálculo do estilo com a posição nova ANTES de ligar a transição,
    // senão a primeira aparição vira um deslize desde o canto da barra.
    void pill.offsetWidth;
    bar.classList.add("pill-ready");
  };

  // Só os botões DIRETOS: nas barras de período, o popover do range personalizado
  // é filho da barra e tem botões próprios, que não participam da seleção.
  const botoes = bar.querySelectorAll<HTMLElement>(":scope > button");

  // Só os botões são observados: `pill-ready` entra e sai da própria barra, e
  // observá-la aqui faria a callback se realimentar em laço.
  const obs = new MutationObserver(mover);
  botoes.forEach((b) => obs.observe(b, { attributes: true, attributeFilter: ["class"] }));

  // A barra cobre o reaparecimento e o redimensionamento da janela; os botões
  // cobrem quem muda de largura sozinho — o "Personalizado" troca o rótulo pelo
  // intervalo escolhido, e a pílula precisa acompanhar esse novo tamanho.
  const ro = new ResizeObserver(mover);
  ro.observe(bar);
  botoes.forEach((b) => ro.observe(b));
  mover();
}
