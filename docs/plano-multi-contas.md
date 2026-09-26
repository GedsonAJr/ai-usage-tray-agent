# Múltiplas contas no Claude e no Codex: viabilidade, dificuldades e plano por etapas

> **Documento de consulta da branch `feat/multi-contas`.** Remover ou manter antes do PR
> final, a decidir no fechamento. Sem push nem PR até o fim do processo.

## Andamento

| Etapa | Estado |
|---|---|
| 1. Fundação (contas extras + Configurações + Uso atual) | **implementada**; falta a validação manual (abaixo) |
| 2. Sessão automática acompanha a conta do CLI | a fazer |
| 3. Widget flutuante escolhe as contas | a fazer |
| 4. Barra de tarefas escolhe as contas | a fazer |
| 5. Dashboard Codex com seletor de conta | a fazer |
| 6. Envio escolhe a conta enviada | a fazer |
| Fechamento (README, CHANGELOG, sync com upstream) | a fazer |

**Pendente de validação manual na Etapa 1** (só dá para testar com o app rodando):
- **`prompt=login` do Codex:** com uma conta Codex já conectada, "Adicionar conta" deve
  mostrar a tela de login da OpenAI em vez de entrar direto na conta aberta no navegador. Se
  não mostrar, o texto de status já orienta a sair da conta no navegador.
- Ida e volta com a 0.2.71 instalada (roteiro em "Verificação").

**Ajuste de desenho feito na implementação:** o id da conta é um **hash da identidade** (org
+ e-mail no Claude, `account_id` + e-mail no Codex), calculado do próprio arquivo de
credenciais, e não um id guardado em `contas.json`. Assim a mesma conta tem a mesma chave no
arquivo legado ou em `contas/`, e não há mapa de ids para manter coerente com o que a versão
antiga faz no arquivo legado. `contas.json` guarda só as preferências por chave (apelido,
ordem dos cards).

**Diretriz de design: no máximo 2 contas por provedor** (até 2 do Claude e 2 do Codex).
É decisão de design, não limite técnico: as telas são pensadas para até dois cards por
provedor.
- **Backend:** a regra fica em `contas::MAX_CONTAS_POR_PROVEDOR`. `destino_do_login` recusa
  uma conta **nova** quando o provedor já tem duas ("Remova uma para conectar outra"), mas
  reconectar uma das duas continua valendo.
- **Frontend:** `settings.ts` espelha o valor e, no limite, esconde "Adicionar conta" e
  mostra o aviso.
- **Etapas seguintes:** ficam dimensionadas por esse teto. O widget (Etapa 3) e a barra de
  tarefas (Etapa 4) exibem no máximo 4 cards (2 por provedor), e o seletor do Dashboard
  Codex (Etapa 5) tem no máximo 2 opções.
- Para aumentar no futuro, basta mudar a constante nos dois lugares e revisar o layout
  dessas telas.

**Pendências do README para o fechamento:** a seção "Uso atual" (cita `set_providers_order`
e um card por provedor), a aba de contas das Configurações e os arquivos novos em
`%APPDATA%` (`contas/`, `contas.json`).

**Correção avulsa feita na branch: login do Claude com Google.** A janela de login não
tratava `window.open`, e o wry descartava o popup do "Continuar com Google" em silêncio; a
claude.ai mostrava "Ocorreu um erro ao fazer login". Agora `on_new_window` → `Allow`.
Validado com o app rodando. Não tem relação com várias contas, então pode virar um PR
próprio se for preciso lançar antes. No fechamento:
- README: tirar o "login por SSO/Google pode não funcionar" (seção de limitações do
  Claude);
- CHANGELOG: entrada em "Corrigido".

## Context
Hoje cada provedor tem **exatamente uma conta**. O login grava um arquivo fixo no config_dir:
`claude-auth.json` (`src-tauri/src/claude_auth.rs:47`) e `codex-auth.json`
(`src-tauri/src/codex_auth.rs:107`). Um novo "Conectar" sobrescreve o anterior. O pedido é
permitir mais de uma conta por provedor.

Forma de trabalho: **uma branch longa** (`feat/multi-contas`, a partir de `upstream/main`),
implementada aos poucos, com **um único PR no final**. Durante esse tempo, a versão instalada
(0.2.71) e a de dev compartilham o mesmo `%APPDATA%\AiUsageTrayAgent`. Por isso, os
arquivos precisam funcionar **nas duas versões**.

## Veredito
**É viável.** As autenticações já são independentes por conta:
- no Claude, cada login gera um `sessionKey` próprio. `clear_all_browsing_data`
  (`lib.rs:3728`) só apaga os cookies locais, e a sessão anterior continua válida;
- no Codex, cada login gera um par access/refresh próprio.

O custo está no modelo de dados: o app inteiro usa `"claude"` / `"codex"` como chave e supõe
uma conta em cada.

## Compatibilidade com a versão antiga (regra central)

**O que a versão antiga faz com os arquivos (conferido no código):**
- Na partida, e sempre que o `config.json` muda (o worker checa o mtime a cada ~1 s,
  `lib.rs:1750`), `load_or_create_config` desserializa e **regrava o arquivo só com os campos
  que conhece** (`lib.rs:3595-3599`). Qualquer campo novo é **apagado em ~1 s** se ela
  estiver aberta.
- `normalize_provider_order` força `ordem` a ser permutação de `["claude","codex"]`
  (`lib.rs:3555`), o que descarta chaves como `"claude:ab12"`.
- Campo existente com **tipo trocado** quebra o parse. Aí `read_config` cai em
  `AppConfig::default()` (`lib.rs:3574`): o usuário perde a configuração.
- `claude_auth::set_needs_reconnect` e `codex_auth::ensure_fresh` regravam o arquivo de
  credenciais pelo struct antigo, apagando campos extras.

**Solução: nada muda no formato do que a versão antiga lê. Tudo o que é novo vai para
arquivos que ela nem conhece.**

| Arquivo | Dono | Conteúdo |
|---|---|---|
| `config.json` | as duas versões | **formato idêntico ao de hoje**. Mesmos campos, tipos e significado (nível de provedor). `ordem` continua `["claude","codex"]` |
| `claude-auth.json` / `codex-auth.json` | as duas versões | credenciais da **conta principal** de cada provedor, no formato de hoje |
| `contas/claude/<id>.json`, `contas/codex/<id>.json` | só a nova | credenciais das **contas extras** (mesmo formato do arquivo legado) |
| `contas.json` | só a nova | tudo o que é por conta, pela chave `"<provedor>:<id>"`: apelido, ordem dos cards e, conforme as etapas, `mostraNoWidget` e `mostraNaBarra` |

**Consequências:**
- A versão antiga continua funcionando e enxerga só a principal de cada provedor, que é
  exatamente o que ela sabe mostrar.
- **"A principal é o que estiver no arquivo legado."** A nova versão não guarda uma cópia
  disso: a cada leitura, a principal é o conteúdo de `claude-auth.json` / `codex-auth.json`.
- Se a versão antiga reconectar com outra conta, a nova apenas passa a exibi-la como
  principal (a chave sai do conteúdo do arquivo). Se essa conta também existia como extra,
  a cópia extra, mais antiga, é apagada.
- Se a versão antiga desconectar (apagar o arquivo), a primeira conta extra é **movida**
  para o arquivo legado. É a mesma regra de "removeu a principal, a próxima assume". A
  promoção só acontece com o legado **ausente**: um legado ilegível pode estar no meio de
  uma gravação e não é sobrescrito.
- "Tornar principal" na nova versão = trocar os dois arquivos de lugar (rename). As chaves
  não mudam, então apelido e ordem acompanham a conta.
- Credenciais **nunca são duplicadas** entre arquivos. No Codex, o `refresh_token` é
  rotativo: duas cópias do mesmo token fazem a primeira renovação invalidar a outra, com
  risco de a OpenAI revogar a sessão inteira.
- Trava por teste: uma fixture `config-legado.json`, capturada da 0.2.71, comparada com as
  chaves de `AppConfig::default()`. Qualquer campo novo no `config.json` quebra o teste.

**Regra operacional durante o desenvolvimento: rodar um de cada vez** (fechar a instalada
antes do `npm run tauri dev`). Com as duas abertas, ambas coletam, enviam ao Loki, disparam a
sessão automática e podem renovar o mesmo token do Codex ao mesmo tempo. Esse problema já
existe hoje e não é novo.

## Dificuldades (resumo)
1. Chave fixa por provedor em todo lugar.
   - Backend: `PROVIDER_KEYS` (`lib.rs:279`), `RuntimeSnapshot.{claude,codex}_metric`
     (`:455`), `UsageSample` (`:496`), `update_metric` (`:2816`), `usage_value` /
     `widget_state_value` / `envio_value` (`:942`, `:1232`, `:1072`).
   - Frontend: `usage.ts:224`, `widget.ts:192`, `envio.ts:62`, `settings.ts:91`.
2. Barra de tarefas: `SLOTS` fixo em `[_; 2]` (`taskbar_widget.rs:42`), índice no
   `GWLP_USERDATA`, cores em array fixo.
3. Codex, 2ª conta: o navegador do sistema já tem sessão e deve voltar a mesma conta. Testar
   `prompt=login` (`codex_auth.rs:497`).
4. Sessão automática: o `claude -p` usa a conta do CLI (`lib.rs:359`). É preciso vigiar a
   conta cuja org bate com `~/.claude.json → oauthAccount.organizationUuid`.
5. Compatibilidade com a versão antiga (seção acima).
6. Rótulo por conta: o anel duplo só tem ícone (`widget-modos.ts:105`).
7. Duplicatas: reconectar a mesma conta deve atualizar. A identidade é org + e-mail no
   Claude e `account_id` + e-mail no Codex.
8. Sem impacto: Dashboard Claude (arquivos locais do CLI), `usage_history` (em memória),
   rótulos do Loki (continua uma conta por provedor, a principal).

---

## Etapas (commits na mesma branch; cada etapa deixa a branch rodando)

A **conta principal** alimenta as telas que ainda não foram adaptadas.
`widget_state_value` / `envio_value` continuam emitindo `claude` / `codex` a partir dela, e
cada etapa tira uma tela da principal. No fim, a principal só define a conta enviada ao Loki,
o que casa com a decisão "uma por provedor, o usuário escolhe" e com a versão antiga.

### Etapa 1: Fundação (contas extras + Configurações + Uso atual)
- **Teste do Codex primeiro:** `prompt=login` na URL de autorização. Se o navegador não pedir
  credenciais, o texto de "Adicionar conta" orienta a sair da conta no navegador (ou usar
  janela anônima). Nada de webview: o login com Google é bloqueado lá.
- **Armazenamento:** conforme a tabela acima.
  - `claude_auth.rs` / `codex_auth.rs`: as funções passam a receber o caminho do arquivo da
    conta, não o `config_dir`. `auth_file(config_dir)` continua sendo o da principal.
  - Novo módulo `contas.rs`: ler/gravar `contas.json`, listar contas (principal + extras),
    promover/rebaixar principal (rename) e dedupe por identidade.
- **Backend:**
  - chave de conta `"<prov>:<id>"`, e o snapshot vira `metrics: BTreeMap<String, UsageMetric>`
    com histórico por chave;
  - coleta com uma thread por conta no `thread::scope` que já existe;
  - `UsageMetric` ganha `conta`/`rotulo` com `skip_serializing`, e o payload do Loki fica
    idêntico;
  - `usage_value` passa a emitir `contas: [{key, provedor, rotulo, principal, metric, history}]`
    na ordem de `contas.json`;
  - widget, barra, envio (Loki), dashboard Codex e sessão automática usam a principal;
  - comandos: login com dedupe (atualiza ou adiciona como extra; o 1º login vira a
    principal), `*_logout(conta)`, `*_auth_status` devolvendo lista, `set_conta_apelido`,
    `set_conta_principal`, e `set_contas_ordem` substituindo `set_providers_order` para os
    cards.
- **Frontend:**
  - `settings.ts` / `index.html`: nas abas Claude e Codex, a lista de contas, cada uma com
    rótulo, e-mail, status, apelido, "Principal" / "Tornar principal", Reconectar e Remover,
    mais o botão "Adicionar conta";
  - `usage.ts`: cards vindos de `contas`, ícone por `provedor`.
- **Testes:**
  - fixture do `config.json` legado;
  - leitura de `contas.json` ausente, que equivale ao estado de hoje;
  - promover/rebaixar principal;
  - principal apagada pela versão antiga;
  - dedupe;
  - Loki só com a principal.

### Etapa 2: Sessão automática acompanha a conta do CLI
- A conta vigiada passa a ser a de `organization_id` igual ao `organizationUuid` do
  `~/.claude.json`.
- Com uma única conta Claude, usar essa. Se nada bater, não disparar e avisar no status.
- Teste da escolha.

### Etapa 3: Widget flutuante escolhe as contas
- `mostraNoWidget` por conta em `contas.json`. Se o campo estiver ausente, herda
  `widget.mostraClaude` / `mostraCodex` do `config.json`, que continua lá intacto para a
  versão antiga.
- `widget_state_value` emite a lista. `widget.ts` / `widget-modos.ts` passam a iterar, com
  ícone por `provedor`.
- Rótulo: nome do provedor se só uma conta dele estiver visível, senão o rótulo da conta.
- Aba Widget: caixa de marcar por conta.
- Com o limite de 2 por provedor, são no máximo 4 cards. O layout é dimensionado para
  esse teto.

### Etapa 4: Barra de tarefas escolhe as contas
- `mostraNaBarra` por conta. Se ausente, herda `providers.*.mostraNaTaskbarWindows`.
- `taskbar_widget.rs`: `SLOTS` vira `Vec` dinâmico com `set_slots(...)`. A janela guarda a
  chave, não o índice. `KEY_COLORS` vira mapa. Mesma regra de rótulo.
- Aba Barra: caixa de marcar por conta. Testar no Windows (`cfg(windows)`).
- Com o limite de 2 por provedor, são no máximo 4 slots. Conferir se cabem na barra com o
  rótulo da conta.

### Etapa 5: Dashboard Codex com seletor de conta
- `get_codex_stats(conta, …)`, com o padrão na principal. Atualizar a allowlist do
  `http_server.rs:36`.
- Seletor na `.toolbar`, visível só com 2 ou mais contas.

### Etapa 6: Envio escolhe a conta enviada
- Aba Envio: por provedor, o seletor "Conta enviada". Ele é o "Tornar principal", que sai da
  lista de contas das Configurações. O liga/desliga `envio.claude/codex` do `config.json`
  continua valendo.
- `envio.ts` mostra a conta enviada.

### Fechamento (antes do PR)
- Sincronizar a branch: `git fetch upstream && git merge upstream/main`. Fazer também de
  tempos em tempos durante as etapas, para não acumular conflito.
- README: Configurações, Uso atual, widget, barra, Envio, login, arquivos em `%APPDATA%`.
- CHANGELOG **só agora**: o número da versão depende das releases que saírem no upstream
  enquanto a branch existe. Promover a `[Não lançado]` publicada conforme o ONBOARDING
  (`gh run list --json number`) e então adicionar a entrada.

## Verificação
- A cada etapa: `npm run build`, `cargo fmt --check`, `cargo clippy`, `cargo check`,
  `cargo test`.
- Ida e volta entre versões:
  1. com a dev, adicionar contas extras e trocar a principal;
  2. fechar a dev e abrir a 0.2.71 instalada: ela mostra a principal e o `config.json` não é
     "consertado";
  3. na 0.2.71, mudar uma opção e desconectar/reconectar;
  4. voltar à dev: contas extras e prefs intactas, principal coerente.
- Roteiro da Etapa 1:
  1. conectar uma 2ª conta Claude e uma 2ª Codex;
  2. reconectar a mesma conta sem duplicar;
  3. remover uma conta;
  4. trocar a principal e conferir que widget, barra e Envio a seguem;
  5. conferir que o payload no log do Envio está igual ao de hoje.
