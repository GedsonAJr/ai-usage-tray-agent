use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

mod claude_auth;
mod codex_auth;
mod codex_dashboard;
mod http_server;
mod usage_dashboard;

#[cfg(target_os = "windows")]
mod taskbar_widget;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Local, NaiveDate, Timelike, Utc};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const TRAY_ID: &str = "main-tray";
const APP_NAME_WINDOWS: &str = "AiUsageTrayAgent";
#[cfg(target_os = "linux")]
const APP_NAME_LINUX: &str = "ai-usage-tray-agent";

// `default` no nivel do container faz com que qualquer campo ausente no JSON
// seja preenchido com o valor de `Default` em vez de falhar a desserializacao.
// Combinado com a normalizacao em `load_or_create_config`, isso garante que um
// `config.json` antigo (sem campos novos) seja migrado e reescrito com os
// padroes na inicializacao, sem perder os valores ja configurados.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppConfig {
    usuario: String,
    intervalo_segundos: u64,
    loki: LokiConfig,
    providers: ProvidersConfig,
    barra_tarefas: TaskbarConfig,
    widget: WidgetConfig,
    envio: EnvioConfig,
    servidor: ServerConfig,
    uso_atual: UsoAtualConfig,
}

/// Servidor HTTP local (opcional) que serve os dashboards de uso pelo navegador,
/// protegido por PIN. Acesso somente leitura (uso atual + dashboards); nunca expoe
/// Configuracoes/Envio nem credenciais. HTTPS, se desejado, fica a cargo de um
/// proxy externo (ex.: Cloudflare). Ver `http_server.rs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ServerConfig {
    /// Liga/desliga o servidor. Padrao desligado.
    habilitado: bool,
    /// Endereco de bind. "127.0.0.1" (padrao) so' aceita conexoes locais;
    /// "0.0.0.0" aceita da rede (use atras de um proxy/tunel com TLS).
    host: String,
    /// Porta TCP do servidor (padrao 8770).
    porta: u16,
    /// PIN de acesso. Vazio mantem o servidor desligado mesmo com `habilitado`.
    pin: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            habilitado: false,
            host: "127.0.0.1".to_string(),
            porta: 8770,
            pin: String::new(),
        }
    }
}

/// Controle do envio das metricas ao Loki. E' independente da coleta: a coleta
/// (controlada por `providers.<ia>.habilitado`) continua acontecendo para
/// alimentar o tray, a barra e o widget; estes campos so' decidem se o resultado
/// e' enviado ao Loki.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct EnvioConfig {
    /// Pausa geral do envio. Mesmo pausado, a coleta continua; so' o envio ao Loki
    /// e' suspenso. Persistido para sobreviver a reinicios; sincronizado com o
    /// snapshot em memoria (fonte usada pelo worker) e refletido no menu do tray.
    pausado: bool,
    /// Envia as metricas do Claude ao Loki. Com `false`, o Claude continua sendo
    /// coletado e exibido, mas nao e' enviado.
    claude: bool,
    /// Envia as metricas do Codex ao Loki. Com `false`, o Codex continua sendo
    /// coletado e exibido, mas nao e' enviado.
    codex: bool,
}

impl Default for EnvioConfig {
    fn default() -> Self {
        Self {
            pausado: false,
            claude: true,
            codex: true,
        }
    }
}

/// Preferencias da tela "Uso atual". Por enquanto so' o liga/desliga do mini
/// grafico de linha (historico das ultimas 5h). Gerenciado pelo toggle da propria
/// tela (comando `set_usage_chart`), nao pelo painel de Configuracoes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct UsoAtualConfig {
    /// Exibe o mini grafico abaixo de cada janela. Com `false`, o grafico some da
    /// tela e o backend para de gravar (e limpa) o historico em memoria.
    grafico: bool,
    /// Mostrar o aviso "os dados serao perdidos" ao desabilitar o grafico. Vira
    /// `false` quando o usuario marca "Nao perguntar novamente".
    avisar_ao_desligar: bool,
}

impl Default for UsoAtualConfig {
    fn default() -> Self {
        Self {
            grafico: true,
            avisar_ao_desligar: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TaskbarConfig {
    /// Lado da barra onde o widget e' ancorado: "direita" (padrao) ou
    /// "esquerda". O calculo que "adivinha" a posicao e' espelhado conforme o
    /// lado; "esquerda" e' util quando o menu Iniciar esta centralizado (deixa a
    /// ponta esquerda livre). O `deslocamento` continua valendo em ambos. Em
    /// outros sistemas operacionais o campo e' ignorado (widget so existe no
    /// Windows).
    lado: String,
    /// Desloca o widget na barra de tarefas (px). Negativo = para a esquerda;
    /// positivo = para a direita. Util para nao sobrepor toolbars/deskbands
    /// (ex.: atalhos de pasta no Windows 10 -> use um valor negativo).
    deslocamento: i32,
    /// Tamanho da fonte em pontos (padrao 9). Limitado a 6..=24.
    tamanho_fonte: u32,
    /// Cor da fonte: "auto" (padrao, preto/branco conforme a cor da barra) ou um
    /// hex "#RRGGBB" (ex.: "#FFD700"). Valores invalidos voltam a "auto".
    cor_fonte: String,
    /// Como exibir o reset no widget: "restante" (padrao, tempo regressivo ex.:
    /// "2:36h") ou "exato" (hora/data do reset ex.: "19:20" ou "22/06, 19:59").
    formato_reset: String,
    /// Quais janelas mostrar na barra: "ambos" (padrao), "sessao" (so 5h) ou
    /// "semanal" (so 7d). Com uma so' janela, o separador "|" some.
    janelas: String,
}

impl Default for TaskbarConfig {
    fn default() -> Self {
        Self {
            lado: "direita".to_string(),
            deslocamento: 0,
            tamanho_fonte: 9,
            cor_fonte: "auto".to_string(),
            formato_reset: "restante".to_string(),
            janelas: "ambos".to_string(),
        }
    }
}

#[cfg(target_os = "windows")]
impl TaskbarConfig {
    /// `true` se o lado configurado e' a esquerda (aceita variacoes comuns).
    fn lado_esquerdo(&self) -> bool {
        matches!(
            self.lado.trim().to_ascii_lowercase().as_str(),
            "esquerda" | "esquerdo" | "left" | "e"
        )
    }

    /// `true` se o reset deve ser exibido como hora/data exata em vez do tempo
    /// restante (aceita variacoes comuns).
    fn mostrar_hora_reset(&self) -> bool {
        matches!(
            self.formato_reset.trim().to_ascii_lowercase().as_str(),
            "exato" | "exata" | "hora" | "horario" | "data" | "absoluto"
        )
    }

    /// Tamanho da fonte em pontos, com limites sensatos (6..=24); 0/ausente -> 9.
    fn tamanho_fonte_pt(&self) -> i32 {
        let pt = self.tamanho_fonte as i32;
        if pt <= 0 {
            9
        } else {
            pt.clamp(6, 24)
        }
    }

    /// Cor da fonte como `(r, g, b)`, ou `None` para automatico (preto/branco
    /// conforme a cor real da barra). Aceita "#RRGGBB" ou "RRGGBB".
    fn cor_fonte_rgb(&self) -> Option<(u8, u8, u8)> {
        let texto = self.cor_fonte.trim().trim_start_matches('#');
        if texto.is_empty() || texto.eq_ignore_ascii_case("auto") || texto.len() != 6 {
            return None;
        }
        let r = u8::from_str_radix(&texto[0..2], 16).ok()?;
        let g = u8::from_str_radix(&texto[2..4], 16).ok()?;
        let b = u8::from_str_radix(&texto[4..6], 16).ok()?;
        Some((r, g, b))
    }
}

/// Widget flutuante na area de trabalho (janela `widget`, sem moldura, sempre na
/// frente). Existe em Windows/Linux; ignorado em macOS (transparencia exigiria
/// `macos-private-api`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WidgetConfig {
    /// Exibe o widget na area de trabalho. Padrao desligado.
    habilitado: bool,
    /// Mostra o card do Claude no widget (alem de o provider estar habilitado).
    mostra_claude: bool,
    /// Mostra o card do Codex no widget (alem de o provider estar habilitado).
    mostra_codex: bool,
    /// Caminho do arquivo de imagem/gif usado como fundo. Vazio = sem fundo.
    fundo: String,
    /// Mantem o widget sempre na frente das outras janelas. Padrao ligado.
    sempre_na_frente: bool,
    /// Opacidade do painel em 0..=100 (padrao 90). Deixa o fundo aparecer.
    opacidade: u32,
    /// Quais janelas mostrar nos cards: "ambos" (padrao), "sessao" (so 5h) ou
    /// "semanal" (so 7d).
    janelas: String,
    /// Como exibir o reset nos cards: "restante" (padrao, tempo regressivo),
    /// "exato" (hora/data do reset) ou "nenhum" (oculta o reset).
    formato_reset: String,
    /// Modo de exibicao de cada provedor: "completo" (padrao, cards com barras),
    /// "minimo" (uma linha por provedor) ou "anelduplo" (aneis concentricos).
    modo: String,
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            habilitado: false,
            mostra_claude: true,
            mostra_codex: true,
            fundo: String::new(),
            sempre_na_frente: true,
            opacidade: 90,
            janelas: "ambos".to_string(),
            formato_reset: "restante".to_string(),
            modo: "completo".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LokiConfig {
    url: String,
}

/// Provedores conhecidos, na ordem canônica (padrão e base da normalização de
/// `providers.ordem`). Ao adicionar um novo provedor no futuro, inclua a chave
/// aqui — ele passa a ter card/slot e entra no fim da ordem por padrão.
const PROVIDER_KEYS: [&str; 2] = ["claude", "codex"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProvidersConfig {
    codex: CodexConfig,
    claude: ClaudeConfig,
    /// Ordem de exibição dos provedores (esquerda→direita / cima→baixo), aplicada
    /// à tela "Uso atual", ao widget e à barra de tarefas (uma config para as três).
    /// Lista de chaves de `PROVIDER_KEYS`; `normalize_config` garante que contenha
    /// exatamente os provedores conhecidos, sem duplicatas.
    ordem: Vec<String>,
}

impl Default for ProvidersConfig {
    fn default() -> Self {
        Self {
            codex: CodexConfig::default(),
            claude: ClaudeConfig::default(),
            ordem: PROVIDER_KEYS.iter().map(|key| key.to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CodexConfig {
    habilitado: bool,
    /// Mostra este provider no widget da barra de tarefas (somente Windows).
    /// Em outros sistemas operacionais o campo e lido mas ignorado, pois o
    /// widget da barra so existe no Windows.
    mostra_na_taskbar_windows: bool,
    auth_json_path: String,
    /// Modo de autenticacao do Codex: "arquivo" (padrao; usa `auth_json_path`) ou
    /// "navegador" (login OAuth pelo navegador; tokens no arquivo gerenciado
    /// `codex-auth.json`, ver `codex_auth`). Valores desconhecidos = "arquivo".
    auth_mode: String,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            habilitado: true,
            mostra_na_taskbar_windows: true,
            auth_json_path: String::new(),
            auth_mode: "arquivo".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ClaudeConfig {
    habilitado: bool,
    /// Mostra este provider no widget da barra de tarefas (somente Windows).
    /// Em outros sistemas operacionais o campo e lido mas ignorado, pois o
    /// widget da barra so existe no Windows.
    mostra_na_taskbar_windows: bool,
    organization_id: String,
    cookie: String,
    /// Modo de autenticacao do Claude: "manual" (padrao; usa `organization_id` +
    /// `cookie`) ou "navegador" (login pelo navegador; sessao + org no arquivo
    /// gerenciado `claude-auth.json`, ver `claude_auth`). Desconhecido = "manual".
    auth_mode: String,
    /// Reabertura automatica da janela de sessao (5h). Ver `SessaoAutoConfig`.
    sessao_auto: SessaoAutoConfig,
}

impl Default for ClaudeConfig {
    fn default() -> Self {
        Self {
            habilitado: true,
            mostra_na_taskbar_windows: true,
            organization_id: String::new(),
            cookie: String::new(),
            auth_mode: "manual".to_string(),
            sessao_auto: SessaoAutoConfig::default(),
        }
    }
}

/// Reabertura automatica da janela de sessao (5h) do Claude.
///
/// A cota da assinatura e' contada em janelas de 5h que so' comecam quando voce
/// manda a primeira mensagem — enquanto nao ha' janela aberta, a API devolve
/// `five_hour.resets_at: null`. Quem quer aproveitar o dia inteiro precisa abrir
/// a janela na mao ("Oi") toda vez que a anterior expira. Com isto ligado, o app
/// percebe que nao ha' janela e manda essa mensagem sozinho.
///
/// Dois modos, ambos exigindo que a coleta diga que **nao ha' janela aberta**
/// (mandar "Oi" com janela aberta nao reinicia a contagem, so' gasta cota):
/// - `automatico`: dispara assim que a janela anterior expira;
/// - `agendado`: dispara so' nos `horarios` escolhidos (hora local, todos os dias).
///   E' "no horario", nao "depois dele": horario perdido (app fechado ou janela
///   ainda aberta naquele momento) nao e' recuperado — espera-se o proximo.
///
/// O disparo usa o **Claude Code CLI** (`claude -p`), que autentica pelo OAuth da
/// assinatura em `~/.claude` — ou seja, consome a mesma cota que o app mede. Uma
/// chave `ANTHROPIC_API_KEY` no ambiente desviaria a chamada para a API paga (pool
/// separado, que nao abre janela nenhuma), entao ela e' removida do processo filho.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SessaoAutoConfig {
    /// Desligado por padrao: a funcao age na conta do usuario e consome cota,
    /// entao so' roda com opt-in explicito nas Configuracoes.
    habilitado: bool,
    /// Quando disparar: `"automatico"` (padrao; assim que a janela anterior
    /// expira) ou `"agendado"` (so' nos `horarios`). Desconhecido = "automatico".
    modo: String,
    /// Horarios do modo agendado, em `"HH:MM"` de **hora local**, validos todos os
    /// dias. Normalizados (ordenados, sem duplicatas, invalidos descartados) em
    /// `normalize_config`. Vazio no modo agendado = nunca dispara.
    horarios: Vec<String>,
    /// Caminho do executavel do Claude Code CLI. Vazio = descobrir sozinho
    /// (ver `resolve_claude_cli`). Serve de escape para instalacoes fora do PATH
    /// do processo do app — comum quando ele sobe pelo autostart.
    caminho_cli: String,
}

impl Default for SessaoAutoConfig {
    fn default() -> Self {
        Self {
            habilitado: false,
            modo: SESSAO_AUTO_MODO_AUTOMATICO.to_string(),
            horarios: Vec::new(),
            caminho_cli: String::new(),
        }
    }
}

/// Modo padrao: reage ao fim da janela, sem horario fixo.
const SESSAO_AUTO_MODO_AUTOMATICO: &str = "automatico";
/// Modo em que a reabertura so' acontece nos horarios escolhidos pelo usuario.
const SESSAO_AUTO_MODO_AGENDADO: &str = "agendado";

/// Mensagem que abre a janela. Fixa: o objetivo e' so' carimbar o inicio da
/// janela, nao obter uma resposta util — e quanto mais curta, menos cota consome.
const SESSAO_AUTO_MENSAGEM: &str = "Oi";

/// Ajustes validos so' para o disparo. O `--settings` do CLI **acrescenta** aos do
/// usuario em vez de substitui-los, entao o modelo que ele escolheu continua
/// valendo: aqui so' o esforco e' rebaixado.
///
/// Por que isso importa: o `claude -p` herda o `~/.claude/settings.json`, e num
/// perfil de uso diario o `effortLevel` costuma estar alto. Um "Oi" respondido com
/// raciocinio estendido gera um bloco grande de tokens de saida — os que mais
/// pesam na cota da janela de 5h — e o disparo passa a consumir vaias vezes o que
/// a mensagem sugere. Abrir a janela nao precisa de raciocinio nenhum.
///
/// O modelo NAO e' fixado de proposito: um nome cravado aqui (ainda que um alias)
/// e' uma escolha do app sobre algo que e' do usuario, e sai do ar sem aviso.
///
/// Vai para o CLI como **arquivo**, nunca como JSON na linha de comando: no
/// Windows o `claude` costuma ser o shim `claude.cmd` do npm, e um argumento com
/// aspas atravessa o `cmd.exe` corrompido — `{"effortLevel":"low"}` chega como
/// `{"effortLevel:low}` colado no argumento seguinte, e o disparo morre com
/// "Settings file not found". Caminho de arquivo passa intacto pelo shim, com
/// espacos e tudo. Ver `escreve_settings_do_disparo`.
const SESSAO_AUTO_SETTINGS: &str = r#"{"effortLevel":"low"}"#;

/// Nome do arquivo gravado a cada disparo com o `SESSAO_AUTO_SETTINGS`.
const SESSAO_AUTO_SETTINGS_ARQUIVO: &str = "settings-disparo.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UsageMetric {
    usuario: String,
    ferramenta: String,
    // Janela de sessao (5h). Opcional: contas cujo plano so' expõe a janela semanal
    // (7d) nao tem janela de sessao, e a UI mostra "Sem dados desta janela".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uso_percentual: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restante_percentual: Option<f64>,
    status: String,
    coletado_em: String,
    reset_em: Option<String>,
    erro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uso_percentual_7d: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restante_percentual_7d: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reset_em_7d: Option<String>,
}

#[derive(Debug, Clone)]
struct RuntimePaths {
    config_dir: PathBuf,
    config_file: PathBuf,
    logs_dir: PathBuf,
}

#[derive(Debug, Clone, Default)]
struct RuntimeSnapshot {
    paused: bool,
    last_error: Option<String>,
    last_successful_send_at: Option<String>,
    codex_metric: Option<UsageMetric>,
    claude_metric: Option<UsageMetric>,
    /// Historico curto dos ultimos envios (anel), exibido na tela "Envio de dados"
    /// em tempo (quase) real. Mais novos no fim; limitado a `SEND_LOG_MAX`.
    send_log: Vec<SendLogEntry>,
    /// Amostras do uso ao longo do tempo (anel em memoria), para os mini-graficos
    /// de linha da tela "Uso atual". Mais novas no fim; podadas para as ultimas
    /// `USAGE_HISTORY_WINDOW_SECS`. So' vive enquanto o app roda (sem disco).
    usage_history: Vec<UsageSample>,
}

/// Uma entrada do historico de envios: quando, qual ferramenta e o resultado.
#[derive(Debug, Clone, Serialize)]
struct SendLogEntry {
    /// ISO-8601 (RFC 3339) em UTC do momento do envio.
    timestamp: String,
    /// "claude" ou "codex".
    ferramenta: String,
    /// "sucesso" ou "falha".
    status: String,
    /// Mensagem de erro quando `status` e' "falha"; `None` no sucesso.
    detalhe: Option<String>,
    /// Payload (dados) efetivamente enviado ao Loki, presente nos envios com
    /// sucesso — para o historico mostrar quais dados foram enviados. `None` nas
    /// falhas.
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
}

/// Quantas entradas de envio manter no anel em memoria.
const SEND_LOG_MAX: usize = 50;

/// Uma amostra do uso num instante, para os mini-graficos de linha da tela "Uso
/// atual". Cada campo e' a % daquela janela (sessao 5h / semanal 7d) de cada
/// provedor, ou `None` quando o provedor estava desabilitado/com erro naquele
/// momento (a UI trata `None` como "sem ponto").
#[derive(Debug, Clone, Serialize)]
struct UsageSample {
    /// ISO-8601 (RFC 3339) em UTC do momento da coleta.
    t: String,
    claude_5h: Option<f64>,
    claude_7d: Option<f64>,
    codex_5h: Option<f64>,
    codex_7d: Option<f64>,
}

/// Janela do historico dos mini-graficos: ultimas 5 horas (a mesma janela da
/// sessao). Por escolha de produto, tanto o grafico da sessao quanto o semanal
/// mostram apenas este intervalo — o historico e' so' em memoria (some ao fechar).
const USAGE_HISTORY_WINDOW_SECS: i64 = 5 * 60 * 60;
/// Teto de amostras no anel (rede de seguranca contra relogio irregular); a 5s de
/// intervalo, 5h dao' ~3600 pontos.
const USAGE_HISTORY_MAX: usize = 6000;
/// Quantos pontos, no maximo, cada serie devolve para a UI (reduzida por stride).
const USAGE_CHART_POINTS: usize = 120;

/// Dados da atualizacao disponivel detectada por `check_for_updates`, consumidos
/// pela janela de novidades (`update.html`) via `get_pending_update`. Guardamos
/// so' strings (nao o objeto `Update`, pesado): a instalacao re-verifica.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct PendingUpdate {
    app_name: String,
    current_version: String,
    new_version: String,
    notes: String,
}

struct SharedState {
    snapshot: Mutex<RuntimeSnapshot>,
    cycle_lock: Mutex<()>,
    stop: AtomicBool,
    /// Ha' uma coleta forcada ("Atualizar agora") em andamento. Coalesce cliques
    /// repetidos para nao empilhar varios ciclos no `cycle_lock`.
    force_pending: AtomicBool,
    /// Ultima atualizacao detectada, exibida pela janela `update.html`.
    pending_update: Mutex<Option<PendingUpdate>>,
    /// Reabertura automatica da sessao do Claude: cooldown + resultado da ultima
    /// tentativa (exibido na aba Claude das Configuracoes).
    sessao_auto: Mutex<SessaoAutoState>,
}

/// Estado em memoria da reabertura automatica. Nao vai para o disco: e' so' o
/// suficiente para nao disparar duas vezes seguidas e para a UI dizer o que
/// aconteceu na ultima tentativa.
#[derive(Debug, Default)]
struct SessaoAutoState {
    /// Quando a ultima tentativa comecou. Base do cooldown.
    last_attempt: Option<Instant>,
    /// Ultimo horario agendado que ja' disparou, como `(data local, minuto do dia)`.
    /// Impede que a folga do horario (ver `sessao_auto_slot_devido`) renda duas
    /// tentativas para o mesmo horario.
    last_slot: Option<(NaiveDate, u32)>,
    /// Ha' uma chamada ao CLI em andamento (ela roda fora do ciclo de coleta).
    running: bool,
    status: SessaoAutoStatus,
}

/// Resultado da ultima tentativa de reabrir a sessao, exposto a' UI.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessaoAutoStatus {
    /// RFC 3339 (UTC) do inicio da ultima tentativa. `None` = nunca tentou.
    ultima_tentativa_em: Option<String>,
    /// `true` quando a ultima tentativa terminou sem erro.
    ultimo_ok: Option<bool>,
    /// Motivo da falha da ultima tentativa; `None` quando deu certo.
    ultimo_erro: Option<String>,
    /// Ha' uma chamada ao CLI em andamento. A UI usa para mostrar "Testando…" e
    /// saber quando parar de consultar o resultado.
    em_execucao: bool,
}

/// Trava o estado da reabertura automatica, recuperando de envenenamento — mesma
/// estrategia de `lock_snapshot`.
fn lock_sessao_auto(shared: &SharedState) -> std::sync::MutexGuard<'_, SessaoAutoState> {
    shared
        .sessao_auto
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Trava o snapshot recuperando de um eventual envenenamento do Mutex (panic
/// anterior segurando o lock). Evita que um unico panic derrube todas as
/// atualizacoes seguintes — mesma estrategia que o `taskbar_widget` ja' adota.
fn lock_snapshot(shared: &SharedState) -> std::sync::MutexGuard<'_, RuntimeSnapshot> {
    shared
        .snapshot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reseta um flag atomico de "em andamento" ao sair do escopo, inclusive em
/// panic. Garante que `force_pending` nunca fique preso em `true` (o que
/// bloquearia novos cliques de "Atualizar agora").
struct FlagGuard<'a>(&'a AtomicBool);

impl Drop for FlagGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Handles dos itens dinamicos do menu do tray, para atualiza-los no lugar
/// (set_text/set_checked/set_enabled) em vez de reconstruir o menu — assim o
/// menu nao fecha sozinho quando atualizamos a cada ciclo de coleta.
struct TrayMenuItems<R: Runtime> {
    toggle_pause: MenuItem<R>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeAuth {
    openai: Option<OpenAiAccess>,
    tokens: Option<OpenAiTokens>,
}

#[derive(Debug, Deserialize)]
struct OpenAiAccess {
    access: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiTokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsageResponse {
    rate_limit: Option<OpenAiRateLimit>,
}

#[derive(Debug, Deserialize)]
struct OpenAiRateLimit {
    primary_window: Option<OpenAiWindow>,
    secondary_window: Option<OpenAiWindow>,
}

/// Uma janela de limite do Codex. A POSICAO (primary/secondary) NAO e' confiavel:
/// a OpenAI suspendeu temporariamente o limite de sessao (5h) e passou a devolver
/// so' o semanal (7d) em `primary_window`, com `secondary_window` ausente. Por isso
/// classificamos cada janela pela duracao (`limit_window_seconds`): ~5h -> sessao;
/// ~7d -> semanal. Assim volta a funcionar sozinho se/quando o 5h retornar.
#[derive(Debug, Deserialize)]
struct OpenAiWindow {
    used_percent: Option<f64>,
    reset_at: Option<i64>,
    limit_window_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsageResponse {
    five_hour: Option<ClaudeFiveHour>,
    seven_day: Option<ClaudeSevenDay>,
}

#[derive(Debug, Deserialize)]
struct ClaudeFiveHour {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeSevenDay {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            usuario: String::new(),
            intervalo_segundos: 10,
            loki: LokiConfig::default(),
            providers: ProvidersConfig::default(),
            barra_tarefas: TaskbarConfig::default(),
            widget: WidgetConfig::default(),
            envio: EnvioConfig::default(),
            servidor: ServerConfig::default(),
            uso_atual: UsoAtualConfig::default(),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            // Persiste POSICAO e SIZE das janelas `widget` e `main` (o usuario pode
            // redimensiona-las). A `main` restaura o estado na criacao e salva ao
            // fechar (ver show_main_window). So' a janela transitoria de novidades
            // (`update`) fica de fora.
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["update"])
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            usage_dashboard::get_stats,
            get_codex_stats,
            get_settings,
            save_settings,
            get_usage,
            force_collect,
            get_widget_state,
            read_widget_background,
            pick_widget_background,
            show_app_menu,
            get_envio_state,
            set_envio_paused,
            set_envio_provider,
            clear_send_log,
            set_usage_chart,
            set_providers_order,
            check_updates_now,
            get_pending_update,
            install_update,
            get_changelog,
            check_update_status,
            open_update_window,
            open_external,
            codex_login,
            codex_auth_status,
            codex_logout,
            codex_login_cancel,
            pick_codex_auth_file,
            claude_login,
            claude_auth_status,
            claude_logout,
            claude_login_cancel,
            claude_select_org
        ])
        .setup(|app| {
            // Janela unica do app (Dashboard + Configuracoes) e' criada sob demanda
            // em show_main_window (tray-only). Fechar pela X destroi a janela e
            // libera o WebView2 (~140 MB); reabrir recria. O app continua vivo no
            // tray porque prevent_exit no run loop impede a saida ao fechar a ultima
            // janela.

            let paths = ensure_storage()?;
            // Garante que o config.json exista e esteja normalizado (campos
            // novos preenchidos com o padrao) ja na inicializacao. A preferencia
            // de exibir na barra de tarefas e lida da config sob demanda.
            let initial_config = load_or_create_config(&paths)?;

            // A pausa do envio e' persistida no config.json; carrega o estado
            // salvo para o snapshot em memoria (fonte usada pelo worker e pelo
            // tray), para sobreviver a reinicios.
            let initial_snapshot = RuntimeSnapshot {
                paused: initial_config.envio.pausado,
                ..RuntimeSnapshot::default()
            };

            let shared = Arc::new(SharedState {
                snapshot: Mutex::new(initial_snapshot),
                cycle_lock: Mutex::new(()),
                stop: AtomicBool::new(false),
                force_pending: AtomicBool::new(false),
                pending_update: Mutex::new(None),
                sessao_auto: Mutex::new(SessaoAutoState::default()),
            });

            app.manage(paths.clone());
            app.manage(shared.clone());

            // Autostart: liga por padrao na primeira execucao (marcada por um
            // arquivo). Nas execucoes seguintes, se continuar ligado, reaplica
            // para manter o caminho do executavel atualizado; se o usuario tiver
            // desligado pelo menu, fica desligado.
            let autostart_marker = paths.config_dir.join("autostart_initialized");
            if !autostart_marker.exists() {
                let _ = app.autolaunch().enable();
                let _ = fs::write(&autostart_marker, "1");
            } else if app.autolaunch().is_enabled().unwrap_or(false) {
                let _ = app.autolaunch().enable();
            }

            create_tray(app)?;

            #[cfg(target_os = "windows")]
            {
                // Clicar no widget da barra abre a janela do app (mesma acao do
                // clique esquerdo no tray). A thread do widget nao tem o
                // AppHandle, entao registramos um callback; ele despacha para a
                // main thread, onde as operacoes de janela sao seguras.
                let app_handle = app.handle().clone();
                taskbar_widget::set_on_activate(move || {
                    let handle = app_handle.clone();
                    let _ = app_handle.run_on_main_thread(move || show_main_window(&handle));
                });

                // Clique direito no widget da barra: roteia o item escolhido para
                // o mesmo tratador do menu do tray, na main thread.
                let app_handle_menu = app.handle().clone();
                taskbar_widget::set_on_menu_command(move |id| {
                    let handle = app_handle_menu.clone();
                    let id = id.to_string();
                    let _ =
                        app_handle_menu.run_on_main_thread(move || handle_menu_event(&handle, &id));
                });

                taskbar_widget::start();
            }

            // Abre o widget no boot se estiver habilitado na config.
            if let Ok(config) = load_or_create_config(&paths) {
                apply_widget(app.handle(), &config);
            }

            refresh_tray(app.handle(), &shared)?;
            start_worker(app.handle().clone(), paths.clone(), shared.clone());

            // Sobe o servidor HTTP dos dashboards se estiver habilitado na config.
            http_server::apply(app.handle());

            // Checagem de atualizacao no boot, em segundo plano. Silenciosa quando
            // nao ha update; se houver, pergunta antes de baixar/instalar.
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(check_for_updates(update_handle, false));

            Ok(())
        })
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if code.is_none() {
                    // Saida disparada por fechar a ultima janela (X do dashboard):
                    // o app e' tray-only, entao impede a saida e segue rodando.
                    api.prevent_exit();
                } else if let Some(state) = app_handle.try_state::<Arc<SharedState>>() {
                    // Saida real (menu "Sair" -> app.exit): sinaliza o worker.
                    state.stop.store(true, Ordering::Relaxed);
                }
            }
        });
}

/// Corpo do POST de configuracoes: o config.json completo mais a preferencia de
/// autostart (que nao mora no config.json, e' gerenciada pelo plugin).
#[derive(Debug, Deserialize)]
struct SaveSettings {
    config: AppConfig,
    #[serde(default)]
    autostart: bool,
}

/// Estado exposto ao painel de configuracoes: o config.json (normalizado), a
/// preferencia de autostart, o SO e o rotulo do autostart (para a UI).
fn settings_value<R: Runtime>(app: &AppHandle<R>, paths: &RuntimePaths) -> Value {
    let config = read_config(paths);
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    // Resultado da ultima reabertura automatica de sessao, para a aba Claude
    // mostrar se funcionou (e o porque quando nao). Vive so' em memoria, entao
    // pode nao existir ainda (app recem-aberto).
    let sessao_auto_status = app
        .try_state::<Arc<SharedState>>()
        .map(|shared| lock_sessao_auto(&shared).status.clone())
        .unwrap_or_default();

    let mut value = json!({
        "autostart": autostart,
        "os": std::env::consts::OS,
        "autostartLabel": autostart_label(),
        "appVersion": app.package_info().version.to_string(),
        "sessaoAutoStatus": sessao_auto_status,
    });
    value["config"] = serde_json::to_value(&config).unwrap_or(Value::Null);
    value
}

fn autostart_label() -> &'static str {
    "Iniciar com o sistema"
}

/// Liga/desliga o autostart so' quando o estado pedido difere do atual.
fn apply_autostart<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let manager = app.autolaunch();
    let currently = manager.is_enabled().unwrap_or(false);
    if enabled != currently {
        let _ = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
    }
}

/// Le o estado atual (config + autostart) para preencher o painel.
#[tauri::command]
fn get_settings(app: AppHandle, paths: State<'_, RuntimePaths>) -> Value {
    settings_value(&app, paths.inner())
}

/// Grava o config.json e aplica o autostart, devolvendo o estado ja' normalizado.
/// A normalizacao (clamp de intervalo/fonte, validacao de cor) acontece na
/// releitura; o worker detecta a mudanca pelo mtime e aplica tray/barra em ~1s.
#[tauri::command]
fn save_settings(
    app: AppHandle,
    paths: State<'_, RuntimePaths>,
    settings: SaveSettings,
) -> Result<Value, String> {
    let mut config = settings.config;

    // Campos gerenciados fora do painel de Configuracoes: `envio` (tela "Envio de
    // dados"), `uso_atual` (toggle da tela "Uso atual") e `providers.ordem` (arrastar
    // na tela "Uso atual"). O painel nao envia esses campos, entao chegariam aqui com
    // os defaults e sobrescreveriam a escolha do usuario. Preserva o disco. Obs.: o
    // painel manda o resto de `providers` (claude/codex), por isso preservamos so' o
    // sub-campo `ordem`, nao o bloco `providers` inteiro.
    let disk = read_config(paths.inner());
    config.envio = disk.envio;
    config.uso_atual = disk.uso_atual;
    config.providers.ordem = disk.providers.ordem;
    normalize_config(&mut config);

    write_config(paths.inner(), &config)
        .map_err(|error| format!("falha ao salvar config.json: {error}"))?;
    apply_autostart(&app, settings.autostart);
    // (Re)aplica o servidor HTTP dos dashboards: liga/desliga e re-bind conforme o
    // host/porta/PIN recem-salvos (idempotente; invalida sessoes antigas).
    http_server::apply(&app);
    Ok(settings_value(&app, paths.inner()))
}

/// Estado de uso exposto a' tela "Uso atual": as metricas atuais de cada
/// provider (a mesma fonte do tray e da barra de tarefas), mais se cada um esta'
/// habilitado e se a coleta esta' pausada. Nao faz rede: le' apenas o snapshot
/// ja' coletado pelo worker.
fn usage_value(paths: &RuntimePaths, shared: &Arc<SharedState>) -> Value {
    // Le' o config fora do lock (faz I/O de disco); depois trava o snapshot so' o
    // tempo de montar as series do historico (downsample, sem I/O) e clonar as duas
    // metricas — sem clonar o anel inteiro de amostras.
    let config = read_config(paths);
    let chart_enabled = config.uso_atual.grafico;
    let (paused, last_error, claude_metric, codex_metric, history) = {
        let snapshot = lock_snapshot(shared);
        // Com o grafico desligado, devolve series vazias (o anel ja' e' limpo no
        // worker; aqui garante que a UI nunca receba pontos residuais).
        let history = if chart_enabled {
            json!({
                "claude": {
                    "session": downsample_usage(&snapshot.usage_history, |s| s.claude_5h),
                    "weekly": downsample_usage(&snapshot.usage_history, |s| s.claude_7d),
                },
                "codex": {
                    "session": downsample_usage(&snapshot.usage_history, |s| s.codex_5h),
                    "weekly": downsample_usage(&snapshot.usage_history, |s| s.codex_7d),
                },
            })
        } else {
            json!({
                "claude": { "session": [], "weekly": [] },
                "codex": { "session": [], "weekly": [] },
            })
        };
        (
            snapshot.paused,
            snapshot.last_error.clone(),
            snapshot.claude_metric.clone(),
            snapshot.codex_metric.clone(),
            history,
        )
    };
    json!({
        "paused": paused,
        "lastError": last_error,
        "chartEnabled": chart_enabled,
        "chartWarnOnDisable": config.uso_atual.avisar_ao_desligar,
        "ordem": config.providers.ordem,
        "claude": {
            "habilitado": config.providers.claude.habilitado,
            "metric": claude_metric,
        },
        "codex": {
            "habilitado": config.providers.codex.habilitado,
            "metric": codex_metric,
        },
        "history": history,
    })
}

/// Le' o uso atual (snapshot) para a tela "Uso atual". Barato e sem rede; pode
/// ser chamado ao abrir/focar a janela.
#[tauri::command]
fn get_usage(paths: State<'_, RuntimePaths>, shared: State<'_, Arc<SharedState>>) -> Value {
    usage_value(paths.inner(), shared.inner())
}

/// Forca uma coleta nova ("Atualizar agora") e devolve o uso ja' atualizado, para
/// a tela mostrar o resultado assim que termina. Roda em `spawn_blocking` para nao
/// travar a main thread: a coleta usa rede sincrona (ate' ~15s de timeout). O erro
/// do ciclo, se houver, ja' fica refletido no proprio snapshot (status/erro por
/// provider). Respeita as regras de envio: com o envio pausado/desabilitado,
/// atualiza os dados/UI **sem** enviar ao Loki (o envio so' ocorre com o envio
/// ativo).
#[tauri::command]
async fn force_collect(app: AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = app.state::<RuntimePaths>().inner().clone();
        let shared = app.state::<Arc<SharedState>>().inner().clone();
        // Coalesce: se ja' ha' uma coleta forcada em andamento, devolve o snapshot
        // atual sem empilhar outro ciclo no cycle_lock.
        if shared.force_pending.swap(true, Ordering::SeqCst) {
            return usage_value(&paths, &shared);
        }
        let _guard = FlagGuard(&shared.force_pending);
        // "Atualizar agora" forca uma coleta nova respeitando as regras de envio
        // (pausa + config.envio); nao e' um envio manual forcado.
        let _ = run_collection_cycle(&app, &paths, &shared);
        usage_value(&paths, &shared)
    })
    .await
    .unwrap_or_else(|error| json!({ "error": error.to_string() }))
}

/// Historico diario de uso do Codex para a tela "Dashboard Codex". Faz uma
/// chamada de rede (analytics do backend do ChatGPT) usando o mesmo token do
/// `auth.json` da coleta; por isso roda em `spawn_blocking` (reqwest sincrono).
/// `days` e' o tamanho da janela (ex.: 7 ou 30) terminando hoje; `start`/`end`
/// (opcionais) definem um range personalizado. Em falha, devolve
/// `{ "error": "..." }` para a tela exibir a mensagem.
#[tauri::command]
async fn get_codex_stats(
    app: AppHandle,
    days: u32,
    start: Option<String>,
    end: Option<String>,
) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = app.state::<RuntimePaths>().inner().clone();
        collect_codex_stats(&paths, days, start, end)
    })
    .await
    .unwrap_or_else(|error| json!({ "error": error.to_string() }))
}

/// Coleta o historico de uso do Codex (rede): le' o `auth_json_path` do config e
/// delega para `codex_dashboard::collect` com o cliente HTTP compartilhado.
/// Compartilhado pelo comando nativo `get_codex_stats` e pelo handler HTTP, que
/// antes duplicavam esta logica.
pub(crate) fn collect_codex_stats(
    paths: &RuntimePaths,
    days: u32,
    start: Option<String>,
    end: Option<String>,
) -> Value {
    let config = read_config(paths);
    let client = http_client();
    let auth_path = match resolve_codex_auth_file(&client, &config, paths) {
        Ok(path) => path,
        Err(error) => return json!({ "error": error }),
    };
    codex_dashboard::collect(&client, &auth_path.to_string_lossy(), days, start, end)
}

/// Estado exposto a' tela "Envio de dados": pausa geral, envio por provider
/// (config.envio), se cada provider esta' habilitado (coleta), a cadencia, o
/// ultimo envio bem-sucedido, se o Loki esta' configurado e o historico de
/// envios. Sem rede: le' o snapshot ja' coletado e o config.json.
fn envio_value(paths: &RuntimePaths, shared: &Arc<SharedState>) -> Value {
    let (paused, last_success, log) = {
        let snapshot = lock_snapshot(shared);
        let log: Vec<&SendLogEntry> = snapshot.send_log.iter().rev().collect();
        (
            snapshot.paused,
            snapshot.last_successful_send_at.clone(),
            serde_json::to_value(&log).unwrap_or(Value::Null),
        )
    };
    let config = read_config(paths);
    json!({
        "paused": paused,
        "intervaloSegundos": config.intervalo_segundos,
        "lastSuccessAt": last_success,
        "lokiConfigurado": !config.loki.url.trim().is_empty(),
        "claude": {
            "habilitado": config.providers.claude.habilitado,
            "enviar": config.envio.claude,
        },
        "codex": {
            "habilitado": config.providers.codex.habilitado,
            "enviar": config.envio.codex,
        },
        "log": log,
    })
}

/// Le' o estado da tela "Envio de dados". Barato e sem rede; chamado ao abrir a
/// tela e periodicamente (atualizacao quase em tempo real do historico).
#[tauri::command]
fn get_envio_state(paths: State<'_, RuntimePaths>, shared: State<'_, Arc<SharedState>>) -> Value {
    envio_value(paths.inner(), shared.inner())
}

/// Pausa ou retoma o envio (geral). Atualiza o snapshot em memoria (fonte do
/// worker e do tray) e persiste em `config.envio.pausado`, para sobreviver a
/// reinicios. Atualiza o tray na hora. Devolve o estado ja' atualizado.
#[tauri::command]
fn set_envio_paused(
    app: AppHandle,
    paths: State<'_, RuntimePaths>,
    shared: State<'_, Arc<SharedState>>,
    paused: bool,
) -> Result<Value, String> {
    apply_paused(&app, paths.inner(), shared.inner(), paused)
        .map_err(|error| format!("falha ao salvar pausa: {error}"))?;
    Ok(envio_value(paths.inner(), shared.inner()))
}

/// Liga/desliga o envio ao Loki de um provider ("claude" ou "codex"), persistindo
/// em `config.envio`. A coleta do provider nao e' afetada (continua aparecendo no
/// tray/barra/widget). Devolve o estado ja' atualizado.
#[tauri::command]
fn set_envio_provider(
    app: AppHandle,
    paths: State<'_, RuntimePaths>,
    shared: State<'_, Arc<SharedState>>,
    ferramenta: String,
    enviar: bool,
) -> Result<Value, String> {
    let mut config = read_config(paths.inner());
    match ferramenta.trim().to_ascii_lowercase().as_str() {
        "claude" => config.envio.claude = enviar,
        "codex" => config.envio.codex = enviar,
        other => return Err(format!("provider desconhecido: {other}")),
    }
    write_config(paths.inner(), &config)
        .map_err(|error| format!("falha ao salvar config.json: {error}"))?;
    let _ = refresh_tray(&app, shared.inner());
    Ok(envio_value(paths.inner(), shared.inner()))
}

/// Limpa o historico de envios em memoria. Devolve o estado ja' atualizado.
#[tauri::command]
fn clear_send_log(paths: State<'_, RuntimePaths>, shared: State<'_, Arc<SharedState>>) -> Value {
    lock_snapshot(shared.inner()).send_log.clear();
    envio_value(paths.inner(), shared.inner())
}

/// Liga/desliga o mini grafico da tela "Uso atual", persistindo em
/// `config.usoAtual.grafico`. Ao desligar, limpa o historico em memoria na hora
/// (para de gravar e "exclui os dados"). Se `dont_ask_again` vier `Some(true)`,
/// desliga tambem o aviso de perda de dados (`avisarAoDesligar`). Devolve o estado
/// de uso ja' atualizado (com `chartEnabled`/`chartWarnOnDisable` e o historico
/// refletindo a escolha).
#[tauri::command]
fn set_usage_chart(
    paths: State<'_, RuntimePaths>,
    shared: State<'_, Arc<SharedState>>,
    enabled: bool,
    dont_ask_again: Option<bool>,
) -> Result<Value, String> {
    let mut config = read_config(paths.inner());
    config.uso_atual.grafico = enabled;
    if dont_ask_again == Some(true) {
        config.uso_atual.avisar_ao_desligar = false;
    }
    write_config(paths.inner(), &config)
        .map_err(|error| format!("falha ao salvar config.json: {error}"))?;
    if !enabled {
        lock_snapshot(shared.inner()).usage_history.clear();
    }
    Ok(usage_value(paths.inner(), shared.inner()))
}

/// Define a ordem de exibição dos provedores — uma única config aplicada à tela
/// "Uso atual", ao widget e à barra de tarefas. Persiste em `config.providers.ordem`
/// (normalizada para uma permutação exata dos provedores conhecidos) e reaplica o
/// tray/barra na hora. Devolve o estado de uso já atualizado (com a nova `ordem`).
#[tauri::command]
fn set_providers_order(
    app: AppHandle,
    paths: State<'_, RuntimePaths>,
    shared: State<'_, Arc<SharedState>>,
    order: Vec<String>,
) -> Result<Value, String> {
    let mut config = read_config(paths.inner());
    config.providers.ordem = order;
    normalize_config(&mut config);
    write_config(paths.inner(), &config)
        .map_err(|error| format!("falha ao salvar config.json: {error}"))?;
    let _ = refresh_tray(&app, shared.inner());
    Ok(usage_value(paths.inner(), shared.inner()))
}

/// Aplica o estado de pausa: snapshot em memoria + persistencia em
/// `config.envio.pausado` + atualizacao do tray + log. Compartilhado pelo comando
/// da tela e pelo item do tray.
fn apply_paused<R: Runtime>(
    app: &AppHandle<R>,
    paths: &RuntimePaths,
    shared: &Arc<SharedState>,
    paused: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    lock_snapshot(shared).paused = paused;

    // Persiste em config.envio.pausado (sobrevive a reinicios).
    let mut config = read_config(paths);
    if config.envio.pausado != paused {
        config.envio.pausado = paused;
        write_config(paths, &config)?;
    }

    let _ = append_log_line(
        paths,
        "info",
        if paused {
            "Envio pausado pelo usuario."
        } else {
            "Envio retomado pelo usuario."
        },
        None,
    );
    let _ = refresh_tray(app, shared);
    Ok(())
}

/// Estado para o widget da area de trabalho: preferencias do widget mais as
/// metricas atuais (o mesmo snapshot da tela "Uso atual"). Barato e sem rede.
fn widget_state_value(paths: &RuntimePaths, shared: &Arc<SharedState>) -> Value {
    let snapshot = lock_snapshot(shared).clone();
    let config = read_config(paths);
    let widget = &config.widget;
    json!({
        "habilitado": widget.habilitado,
        "mostraClaude": widget.mostra_claude,
        "mostraCodex": widget.mostra_codex,
        "fundo": widget.fundo,
        "opacidade": widget.opacidade,
        "janelas": widget.janelas,
        "formatoReset": widget.formato_reset,
        "modo": widget.modo,
        "sempreNaFrente": widget.sempre_na_frente,
        "ordem": config.providers.ordem,
        "paused": snapshot.paused,
        "claude": {
            "habilitado": config.providers.claude.habilitado,
            "metric": snapshot.claude_metric,
        },
        "codex": {
            "habilitado": config.providers.codex.habilitado,
            "metric": snapshot.codex_metric,
        },
    })
}

/// Le' o estado do widget (preferencias + uso). Chamado periodicamente pela
/// janela do widget; barato e sem rede.
#[tauri::command]
fn get_widget_state(paths: State<'_, RuntimePaths>, shared: State<'_, Arc<SharedState>>) -> Value {
    widget_state_value(paths.inner(), shared.inner())
}

/// Le' o arquivo de fundo configurado e devolve um data URL base64 para exibir no
/// widget (funciona para imagem e gif). `None` quando nao ha' fundo ou o arquivo
/// nao pode ser lido. So' e' chamado quando o caminho do fundo muda.
#[tauri::command]
fn read_widget_background(paths: State<'_, RuntimePaths>) -> Option<String> {
    let config = read_config(paths.inner());
    let path = config.widget.fundo.trim();
    if path.is_empty() {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let mime = mime_from_path(path);
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Mime a partir da extensao do arquivo de fundo (imagens e gif).
fn mime_from_path(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

/// Abre o seletor de arquivo nativo para escolher a imagem/gif de fundo do
/// widget. Devolve o caminho escolhido, ou `None` se o usuario cancelar.
///
/// `async` de proposito: comandos sincronos do Tauri rodam na main thread, e
/// `blocking_pick_file` abriria um loop modal aninhado ali (travando o event loop
/// e o tray, e fazendo o widget reaparecer na barra de tarefas). Como `async`, o
/// comando roda fora da main thread; o `spawn_blocking` isola a chamada modal
/// numa thread de bloqueio, sem tocar na main thread.
#[tauri::command]
async fn pick_widget_background(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .add_filter(
                "Imagens e GIFs",
                &["png", "jpg", "jpeg", "gif", "webp", "bmp"],
            )
            .blocking_pick_file()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

/// Abre o seletor de arquivo nativo para escolher o `auth.json` do Codex (modo de
/// autenticacao por arquivo). Devolve o caminho, ou `None` se o usuario cancelar.
/// `async` pelo mesmo motivo de `pick_widget_background` (evitar loop modal na main
/// thread e travar o event loop/tray).
#[tauri::command]
async fn pick_codex_auth_file(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .add_filter("auth.json", &["json"])
            .add_filter("Todos os arquivos", &["*"])
            .blocking_pick_file()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

/// Abre o menu do app (mesmos itens do tray) na posicao do cursor. Chamado pelo
/// clique direito no widget da area de trabalho; reusa o mesmo menu nativo do
/// widget da barra (que ja' roteia o item escolhido para `handle_menu_event`).
/// So' Windows: em outros SOs e' um no-op.
///
/// Roda numa thread propria (NAO na main thread): `show_context_menu` abre um
/// `TrackPopupMenu`, que e' um loop modal proprio. Na main thread ele aninharia
/// no event loop do tao e deixaria a janela aberta em seguida (ex.: "Abrir") em
/// branco — o WebView2 nao inicializa nesse estado reentrante. O `TrackPopupMenu`
/// pumpa as proprias mensagens e cria a janela-dona, entao funciona fora da main
/// thread (mesmo caminho do clique direito no widget da barra). O item escolhido
/// e' despachado para a main thread pelo callback `set_on_menu_command`.
#[tauri::command]
fn show_app_menu(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        std::thread::spawn(|| unsafe { taskbar_widget::show_context_menu() });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// Cria a janela do widget (sem moldura, sempre na frente, arrastavel) carregando
/// `widget.html`. Posicao/tamanho sao restaurados pelo plugin window-state quando
/// houver estado salvo. So' existe em Windows/Linux (transparencia em macOS
/// exigiria `macos-private-api`).
#[cfg(not(target_os = "macos"))]
fn show_widget_window<R: Runtime>(app: &AppHandle<R>, config: &AppConfig) {
    if app.get_webview_window("widget").is_some() {
        return;
    }
    let result = WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("widget.html".into()))
        .title("Widget de uso")
        .inner_size(320.0, 180.0)
        .min_inner_size(160.0, 48.0)
        .decorations(false)
        // Janela OPACA: no Windows o DWM arredonda/recorta os cantos da janela
        // (mostrando o desktop atras) em hardware, sem serrilhado. Janela
        // transparente + arredondamento no CSS deixava o "canto escuro" (o
        // anti-aliasing da curva do WebView2 contra o fundo transparente).
        .skip_taskbar(true)
        .always_on_top(config.widget.sempre_na_frente)
        // Redimensionavel pelo usuario; o tamanho e' salvo (window-state). Na
        // primeira vez, o proprio widget ajusta a altura ao conteudo.
        .resizable(true)
        // Posicao inicial no centro; restauramos a ultima posicao/tamanho
        // salvos logo abaixo, quando houver estado.
        .center()
        .build();
    match result {
        Ok(window) => {
            use tauri_plugin_window_state::{StateFlags, WindowExt};
            // Reaplica a ultima posicao/tamanho salvos (no-op na primeira vez).
            let _ = window.restore_state(StateFlags::POSITION | StateFlags::SIZE);
            // Arredonda os cantos pelo DWM (limpo, em hardware) e remove a borda
            // que o Windows 11 desenha em toda janela top-level.
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = window.hwnd() {
                let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
                round_widget_window(hwnd);
                // Remove a "linha branca" do topo de janelas sem moldura e
                // redimensionaveis (tao deixa 1px do topo fora da area cliente).
                widget_frame::install(hwnd);
            }
        }
        Err(error) => handle_runtime_error(app, &format!("Falha ao abrir o widget: {error}")),
    }
}

/// Subclasse da janela do widget para corrigir a "linha branca" no topo das
/// janelas sem moldura (`decorations:false`) e redimensionaveis no Windows: o
/// `WM_NCCALCSIZE` do tao deixa o pixel do topo fora da area cliente, e a borda
/// da janela aparece ali. Aqui reivindicamos esse pixel (a area cliente passa a
/// cobrir o topo inteiro), preservando o resize/snap do tao (so' ajustamos o
/// retangulo cliente em 1px; o restante segue pelo proc original).
#[cfg(target_os = "windows")]
mod widget_frame {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, SetWindowLongPtrW, SetWindowPos, GWLP_WNDPROC, NCCALCSIZE_PARAMS,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_NCCALCSIZE,
        WNDPROC,
    };

    static PREV_PROC: AtomicIsize = AtomicIsize::new(0);

    pub fn install(hwnd: HWND) {
        unsafe {
            let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, subclass_proc as *const () as isize);
            PREV_PROC.store(prev, Ordering::SeqCst);
            // Forca um recalculo do frame (dispara WM_NCCALCSIZE) para o ajuste do
            // topo valer ja' na primeira exibicao — senao a linha branca so' some
            // depois do primeiro redimensionamento.
            let _ = SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let prev: WNDPROC = std::mem::transmute(PREV_PROC.load(Ordering::SeqCst));
        if msg == WM_NCCALCSIZE && wparam.0 != 0 {
            let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
            // rgrc[0] entra como o retangulo da janela; guarda o topo antes de o
            // proc original transformar em retangulo cliente.
            let window_top = params.rgrc[0].top;
            let result = CallWindowProcW(prev, hwnd, msg, wparam, lparam);
            // Faz a area cliente cobrir o pixel do topo (some a linha branca).
            params.rgrc[0].top = window_top;
            return result;
        }
        CallWindowProcW(prev, hwnd, msg, wparam, lparam)
    }
}

/// Arredonda a janela do widget pelo proprio DWM (Windows 11) — recorte limpo,
/// em hardware, sem o serrilhado que o arredondamento via CSS deixava nos cantos
/// (anti-aliasing contra o fundo transparente do WebView2). Tambem remove a borda
/// fina que o Windows desenha (`DWMWA_COLOR_NONE`). Em Windows 10 os atributos
/// sao ignorados (erro silencioso) — la' o widget fica com cantos retos.
#[cfg(target_os = "windows")]
fn round_widget_window(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    unsafe {
        let pref = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        );
        // 0xFFFFFFFE = DWMWA_COLOR_NONE (remove a borda desenhada pelo DWM).
        let color: u32 = 0xFFFF_FFFE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &color as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&color) as u32,
        );
    }
}

/// Aplica a config do widget: cria/destroi a janela conforme `habilitado` e
/// atualiza o "sempre na frente". Pode ser chamada da thread do worker, entao as
/// operacoes de janela sao despachadas para a main thread.
#[cfg(not(target_os = "macos"))]
fn apply_widget<R: Runtime>(app: &AppHandle<R>, config: &AppConfig) {
    let app = app.clone();
    let config = config.clone();
    let _ = app.clone().run_on_main_thread(move || {
        match (config.widget.habilitado, app.get_webview_window("widget")) {
            (true, Some(window)) => {
                let _ = window.set_always_on_top(config.widget.sempre_na_frente);
            }
            (true, None) => show_widget_window(&app, &config),
            (false, Some(window)) => {
                let _ = window.destroy();
            }
            (false, None) => {}
        }
    });
}

#[cfg(target_os = "macos")]
fn apply_widget<R: Runtime>(_app: &AppHandle<R>, _config: &AppConfig) {}

fn create_tray<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    let (menu, handles) = build_tray_menu(app.handle(), &RuntimeSnapshot::default())?;
    app.manage(handles);

    // Clique esquerdo abre o app; clique direito abre o menu (padrao do Windows).
    // `show_menu_on_left_click(false)` impede o menu no clique esquerdo; o menu no
    // clique direito continua sendo o comportamento padrao da bandeja.
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .icon(app.default_window_icon().unwrap().clone())
        // Tooltip estatico so' com o nome do app (Windows). Nao reflete metricas:
        // o uso vai no menu do tray e no widget da barra. No Linux e' no-op.
        .tooltip(APP_NAME_WINDOWS)
        .build(app)?;

    Ok(())
}

fn tray_pause_label(snapshot: &RuntimeSnapshot) -> &'static str {
    if snapshot.paused {
        "Retomar envio"
    } else {
        "Pausar envio"
    }
}

fn build_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &RuntimeSnapshot,
) -> tauri::Result<(Menu<R>, TrayMenuItems<R>)> {
    let pause_label = tray_pause_label(snapshot);

    let open_app_item = MenuItem::with_id(app, "open_app", "Abrir", true, None::<&str>)?;
    let open_config_item =
        MenuItem::with_id(app, "open_config", "Abrir config.json", true, None::<&str>)?;
    let open_logs_item =
        MenuItem::with_id(app, "open_logs", "Abrir pasta de logs", true, None::<&str>)?;
    let toggle_pause_item =
        MenuItem::with_id(app, "toggle_pause", pause_label, true, None::<&str>)?;
    let check_updates_item = MenuItem::with_id(
        app,
        "check_updates",
        "Buscar atualizações",
        true,
        None::<&str>,
    )?;

    let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;

    let separator_actions = PredefinedMenuItem::separator(app)?;

    let items: Vec<&dyn IsMenuItem<R>> = vec![
        &open_app_item,
        &open_config_item,
        &open_logs_item,
        &toggle_pause_item,
        &check_updates_item,
        &separator_actions,
        &quit_item,
    ];

    let menu = Menu::with_items(app, &items)?;
    drop(items); // encerra os borrows antes de mover os itens para os handles

    let handles = TrayMenuItems {
        toggle_pause: toggle_pause_item,
    };

    Ok((menu, handles))
}

/// Atualiza os itens dinamicos do menu do tray no lugar, sem reconstruir o menu
/// (reconstruir fecharia o menu aberto).
///
/// As atualizacoes sao postadas como uma unica tarefa na main thread sem
/// esperar o resultado. Isso evita que a thread do worker bloqueie enquanto o
/// menu popup esta aberto (a main thread fica no loop modal do menu ate fechar).
fn update_tray_menu<R: Runtime>(app: &AppHandle<R>, snapshot: &RuntimeSnapshot) {
    let pause = tray_pause_label(snapshot).to_string();

    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(items) = app.try_state::<TrayMenuItems<R>>() else {
            return;
        };
        let _ = items.toggle_pause.set_text(pause);
    });
}

/// Exibe e foca a janela unica do app (Dashboard + Configuracoes). Acionada pelo
/// item "Abrir" do tray. Se a janela ja existe, apenas a traz ao foco (desfazendo
/// a minimizacao); senao, a cria sob demanda. Fechar a janela a destroi (libera o
/// WebView2), entao a proxima abertura recai no caminho de criacao.
///
/// Posicao/tamanho sao lembrados entre aberturas: ao criar, restauramos o ultimo
/// estado salvo (`restore_state`; no-op na 1a vez, quando cai no `inner_size`
/// centralizado); ao fechar, salvamos o estado no `CloseRequested` — a janela
/// ainda esta viva ali, e como o app segue no tray (nao ha "exit") o salvamento
/// automatico do plugin no encerramento nao pegaria a geometria a tempo.
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    let result = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("AiUsageTrayAgent")
        .inner_size(960.0, 660.0)
        .min_inner_size(720.0, 520.0)
        .center()
        .resizable(true)
        .decorations(true)
        // Desliga o handler NATIVO de drag-drop (de arquivos) do webview: por padrao
        // ele intercepta os eventos e impede o drag-and-drop HTML5 da propria pagina
        // (ex.: reordenar os cards da tela "Uso atual"), deixando o cursor "bloqueado".
        // O app nao usa drop de arquivos, entao desligar e' seguro.
        .disable_drag_drop_handler()
        // Cria OCULTA: restauramos posicao/tamanho com ela escondida e so' entao
        // damos show(), para a janela aparecer uma unica vez ja' no tamanho certo
        // (sem o "pulo" do tamanho padrao -> tamanho salvo).
        .visible(false)
        // Pinta o fundo com a cor escura do app (styles.css: body #1a1915) para o
        // WebView2 nao mostrar o flash branco enquanto o HTML/CSS ainda carrega.
        .background_color(tauri::window::Color(26, 25, 21, 255))
        .build();
    match result {
        Ok(window) => {
            use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};
            // Reaplica a ultima posicao/tamanho salvos (no-op na primeira vez), com
            // a janela ainda oculta.
            let _ = window.restore_state(StateFlags::POSITION | StateFlags::SIZE);
            // Salva o estado ao fechar (a janela ainda esta viva aqui); como o app
            // segue no tray (sem "exit"), o save automatico do plugin no
            // encerramento nao pegaria a geometria a tempo.
            let app_for_save = app.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    let _ = app_for_save.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
                }
            });
            // Ja' no tamanho/posicao finais e com fundo escuro: exibe e foca.
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => handle_runtime_error(app, &format!("Falha ao abrir a janela: {error}")),
    }
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, menu_id: &str) {
    match menu_id {
        "open_app" => {
            show_main_window(app);
        }
        "open_config" => {
            if let Some(paths) = app.try_state::<RuntimePaths>() {
                if let Err(error) = open_path(&paths.config_file) {
                    handle_runtime_error(app, &format!("Falha ao abrir config.json: {error}"));
                }
            }
        }
        "open_logs" => {
            if let Some(paths) = app.try_state::<RuntimePaths>() {
                if let Err(error) = open_path(&paths.logs_dir) {
                    handle_runtime_error(app, &format!("Falha ao abrir logs: {error}"));
                }
            }
        }
        "check_updates" => {
            let app = app.clone();
            tauri::async_runtime::spawn(check_for_updates(app, true));
        }
        "toggle_pause" => {
            if let (Some(shared), Some(paths)) = (
                app.try_state::<Arc<SharedState>>(),
                app.try_state::<RuntimePaths>(),
            ) {
                let new_paused = !lock_snapshot(shared.inner()).paused;
                if let Err(error) = apply_paused(app, paths.inner(), &shared, new_paused) {
                    handle_runtime_error(app, &format!("Falha ao alterar a pausa: {error}"));
                }
            }
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn start_worker<R: Runtime + 'static>(
    app: AppHandle<R>,
    paths: RuntimePaths,
    shared: Arc<SharedState>,
) {
    thread::spawn(move || loop {
        if shared.stop.load(Ordering::Relaxed) {
            break;
        }

        let mut interval = current_interval(&paths);

        // Sempre coleta: os dados alimentam o tray, a barra e o widget mesmo com o
        // envio pausado/desabilitado. O proprio ciclo decide, por provider, se
        // envia ao Loki (respeitando a pausa e o config.envio).
        let _ = run_collection_cycle(&app, &paths, &shared);

        // Espera ate o proximo ciclo de coleta. A thread ja acordava a cada
        // segundo (para reagir ao stop); aproveitamos esse tick para checar, via
        // mtime, se o config.json foi editado. Se mudou, aplicamos a nova config
        // na hora com refresh_tray (posicao na barra, fonte, cor, lado,
        // visibilidade dos provedores e o proprio intervalo) — SEM disparar um
        // envio extra ao Loki. Assim a edicao vale em ~1s sem reduzir o intervalo
        // de envio. A checagem le so o metadado (stat), nao o conteudo; o arquivo
        // so e' lido/parseado quando o mtime realmente muda.
        let mut last_mtime = config_mtime(&paths);
        let mut elapsed = 0u64;
        while elapsed < interval {
            if shared.stop.load(Ordering::Relaxed) {
                break;
            }
            thread::sleep(Duration::from_secs(1));
            elapsed += 1;

            let current = config_mtime(&paths);
            if current != last_mtime {
                // Edicao manual do config.json: normaliza/reescreve uma unica vez
                // aqui (clamp, campos novos) — os caminhos de leitura usam
                // `read_config`, que nao reescreve. Depois reaplica tray/barra/
                // widget e o intervalo.
                let _ = load_or_create_config(&paths);
                let _ = refresh_tray(&app, &shared);
                interval = current_interval(&paths);
                // Re-le o mtime apos aplicar: refresh_tray/normalizacao podem
                // reescrever o arquivo, e nao queremos tratar a propria escrita
                // como uma nova edicao externa.
                last_mtime = config_mtime(&paths);
            }
        }
    });
}

/// Le o intervalo de coleta (segundos) do config.json. `read_config` ja' aplica o
/// clamp 5..=3600 e cai no padrao (10s) se o arquivo nao puder ser lido.
fn current_interval(paths: &RuntimePaths) -> u64 {
    read_config(paths).intervalo_segundos
}

/// Data de modificacao do config.json, usada para detectar edicoes externas.
/// `None` quando o arquivo nao pode ser lido (ex.: durante um save atomico do
/// editor); a comparacao com o valor anterior ainda detecta a transicao.
fn config_mtime(paths: &RuntimePaths) -> Option<std::time::SystemTime> {
    fs::metadata(&paths.config_file)
        .and_then(|meta| meta.modified())
        .ok()
}

/// Cliente HTTP compartilhado entre ciclos de coleta. Construido uma unica vez
/// (lazy) para reaproveitar o pool de conexoes/keep-alive e evitar recriar o
/// runtime interno do reqwest a cada ciclo. `Client` e' Arc por dentro, entao
/// clonar e' barato e compartilha o mesmo pool.
fn http_client() -> Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_else(|_| Client::new())
        })
        .clone()
}

/// Resultado da coleta de um provedor: `None` quando o provedor esta'
/// desabilitado; senao `Ok(metrica)` ou `Err(mensagem)`.
type CollectOutcome = Option<Result<UsageMetric, String>>;

/// Coleta as metricas dos providers habilitados (sempre, para alimentar o tray, a
/// barra e o widget) e envia ao Loki conforme as regras de envio.
///
/// O envio de cada provider acontece quando:
/// - o envio nao esta' pausado, **e**
/// - o envio daquele provider esta' habilitado em `config.envio`.
///
/// Ou seja, com o envio pausado/desabilitado a coleta continua normalmente; so' o
/// trafego ao Loki e' suprimido. Cada tentativa de envio (sucesso ou falha) e'
/// registrada no historico (`send_log`) exibido na tela "Envio de dados".
fn run_collection_cycle<R: Runtime>(
    app: &AppHandle<R>,
    paths: &RuntimePaths,
    shared: &Arc<SharedState>,
) -> Result<(), String> {
    let _lock = shared
        .cycle_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let config = read_config(paths);
    let client = http_client();

    // O ciclo respeita a pausa geral; o desligamento por provider (config.envio)
    // tambem e' respeitado.
    let paused = lock_snapshot(shared).paused;
    let send_allowed = !paused;
    let send_codex = send_allowed && config.envio.codex;
    let send_claude = send_allowed && config.envio.claude;

    let codex_enabled = config.providers.codex.habilitado;
    let claude_enabled = config.providers.claude.habilitado;

    // Coleta os dois provedores em paralelo: cada GET tem timeout de 15s, entao
    // serializa-los faria o ciclo (e a janela do `cycle_lock`) somar as latencias.
    // As coletas sao puras (client + config), sem tocar no estado compartilhado;
    // o processamento (snapshot, envio, log) acontece depois, em sequencia.
    let (codex_result, claude_result): (CollectOutcome, CollectOutcome) = thread::scope(|scope| {
        let codex_handle =
            codex_enabled.then(|| scope.spawn(|| collect_codex_metric(&client, &config, paths)));
        let claude_result = claude_enabled.then(|| collect_claude_metric(&client, &config, paths));
        let codex_result = codex_handle.map(|handle| {
            handle
                .join()
                .unwrap_or_else(|_| Err("Panico durante a coleta do Codex.".to_string()))
        });
        (codex_result, claude_result)
    });

    let mut had_error = false;
    if let Some(result) = codex_result {
        had_error |= handle_collected(
            app, paths, shared, &client, &config, "codex", result, send_codex,
        );
    }
    if let Some(result) = claude_result {
        had_error |= handle_collected(
            app,
            paths,
            shared,
            &client,
            &config,
            "claude",
            result,
            send_claude,
        );
    }

    if !codex_enabled && !claude_enabled {
        record_runtime_error(app, "Nenhum provider habilitado.");
    } else if !had_error {
        clear_last_error(shared);
    }

    // Registra uma amostra no historico (anel em memoria) para os mini-graficos da
    // tela "Uso atual". Roda apos os dois provedores terem atualizado o snapshot.
    push_usage_sample(shared, config.uso_atual.grafico);

    // Se a janela de 5h do Claude expirou e a reabertura automatica esta' ligada,
    // manda a mensagem que abre uma nova. Nao bloqueia: a chamada ao CLI vai para
    // uma thread propria (ver `maybe_reopen_claude_session`).
    maybe_reopen_claude_session(paths, shared, &config);

    // Um unico refresh do tray por ciclo (os erros acima usam `record_runtime_error`,
    // que nao refresca, para nao repintar varias vezes).
    refresh_tray(app, shared).map_err(|error| error.to_string())?;
    Ok(())
}

/// Intervalo minimo entre duas tentativas de reabrir a sessao. Cobre o tempo do
/// CLI responder mais a propagacao na API (a janela aparece na coleta seguinte),
/// e evita martelar quando a tentativa falha (ex.: CLI ausente).
const SESSAO_AUTO_COOLDOWN: Duration = Duration::from_secs(180);

/// Teto para a chamada ao CLI. Passou disso, o processo e' morto e a tentativa
/// vira falha — nao pode ficar um `claude` pendurado a cada janela.
const SESSAO_AUTO_TIMEOUT: Duration = Duration::from_secs(120);

/// Decide se e' hora de reabrir a janela de sessao do Claude e, se for, dispara a
/// chamada **fora** do ciclo de coleta (o CLI leva segundos; segurar o
/// `cycle_lock` congelaria tray/barra/widget nesse intervalo).
///
/// So' age sobre uma coleta bem-sucedida que diga explicitamente que nao ha'
/// janela (`status == "ok"` e `reset_em == None`). Falha de coleta ou credencial
/// expirada **nao** sao sinal de janela fechada — disparar ali gastaria cota a
/// toa, possivelmente em looping.
///
/// No modo `agendado` isso ainda vale, e ha' a condicao extra do horario: ver
/// `sessao_auto_slot_devido`.
fn maybe_reopen_claude_session(
    paths: &RuntimePaths,
    shared: &Arc<SharedState>,
    config: &AppConfig,
) {
    let claude = &config.providers.claude;
    if !claude.habilitado || !claude.sessao_auto.habilitado {
        return;
    }

    {
        let snapshot = lock_snapshot(shared);
        let sem_janela = snapshot
            .claude_metric
            .as_ref()
            .is_some_and(|metric| metric.status == "ok" && metric.reset_em.is_none());
        if !sem_janela {
            return;
        }
    }

    // Modo agendado: sem horario devido agora, nao faz nada — nem que a janela
    // esteja fechada ha' horas (horario perdido nao e' recuperado).
    let slot = if claude.sessao_auto.modo == SESSAO_AUTO_MODO_AGENDADO {
        let agora = Local::now();
        match sessao_auto_slot_devido(&claude.sessao_auto, config.intervalo_segundos, agora) {
            Some(minuto) => Some((agora.date_naive(), minuto)),
            None => return,
        }
    } else {
        None
    };

    // Marca a tentativa com o lock ainda tomado, para que dois ciclos nao disparem
    // o mesmo "Oi" em paralelo.
    {
        let mut state = lock_sessao_auto(shared);
        if state.running
            || state
                .last_attempt
                .is_some_and(|at| at.elapsed() < SESSAO_AUTO_COOLDOWN)
        {
            return;
        }
        // Um disparo por horario agendado: a folga do horario e' maior que o
        // cooldown, entao sem isto o mesmo horario poderia render duas tentativas.
        if slot.is_some() {
            if state.last_slot == slot {
                return;
            }
            state.last_slot = slot;
        }
        state.last_attempt = Some(Instant::now());
        state.running = true;
        state.status.em_execucao = true;
        state.status.ultima_tentativa_em = Some(Utc::now().to_rfc3339());
    }

    let paths = paths.clone();
    let shared = shared.clone();
    let sessao_auto = claude.sessao_auto.clone();
    thread::spawn(move || {
        let resultado = run_claude_session_opener(&paths, &sessao_auto);

        let mut state = lock_sessao_auto(&shared);
        state.running = false;
        state.status.em_execucao = false;
        // Erro repetido (ex.: CLI ausente a cada cooldown) so' vai ao log quando
        // muda, para nao encher o arquivo de linhas identicas.
        let erro_novo = match (&resultado, &state.status.ultimo_erro) {
            (Err(atual), Some(anterior)) => atual != anterior,
            _ => true,
        };
        match resultado {
            Ok(()) => {
                state.status.ultimo_ok = Some(true);
                state.status.ultimo_erro = None;
                let _ = append_log_line(
                    &paths,
                    "info",
                    "Sessao do Claude reaberta automaticamente.",
                    Some(json!({ "ferramenta": "claude", "mensagem": SESSAO_AUTO_MENSAGEM })),
                );
            }
            Err(erro) => {
                state.status.ultimo_ok = Some(false);
                if erro_novo {
                    let _ = append_log_line(
                        &paths,
                        "error",
                        "Falha ao reabrir a sessao do Claude.",
                        Some(json!({ "ferramenta": "claude", "error": erro })),
                    );
                }
                state.status.ultimo_erro = Some(erro);
            }
        }
    });
}

/// Qual horario agendado esta' "devido" agora (minuto do dia), se algum.
///
/// A comparacao nao pode exigir o segundo exato: quem decide e' o ciclo de coleta,
/// que roda a cada `intervalo_segundos` (5s..3600s) e dificilmente cai no instante
/// do horario. Entao vale uma folga logo **depois** do horario, do tamanho de um
/// ciclo + 1 min (piso de 2 min, teto de 10 min) — o suficiente para o horario nao
/// passar em branco, e curto o bastante para continuar sendo "no horario" e nao
/// "recuperar horario perdido".
///
/// Se dois horarios caem na mesma folga, vence o mais recente. Um horario perto da
/// meia-noite tem a folga truncada em 23:59:59 (nao vira o dia); irrelevante na
/// pratica e evita a complicacao de comparar entre dias.
fn sessao_auto_slot_devido(
    config: &SessaoAutoConfig,
    intervalo_segundos: u64,
    agora: DateTime<Local>,
) -> Option<u32> {
    let folga = (intervalo_segundos + 60).clamp(120, 600);
    let agora_segundos = u64::from(agora.num_seconds_from_midnight());
    config
        .horarios
        .iter()
        .filter_map(|horario| parse_horario(horario))
        .filter(|minuto| {
            let inicio = u64::from(*minuto) * 60;
            agora_segundos >= inicio && agora_segundos - inicio < folga
        })
        .max()
}

/// Grava o `SESSAO_AUTO_SETTINGS` em `<workdir>/settings-disparo.json` e devolve o
/// caminho, que e' o que vai no `--settings`.
///
/// Reescrito a cada disparo de proposito: o arquivo e' derivado da constante, e
/// nao um estado que o usuario edita — se ele sumir ou for alterado, o proximo
/// disparo o coloca de volta no lugar certo.
fn escreve_settings_do_disparo(workdir: &Path) -> Result<PathBuf, String> {
    let destino = workdir.join(SESSAO_AUTO_SETTINGS_ARQUIVO);
    fs::write(&destino, SESSAO_AUTO_SETTINGS).map_err(|error| {
        format!(
            "nao foi possivel gravar os ajustes do disparo em {}: {error}",
            destino.display()
        )
    })?;
    Ok(destino)
}

/// Executa `claude -p "<mensagem>"` e devolve `Ok(())` se o CLI saiu com sucesso.
///
/// Detalhes que importam:
/// - roda no diretorio de config do app (neutro): evita carregar o `CLAUDE.md` de
///   algum projeto e o prompt de confianca de pasta;
/// - remove `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` do processo filho — com uma
///   delas setada o CLI iria para a API paga, que e' outro pool e **nao** abre a
///   janela da assinatura;
/// - rebaixa o esforco de raciocinio (ver `SESSAO_AUTO_SETTINGS`, entregue como
///   arquivo porque o shim `claude.cmd` do Windows corrompe JSON na linha de
///   comando) e corta os servidores MCP: sao os dois lados da conta de um disparo
///   que so' precisa existir — o raciocinio infla a saida, e as definicoes de
///   ferramenta de cada servidor MCP incham o prompt de sistema;
/// - stdin fechado (o CLI nunca fica esperando digitacao); stdout e stderr sao
///   capturados e, na falha, viram o detalhe do erro (ver `erro_do_cli`) — no
///   sucesso o texto e' descartado;
/// - timeout com kill, para nao deixar processo pendurado.
fn run_claude_session_opener(
    paths: &RuntimePaths,
    config: &SessaoAutoConfig,
) -> Result<(), String> {
    let exe = resolve_claude_cli(config)?;
    // Subpasta dedicada, e nao o proprio config_dir: o Claude Code grava um
    // transcript por disparo em `~/.claude/projects/<cwd>/`, e a Dashboard Claude
    // deste app agrupa por basename do `cwd`. Rodando aqui, esses disparos
    // aparecem na aba Projetos como "sessao-auto" — identificavel — em vez de um
    // "AiUsageTrayAgent" que ninguem liga ao recurso.
    let workdir = paths.config_dir.join("sessao-auto");
    let _ = fs::create_dir_all(&workdir);
    let settings = escreve_settings_do_disparo(&workdir)?;

    let mut command = Command::new(&exe);
    command
        .arg("-p")
        .arg(SESSAO_AUTO_MENSAGEM)
        .arg("--settings")
        .arg(&settings)
        // Sem nenhum `--mcp-config` junto, isto significa NENHUM servidor MCP: as
        // definicoes de ferramenta deles entrariam inteiras no prompt de sistema,
        // e o disparo nao usa ferramenta alguma.
        .arg("--strict-mcp-config")
        .current_dir(&workdir)
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Sem isso, cada disparo pisca um console preto na frente do usuario.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "nao foi possivel executar o Claude Code CLI ({}): {error}",
            exe.display()
        )
    })?;

    // Os dois pipes sao drenados em threads, e nao depois do `wait`: um pipe cheio
    // bloqueia quem escreve, entao o filho ficaria travado ate' o timeout de 2 min
    // esperando alguem ler. Nao e' teorico agora que o stdout esta' capturado — no
    // sucesso ele carrega a resposta inteira do modelo.
    let saida = drena_pipe(child.stdout.take());
    let erros = drena_pipe(child.stderr.take());

    let deadline = Instant::now() + SESSAO_AUTO_TIMEOUT;
    let aguardou = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!(
                        "o Claude Code CLI nao respondeu em {}s",
                        SESSAO_AUTO_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => break Err(format!("falha ao aguardar o Claude Code CLI ({error})")),
        }
    };

    // Os pipes fecham quando o processo termina — inclusive morto no timeout —,
    // entao as threads de drenagem sempre chegam ao EOF e o join nao pendura.
    let saida = saida.join().unwrap_or_default();
    let erros = erros.join().unwrap_or_default();

    // Sempre depois do processo terminar (com sucesso, erro ou morto no timeout):
    // o transcript ja' foi gravado e nao queremos deixa-lo para tras.
    cleanup_session_transcripts(&workdir);

    // No timeout nao ha' status, mas o que o CLI escreveu antes de travar e' a
    // melhor (as vezes a unica) pista do motivo.
    let status = match aguardou {
        Ok(status) => status,
        Err(base) => return Err(erro_do_cli(&base, &saida, &erros)),
    };
    if status.success() {
        // Sucesso: a resposta do modelo nao interessa a ninguem, some com ela.
        return Ok(());
    }
    Err(erro_do_cli(
        &format!("o Claude Code CLI terminou com {status}"),
        &saida,
        &erros,
    ))
}

/// Le um pipe do processo filho ate' o EOF, numa thread, sem nunca falhar: o
/// conteudo e' diagnostico, entao byte invalido virar `U+FFFD` e' melhor que
/// perder a mensagem toda (o que `read_to_string` faria).
fn drena_pipe<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buffer);
        }
        String::from_utf8_lossy(&buffer).into_owned()
    })
}

/// Monta a mensagem de falha juntando a causa observavel (`base`, sem o ponto
/// final) com o que o CLI escreveu.
///
/// O `claude -p` reporta a falha no **stdout** — "Not logged in · Please run
/// /login", limite de uso, etc. — e costuma deixar o stderr vazio; sem isto o
/// usuario so' via "terminou com exit code: 1" e nao tinha como saber o porque.
/// Os dois streams entram (stderr primeiro, onde aparecem os erros de runtime do
/// Node).
fn erro_do_cli(base: &str, stdout: &str, stderr: &str) -> String {
    let detalhe = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|parte| !parte.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    // Ultimos 300 caracteres (nao bytes: fatiar por byte pode cair no meio de um
    // caractere multibyte e entrar em panico).
    let detalhe: String = {
        let cauda: Vec<char> = detalhe.chars().rev().take(300).collect();
        cauda.into_iter().rev().collect()
    };
    if detalhe.is_empty() {
        format!("{base}.")
    } else {
        format!("{base}: {detalhe}")
    }
}

/// Apaga o transcript que o Claude Code grava a cada disparo.
///
/// O CLI persiste uma sessao por execucao em
/// `~/.claude/projects/<cwd-codificado>/<uuid>.jsonl`. Esses "Oi" nao sao conversa
/// de verdade: sujariam o historico do CLI (`claude --resume`) e a Dashboard Claude
/// deste app, que le exatamente esses arquivos.
///
/// A identificacao e' por **conteudo**, nao pelo nome da pasta: o Claude Code
/// codifica o caminho do `cwd` no nome do diretorio, e replicar essa regra aqui
/// quebraria silenciosamente se ela mudasse (ou com acentos no nome de usuario).
/// Em vez disso, procura o diretorio cujos transcripts declaram o nosso `workdir`
/// — que so' este recurso usa. Se nada casar, nao apaga nada.
fn cleanup_session_transcripts(workdir: &Path) {
    let Some(projects) = dirs::home_dir().map(|home| home.join(".claude").join("projects")) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&projects) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir.is_dir() && transcripts_belong_to(&dir, workdir) {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

/// `true` quando **todo** transcript da pasta foi gerado a partir de `workdir`.
///
/// Le' so' o inicio de cada arquivo (o `cwd` aparece logo nas primeiras linhas)
/// para nao carregar transcripts grandes de outros projetos. Basta um transcript
/// apontando para outro diretorio — ou nenhum transcript com `cwd` — para a pasta
/// ser considerada de terceiros e ficar intacta.
fn transcripts_belong_to(dir: &Path, workdir: &Path) -> bool {
    let alvo = workdir.to_string_lossy();
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };

    let mut confirmados = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        // O Claude Code guarda outras coisas junto dos transcripts (ex.: a pasta
        // `memory/` do projeto). Sao artefatos dele para *este* diretorio, entao
        // nao invalidam a pasta — quem decide e' o `cwd` dos `.jsonl`.
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(file) = File::open(&path) else {
            return false;
        };
        let cwd = std::io::BufReader::new(file)
            .lines()
            .take(10)
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
            .find_map(|obj| obj.get("cwd").and_then(Value::as_str).map(str::to_string));
        // Windows nao diferencia maiusculas em caminho; comparar exato daria
        // falso negativo (e a limpeza nunca aconteceria).
        match cwd {
            Some(cwd) if cwd.eq_ignore_ascii_case(&alvo) => confirmados += 1,
            _ => return false,
        }
    }
    confirmados > 0
}

/// Descobre o executavel do Claude Code CLI.
///
/// O `caminho_cli` do config manda, quando preenchido. Sem ele, tenta os locais
/// conhecidos de instalacao **antes** do PATH: o app costuma subir pelo autostart,
/// cujo ambiente nem sempre traz o `PATH` completo do shell do usuario.
fn resolve_claude_cli(config: &SessaoAutoConfig) -> Result<PathBuf, String> {
    let manual = config.caminho_cli.trim();
    if !manual.is_empty() {
        let path = PathBuf::from(manual);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!(
                "caminho do Claude Code CLI nao encontrado: {manual}"
            ))
        };
    }

    for candidate in claude_cli_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    if let Some(found) = claude_cli_from_path() {
        return Ok(found);
    }

    Err(
        "Claude Code CLI nao encontrado. Instale-o (npm i -g @anthropic-ai/claude-code), \
         faca login com a sua assinatura e, se preciso, informe o caminho no config.json \
         (providers.claude.sessaoAuto.caminhoCli)."
            .to_string(),
    )
}

/// Locais padrao de instalacao do CLI, por sistema.
fn claude_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let home = dirs::home_dir();

    #[cfg(target_os = "windows")]
    {
        // Instalacao via npm global: `claude.cmd`. O `std::process::Command` sabe
        // executar .cmd/.bat com escape correto desde o Rust 1.77.
        if let Some(appdata) = env::var_os("APPDATA") {
            candidates.push(PathBuf::from(&appdata).join("npm").join("claude.cmd"));
        }
        if let Some(home) = home.as_ref() {
            candidates.push(home.join(".local").join("bin").join("claude.exe"));
            candidates.push(home.join(".local").join("bin").join("claude.cmd"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = home.as_ref() {
            candidates.push(home.join(".local").join("bin").join("claude"));
            candidates.push(home.join(".claude").join("local").join("claude"));
        }
        candidates.push(PathBuf::from("/usr/local/bin/claude"));
        candidates.push(PathBuf::from("/usr/bin/claude"));
    }

    candidates
}

/// Ultimo recurso: pergunta ao sistema onde esta' o `claude` (`where`/`which`).
fn claude_cli_from_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let mut locator = {
        let mut command = Command::new("cmd");
        command.args(["/C", "where", "claude"]);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut locator = {
        let mut command = Command::new("sh");
        command.args(["-c", "command -v claude"]);
        command
    };

    let output = locator.stdin(Stdio::null()).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // No Windows o `where` lista tambem o script sem extensao (que o
        // CreateProcess nao executa); fica so' com o que da' para rodar.
        .filter(|line| {
            !cfg!(target_os = "windows")
                || ["cmd", "exe", "bat"].iter().any(|extension| {
                    line.to_ascii_lowercase()
                        .ends_with(&format!(".{extension}"))
                })
        })
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

/// Processa o resultado da coleta de um provedor: atualiza o snapshot (sempre) e,
/// se o envio estiver permitido, envia ao Loki, registrando sucesso/falha no
/// historico e no log. Retorna `true` se houve erro (coleta ou envio). Nao toca no
/// tray — o ciclo faz um unico `refresh_tray` no fim.
#[allow(clippy::too_many_arguments)]
fn handle_collected<R: Runtime>(
    app: &AppHandle<R>,
    paths: &RuntimePaths,
    shared: &Arc<SharedState>,
    client: &Client,
    config: &AppConfig,
    ferramenta: &str,
    result: Result<UsageMetric, String>,
    send_allowed: bool,
) -> bool {
    match result {
        Ok(metric) => {
            // A coleta sempre atualiza os dados/UI; o envio ao Loki ocorre conforme
            // as regras de envio (pausa geral + config.envio).
            update_metric(shared, metric.clone());
            if !send_allowed {
                return false;
            }
            match send_metric_to_loki(client, config, &metric) {
                Ok(body) => {
                    let _ = append_log_line(
                        paths,
                        "info",
                        "Metrica enviada para o Loki.",
                        Some(json!({
                            "ferramenta": ferramenta,
                            "uso_percentual": metric.uso_percentual,
                            "uso_percentual_7d": metric.uso_percentual_7d,
                            "status": metric.status,
                            "reset_em": metric.reset_em,
                            "reset_em_7d": metric.reset_em_7d
                        })),
                    );
                    // Guarda o payload enviado no historico, para a tela "Envio de
                    // dados" mostrar quais dados foram ao Loki.
                    push_send_log(shared, ferramenta, "sucesso", None, Some(body));
                    mark_success(shared);
                    false
                }
                Err(error) => {
                    let _ = append_log_line(
                        paths,
                        "error",
                        "Falha ao enviar metrica para o Loki.",
                        Some(json!({ "ferramenta": ferramenta, "error": error })),
                    );
                    push_send_log(shared, ferramenta, "falha", Some(error.clone()), None);
                    record_runtime_error(app, &error);
                    true
                }
            }
        }
        Err(error) => {
            let metric = build_error_metric(&config.usuario, ferramenta, &error);
            update_metric(shared, metric);
            let _ = append_log_line(
                paths,
                "error",
                "Falha ao coletar metrica.",
                Some(json!({ "ferramenta": ferramenta, "error": error })),
            );
            record_runtime_error(app, &error);
            true
        }
    }
}

/// Resolve o arquivo de credenciais do Codex conforme o modo de autenticacao:
/// "navegador" usa o arquivo gerenciado (`codex_auth`), renovando o token se
/// preciso; qualquer outro valor usa o caminho do `auth.json` informado pelo
/// usuario. Devolve o caminho pronto para os leitores (coleta e dashboard).
fn resolve_codex_auth_file(
    client: &Client,
    config: &AppConfig,
    paths: &RuntimePaths,
) -> Result<PathBuf, String> {
    if config.providers.codex.auth_mode == "navegador" {
        codex_auth::ensure_fresh(client, &paths.config_dir)
    } else {
        let path = config.providers.codex.auth_json_path.trim();
        if path.is_empty() {
            return Err("Caminho do auth.json do Codex nao configurado.".to_string());
        }
        Ok(PathBuf::from(path))
    }
}

fn collect_codex_metric(
    client: &Client,
    config: &AppConfig,
    paths: &RuntimePaths,
) -> Result<UsageMetric, String> {
    let auth_path = resolve_codex_auth_file(client, config, paths)?;

    let auth_raw = fs::read_to_string(&auth_path)
        .map_err(|error| format!("Falha ao ler auth.json do Codex: {error}"))?;
    let auth: OpenCodeAuth =
        serde_json::from_str(&auth_raw).map_err(|error| format!("auth.json invalido: {error}"))?;
    let openai_access = auth.openai.and_then(|value| value.access);
    // Consome `auth.tokens` uma unica vez para pegar access_token + account_id.
    let (tokens_access, account_id) = auth
        .tokens
        .map_or((None, None), |value| (value.access_token, value.account_id));
    let token = openai_access
        .or(tokens_access)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Campos openai.access ou tokens.access_token nao foram encontrados no auth.json do Codex."
                .to_string()
        })?;
    // O login pelo navegador gera token multi-org e salva `tokens.account_id`. Sem
    // o header `chatgpt-account-id` o backend nao resolve a janela semanal
    // (secondary_window) desse token, entao o uso 7d volta nulo (espelha o
    // dashboard, que ja envia esse header).
    let account_id = account_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let mut request = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .header("accept", "*/*")
        .header("accept-language", "pt-BR,pt;q=0.9,en;q=0.8")
        .header("authorization", format!("Bearer {token}"))
        .header("cache-control", "no-cache")
        .header("pragma", "no-cache")
        .header("oai-language", "pt-BR")
        .header("x-openai-target-path", "/backend-api/wham/usage")
        .header("x-openai-target-route", "/backend-api/wham/usage");
    if let Some(account_id) = account_id {
        request = request.header("chatgpt-account-id", account_id);
    }

    let response = request
        .send()
        .map_err(|error| format!("Falha HTTP ao consultar Codex: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Codex retornou status HTTP {}.", response.status()));
    }

    let payload: OpenAiUsageResponse = response
        .json()
        .map_err(|error| format!("Falha ao decodificar resposta do Codex: {error}"))?;

    let rate_limit = payload
        .rate_limit
        .ok_or_else(|| "rate_limit nao foi encontrado na resposta do Codex.".to_string())?;

    // Classifica cada janela presente pela DURACAO, nao pela posicao (primary/
    // secondary): a janela com >= 1 dia de duracao e' a semanal (7d, ~604800s);
    // as demais sao a de sessao (5h, ~18000s). Hoje a OpenAI suspendeu o 5h e so'
    // devolve o semanal em `primary_window` (sem `secondary_window`) — a
    // classificacao por duracao acerta esse caso e volta a mostrar o 5h sozinha se
    // ele retornar. Fallback: sem `limit_window_seconds`, mantem a ordem legada
    // (1a janela = sessao, 2a = semanal).
    const WEEKLY_MIN_SECONDS: i64 = 24 * 60 * 60;
    let mut session_window: Option<&OpenAiWindow> = None;
    let mut weekly_window: Option<&OpenAiWindow> = None;
    for (index, window) in [
        rate_limit.primary_window.as_ref(),
        rate_limit.secondary_window.as_ref(),
    ]
    .into_iter()
    .enumerate()
    {
        let Some(window) = window else { continue };
        let is_weekly = match window.limit_window_seconds {
            Some(seconds) => seconds >= WEEKLY_MIN_SECONDS,
            None => index == 1,
        };
        if is_weekly {
            weekly_window.get_or_insert(window);
        } else {
            session_window.get_or_insert(window);
        }
    }

    if session_window.is_none() && weekly_window.is_none() {
        return Err("rate_limit sem janelas de uso na resposta do Codex.".to_string());
    }

    let session_used = session_window.and_then(|window| window.used_percent);
    let session_reset = session_window.and_then(|window| window.reset_at);
    let weekly_used = weekly_window.and_then(|window| window.used_percent);
    let weekly_reset = weekly_window.and_then(|window| window.reset_at);

    Ok(UsageMetric {
        usuario: normalized_user(&config.usuario),
        ferramenta: "codex".to_string(),
        uso_percentual: session_used.map(round_percent),
        restante_percentual: session_used.map(remaining_percent),
        status: "ok".to_string(),
        coletado_em: Utc::now().to_rfc3339(),
        reset_em: session_reset.and_then(timestamp_seconds_to_iso),
        erro: None,
        uso_percentual_7d: weekly_used.map(round_percent),
        restante_percentual_7d: weekly_used.map(remaining_percent),
        reset_em_7d: weekly_reset.and_then(timestamp_seconds_to_iso),
    })
}

/// Resolve as credenciais do Claude conforme o modo de autenticacao: "navegador"
/// usa a sessao capturada (arquivo gerenciado `claude_auth`); qualquer outro valor
/// usa `organization_id` + `cookie` do config. Devolve `(cookie_header, org_id)`.
fn resolve_claude_credentials(
    config: &AppConfig,
    paths: &RuntimePaths,
) -> Result<(String, String), String> {
    if config.providers.claude.auth_mode == "navegador" {
        claude_auth::credentials(&paths.config_dir)
    } else {
        let organization_id = config.providers.claude.organization_id.trim();
        let cookie = config.providers.claude.cookie.trim();
        if organization_id.is_empty() {
            return Err("Organization ID do Claude nao configurado.".to_string());
        }
        if cookie.is_empty() {
            return Err("Cookie do Claude nao configurado.".to_string());
        }
        Ok((cookie.to_string(), organization_id.to_string()))
    }
}

fn collect_claude_metric(
    client: &Client,
    config: &AppConfig,
    paths: &RuntimePaths,
) -> Result<UsageMetric, String> {
    let (cookie, organization_id) = resolve_claude_credentials(config, paths)?;

    let response = client
        .get(format!(
            "https://claude.ai/api/organizations/{organization_id}/usage"
        ))
        .header("accept", "*/*")
        .header("cookie", cookie)
        .header("referer", "https://claude.ai/settings/usage")
        .header(
            "user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        )
        .send()
        .map_err(|error| format!("Falha HTTP ao consultar Claude: {error}"))?;

    // No modo navegador, um 401/403 significa sessao web expirada/rejeitada (nao ha
    // refresh_token): marca para a UI oferecer "Reconectar"; sucesso limpa a marca.
    if config.providers.claude.auth_mode == "navegador" {
        let code = response.status().as_u16();
        if code == 401 || code == 403 {
            claude_auth::set_needs_reconnect(&paths.config_dir, true);
            // Mesma mensagem exibida na aba Claude das Configuracoes (reconexao).
            return Err(
                "Sessão expirada. Reconecte sua conta para continuar a coleta.".to_string(),
            );
        } else if response.status().is_success() {
            claude_auth::set_needs_reconnect(&paths.config_dir, false);
        }
    }

    if !response.status().is_success() {
        return Err(format!(
            "Claude retornou status HTTP {}.",
            response.status()
        ));
    }

    let payload: ClaudeUsageResponse = response
        .json()
        .map_err(|error| format!("Falha ao decodificar resposta do Claude: {error}"))?;

    let five_hour = payload
        .five_hour
        .ok_or_else(|| "five_hour nao foi encontrado na resposta do Claude.".to_string())?;
    let utilization = five_hour.utilization.ok_or_else(|| {
        "five_hour.utilization nao foi encontrado na resposta do Claude.".to_string()
    })?;

    let seven_day_utilization = payload
        .seven_day
        .as_ref()
        .and_then(|value| value.utilization);
    let seven_day_resets_at = payload
        .seven_day
        .as_ref()
        .and_then(|value| value.resets_at.clone());

    Ok(UsageMetric {
        usuario: normalized_user(&config.usuario),
        ferramenta: "claude".to_string(),
        uso_percentual: Some(round_percent(utilization)),
        restante_percentual: Some(remaining_percent(utilization)),
        status: "ok".to_string(),
        coletado_em: Utc::now().to_rfc3339(),
        reset_em: five_hour.resets_at,
        erro: None,
        uso_percentual_7d: seven_day_utilization.map(round_percent),
        restante_percentual_7d: seven_day_utilization.map(remaining_percent),
        reset_em_7d: seven_day_resets_at,
    })
}

/// Hostname da maquina, calculado uma unica vez (nao muda durante a execucao).
fn host_name() -> String {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(|| {
        hostname::get()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    })
    .clone()
}

/// Envia a metrica ao Loki. Em caso de sucesso devolve o **body** (payload
/// interno) efetivamente enviado, para que o historico de envios mostre
/// exatamente quais dados foram ao Loki.
fn send_metric_to_loki(
    client: &Client,
    config: &AppConfig,
    metric: &UsageMetric,
) -> Result<Value, String> {
    if config.loki.url.trim().is_empty() {
        return Err("URL do Loki nao configurada.".to_string());
    }

    let timestamp_nanos = iso_to_nanos(&metric.coletado_em)?;
    let host = host_name();

    let mut body = json!({
        "status": metric.status,
        "reset_em": metric.reset_em
    });

    if let Some(value) = metric.uso_percentual {
        body["uso_percentual"] = json!(value);
    }
    if let Some(value) = metric.restante_percentual {
        body["restante_percentual"] = json!(value);
    }
    if let Some(error) = &metric.erro {
        body["erro"] = Value::String(error.clone());
    }

    if let Some(value) = metric.uso_percentual_7d {
        body["uso_percentual_7d"] = json!(value);
    }
    if let Some(value) = metric.restante_percentual_7d {
        body["restante_percentual_7d"] = json!(value);
    }
    if let Some(value) = &metric.reset_em_7d {
        body["reset_em_7d"] = Value::String(value.clone());
    }

    let payload = json!({
        "streams": [
            {
                "stream": {
                    "app": "ai-usage-tray-agent",
                    "usuario": metric.usuario,
                    "ferramenta": metric.ferramenta,
                    "host": host
                },
                "values": [
                    [timestamp_nanos, body.to_string()]
                ]
            }
        ]
    });

    let request = client
        .post(config.loki.url.trim())
        .header("content-type", "application/json")
        .json(&payload);

    let response = request
        .send()
        .map_err(|error| format!("Falha HTTP ao enviar para Loki: {error}"))?;

    if response.status().is_success() {
        Ok(body)
    } else {
        Err(format!("Loki retornou status HTTP {}.", response.status()))
    }
}

fn refresh_tray<R: Runtime>(app: &AppHandle<R>, shared: &Arc<SharedState>) -> tauri::Result<()> {
    // `tray` so' e' usado no Linux (set_title); no Windows o handle serve apenas
    // como guarda de "o tray existe".
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        // Le' a config uma unica vez por refresh (em vez de recarregar para a
        // barra de tarefas e o widget separadamente).
        let config = app
            .try_state::<RuntimePaths>()
            .map(|paths| read_config(paths.inner()));

        // Metrica de provider desabilitado nao deve sobreviver no snapshot: senao
        // o menu do tray (e o titulo no Linux) exibiriam um valor obsoleto depois
        // de desligar o provider. O snapshot e' a fonte unica (tambem lida por "Uso atual" e pelo
        // widget, que ja' tratam o estado "desabilitado").
        let snapshot = {
            let mut guard = lock_snapshot(shared);
            if let Some(config) = &config {
                if !config.providers.codex.habilitado {
                    guard.codex_metric = None;
                }
                if !config.providers.claude.habilitado {
                    guard.claude_metric = None;
                }
            }
            guard.clone()
        };

        #[cfg(target_os = "windows")]
        {
            taskbar_widget::set_paused(snapshot.paused);
            if let Some(config) = &config {
                taskbar_widget::set_offset(config.barra_tarefas.deslocamento);
                taskbar_widget::set_side(config.barra_tarefas.lado_esquerdo());
                taskbar_widget::set_font_size(config.barra_tarefas.tamanho_fonte_pt());
                taskbar_widget::set_font_color(config.barra_tarefas.cor_fonte_rgb());
                taskbar_widget::set_order(&config.providers.ordem);
                let mostrar_hora = config.barra_tarefas.mostrar_hora_reset();
                let (mostra_sessao, mostra_semanal) = parse_janelas(&config.barra_tarefas.janelas);
                taskbar_widget::set_provider(
                    "codex",
                    config.providers.codex.habilitado
                        && config.providers.codex.mostra_na_taskbar_windows,
                    widget_detail(
                        snapshot.codex_metric.as_ref(),
                        mostrar_hora,
                        mostra_sessao,
                        mostra_semanal,
                    ),
                );
                taskbar_widget::set_provider(
                    "claude",
                    config.providers.claude.habilitado
                        && config.providers.claude.mostra_na_taskbar_windows,
                    widget_detail(
                        snapshot.claude_metric.as_ref(),
                        mostrar_hora,
                        mostra_sessao,
                        mostra_semanal,
                    ),
                );
            }
        }

        #[cfg(target_os = "linux")]
        tray.set_title(Some(format!(
            "C:{} / Cl:{}",
            metric_text(snapshot.codex_metric.as_ref()),
            metric_text(snapshot.claude_metric.as_ref())
        )))?;

        // Aplica a config do widget (criar/destruir/sempre-na-frente) em
        // Windows/Linux, reusando o config ja' lido acima.
        #[cfg(not(target_os = "macos"))]
        if let Some(config) = &config {
            apply_widget(app, config);
        }

        update_tray_menu(app, &snapshot);
    }

    Ok(())
}

fn update_metric(shared: &Arc<SharedState>, metric: UsageMetric) {
    let mut snapshot = lock_snapshot(shared);
    match metric.ferramenta.as_str() {
        "codex" => snapshot.codex_metric = Some(metric),
        "claude" => snapshot.claude_metric = Some(metric),
        _ => {}
    }
}

fn mark_success(shared: &Arc<SharedState>) {
    let mut snapshot = lock_snapshot(shared);
    snapshot.last_successful_send_at = Some(Utc::now().to_rfc3339());
}

/// Registra uma tentativa de envio no historico em memoria (anel). Mantem no
/// maximo `SEND_LOG_MAX` entradas, descartando as mais antigas.
fn push_send_log(
    shared: &Arc<SharedState>,
    ferramenta: &str,
    status: &str,
    detalhe: Option<String>,
    payload: Option<Value>,
) {
    let mut snapshot = lock_snapshot(shared);
    snapshot.send_log.push(SendLogEntry {
        timestamp: Utc::now().to_rfc3339(),
        ferramenta: ferramenta.to_string(),
        status: status.to_string(),
        detalhe,
        payload,
    });
    let excess = snapshot.send_log.len().saturating_sub(SEND_LOG_MAX);
    if excess > 0 {
        snapshot.send_log.drain(0..excess);
    }
}

fn clear_last_error(shared: &Arc<SharedState>) {
    let mut snapshot = lock_snapshot(shared);
    snapshot.last_error = None;
}

/// Registra uma amostra do uso atual no anel de historico (em memoria) e poda o
/// que passou da janela de 5h. Chamado uma vez por ciclo de coleta, depois que os
/// dois provedores ja' atualizaram o snapshot. Grava a % de cada janela por
/// provedor, usando `None` quando o provedor esta' desabilitado ou com erro
/// naquele instante. Uma amostra totalmente vazia (nenhum dado ainda) e' ignorada
/// para nao abrir "furos" no comeco.
///
/// Com `enabled == false` (grafico desligado na tela "Uso atual"), nao grava e
/// limpa o historico ja' acumulado — para de gravar e "exclui os dados".
fn push_usage_sample(shared: &Arc<SharedState>, enabled: bool) {
    let mut snapshot = lock_snapshot(shared);
    if !enabled {
        if !snapshot.usage_history.is_empty() {
            snapshot.usage_history.clear();
        }
        return;
    }
    let value = |metric: &Option<UsageMetric>, weekly: bool| -> Option<f64> {
        let metric = metric.as_ref()?;
        if metric.status == "erro" || metric.erro.is_some() {
            return None;
        }
        if weekly {
            metric.uso_percentual_7d
        } else {
            metric.uso_percentual
        }
    };
    let sample = UsageSample {
        t: Utc::now().to_rfc3339(),
        claude_5h: value(&snapshot.claude_metric, false),
        claude_7d: value(&snapshot.claude_metric, true),
        codex_5h: value(&snapshot.codex_metric, false),
        codex_7d: value(&snapshot.codex_metric, true),
    };
    if sample.claude_5h.is_none()
        && sample.claude_7d.is_none()
        && sample.codex_5h.is_none()
        && sample.codex_7d.is_none()
    {
        return;
    }
    snapshot.usage_history.push(sample);
    prune_usage_history(&mut snapshot.usage_history);
}

/// Poda o anel de historico: descarta amostras mais velhas que a janela de 5h
/// (relativas a' amostra mais recente) e aplica o teto de contagem.
fn prune_usage_history(history: &mut Vec<UsageSample>) {
    if let Some(newest) = history
        .last()
        .and_then(|sample| DateTime::parse_from_rfc3339(&sample.t).ok())
    {
        let cutoff = newest - chrono::Duration::seconds(USAGE_HISTORY_WINDOW_SECS);
        history.retain(|sample| {
            DateTime::parse_from_rfc3339(&sample.t)
                .map(|when| when >= cutoff)
                .unwrap_or(true)
        });
    }
    let excess = history.len().saturating_sub(USAGE_HISTORY_MAX);
    if excess > 0 {
        history.drain(0..excess);
    }
}

/// Reduz o historico a no maximo `USAGE_CHART_POINTS` pontos (stride uniforme,
/// sempre incluindo a ultima amostra), extraindo um valor por amostra via `pick`.
/// Pontos sem valor (provedor desabilitado/erro naquele instante) sao omitidos.
/// Formato: `[{ "t": <iso>, "pct": <num> }, ...]`, em ordem cronologica.
fn downsample_usage(
    history: &[UsageSample],
    pick: impl Fn(&UsageSample) -> Option<f64>,
) -> Vec<Value> {
    let n = history.len();
    if n == 0 {
        return Vec::new();
    }
    let stride = n.div_ceil(USAGE_CHART_POINTS).max(1);
    history
        .iter()
        .enumerate()
        .filter(|(i, _)| i % stride == 0 || *i == n - 1)
        .filter_map(|(_, sample)| pick(sample).map(|pct| json!({ "t": sample.t, "pct": pct })))
        .collect()
}

/// Registra um erro de runtime (estado + log) SEM atualizar o tray. Usado dentro
/// do ciclo de coleta, que faz um unico `refresh_tray` no fim — evita repintar o
/// tray varias vezes por ciclo.
fn record_runtime_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    if let Some(shared) = app.try_state::<Arc<SharedState>>() {
        lock_snapshot(shared.inner()).last_error = Some(message.to_string());
    }
    let _ = append_log_line(app.state::<RuntimePaths>().inner(), "error", message, None);
}

/// Registra um erro de runtime e atualiza o tray na hora. Para os pontos avulsos
/// (itens de menu, erros de janela) que nao tem um `refresh_tray` posterior
/// garantido.
fn handle_runtime_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    record_runtime_error(app, message);
    if let Some(shared) = app.try_state::<Arc<SharedState>>() {
        let _ = refresh_tray(app, &shared);
    }
}

/// Verifica se ha uma versao mais nova publicada (endpoint do updater no
/// `tauri.conf.json`) e, havendo, pergunta ao usuario antes de baixar/instalar.
///
/// Roda em uma tarefa async (fora da main thread), entao os dialogos usam
/// `blocking_show`. `manual = true` quando acionada pelo item "Buscar
/// atualizacoes" do tray: nesse caso tambem avisa quando nao ha update ou quando
/// a verificacao falha. No boot (`manual = false`) so' interage se houver update.
async fn check_for_updates<R: Runtime>(app: AppHandle<R>, manual: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;

    // Nome do app (productName) para identificar o que esta' sendo atualizado nos
    // dialogos — o usuario pode ter varias bandejas/apps abertos.
    let app_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "AiUsageTrayAgent".to_string());

    let log_error = |app: &AppHandle<R>, message: &str| {
        if let Some(paths) = app.try_state::<RuntimePaths>() {
            let _ = append_log_line(paths.inner(), "error", message, None);
        }
    };
    let notify = |app: &AppHandle<R>, message: String| {
        app.dialog()
            .message(message)
            .title(app_name.as_str())
            .buttons(MessageDialogButtons::Ok)
            .blocking_show();
    };

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            log_error(&app, &format!("Updater indisponível: {error}"));
            if manual {
                notify(
                    &app,
                    format!("Não foi possível verificar atualizações do {app_name}."),
                );
            }
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            // Guarda os dados da versao (incluindo o changelog em `update.body`,
            // que vem do campo `notes` do manifesto) e abre a janela de novidades.
            // A instalacao em si roda no comando `install_update` (botao da janela),
            // que re-verifica antes de baixar — por isso nao seguramos o `update`.
            if let Some(shared) = app.try_state::<Arc<SharedState>>() {
                let pending = PendingUpdate {
                    app_name: app_name.clone(),
                    current_version: update.current_version.to_string(),
                    new_version: update.version.to_string(),
                    notes: update.body.clone().unwrap_or_default(),
                };
                let mut guard = shared
                    .pending_update
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *guard = Some(pending);
            }
            show_update_window(&app);
        }
        Ok(None) => {
            if manual {
                notify(
                    &app,
                    format!("O {app_name} já está na versão mais recente."),
                );
            }
        }
        Err(error) => {
            log_error(&app, &format!("Falha ao verificar atualização: {error}"));
            if manual {
                notify(
                    &app,
                    format!("Não foi possível verificar atualizações do {app_name}: {error}"),
                );
            }
        }
    }
}

/// Acionado pelo botao "Buscar atualizacoes" da aba Sistema (Configuracoes).
/// Faz a verificacao (mesma usada pelo tray), com feedback via dialogo nativo.
/// Comando `async`: roda fora da main thread (os dialogos usam `blocking_show`) e
/// so' resolve quando o fluxo termina, para a UI poder limpar o aviso de
/// "verificando".
#[tauri::command]
async fn check_updates_now(app: AppHandle) {
    check_for_updates(app, true).await;
}

/// Status da verificacao de atualizacao, consumido pela aba "Sobre" das
/// Configuracoes para decidir a mensagem e qual botao mostrar.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    available: bool,
    current_version: String,
    new_version: Option<String>,
    error: Option<String>,
}

/// Verifica se ha atualizacao SEM efeitos colaterais de UI (nao abre janela nem
/// dialogo) — usado pela aba "Sobre". Quando ha update, guarda os dados em
/// `pending_update` para o "Atualizar agora" (`open_update_window`) reaproveitar.
#[tauri::command]
async fn check_update_status(app: AppHandle) -> UpdateStatus {
    use tauri_plugin_updater::UpdaterExt;

    let current = app.package_info().version.to_string();
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            return UpdateStatus {
                current_version: current,
                error: Some(format!("Updater indisponível: {error}")),
                ..Default::default()
            }
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            if let Some(shared) = app.try_state::<Arc<SharedState>>() {
                let app_name = app
                    .config()
                    .product_name
                    .clone()
                    .unwrap_or_else(|| "AiUsageTrayAgent".to_string());
                let pending = PendingUpdate {
                    app_name,
                    current_version: update.current_version.to_string(),
                    new_version: update.version.to_string(),
                    notes: update.body.clone().unwrap_or_default(),
                };
                *shared
                    .pending_update
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pending);
            }
            UpdateStatus {
                available: true,
                current_version: update.current_version.to_string(),
                new_version: Some(update.version.to_string()),
                error: None,
            }
        }
        Ok(None) => UpdateStatus {
            current_version: current,
            ..Default::default()
        },
        Err(error) => UpdateStatus {
            current_version: current,
            error: Some(format!("{error}")),
            ..Default::default()
        },
    }
}

/// Abre a janela de novidades (`update.html`) a partir dos dados ja' guardados em
/// `pending_update` (por `check_update_status`/`check_for_updates`). Acionado pelo
/// botao "Atualizar agora" da tela "Sobre".
///
/// `async` de proposito: comandos sincronos rodam na thread principal, e criar a
/// `WebviewWindow` ali (dentro do comando) trava o event loop — a janela abre mas
/// o webview nunca carrega (tela branca). Como `async`, o Tauri roda isto fora da
/// main thread e a criacao da janela e' despachada para o event loop livre (mesmo
/// caminho do "Buscar atualizacoes" do tray, que ja' funciona por ser async).
#[tauri::command]
async fn open_update_window(app: AppHandle) {
    show_update_window(&app);
}

/// Abre (ou foca) a janela de novidades da atualizacao (`update.html`). Os dados
/// (versoes + changelog) ja' foram guardados em `SharedState.pending_update` por
/// `check_for_updates`; a janela os busca via `get_pending_update`.
fn show_update_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("update") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    let app_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "AiUsageTrayAgent".to_string());
    let result = WebviewWindowBuilder::new(app, "update", WebviewUrl::App("update.html".into()))
        .title(app_name)
        .inner_size(520.0, 560.0)
        .min_inner_size(420.0, 420.0)
        .center()
        .resizable(true)
        .decorations(true)
        .build();
    match result {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(error) => handle_runtime_error(
            app,
            &format!("Falha ao abrir a janela de atualização: {error}"),
        ),
    }
}

/// Dados da atualizacao pendente para a janela `update.html`. `None` quando nao
/// ha' atualizacao detectada (a janela mostra um aviso e desabilita o botao).
#[tauri::command]
fn get_pending_update(shared: State<'_, Arc<SharedState>>) -> Option<PendingUpdate> {
    shared
        .pending_update
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Acionado pelo botao "Atualizar agora" da janela de novidades. Re-verifica,
/// baixa e instala a atualizacao, emitindo o progresso (`update-progress`) para a
/// janela `update`. Ao concluir com sucesso, reinicia o app (a chamada nunca
/// "retorna" nesse caso). Em falha, retorna a mensagem para a janela exibir.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|error| format!("Updater indisponível: {error}"))?;

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Err("Nenhuma atualização disponível.".to_string()),
        Err(error) => return Err(format!("Falha ao verificar atualização: {error}")),
    };

    // `download_and_install` recebe um `Fn` (nao `FnMut`); acumula os bytes via
    // atomico compartilhado para emitir o progresso.
    let downloaded = Arc::new(AtomicU64::new(0));
    let dl = downloaded.clone();
    let app_progress = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                let acc = dl.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let _ = app_progress.emit_to(
                    "update",
                    "update-progress",
                    json!({ "downloaded": acc, "total": total }),
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(_) => {
            app.restart();
        }
        Err(error) => {
            if let Some(paths) = app.try_state::<RuntimePaths>() {
                let _ = append_log_line(
                    paths.inner(),
                    "error",
                    &format!("Falha ao instalar atualização: {error}"),
                    None,
                );
            }
            Err(format!("Falha ao instalar a atualização: {error}"))
        }
    }
}

/// Busca o `CHANGELOG.md` cru do branch `main` no GitHub. E' a fonte do
/// changelog exibido no app (janela OTA: "delta" de versoes; tela "Novidades":
/// historico completo). Feito no backend porque a CSP do webview bloqueia
/// requisicoes a hosts externos. Roda em `spawn_blocking` (cliente reqwest
/// bloqueante, como o resto da coleta). Em falha, retorna `Err` e a UI mostra um
/// aviso (sem impedir a atualizacao).
#[tauri::command]
async fn get_changelog() -> Result<String, String> {
    const URL: &str =
        "https://raw.githubusercontent.com/wzuqui/ai-usage-tray-agent/main/CHANGELOG.md";

    tauri::async_runtime::spawn_blocking(|| {
        let response = http_client()
            .get(URL)
            .header("User-Agent", "ai-usage-tray-agent")
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        response.text().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn build_error_metric(usuario: &str, ferramenta: &str, erro: &str) -> UsageMetric {
    UsageMetric {
        usuario: normalized_user(usuario),
        ferramenta: ferramenta.to_string(),
        uso_percentual: Some(0.0),
        restante_percentual: Some(100.0),
        status: "erro".to_string(),
        coletado_em: Utc::now().to_rfc3339(),
        reset_em: None,
        erro: Some(erro.to_string()),
        uso_percentual_7d: None,
        restante_percentual_7d: None,
        reset_em_7d: None,
    }
}

fn normalized_user(usuario: &str) -> String {
    let trimmed = usuario.trim();
    if trimmed.is_empty() {
        "desconhecido".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(target_os = "linux")]
fn metric_text(metric: Option<&UsageMetric>) -> String {
    let Some(metric) = metric else {
        return "--".to_string();
    };
    let session = metric.uso_percentual.map(|value| format!("{value:.1}%"));
    let weekly = metric
        .uso_percentual_7d
        .map(|value| format!("{value:.1}% (7d)"));
    match (session, weekly) {
        (Some(session), Some(weekly)) => format!("{session} | {weekly}"),
        (Some(session), None) => session,
        (None, Some(weekly)) => weekly,
        (None, None) => "--".to_string(),
    }
}

/// Quais janelas exibir a partir da config "janelas": devolve
/// `(mostra_sessao, mostra_semanal)`. "sessao" -> so 5h; "semanal" -> so 7d;
/// qualquer outro valor (inclusive "ambos") -> as duas.
#[cfg(target_os = "windows")]
fn parse_janelas(value: &str) -> (bool, bool) {
    match value.trim().to_ascii_lowercase().as_str() {
        "sessao" | "sessão" | "session" | "5h" => (true, false),
        "semanal" | "semana" | "weekly" | "7d" => (false, true),
        _ => (true, true),
    }
}

/// Linha de detalhe do widget da barra de tarefas. Com `mostrar_hora = false`
/// usa o tempo restante (`20% (2:36h) | 50% (2d)`); com `true` usa a hora/data
/// exata do reset (`20% (19:20) | 50% (22/06, 19:59)`). `mostra_sessao`/
/// `mostra_semanal` escolhem as janelas (5h/7d); com uma so', o separador "|"
/// some. Se a janela escolhida nao tem dados, cai na outra que estiver disponivel.
#[cfg(target_os = "windows")]
fn widget_detail(
    metric: Option<&UsageMetric>,
    mostrar_hora: bool,
    mostra_sessao: bool,
    mostra_semanal: bool,
) -> String {
    let Some(metric) = metric else {
        return "--".to_string();
    };
    if metric.status == "erro" {
        return "erro".to_string();
    }

    let suffix = |iso: Option<&str>| {
        if mostrar_hora {
            reset_suffix_clock(iso)
        } else {
            reset_suffix(iso)
        }
    };

    let session = metric
        .uso_percentual
        .map(|value| format!("{:.0}%{}", value, suffix(metric.reset_em.as_deref())));
    let weekly = metric
        .uso_percentual_7d
        .map(|value| format!("{:.0}%{}", value, suffix(metric.reset_em_7d.as_deref())));

    let mut parts: Vec<String> = Vec::new();
    if mostra_sessao {
        if let Some(session) = &session {
            parts.push(session.clone());
        }
    }
    if mostra_semanal {
        if let Some(weekly) = &weekly {
            parts.push(weekly.clone());
        }
    }
    // Sem nenhuma parte (ex.: janela escolhida sem dados): cai na que existir, ou
    // "--" se nenhuma tem dados.
    if parts.is_empty() {
        return session.or(weekly).unwrap_or_else(|| "--".to_string());
    }
    parts.join(" | ")
}

/// Sufixo " (tempo)" para o reset (tempo restante); vazio quando nao ha reset valido.
#[cfg(target_os = "windows")]
fn reset_suffix(iso: Option<&str>) -> String {
    match format_reset(iso) {
        Some(text) => format!(" ({text})"),
        None => String::new(),
    }
}

/// Sufixo " (hora)" para o reset (hora/data exata); vazio quando nao ha reset valido.
#[cfg(target_os = "windows")]
fn reset_suffix_clock(iso: Option<&str>) -> String {
    match format_reset_clock(iso) {
        Some(text) => format!(" ({text})"),
        None => String::new(),
    }
}

/// Formata a hora/data exata do reset em horario local: "19:20" se for hoje, ou
/// "22/06, 19:59" se for outro dia.
#[cfg(target_os = "windows")]
fn format_reset_clock(iso: Option<&str>) -> Option<String> {
    let reset = DateTime::parse_from_rfc3339(iso?)
        .ok()?
        .with_timezone(&chrono::Local);
    let same_day = reset.date_naive() == chrono::Local::now().date_naive();
    let text = if same_day {
        reset.format("%H:%M").to_string()
    } else {
        reset.format("%d/%m, %H:%M").to_string()
    };
    Some(text)
}

/// Formata o tempo restante ate o reset: "2d", "2:36h" ou "45m".
#[cfg(target_os = "windows")]
fn format_reset(iso: Option<&str>) -> Option<String> {
    let reset = DateTime::parse_from_rfc3339(iso?).ok()?;
    let seconds = (reset.with_timezone(&Utc) - Utc::now()).num_seconds();
    if seconds <= 0 {
        return Some("0m".to_string());
    }
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if days >= 1 {
        Some(format!("{days}d"))
    } else if hours >= 1 {
        Some(format!("{hours}:{minutes:02}h"))
    } else {
        Some(format!("{minutes}m"))
    }
}

fn iso_to_nanos(iso: &str) -> Result<String, String> {
    let timestamp = DateTime::parse_from_rfc3339(iso)
        .map_err(|error| format!("Timestamp invalido para Loki: {error}"))?;
    Ok(timestamp
        .timestamp_nanos_opt()
        .unwrap_or_default()
        .to_string())
}

fn timestamp_seconds_to_iso(value: i64) -> Option<String> {
    DateTime::from_timestamp(value, 0).map(|timestamp| timestamp.to_rfc3339())
}

fn round_percent(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Percentual restante (100 - usado), arredondado e limitado a 0..=100 — evita
/// exibir valores negativos caso a API devolva uso acima de 100%.
fn remaining_percent(used: f64) -> f64 {
    round_percent((100.0 - used).clamp(0.0, 100.0))
}

fn ensure_storage() -> Result<RuntimePaths, Box<dyn std::error::Error>> {
    let paths = runtime_paths()?;
    fs::create_dir_all(&paths.config_dir)?;
    fs::create_dir_all(&paths.logs_dir)?;
    Ok(paths)
}

fn runtime_paths() -> Result<RuntimePaths, Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        let app_data = env::var("APPDATA")
            .map(PathBuf::from)
            .or_else(|_| dirs::config_dir().ok_or(env::VarError::NotPresent))?;
        let local_app_data = env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|_| dirs::data_local_dir().ok_or(env::VarError::NotPresent))?;

        return Ok(RuntimePaths {
            config_dir: app_data.join(APP_NAME_WINDOWS),
            config_file: app_data.join(APP_NAME_WINDOWS).join("config.json"),
            logs_dir: local_app_data.join(APP_NAME_WINDOWS).join("logs"),
        });
    }

    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir().ok_or("Home directory nao encontrada.")?;

        return Ok(RuntimePaths {
            config_dir: home.join(".config").join(APP_NAME_LINUX),
            config_file: home
                .join(".config")
                .join(APP_NAME_LINUX)
                .join("config.json"),
            logs_dir: home
                .join(".local")
                .join("state")
                .join(APP_NAME_LINUX)
                .join("logs"),
        });
    }

    #[allow(unreachable_code)]
    Err("Sistema operacional nao suportado.".into())
}

/// Aplica os limites sensatos aos campos numericos (clamp), in-place. Compartilhado
/// pela leitura (`read_config`), pela criacao/normalizacao (`load_or_create_config`)
/// e pelo save das Configuracoes (`save_settings`).
fn normalize_config(config: &mut AppConfig) {
    config.intervalo_segundos = config.intervalo_segundos.clamp(5, 3600);
    config.widget.opacidade = config.widget.opacidade.clamp(0, 100);
    if config.servidor.host.trim().is_empty() {
        config.servidor.host = "127.0.0.1".to_string();
    }
    if config.servidor.porta == 0 {
        config.servidor.porta = 8770;
    }
    normalize_provider_order(&mut config.providers.ordem);
    normalize_sessao_auto(&mut config.providers.claude.sessao_auto);
}

/// Sanitiza a reabertura automatica: modo desconhecido volta para `automatico` e a
/// lista de horarios fica canonica (so' `"HH:MM"` valido, sem duplicatas, em ordem
/// cronologica). Assim o resto do codigo pode confiar na lista sem revalidar, e o
/// painel sempre reabre mostrando o que esta' realmente valendo.
fn normalize_sessao_auto(sessao_auto: &mut SessaoAutoConfig) {
    if sessao_auto.modo != SESSAO_AUTO_MODO_AGENDADO {
        sessao_auto.modo = SESSAO_AUTO_MODO_AUTOMATICO.to_string();
    }
    let mut minutos: Vec<u32> = sessao_auto
        .horarios
        .iter()
        .filter_map(|horario| parse_horario(horario))
        .collect();
    minutos.sort_unstable();
    minutos.dedup();
    sessao_auto.horarios = minutos
        .into_iter()
        .map(|minuto| format!("{:02}:{:02}", minuto / 60, minuto % 60))
        .collect();
}

/// Converte `"HH:MM"` (aceita `"H:MM"` e sobras de espaco) no minuto do dia.
/// `None` para qualquer coisa fora disso — inclusive `"24:00"` e `"09:60"`.
fn parse_horario(horario: &str) -> Option<u32> {
    let (hora, minuto) = horario.trim().split_once(':')?;
    let hora: u32 = hora.trim().parse().ok()?;
    let minuto: u32 = minuto.trim().parse().ok()?;
    if hora > 23 || minuto > 59 {
        return None;
    }
    Some(hora * 60 + minuto)
}

/// Sanitiza a ordem dos provedores: mantém só chaves conhecidas (`PROVIDER_KEYS`),
/// sem duplicatas, preservando a ordem escolhida pelo usuário; depois anexa, na
/// ordem canônica, qualquer provedor conhecido que esteja faltando. Resultado:
/// sempre uma permutação exata dos provedores conhecidos (robusto a JSON inválido
/// e pronto para novos provedores, que entram no fim).
fn normalize_provider_order(order: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    order.retain(|key| PROVIDER_KEYS.contains(&key.as_str()) && seen.insert(key.clone()));
    for &key in PROVIDER_KEYS.iter() {
        if !order.iter().any(|existing| existing == key) {
            order.push(key.to_string());
        }
    }
}

/// Le e normaliza (clamp) o config.json SEM o round-trip de `Value` nem reescrita
/// — barato e sem efeito colateral em disco. E' a variante usada nos caminhos de
/// leitura quentes (comandos de UI em polling, refresh do tray, ciclo de coleta).
/// A criacao do arquivo e a normalizacao-com-reescrita ficam em
/// `load_or_create_config` (boot + deteccao de edicao manual no worker).
fn read_config(paths: &RuntimePaths) -> AppConfig {
    let Ok(content) = fs::read_to_string(&paths.config_file) else {
        return AppConfig::default();
    };
    let mut config: AppConfig = serde_json::from_str(&content).unwrap_or_default();
    normalize_config(&mut config);
    config
}

fn load_or_create_config(paths: &RuntimePaths) -> Result<AppConfig, Box<dyn std::error::Error>> {
    if !paths.config_file.exists() {
        let default_config = AppConfig::default();
        write_config(paths, &default_config)?;
        return Ok(default_config);
    }

    let content = fs::read_to_string(&paths.config_file)?;
    // Campos ausentes sao preenchidos com os padroes (containers com
    // `#[serde(default)]`), preservando os valores ja existentes no arquivo.
    let mut config: AppConfig = serde_json::from_str(&content)?;
    normalize_config(&mut config);

    // Normaliza o arquivo: se algo estava faltando (ou fora do clamp), regrava
    // com a estrutura completa. A comparacao e feita sobre `Value` para ignorar
    // diferencas de formatacao/ordem e so reescrever quando houver mudanca real.
    let original: Value = serde_json::from_str(&content)?;
    let canonical: Value = serde_json::to_value(&config)?;
    if original != canonical {
        write_config(paths, &config)?;
    }

    Ok(config)
}

fn write_config(
    paths: &RuntimePaths,
    config: &AppConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let payload = serde_json::to_string_pretty(config)?;
    fs::write(&paths.config_file, format!("{payload}\n"))?;
    Ok(())
}

fn append_log_line(
    paths: &RuntimePaths,
    level: &str,
    message: &str,
    meta: Option<Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(&paths.logs_dir)?;

    let log_path = paths
        .logs_dir
        .join(format!("{}.log", Utc::now().format("%Y-%m-%d")));
    let mut file = open_append_file(&log_path)?;
    let payload = json!({
        "timestamp": Utc::now().to_rfc3339(),
        "level": level,
        "message": message,
        "meta": meta
    });

    writeln!(file, "{payload}")?;
    Ok(())
}

fn open_append_file(path: &Path) -> Result<File, Box<dyn std::error::Error>> {
    Ok(OpenOptions::new().create(true).append(true).open(path)?)
}

/// Abre uma URL http(s) no navegador padrao do sistema. Usado pelo link do
/// repositorio na aba "Sobre" (a CSP impede navegar a webview para fora).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("URL inválida.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Abertura de URL nao suportada neste sistema.".to_string())
}

/// Login do Claude pelo navegador: abre `claude.ai/login` numa janela propria,
/// aguarda o usuario logar e captura o cookie de sessao (`sessionKey`, httpOnly) via
/// `cookies_for_url`; depois descobre o `organization_id` e guarda tudo no arquivo
/// gerenciado. `async` porque criar a WebviewWindow num comando sincrono trava o
/// event loop (janela em branco); a leitura de cookie roda em `spawn_blocking`
/// porque no Windows ela deadlocka se chamada na main thread.
#[tauri::command]
async fn claude_login(app: AppHandle) -> Result<Value, String> {
    // Fecha uma janela de login anterior que tenha sobrado aberta (libera o label).
    if let Some(existing) = app.get_webview_window("claude-login") {
        let _ = existing.close();
    }
    let cancel_flag = claude_auth::begin_login();

    // Abre em branco de proposito: a captura limpa a sessao persistida do webview e
    // so entao navega para o login, garantindo que cada "Conectar" peca credenciais
    // (permite trocar de conta) em vez de reusar o cookie da sessao anterior.
    let blank_url = Url::parse("about:blank").map_err(|error| format!("URL inválida: {error}"))?;
    let window =
        match WebviewWindowBuilder::new(&app, "claude-login", WebviewUrl::External(blank_url))
            .title("Entrar no Claude")
            .inner_size(480.0, 780.0)
            .center()
            .build()
        {
            Ok(window) => window,
            Err(error) => {
                claude_auth::end_login(&cancel_flag);
                return Err(format!(
                    "Falha ao abrir a janela de login do Claude: {error}"
                ));
            }
        };

    let flag_for_task = cancel_flag.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let paths = app.state::<RuntimePaths>().inner().clone();
        capture_claude_login(&app, &window, &paths, &flag_for_task)
    })
    .await
    .map_err(|error| error.to_string());

    claude_auth::end_login(&cancel_flag);
    outcome?
}

/// Loop (fora da main thread) que espera o cookie `sessionKey` aparecer no webview
/// de login, respeitando cancelamento, fechamento da janela pelo usuario e um
/// timeout. Ao capturar, fecha a janela, descobre o `organization_id` e persiste.
fn capture_claude_login(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &RuntimePaths,
    cancel_flag: &AtomicBool,
) -> Result<Value, String> {
    let claude_url = Url::parse("https://claude.ai").expect("URL estatica valida");

    // Limpa cookies/dados do webview (a janela esta em `about:blank`, sem sessao
    // sendo criada) e navega para o login — forca um login novo, sem reusar a conta
    // anterior. A limpeza conclui bem antes de o usuario enviar as credenciais.
    let _ = window.clear_all_browsing_data();
    thread::sleep(Duration::from_millis(700));
    if let Ok(login_url) = Url::parse("https://claude.ai/login") {
        let _ = window.navigate(login_url);
    }

    let deadline = Instant::now() + Duration::from_secs(5 * 60);

    let session_key = loop {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = window.close();
            return Err("Login cancelado.".to_string());
        }
        // Usuario fechou a janela de login manualmente.
        if app.get_webview_window("claude-login").is_none() {
            return Err("Login cancelado.".to_string());
        }
        if Instant::now() >= deadline {
            let _ = window.close();
            return Err("Tempo limite aguardando o login do Claude.".to_string());
        }
        if let Ok(cookies) = window.cookies_for_url(claude_url.clone()) {
            if let Some(value) = cookies
                .iter()
                .find(|cookie| cookie.name() == "sessionKey")
                .map(|cookie| cookie.value().trim().to_string())
                .filter(|value| !value.is_empty())
            {
                break value;
            }
        }
        thread::sleep(Duration::from_millis(1000));
    };

    let _ = window.close();
    let client = http_client();
    let orgs = claude_auth::fetch_chat_organizations(&client, &session_key)?;

    match orgs.as_slice() {
        [] => Err("Nenhuma organização encontrada na conta do Claude.".to_string()),
        // Uma unica org: nada a escolher, salva direto (comportamento de sempre).
        [org] => {
            let email = claude_auth::fetch_email(&client, &session_key);
            let status = claude_auth::store(&paths.config_dir, &session_key, &org.uuid, email)?;
            Ok(json!({ "needsSelection": false, "status": status }))
        }
        // Varias orgs com "chat": guarda a sessao e devolve as candidatas (com o uso
        // atual de cada uma) para o usuario escolher; a coleta e' por org e escolher a
        // errada faz o app reportar 0% (ex.: org pessoal antiga vs. org de time usada).
        _ => {
            claude_auth::set_pending_session(&session_key);
            let email = claude_auth::fetch_email(&client, &session_key);
            let candidates: Vec<Value> = orgs
                .iter()
                .map(|org| {
                    json!({
                        "uuid": org.uuid,
                        "name": org.name,
                        "utilization": claude_org_utilization(&client, &session_key, &org.uuid),
                    })
                })
                .collect();
            Ok(json!({
                "needsSelection": true,
                "email": email,
                "organizations": candidates,
            }))
        }
    }
}

/// Uso da janela de 5h (0..100) de uma org, para ajudar o usuario a identificar a org
/// certa na tela de escolha. Melhor-esforco: qualquer falha vira `null`.
fn claude_org_utilization(
    client: &Client,
    session_key: &str,
    organization_id: &str,
) -> Option<f64> {
    let response = client
        .get(format!(
            "https://claude.ai/api/organizations/{organization_id}/usage"
        ))
        .header("accept", "*/*")
        .header("cookie", claude_auth::cookie_header(session_key))
        .header("referer", "https://claude.ai/settings/usage")
        .header(
            "user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        )
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: ClaudeUsageResponse = response.json().ok()?;
    payload
        .five_hour
        .and_then(|fh| fh.utilization)
        .map(round_percent)
}

/// Status do login do Claude pelo navegador (sem rede), para a aba Claude.
#[tauri::command]
fn claude_auth_status(paths: State<'_, RuntimePaths>) -> Value {
    claude_auth::status(&paths.config_dir)
}

/// Remove as credenciais do login do Claude pelo navegador ("Desconectar").
#[tauri::command]
fn claude_logout(paths: State<'_, RuntimePaths>) -> Result<(), String> {
    claude_auth::logout(&paths.config_dir)
}

/// Cancela um login do Claude em andamento (botao "Cancelar"): faz o loop de
/// captura parar e fechar a janela sem esperar o timeout.
#[tauri::command]
fn claude_login_cancel() {
    claude_auth::cancel();
}

/// Grava a org escolhida pelo usuario quando o login pelo navegador encontrou mais de
/// uma org com "chat" (ver `capture_claude_login`). Usa a sessao pendente capturada no
/// login; devolve o status para a UI. Erro se a sessao pendente expirou (novo login).
#[tauri::command]
fn claude_select_org(
    paths: State<'_, RuntimePaths>,
    organization_id: String,
) -> Result<Value, String> {
    let session_key = claude_auth::take_pending_session()
        .ok_or_else(|| "Sessão de login expirou. Conecte novamente.".to_string())?;
    let organization_id = organization_id.trim();
    if organization_id.is_empty() {
        return Err("Nenhuma organização selecionada.".to_string());
    }
    let client = http_client();
    let email = claude_auth::fetch_email(&client, &session_key);
    claude_auth::store(&paths.config_dir, &session_key, organization_id, email)
}

/// Login do Codex pelo navegador (OAuth + PKCE), alternativa ao caminho do
/// `auth.json`. E' bloqueante (sobe o servidor de callback e aguarda ate' ~5 min o
/// usuario concluir no navegador), entao roda em `spawn_blocking` para nao travar o
/// event loop. Grava os tokens no arquivo gerenciado e devolve o status do login
/// (`{connected,email,expiresAt,accountId}`).
#[tauri::command]
async fn codex_login(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = app.state::<RuntimePaths>().inner().clone();
        codex_auth::login(&http_client(), &paths.config_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Status do login do Codex pelo navegador (sem rede), para a aba Codex das
/// Configuracoes exibir "Conectado como ...".
#[tauri::command]
fn codex_auth_status(paths: State<'_, RuntimePaths>) -> Value {
    codex_auth::status(&paths.config_dir)
}

/// Remove as credenciais do login pelo navegador ("Desconectar").
#[tauri::command]
fn codex_logout(paths: State<'_, RuntimePaths>) -> Result<(), String> {
    codex_auth::logout(&paths.config_dir)
}

/// Cancela um login pelo navegador em andamento (botao "Cancelar"): libera a porta
/// 1455 e faz o `codex_login` pendente retornar sem esperar o timeout.
#[tauri::command]
fn codex_login_cancel() {
    codex_auth::cancel();
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Abertura de caminho nao suportada neste sistema.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn agendado(horarios: &[&str]) -> SessaoAutoConfig {
        SessaoAutoConfig {
            habilitado: true,
            modo: SESSAO_AUTO_MODO_AGENDADO.to_string(),
            horarios: horarios.iter().map(|h| h.to_string()).collect(),
            caminho_cli: String::new(),
        }
    }

    fn local(hora: u32, minuto: u32, segundo: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 8, 19, hora, minuto, segundo)
            .single()
            .expect("horario local valido (dia sem salto de fuso)")
    }

    #[test]
    fn parse_horario_aceita_hh_mm_e_recusa_o_resto() {
        assert_eq!(parse_horario("09:00"), Some(540));
        assert_eq!(parse_horario(" 9:05 "), Some(545));
        assert_eq!(parse_horario("23:59"), Some(1439));
        assert_eq!(parse_horario("24:00"), None);
        assert_eq!(parse_horario("09:60"), None);
        assert_eq!(parse_horario("0900"), None);
        assert_eq!(parse_horario(""), None);
    }

    #[test]
    fn normalize_sessao_auto_ordena_deduplica_e_descarta_invalidos() {
        let mut config = agendado(&["19:00", "9:0", "09:00", "banana", "25:00"]);
        normalize_sessao_auto(&mut config);
        assert_eq!(config.horarios, vec!["09:00", "19:00"]);
        assert_eq!(config.modo, SESSAO_AUTO_MODO_AGENDADO);

        let mut desconhecido = agendado(&[]);
        desconhecido.modo = "cron".to_string();
        normalize_sessao_auto(&mut desconhecido);
        assert_eq!(desconhecido.modo, SESSAO_AUTO_MODO_AUTOMATICO);
    }

    #[test]
    fn erro_do_cli_usa_stdout_stderr_e_trunca() {
        // O caso real: `claude -p` falha, escreve no stdout e deixa o stderr vazio.
        assert_eq!(
            erro_do_cli(
                "o Claude Code CLI terminou com exit code: 1",
                "Not logged in · Please run /login\n",
                "",
            ),
            "o Claude Code CLI terminou com exit code: 1: Not logged in · Please run /login"
        );
        // Os dois streams com texto: stderr primeiro.
        assert_eq!(
            erro_do_cli("base", "do stdout", "do stderr"),
            "base: do stderr | do stdout"
        );
        // Nada capturado: mantem a frase fechada, sem tracos soltos.
        assert_eq!(erro_do_cli("base", "  ", ""), "base.");
        // Truncagem pela cauda, contando caracteres (nao bytes).
        let longo = "ç".repeat(400);
        let erro = erro_do_cli("base", &longo, "");
        assert_eq!(erro.chars().count(), "base: ".chars().count() + 300);
        assert!(erro.ends_with('ç'));
    }

    /// Ponta a ponta com um CLI falso: o que o processo escreve no stdout tem de
    /// chegar na mensagem de erro — antes o stdout era descartado e sobrava so'
    /// "terminou com exit code: 1".
    #[cfg(target_os = "windows")]
    #[test]
    fn opener_leva_o_stdout_do_cli_falho_para_a_mensagem() {
        let base = std::env::temp_dir().join("ai-usage-tray-agent-teste-opener");
        fs::create_dir_all(&base).expect("criar a pasta do teste");
        let falso = base.join("claude-falso.cmd");
        fs::write(
            &falso,
            "@echo off\r\necho Not logged in - Please run /login\r\nexit /b 1\r\n",
        )
        .expect("gravar o CLI falso");

        let paths = RuntimePaths {
            config_dir: base.clone(),
            config_file: base.join("config.json"),
            logs_dir: base.join("logs"),
        };
        let config = SessaoAutoConfig {
            habilitado: true,
            caminho_cli: falso.to_string_lossy().into_owned(),
            ..SessaoAutoConfig::default()
        };

        let erro = run_claude_session_opener(&paths, &config).expect_err("o CLI falso sai com 1");
        assert!(erro.contains("Not logged in"), "erro sem o detalhe: {erro}");
        assert!(erro.contains("exit code: 1"), "erro sem o status: {erro}");
    }

    /// Regressao: o `--settings` tem de chegar como **caminho de arquivo**. Com o
    /// JSON inline, o shim `claude.cmd` do npm entregava `{"effortLevel:low}`
    /// colado no argumento seguinte e todo disparo morria com "Settings file not
    /// found". O CLI falso aqui e' um `.cmd` justamente por isso.
    #[cfg(target_os = "windows")]
    #[test]
    fn opener_passa_os_ajustes_como_arquivo_e_nao_como_json_inline() {
        let base = std::env::temp_dir().join("ai-usage-tray-agent-teste-settings");
        fs::create_dir_all(&base).expect("criar a pasta do teste");
        let falso = base.join("claude-falso.cmd");
        // %4 e' o valor do `--settings` (%1=-p %2=<mensagem> %3=--settings).
        fs::write(
            &falso,
            "@echo off
echo settings=%4
exit /b 1
",
        )
        .expect("gravar o CLI falso");

        let paths = RuntimePaths {
            config_dir: base.clone(),
            config_file: base.join("config.json"),
            logs_dir: base.join("logs"),
        };
        let config = SessaoAutoConfig {
            habilitado: true,
            caminho_cli: falso.to_string_lossy().into_owned(),
            ..SessaoAutoConfig::default()
        };

        let erro = run_claude_session_opener(&paths, &config).expect_err("o CLI falso sai com 1");
        assert!(
            erro.contains(SESSAO_AUTO_SETTINGS_ARQUIVO),
            "o CLI nao recebeu o caminho do arquivo: {erro}"
        );
        assert!(
            !erro.contains("effortLevel"),
            "o JSON foi parar na linha de comando: {erro}"
        );

        let gravado =
            fs::read_to_string(base.join("sessao-auto").join(SESSAO_AUTO_SETTINGS_ARQUIVO))
                .expect("ler os ajustes gravados");
        assert_eq!(gravado, SESSAO_AUTO_SETTINGS);
    }

    /// O detalhe nao pode parar na UI: e' no log do app que o usuario (ou quem
    /// ajuda ele) vai procurar depois. Roda o caminho real de ponta a ponta —
    /// coleta "ok, sem janela" + CLI falso — e confere UI **e** arquivo de log.
    #[cfg(target_os = "windows")]
    #[test]
    fn falha_da_reabertura_vai_para_a_ui_e_para_o_log_com_o_detalhe() {
        let base = std::env::temp_dir().join("ai-usage-tray-agent-teste-log");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("criar a pasta do teste");
        let falso = base.join("claude-falso.cmd");
        fs::write(
            &falso,
            "@echo off\r\necho Not logged in - Please run /login\r\nexit /b 1\r\n",
        )
        .expect("gravar o CLI falso");

        let paths = RuntimePaths {
            config_dir: base.clone(),
            config_file: base.join("config.json"),
            logs_dir: base.join("logs"),
        };
        let mut config = AppConfig::default();
        config.providers.claude.sessao_auto = SessaoAutoConfig {
            habilitado: true,
            caminho_cli: falso.to_string_lossy().into_owned(),
            ..SessaoAutoConfig::default()
        };
        let shared = Arc::new(SharedState {
            snapshot: Mutex::new(RuntimeSnapshot::default()),
            cycle_lock: Mutex::new(()),
            stop: AtomicBool::new(false),
            force_pending: AtomicBool::new(false),
            pending_update: Mutex::new(None),
            sessao_auto: Mutex::new(SessaoAutoState::default()),
        });
        // O gatilho do recurso: coleta bem-sucedida sem janela de sessao.
        lock_snapshot(&shared).claude_metric = Some(UsageMetric {
            usuario: "teste".to_string(),
            ferramenta: "claude".to_string(),
            uso_percentual: Some(0.0),
            restante_percentual: Some(100.0),
            status: "ok".to_string(),
            coletado_em: Utc::now().to_rfc3339(),
            reset_em: None,
            erro: None,
            uso_percentual_7d: None,
            restante_percentual_7d: None,
            reset_em_7d: None,
        });

        maybe_reopen_claude_session(&paths, &shared, &config);

        // A chamada ao CLI roda fora do ciclo, em thread propria; espera ela acabar.
        let limite = Instant::now() + Duration::from_secs(30);
        while lock_sessao_auto(&shared).status.em_execucao && Instant::now() < limite {
            thread::sleep(Duration::from_millis(50));
        }

        let status = lock_sessao_auto(&shared).status.clone();
        assert_eq!(status.ultimo_ok, Some(false), "a tentativa devia falhar");
        let erro_ui = status.ultimo_erro.unwrap_or_default();
        assert!(
            erro_ui.contains("Not logged in"),
            "UI sem o detalhe: {erro_ui}"
        );

        let log = paths
            .logs_dir
            .join(format!("{}.log", Utc::now().format("%Y-%m-%d")));
        let conteudo = fs::read_to_string(&log).expect("o log do dia foi criado");
        assert!(
            conteudo.contains("Falha ao reabrir a sessao do Claude."),
            "log sem a mensagem: {conteudo}"
        );
        assert!(
            conteudo.contains("Not logged in"),
            "log sem o detalhe: {conteudo}"
        );
    }

    #[test]
    fn slot_devido_vale_no_horario_e_na_folga_do_ciclo() {
        let config = agendado(&["09:00", "14:00"]);
        // No horario e dentro da folga (piso de 2 min com o intervalo padrao).
        assert_eq!(
            sessao_auto_slot_devido(&config, 10, local(9, 0, 0)),
            Some(540)
        );
        assert_eq!(
            sessao_auto_slot_devido(&config, 10, local(9, 1, 59)),
            Some(540)
        );
        // Passou da folga: horario perdido nao e' recuperado.
        assert_eq!(sessao_auto_slot_devido(&config, 10, local(9, 2, 1)), None);
        assert_eq!(sessao_auto_slot_devido(&config, 10, local(13, 0, 0)), None);
        // Antes do horario tambem nao dispara.
        assert_eq!(sessao_auto_slot_devido(&config, 10, local(8, 59, 59)), None);
        // Intervalo de coleta longo alarga a folga (um ciclo + 1 min).
        assert_eq!(
            sessao_auto_slot_devido(&config, 300, local(9, 5, 0)),
            Some(540)
        );
        // Sem horarios, nunca dispara.
        assert_eq!(
            sessao_auto_slot_devido(&agendado(&[]), 10, local(9, 0, 0)),
            None
        );
    }
}
