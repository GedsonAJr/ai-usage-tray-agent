// Animações compartilhadas da troca de abas (Configurações, Dashboard Claude e
// Dashboard Codex): o contêiner acompanha a altura da aba escolhida e o conteúdo
// que entra recebe um fade, em vez de a tela saltar de tamanho.
//
// Duas armadilhas que este módulo existe para evitar:
//
// 1. Pendurar o fade numa classe de estado (`.on`) depende de o navegador tratar
//    o painel como "renderizado pela primeira vez" ao sair do `display: none`.
//    Esse disparo deixa de ser garantido quando, no mesmo quadro, se força um
//    recálculo de layout ou se mexe na altura do elemento pai — que é exatamente
//    o que a animação de altura faz. Por isso a classe da animação é REPOSTA a
//    cada troca (tira, força o reflow, devolve), e não deduzida do estado.
//
// 2. A altura de destino é MEDIDA, não `auto`. Nas abas de lista do Dashboard
//    Claude o painel é limitado pela altura da janela (ver .dash-scroll), então
//    `auto` daria a altura do conteúdo inteiro — muito maior que o destino real.

/// Duração da animação de altura. O fade do conteúdo (CSS) acompanha este valor:
/// quando ele era bem mais longo, o painel já tinha parado de crescer e o texto
/// ainda estava translúcido — o movimento parecia continuar depois de terminar.
const ALTURA_MS = 300;

interface Pendente {
  raf?: number;
  /// Desmarca o relógio e o listener que soltariam a altura da troca anterior —
  /// sem tocar na altura em si, que a troca nova vai reescrever.
  cancelar?: () => void;
}
const pendentes = new WeakMap<HTMLElement, Pendente>();

/// Reinicia a animação de entrada de um elemento que muda de conteúdo sem trocar
/// de nó (o gráfico do Codex) ou que precisa animar de forma determinística.
///
/// A classe SAI no fim da animação. Deixá-la pendurada fazia o fade tocar de novo
/// sozinho: sair de `display: none` reinicia as animações CSS do elemento, então
/// toda volta à tela pelo menu lateral reproduzia o fade da última troca de aba —
/// por cima do fade da própria tela, que dura outro tanto.
///
/// Só `animationend` limpa. `animationcancel` não serve: remover a classe aqui em
/// cima já cancela a animação anterior, e o evento chega depois de a nova ter
/// começado — ele apagaria justamente a classe que acabamos de pôr.
export function reiniciaEntrada(node: HTMLElement): void {
  node.classList.remove("entrando");
  void node.offsetWidth;
  node.classList.add("entrando");
  // Mesma referência de função a cada chamada: o DOM ignora listeners repetidos,
  // então trocas seguidas não empilham nada.
  node.addEventListener("animationend", limpaEntrada, { once: true });
}

function limpaEntrada(e: Event): void {
  if ((e as AnimationEvent).animationName !== "tab-in") return;
  (e.currentTarget as HTMLElement).classList.remove("entrando");
}

/// Cala, pelo primeiro quadro, as animações de entrada dos blocos de um contêiner
/// que acabou de aparecer. Sair de `display: none` faz o navegador tratar tudo lá
/// dentro como renderizado pela primeira vez: o `@starting-style` de
/// `.anima-altura` volta a valer e os blocos JÁ abertos crescem do zero de novo,
/// como se o usuário tivesse acabado de ligá-los. É a mesma guarda que
/// `animaTrocaDeAba` usa na troca de abas, aplicada à troca de telas.
export function silenciaEntrada(container: HTMLElement): void {
  container.classList.add("trocando-aba");
  // Fixa o estilo de primeira renderização ainda com as transições desligadas —
  // é neste recálculo que o `@starting-style` seria consumido.
  void container.offsetHeight;
  requestAnimationFrame(() => container.classList.remove("trocando-aba"));
}

/// Executa `troca` (o que de fato muda a aba: classes, render) levando a altura
/// de `container` da medida antiga até a nova, e dá o fade de entrada em cada
/// painel informado.
export function animaTrocaDeAba(
  container: HTMLElement,
  troca: () => void,
  ...paineis: (HTMLElement | null)[]
): void {
  const pend = pendentes.get(container) ?? {};
  pendentes.set(container, pend);

  // Encerra o agendamento da troca anterior antes de medir: se ele disparasse no
  // meio desta, apagaria a altura e a classe da animação nova.
  pend.cancelar?.();

  const antes = container.offsetHeight;

  // Desliga a transição ANTES de medir o destino. Com `interpolate-size` (ver
  // styles.css) `height: auto` virou interpolável, então limpar o height com a
  // transição ativa não solta mais a altura: começa uma transição PARA `auto`, e
  // a medida abaixo leria o primeiro quadro dela — ou seja, a altura antiga.
  // Numa troca em cima de outra (clique rápido) isso dava `depois == antes`:
  // nenhuma animação, e o painel ficava preso no tamanho da aba anterior,
  // cortando o conteúdo novo, até o relógio de segurança soltar.
  container.classList.remove("anima-altura-troca");

  // Blocos internos que animam a própria altura (`.anima-altura` + [hidden]) não
  // podem "nascer" animando quando a aba aparece: seria a metade de baixo da aba
  // se abrindo sozinha. Pelo primeiro quadro as transições deles ficam desligadas.
  container.classList.add("trocando-aba");

  troca();

  // Mede o destino com a aba nova já no layout. O height inline é limpo antes
  // para o caso de uma troca anterior ter sido interrompida no meio.
  container.style.height = "";
  const depois = container.offsetHeight;

  container.style.height = antes + "px";
  void container.offsetHeight;
  container.classList.add("anima-altura-troca");
  container.style.height = depois + "px";

  for (const painel of paineis) if (painel) reiniciaEntrada(painel);

  // Cliques rápidos: sem cancelar, o quadro agendado pela troca anterior removeria
  // a classe desta, devolvendo o "abre da metade para baixo" de vez em quando.
  if (pend.raf !== undefined) cancelAnimationFrame(pend.raf);
  pend.raf = requestAnimationFrame(() => {
    pend.raf = undefined;
    container.classList.remove("trocando-aba");
  });

  // Devolve a altura ao conteúdo no fim: um bloco que abra depois não pode
  // esbarrar num height fixo. O gatilho é o próprio fim da transição — soltar por
  // relógio erra quando o quadro atrasa (o Codex reconstrói o gráfico junto) e o
  // painel salta no meio do caminho. O relógio fica de rede de segurança: sem
  // mudança de altura não há transição, logo não há evento.
  const solta = (): void => {
    pend.cancelar?.();
    container.classList.remove("anima-altura-troca");
    container.style.height = "";
  };
  const aoFim = (e: TransitionEvent): void => {
    if (e.target === container && e.propertyName === "height") solta();
  };
  container.addEventListener("transitionend", aoFim);
  const timer = window.setTimeout(solta, ALTURA_MS + 120);
  pend.cancelar = (): void => {
    clearTimeout(timer);
    container.removeEventListener("transitionend", aoFim);
    pend.cancelar = undefined;
  };
}
