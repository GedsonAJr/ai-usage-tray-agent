# Onboarding — ai-usage-tray-agent

Guia de **fluxo de trabalho** para quem for contribuir com o projeto. Cobre o que
**não dá pra inferir lendo o código**: topologia do git, como a release sai, por que
o CHANGELOG é crítico, os pontos sensíveis do OTA e as armadilhas técnicas já
aprendidas. Para a arquitetura/telas, veja o `README.md`.

---

## TL;DR (o mínimo pra não quebrar nada)

1. **Nunca commite direto no `main`.** Toda mudança vai por branch de tópico +
   Pull Request no upstream (`wzuqui/ai-usage-tray-agent`).
2. **A release sai SÓ do upstream**, automaticamente no merge para o `main` dele.
   Push no seu fork não publica nada.
3. **Sempre atualize o `CHANGELOG.md` antes de mergear** — o app lê esse arquivo em
   runtime pra mostrar as novidades/OTA. Sem isso, o usuário vê novidades vazias.
4. **A chave de assinatura do updater existe só no secret do upstream e não está no
   repo.** Se for perdida, nenhum app instalado aceita updates futuros.

---

## 1. Topologia do Git

- `origin` = fork pessoal (`GedsonAJr/ai-usage-tray-agent`) — só para desenvolvimento/PR.
- `upstream` = repositório oficial (`wzuqui/ai-usage-tray-agent`) — fonte de distribuição.
- O mantenedor atual é **owner do upstream** (pode configurar secrets/Settings do `wzuqui`).
- O upstream aceita PRs com **merge commit** (preserva os SHAs originais).
- O upstream tem um ruleset **"Code Review" sem bypass** → **tudo passa por PR**; o CI
  **não pode** commitar de volta no `main`.

## 2. Release — onde e como sai

- A release roda **apenas no upstream**. `.github/workflows/release.yml` tem um guard:
  `if: github.repository == 'wzuqui/ai-usage-tray-agent'`.
- **Push no `origin/main` (fork) NÃO dispara release.** Só o merge no `main` do
  upstream recria a release rolling `main-latest`.
- A versão é injetada como `0.2.<github.run_number>` a cada build e **precisa ser
  monotônica** (o updater compara semver). **Toda execução consome um `run_number`,
  inclusive um ensaio que não publica** — por isso a numeração pula às vezes
  (0.2.56 → 0.2.58, com o 57 gasto num ensaio). Não é erro.
- O workflow também aceita **disparo manual**, com a entrada **`ensaio` ligada por
  padrão**: compila e empacota os dois sistemas e **para antes de publicar**, sem tocar
  na tag `main-latest` nem no `latest.json`.

  ```sh
  gh workflow run release.yml --repo wzuqui/ai-usage-tray-agent --ref main -f ensaio=true
  ```

  Ele existe porque o `release.yml` **não roda em PR** — é a única forma de validar uma
  mudança nele antes que ela vire release. Duas limitações que já custaram tempo:
  - **O ensaio pula o job `release`.** Então ele NÃO valida o `download-artifact` nem o
    `action-gh-release`, que vivem lá. Serve para o job `build`.
  - **O `workflow_dispatch` só enxerga refs do upstream.** Uma branch do fork é invisível
    para ele.

## 3. Fluxo de contribuição (passo a passo)

Para cada mudança:

```sh
git fetch upstream
git switch -c <branch> upstream/main      # SEMPRE parta de upstream/main
# ... editar + commit ...
git push -u origin <branch>
gh pr create --repo wzuqui/ai-usage-tray-agent --base main --head GedsonAJr:<branch>
# após aprovar/mergear o PR, sincronize o fork (passo 4 abaixo)
```

Sincronizar o fork periodicamente (fast-forward simples):

```sh
git fetch upstream && git switch main && git merge upstream/main && git push origin main
```

Todo PR roda o **`ci.yml`**: `npm run build`, `cargo check` e `cargo test`, em
**Windows e Ubuntu**. Espere os dois checks antes de mergear. O Windows não é
redundante — o backend tem módulos sob `#[cfg(windows)]` (tray, janela, autostart) que um
`cargo check` no Linux nem compila.

`cargo fmt --check` e `clippy` **não** são porta: o `fmt` falha hoje em código
pré-existente, e um CI que nasce vermelho vira ruído que todo mundo ignora. Para gatear,
primeiro formate o que existe.

> **Por que nunca commitar no `main` primeiro:** commitar no main e depois rebasear
> para o PR cria dois commits com o mesmo conteúdo (já aconteceu). Como o upstream usa
> merge commit, partir sempre de `upstream/main` mantém o histórico limpo.

## 4. CHANGELOG.md — é runtime, não cosmético

- **O app lê o `CHANGELOG.md` do `main` em tempo de execução** (comando `get_changelog`)
  para montar a janela de atualização OTA (mostra o *delta* entre a versão instalada e a
  mais nova) e a tela **Novidades** (histórico completo).
- O campo `notes` do `latest.json` **não é mais usado** (vai vazio).
- **Consequência:** sempre preencha o CHANGELOG **antes** de qualquer fluxo git que entre
  no `main`. Sem isso, o usuário vê novidades vazias/desatualizadas.

**Estilo:**
- **CHANGELOG.md** = resumido e voltado ao usuário final. Só o que é **visível/perceptível**,
  no padrão Keep a Changelog (Adicionado/Alterado/Corrigido/Removido/Obsoleto/Segurança).
  Sem nomes de arquivo, campos internos ou hashes.
- **Cada item em UMA ÚNICA LINHA** (sem quebra manual) — renderers de versões antigas
  quebram itens multi-linha de forma estranha na janela OTA.
- **Mensagem de commit** = completa e técnica (é nela que mora o changelog "detalhado").

**Modelo cumulativo (Keep a Changelog):**
- O arquivo mantém uma seção por versão lançada, que nunca é apagada.
- `[Não lançado]` no topo = a versão mais nova ainda não promovida; o app a mapeia para a
  versão alvo ao exibir.
- A cada novo ciclo, **antes** de registrar mudanças novas:
  1. Promova a `[Não lançado]` anterior para `## [0.2.<run>] - AAAA-MM-DD`. A versão é
     `0.2.<run_number>` da **run de Release do upstream** (a release só roda lá — ver seção 2),
     que corresponde à última PR mergeada no `main` do upstream. Pegue o `run_number` e a data
     com (o `--repo` é obrigatório: você está no fork):

     ```sh
     gh run list --repo wzuqui/ai-usage-tray-agent --workflow=release.yml -L 1 \
       --json number,displayTitle,createdAt
     # versão = 0.2.<number>;  data (AAAA-MM-DD) = o dia de createdAt
     ```

     > ⚠️ **Não confie na saída em tabela do `gh run list`.** A coluna numérica ali é o
     > **run ID** (ex.: `29020790682`), não o `run_number` que vira a versão. Sempre use
     > `--json number` (ou `gh run view <id> --json number`) para pegar o número certo.

     Se a `[Não lançado]` estava vazia, não crie seção.
  2. Recrie uma `[Não lançado]` vazia no topo e adicione ali as entradas novas.
- **Cuidado com o parser** (`parseChangelog`/`renderMarkdown` em `src/changelog.ts`): a guia
  "Como manter" no topo é blockquote (`>`), nunca `## `; subtítulos de categoria usam `### `
  (só `## ` vira seção).

## 5. OTA / Auto-update — pontos sensíveis

- Implementado com `tauri-plugin-updater` (v2), com o fluxo **no backend Rust**
  (`src-tauri/src/lib.rs`, `check_for_updates`), porque o app é tray-only e a webview nem
  sempre existe. Checa no boot (silencioso se não há update) e abre uma janela de novidades
  (`update.html`) mostrando o changelog antes de instalar. Há item "Buscar atualizações" no
  menu do tray. Cobre MSI (Windows) e AppImage (Linux).
- **Assinatura (CRÍTICO):** a chave privada (`tauri signer generate`, sem senha) está apenas
  no secret `TAURI_SIGNING_PRIVATE_KEY` do upstream. **Ela NÃO está no repositório. Se for
  perdida, nenhum update futuro é aceito pelos apps já instalados.**
- **Endpoint/pubkey:** `tauri.conf.json` → `bundle.createUpdaterArtifacts: true` +
  `plugins.updater` (pubkey embutida + endpoint
  `https://github.com/wzuqui/ai-usage-tray-agent/releases/latest/download/latest.json`).
  Ao mexer em release/versão/updater, mantenha versão monotônica e endpoint/pubkey coerentes.
- **O job `release` publica ANTES de limpar, e a ordem é deliberada.** A limpeza existe
  porque os nomes carregam a versão (`0.2.<run>`), então builds diferentes geram nomes
  diferentes e os antigos não são sobrescritos. Quando ela vinha **antes** da publicação,
  uma falha ali deixava a release esvaziada: o `latest.json` tinha sido apagado sem ser
  reposto, e **todo app instalado passava a receber "não foi possível verificar
  atualizações"** até alguém reexecutar o workflow. Publicando primeiro, uma falha aborta
  antes da limpeza e o conjunto anterior continua servindo.
  A lista do que **fica** é lida do diretório que acabou de subir, e não repetida à mão —
  se fosse só inverter os passos, a consulta devolveria *todos* os assets, inclusive os
  recém-publicados, e a build se apagaria sozinha.
- **A entrega de assets do GitHub falha de vez em quando** (504, `linuxdeploy` abortando
  no AppImage, `latest.json` inacessível por instantes). Já derrubou build e verificação
  de update no mesmo dia. Reexecutar costuma resolver; se cair duas vezes seguidas, é
  indisponibilidade do lado deles — espere em vez de insistir.
- **Build local:** o build completo exige a chave de assinatura; use
  `npx tauri build --no-bundle` para pular o bundling/assinatura. Testes do dia a dia são em
  modo dev: `npm run tauri dev`.

## 6. Armadilhas técnicas já aprendidas

- **Comandos Tauri que criam/abrem uma `WebviewWindow` DEVEM ser `async fn`.** Um comando
  síncrono roda na thread principal e **trava o event loop** — a janela abre mas o webview
  nunca carrega (tela em branco). Isso causou um bug do OTA (janela de novidades em branco
  ao abrir pela tela "Sobre").
- **API de uso do Codex:** os dados de analytics vêm do backend `chatgpt.com/backend-api/wham/...`
  e abrem direto com o token do `~/.codex/auth.json`
  (`Authorization: Bearer <access_token>` + `chatgpt-account-id: <account_id>`). O namespace
  `wham/` funciona; o `codex/...` dá 403. O `access_token` expira (~10 dias) — **releia o
  `auth.json` a cada coleta** para pegar o token renovado. Endpoints principais:
  `wham/usage` (gauges) e `wham/usage/daily-token-usage-breakdown` (série temporal; unidade
  em **percentual**, não tokens).

- **O `claude -p` da reabertura automática de sessão herda o `~/.claude/settings.json`
  do usuário.** Num perfil de uso diário isso significa o modelo mais caro com raciocínio
  estendido respondendo a um "Oi" — chegou a consumir 4-5% da janela de 5h só para
  abri-la. O disparo passa `--settings '{"effortLevel":"low"}'` e `--strict-mcp-config`
  para se isolar disso. O `--settings` do CLI **acrescenta** aos ajustes do usuário (não
  substitui) e vale só para aquela execução — nada é gravado no `settings.json` dele.
  **O modelo NÃO é fixado de propósito:** um nome cravado no código é uma escolha do app
  sobre algo que é do usuário, e some sem aviso (nome completo aponta para uma release que
  é aposentada; até um alias é nome de terceiro). Se precisar controlá-lo, vire campo nas
  Configurações com queda segura para o padrão do CLI.

- **Nada de JSON com aspas na linha de comando do `claude` no Windows.** Lá o CLI quase
  sempre é o shim `claude.cmd` do npm, e o `cmd.exe` no meio do caminho corrompe qualquer
  argumento com aspas: `{"effortLevel":"low"}` chegou do outro lado como
  `{"effortLevel:low}` **colado no argumento seguinte**, e toda reabertura automática
  morria com `Error: Settings file not found: ...`. O escape do Rust não tem culpa — o
  mesmo argumento passa intacto quando o alvo é o `claude.exe` direto. A saída é passar
  **caminho de arquivo** no `--settings` (grafado a cada disparo em
  `<config>/sessao-auto/settings-disparo.json`): caminho atravessa o shim intacto, com
  espaços e tudo. O teste `opener_passa_os_ajustes_como_arquivo_e_nao_como_json_inline`
  trava isso com um `.cmd` falso.

## 7. Disciplina de documentação

Antes de **qualquer** commit, faça uma passada de consistência e inclua as mudanças de doc
**no mesmo PR** da feature:
- `README.md` reflete as telas/comandos/estrutura/fluxos atuais?
- `CHANGELOG.md` tem a entrada da versão? (ver seção 4)
- Alguma doc cita arquivo/função/fluxo que mudou?

---

*Este guia complementa o `README.md` (arquitetura e telas) e o `CHANGELOG.md` (histórico de
versões). Mantenha-o atualizado quando o fluxo de trabalho mudar.*
