// Varias contas por provedor (Claude e Codex).
//
// Compatibilidade com a versao anterior, que so' conhece uma conta por provedor e
// pode rodar na mesma maquina (mesmo config_dir):
// - a conta PRINCIPAL de cada provedor mora no arquivo legado (`claude-auth.json` /
//   `codex-auth.json`), no formato de sempre. A versao antiga continua lendo e
//   renovando esse arquivo e enxerga so' a principal;
// - as contas EXTRAS moram em `contas/<provedor>/<id>.json`, no mesmo formato, numa
//   pasta que a versao antiga nem conhece;
// - o que e' por conta (apelido, ordem dos cards) fica em `contas.json`, tambem
//   invisivel para ela. O `config.json` NAO ganha campo novo: a versao antiga o
//   regrava so' com os campos que conhece e apagaria qualquer campo novo em ~1s.
//
// O id de uma conta e' um hash da identidade (org + e-mail no Claude, account_id +
// e-mail no Codex), nao um numero guardado em algum lugar. A mesma conta tem a
// mesma chave esteja ela no arquivo legado ou em `contas/`, entao promover/rebaixar
// e' so' trocar arquivos de lugar, e reconectar a mesma conta cai na mesma chave (nao
// duplica). Credenciais nunca sao copiadas, so' movidas: no Codex o refresh_token e'
// rotativo, e duas copias do mesmo token se invalidam na primeira renovacao.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{claude_auth, codex_auth};

/// Arquivo com as preferencias por conta (apelido, ordem). So' esta versao o le'.
const ARQUIVO_PREFS: &str = "contas.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provedor {
    Claude,
    Codex,
}

impl Provedor {
    pub const TODOS: [Provedor; 2] = [Provedor::Claude, Provedor::Codex];

    /// Chave do provedor ("claude"/"codex"), a mesma de `providers.ordem`, do
    /// `ferramenta` das metricas e do prefixo das chaves de conta.
    pub fn chave(self) -> &'static str {
        match self {
            Provedor::Claude => "claude",
            Provedor::Codex => "codex",
        }
    }

    pub fn nome(self) -> &'static str {
        match self {
            Provedor::Claude => "Claude",
            Provedor::Codex => "Codex",
        }
    }

    /// Provedor de uma chave de conta (`"claude:ab12"`) ou de provedor (`"claude"`).
    pub fn da_chave(chave: &str) -> Option<Self> {
        match chave.split(':').next()? {
            "claude" => Some(Provedor::Claude),
            "codex" => Some(Provedor::Codex),
            _ => None,
        }
    }

    /// Arquivo legado de credenciais, que guarda a conta principal.
    pub fn arquivo_principal(self, config_dir: &Path) -> PathBuf {
        match self {
            Provedor::Claude => claude_auth::auth_file(config_dir),
            Provedor::Codex => codex_auth::auth_file(config_dir),
        }
    }

    fn pasta_extras(self, config_dir: &Path) -> PathBuf {
        config_dir.join("contas").join(self.chave())
    }

    /// Identidade (base do id) e e-mail do login gravado em `arquivo`. `None` =
    /// arquivo ausente ou sem login valido.
    fn identidade(self, arquivo: &Path) -> Option<(String, Option<String>)> {
        match self {
            Provedor::Claude => claude_auth::identity(arquivo),
            Provedor::Codex => codex_auth::identity(arquivo),
        }
    }
}

/// Uma conta conectada, com o arquivo onde estao as credenciais dela.
#[derive(Debug, Clone)]
pub struct Conta {
    /// `"<provedor>:<id>"`: chave usada no snapshot, na ordem dos cards e nas prefs.
    pub chave: String,
    pub arquivo: PathBuf,
    pub principal: bool,
    pub email: Option<String>,
}

/// Chave da conta a partir da identidade devolvida pelo modulo de login.
pub fn chave_da_identidade(provedor: Provedor, identidade: &str) -> String {
    let hash = Sha256::digest(identidade.as_bytes());
    let hex: String = hash
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}:{hex}", provedor.chave())
}

fn sufixo(chave: &str) -> &str {
    chave.split_once(':').map(|(_, id)| id).unwrap_or(chave)
}

/// Serializa quem mexe nos arquivos de conta: a listagem acerta o disco (move e
/// apaga arquivos), e ela roda tanto no ciclo de coleta quanto nos comandos da UI.
fn trava() -> MutexGuard<'static, ()> {
    static TRAVA: OnceLock<Mutex<()>> = OnceLock::new();
    TRAVA
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Grava por arquivo temporario + rename, para que um leitor concorrente nunca
/// veja o arquivo pela metade (a listagem roda em paralelo com a coleta, que
/// regrava credenciais).
pub fn gravar_atomico(caminho: &Path, conteudo: &str) -> Result<(), String> {
    if let Some(pasta) = caminho.parent() {
        fs::create_dir_all(pasta)
            .map_err(|error| format!("Falha ao criar diretório {}: {error}", pasta.display()))?;
    }
    let mut temporario = caminho.as_os_str().to_owned();
    temporario.push(".tmp");
    let temporario = PathBuf::from(temporario);
    fs::write(&temporario, conteudo)
        .map_err(|error| format!("Falha ao gravar {}: {error}", temporario.display()))?;
    fs::rename(&temporario, caminho)
        .map_err(|error| format!("Falha ao gravar {}: {error}", caminho.display()))
}

fn ler_conta(provedor: Provedor, arquivo: &Path, principal: bool) -> Option<Conta> {
    let (identidade, email) = provedor.identidade(arquivo)?;
    Some(Conta {
        chave: chave_da_identidade(provedor, &identidade),
        arquivo: arquivo.to_path_buf(),
        principal,
        email,
    })
}

fn extras_no_disco(provedor: Provedor, config_dir: &Path) -> Vec<Conta> {
    let Ok(entradas) = fs::read_dir(provedor.pasta_extras(config_dir)) else {
        return Vec::new();
    };
    let mut arquivos: Vec<PathBuf> = entradas
        .filter_map(Result::ok)
        .map(|entrada| entrada.path())
        .filter(|caminho| caminho.extension().is_some_and(|ext| ext == "json"))
        .collect();
    arquivos.sort();
    arquivos
        .iter()
        .filter_map(|arquivo| ler_conta(provedor, arquivo, false))
        .collect()
}

/// Contas do provedor: a principal primeiro, depois as extras. Antes de listar,
/// acerta o disco:
/// - extra com a mesma chave da principal (a versao antiga reconectou nessa
///   conta): a extra sai, porque a do arquivo legado e' a mais recente;
/// - extras repetidas entre si: fica a primeira;
/// - sem arquivo legado (a versao antiga desconectou, ou a principal foi
///   removida): a primeira extra e' movida para la' e vira a principal.
///
/// A promocao exige que o arquivo legado NAO EXISTA. Um legado ilegivel pode estar
/// no meio de uma gravacao (da versao antiga, por exemplo), e sobrescreve-lo
/// perderia a principal.
pub fn listar(config_dir: &Path, provedor: Provedor) -> Vec<Conta> {
    let _trava = trava();
    listar_sem_trava(config_dir, provedor)
}

fn listar_sem_trava(config_dir: &Path, provedor: Provedor) -> Vec<Conta> {
    let legado = provedor.arquivo_principal(config_dir);
    let mut principal = ler_conta(provedor, &legado, true);
    let mut extras: Vec<Conta> = Vec::new();
    for conta in extras_no_disco(provedor, config_dir) {
        let repetida = principal.as_ref().is_some_and(|p| p.chave == conta.chave)
            || extras.iter().any(|extra| extra.chave == conta.chave);
        if repetida {
            let _ = fs::remove_file(&conta.arquivo);
            continue;
        }
        extras.push(conta);
    }
    if principal.is_none() && !legado.exists() && !extras.is_empty() {
        let promovida = extras.remove(0);
        if fs::rename(&promovida.arquivo, &legado).is_ok() {
            principal = Some(Conta {
                arquivo: legado,
                principal: true,
                ..promovida
            });
        } else {
            extras.insert(0, promovida);
        }
    }
    principal.into_iter().chain(extras).collect()
}

/// Onde gravar um login recem-feito, pela identidade da conta: no arquivo da
/// conta que ja' tem essa chave (reconectar nao duplica), no arquivo legado se o
/// provedor ainda nao tem principal, ou num arquivo novo em `contas/`.
pub fn destino_do_login(
    config_dir: &Path,
    provedor: Provedor,
    identidade: &str,
) -> (PathBuf, String) {
    let _trava = trava();
    let chave = chave_da_identidade(provedor, identidade);
    let contas = listar_sem_trava(config_dir, provedor);
    if let Some(conta) = contas.iter().find(|conta| conta.chave == chave) {
        return (conta.arquivo.clone(), chave);
    }
    let legado = provedor.arquivo_principal(config_dir);
    if !legado.exists() {
        return (legado, chave);
    }
    let arquivo = provedor
        .pasta_extras(config_dir)
        .join(format!("{}.json", sufixo(&chave)));
    (arquivo, chave)
}

/// Promove uma conta extra a principal: a principal atual vai para `contas/` e a
/// escolhida para o arquivo legado (que a versao antiga le').
pub fn tornar_principal(config_dir: &Path, chave: &str) -> Result<(), String> {
    let _trava = trava();
    let provedor =
        Provedor::da_chave(chave).ok_or_else(|| format!("Conta desconhecida: {chave}"))?;
    let contas = listar_sem_trava(config_dir, provedor);
    let alvo = contas
        .iter()
        .find(|conta| conta.chave == chave)
        .ok_or_else(|| "Conta não encontrada.".to_string())?;
    if alvo.principal {
        return Ok(());
    }
    let legado = provedor.arquivo_principal(config_dir);
    if let Some(atual) = contas.iter().find(|conta| conta.principal) {
        let destino = provedor
            .pasta_extras(config_dir)
            .join(format!("{}.json", sufixo(&atual.chave)));
        fs::create_dir_all(provedor.pasta_extras(config_dir))
            .map_err(|error| format!("Falha ao criar a pasta de contas: {error}"))?;
        fs::rename(&legado, &destino)
            .map_err(|error| format!("Falha ao mover a conta principal: {error}"))?;
    }
    // Se falhar aqui, o legado ficou vazio e a proxima listagem promove a primeira
    // extra: nenhuma credencial se perde.
    fs::rename(&alvo.arquivo, &legado)
        .map_err(|error| format!("Falha ao promover a conta: {error}"))
}

/// Remove a conta (apaga as credenciais dela) e suas preferencias. Se era a
/// principal, a proxima assume (ver `listar`).
pub fn remover(config_dir: &Path, chave: &str) -> Result<(), String> {
    let _trava = trava();
    let provedor =
        Provedor::da_chave(chave).ok_or_else(|| format!("Conta desconhecida: {chave}"))?;
    let contas = listar_sem_trava(config_dir, provedor);
    let conta = contas
        .iter()
        .find(|conta| conta.chave == chave)
        .ok_or_else(|| "Conta não encontrada.".to_string())?;
    match fs::remove_file(&conta.arquivo) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Falha ao remover a conta: {error}")),
    }
    listar_sem_trava(config_dir, provedor);

    let mut prefs = ler_prefs_sem_trava(config_dir);
    let tinha = prefs.contas.remove(chave).is_some() || prefs.ordem.iter().any(|k| k == chave);
    if tinha {
        prefs.ordem.retain(|k| k != chave);
        gravar_prefs_sem_trava(config_dir, &prefs)?;
    }
    Ok(())
}

// ---- Preferencias por conta (`contas.json`) ---------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// Preferencias de cada conta, pela chave `"<provedor>:<id>"`.
    pub contas: BTreeMap<String, PrefsConta>,
    /// Ordem dos cards da tela "Uso atual". Um provedor sem conta aparece com a
    /// chave dele ("claude"), que e' a do card de "nao conectado".
    pub ordem: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrefsConta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apelido: Option<String>,
}

impl Prefs {
    pub fn apelido(&self, chave: &str) -> Option<&str> {
        self.contas
            .get(chave)
            .and_then(|conta| conta.apelido.as_deref())
    }
}

pub fn ler_prefs(config_dir: &Path) -> Prefs {
    let _trava = trava();
    ler_prefs_sem_trava(config_dir)
}

fn ler_prefs_sem_trava(config_dir: &Path) -> Prefs {
    fs::read_to_string(config_dir.join(ARQUIVO_PREFS))
        .ok()
        .and_then(|conteudo| serde_json::from_str(&conteudo).ok())
        .unwrap_or_default()
}

fn gravar_prefs_sem_trava(config_dir: &Path, prefs: &Prefs) -> Result<(), String> {
    let conteudo = serde_json::to_string_pretty(prefs).map_err(|error| error.to_string())?;
    gravar_atomico(&config_dir.join(ARQUIVO_PREFS), &format!("{conteudo}\n"))
}

/// Define (ou limpa, com vazio/`None`) o apelido de uma conta.
pub fn definir_apelido(
    config_dir: &Path,
    chave: &str,
    apelido: Option<String>,
) -> Result<(), String> {
    let _trava = trava();
    let apelido = apelido
        .map(|texto| texto.trim().to_string())
        .filter(|texto| !texto.is_empty());
    let mut prefs = ler_prefs_sem_trava(config_dir);
    match apelido {
        Some(apelido) => {
            prefs.contas.entry(chave.to_string()).or_default().apelido = Some(apelido);
        }
        None => {
            if let Some(conta) = prefs.contas.get_mut(chave) {
                conta.apelido = None;
                if *conta == PrefsConta::default() {
                    prefs.contas.remove(chave);
                }
            }
        }
    }
    gravar_prefs_sem_trava(config_dir, &prefs)
}

/// Grava a nova ordem dos cards. Chaves que nao estao na tela agora (ex.: de um
/// provedor desativado) mantem-se no fim, para nao perderem a posicao salva.
pub fn definir_ordem(config_dir: &Path, nova: &[String]) -> Result<(), String> {
    let _trava = trava();
    let mut prefs = ler_prefs_sem_trava(config_dir);
    let mut ordem: Vec<String> = Vec::new();
    for chave in nova.iter().chain(prefs.ordem.iter()) {
        if !ordem.contains(chave) {
            ordem.push(chave.clone());
        }
    }
    prefs.ordem = ordem;
    gravar_prefs_sem_trava(config_dir, &prefs)
}

/// Aplica a ordem salva as chaves presentes (que ja' chegam na ordem natural:
/// provedores na ordem do `config.json`, principal primeiro). As que estao na ordem
/// salva vem na ordem dela; uma chave nova entra logo depois da ultima do mesmo
/// provedor, ou no fim se o provedor ainda nao aparece.
pub fn ordenar(presentes: &[String], salva: &[String]) -> Vec<String> {
    let mut saida: Vec<String> = Vec::new();
    for chave in salva {
        if presentes.contains(chave) && !saida.contains(chave) {
            saida.push(chave.clone());
        }
    }
    for chave in presentes {
        if saida.contains(chave) {
            continue;
        }
        let provedor = chave.split(':').next().unwrap_or(chave);
        let posicao = saida
            .iter()
            .rposition(|outra| outra.split(':').next() == Some(provedor))
            .map(|indice| indice + 1)
            .unwrap_or(saida.len());
        saida.insert(posicao, chave.clone());
    }
    saida
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Pasta temporaria exclusiva de cada teste (os testes rodam em paralelo).
    fn pasta(nome: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ai-usage-contas-{nome}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn claude(caminho: &Path, org: &str, email: &str) {
        claude_auth::store(caminho, "sk-teste", org, Some(email.to_string())).unwrap();
    }

    fn codex(caminho: &Path, account_id: &str, email: &str) {
        let conteudo = serde_json::json!({
            "tokens": { "access_token": "tok", "account_id": account_id },
            "email": email,
        });
        gravar_atomico(caminho, &conteudo.to_string()).unwrap();
    }

    fn chave_claude(org: &str, email: &str) -> String {
        chave_da_identidade(
            Provedor::Claude,
            &claude_auth::identity_of(org, Some(email)),
        )
    }

    #[test]
    fn so_o_arquivo_legado_e_a_principal_como_hoje() {
        let dir = pasta("legado");
        claude(&claude_auth::auth_file(&dir), "org-a", "a@x.com");
        let contas = listar(&dir, Provedor::Claude);
        assert_eq!(contas.len(), 1);
        assert!(contas[0].principal);
        assert_eq!(contas[0].chave, chave_claude("org-a", "a@x.com"));
        assert_eq!(contas[0].email.as_deref(), Some("a@x.com"));
        assert!(listar(&dir, Provedor::Codex).is_empty());
    }

    #[test]
    fn login_novo_vai_para_o_legado_e_depois_para_contas() {
        let dir = pasta("destino");
        let id_a = claude_auth::identity_of("org-a", Some("a@x.com"));
        let (arquivo, chave_a) = destino_do_login(&dir, Provedor::Claude, &id_a);
        assert_eq!(arquivo, claude_auth::auth_file(&dir));
        claude(&arquivo, "org-a", "a@x.com");

        let id_b = claude_auth::identity_of("org-b", Some("b@x.com"));
        let (arquivo_b, chave_b) = destino_do_login(&dir, Provedor::Claude, &id_b);
        assert_ne!(arquivo_b, claude_auth::auth_file(&dir));
        claude(&arquivo_b, "org-b", "b@x.com");

        let contas = listar(&dir, Provedor::Claude);
        let chaves: Vec<&str> = contas.iter().map(|c| c.chave.as_str()).collect();
        assert_eq!(chaves, vec![chave_a.as_str(), chave_b.as_str()]);
        assert!(contas[0].principal && !contas[1].principal);
    }

    #[test]
    fn reconectar_a_mesma_conta_nao_duplica() {
        let dir = pasta("dedupe");
        claude(&claude_auth::auth_file(&dir), "org-a", "a@x.com");
        let id_b = claude_auth::identity_of("org-b", Some("b@x.com"));
        let (arquivo_b, _) = destino_do_login(&dir, Provedor::Claude, &id_b);
        claude(&arquivo_b, "org-b", "b@x.com");

        // E-mail com caixa diferente continua sendo a mesma conta.
        let id_b_de_novo = claude_auth::identity_of("org-b", Some("B@X.com"));
        let (destino, _) = destino_do_login(&dir, Provedor::Claude, &id_b_de_novo);
        assert_eq!(destino, arquivo_b);
        let id_a = claude_auth::identity_of("org-a", Some("a@x.com"));
        let (destino, _) = destino_do_login(&dir, Provedor::Claude, &id_a);
        assert_eq!(destino, claude_auth::auth_file(&dir));
        assert_eq!(listar(&dir, Provedor::Claude).len(), 2);
    }

    #[test]
    fn tornar_principal_troca_os_arquivos_sem_mudar_as_chaves() {
        let dir = pasta("promover");
        codex(&codex_auth::auth_file(&dir), "acc-a", "a@x.com");
        let id_b = "acc-b|b@x.com";
        let (arquivo_b, chave_b) = destino_do_login(&dir, Provedor::Codex, id_b);
        codex(&arquivo_b, "acc-b", "b@x.com");
        let chave_a = listar(&dir, Provedor::Codex)[0].chave.clone();

        tornar_principal(&dir, &chave_b).unwrap();
        let contas = listar(&dir, Provedor::Codex);
        assert_eq!(contas.len(), 2);
        assert_eq!(contas[0].chave, chave_b);
        assert!(contas[0].principal);
        assert_eq!(contas[0].arquivo, codex_auth::auth_file(&dir));
        assert_eq!(contas[1].chave, chave_a);

        // A versao antiga le' o arquivo legado: agora ele tem a conta B.
        let (_, email) = codex_auth::identity(&codex_auth::auth_file(&dir)).unwrap();
        assert_eq!(email.as_deref(), Some("b@x.com"));
    }

    #[test]
    fn sem_legado_a_primeira_extra_vira_principal() {
        let dir = pasta("sem-legado");
        claude(&claude_auth::auth_file(&dir), "org-a", "a@x.com");
        let id_b = claude_auth::identity_of("org-b", Some("b@x.com"));
        let (arquivo_b, chave_b) = destino_do_login(&dir, Provedor::Claude, &id_b);
        claude(&arquivo_b, "org-b", "b@x.com");

        // A versao antiga clicou em "Desconectar": apagou so' o legado.
        fs::remove_file(claude_auth::auth_file(&dir)).unwrap();
        let contas = listar(&dir, Provedor::Claude);
        assert_eq!(contas.len(), 1);
        assert_eq!(contas[0].chave, chave_b);
        assert!(contas[0].principal);
        assert!(claude_auth::auth_file(&dir).exists());
        assert!(!arquivo_b.exists());
    }

    #[test]
    fn legado_ilegivel_nao_e_sobrescrito() {
        let dir = pasta("ilegivel");
        let id_b = claude_auth::identity_of("org-b", Some("b@x.com"));
        let arquivo_b = dir.join("contas").join("claude").join(format!(
            "{}.json",
            sufixo(&chave_da_identidade(Provedor::Claude, &id_b))
        ));
        claude(&arquivo_b, "org-b", "b@x.com");
        // Legado presente mas pela metade (gravacao em curso).
        fs::write(claude_auth::auth_file(&dir), "{\"session_k").unwrap();

        let contas = listar(&dir, Provedor::Claude);
        assert_eq!(contas.len(), 1);
        assert!(!contas[0].principal);
        assert!(arquivo_b.exists());
        assert_eq!(
            fs::read_to_string(claude_auth::auth_file(&dir)).unwrap(),
            "{\"session_k"
        );
    }

    #[test]
    fn versao_antiga_reconectou_em_uma_extra() {
        let dir = pasta("reconectou");
        claude(&claude_auth::auth_file(&dir), "org-a", "a@x.com");
        let id_b = claude_auth::identity_of("org-b", Some("b@x.com"));
        let (arquivo_b, chave_b) = destino_do_login(&dir, Provedor::Claude, &id_b);
        claude(&arquivo_b, "org-b", "b@x.com");

        // A versao antiga reconecta com a conta B: sobrescreve o legado.
        claude(&claude_auth::auth_file(&dir), "org-b", "b@x.com");
        let contas = listar(&dir, Provedor::Claude);
        assert_eq!(contas.len(), 1);
        assert_eq!(contas[0].chave, chave_b);
        assert!(contas[0].principal);
        assert!(!arquivo_b.exists());
    }

    #[test]
    fn remover_a_principal_promove_a_proxima_e_limpa_as_prefs() {
        let dir = pasta("remover");
        claude(&claude_auth::auth_file(&dir), "org-a", "a@x.com");
        let id_b = claude_auth::identity_of("org-b", Some("b@x.com"));
        let (arquivo_b, chave_b) = destino_do_login(&dir, Provedor::Claude, &id_b);
        claude(&arquivo_b, "org-b", "b@x.com");
        let chave_a = chave_claude("org-a", "a@x.com");
        definir_apelido(&dir, &chave_a, Some("Pessoal".to_string())).unwrap();
        definir_ordem(&dir, &[chave_b.clone(), chave_a.clone()]).unwrap();

        remover(&dir, &chave_a).unwrap();
        let contas = listar(&dir, Provedor::Claude);
        assert_eq!(contas.len(), 1);
        assert_eq!(contas[0].chave, chave_b);
        assert!(contas[0].principal);
        let prefs = ler_prefs(&dir);
        assert_eq!(prefs.apelido(&chave_a), None);
        assert_eq!(prefs.ordem, vec![chave_b]);
    }

    #[test]
    fn apelido_vazio_limpa() {
        let dir = pasta("apelido");
        definir_apelido(&dir, "claude:1", Some("  Trabalho ".to_string())).unwrap();
        assert_eq!(ler_prefs(&dir).apelido("claude:1"), Some("Trabalho"));
        definir_apelido(&dir, "claude:1", Some("   ".to_string())).unwrap();
        assert_eq!(ler_prefs(&dir), Prefs::default());
    }

    #[test]
    fn ordenar_respeita_a_salva_e_poe_a_nova_junto_do_provedor() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        // Sem ordem salva: a natural.
        assert_eq!(
            ordenar(&s(&["claude:a", "codex:x"]), &[]),
            s(&["claude:a", "codex:x"])
        );
        // Ordem salva manda; a conta nova do Claude entra depois da outra do Claude.
        assert_eq!(
            ordenar(
                &s(&["claude:a", "claude:b", "codex:x"]),
                &s(&["codex:x", "claude:a"])
            ),
            s(&["codex:x", "claude:a", "claude:b"])
        );
        // Chave salva que nao esta' presente e' ignorada; o placeholder do provedor
        // sem conta ("codex") tambem e' uma chave como outra qualquer.
        assert_eq!(
            ordenar(
                &s(&["codex", "claude:a"]),
                &s(&["claude:z", "codex", "claude:a"])
            ),
            s(&["codex", "claude:a"])
        );
    }

    #[test]
    fn definir_ordem_preserva_quem_nao_esta_na_tela() {
        let dir = pasta("ordem");
        definir_ordem(&dir, &["claude:a".to_string(), "codex:x".to_string()]).unwrap();
        // Codex desativado: a tela so' mostra o Claude.
        definir_ordem(&dir, &["claude:b".to_string(), "claude:a".to_string()]).unwrap();
        assert_eq!(
            ler_prefs(&dir).ordem,
            vec!["claude:b", "claude:a", "codex:x"]
        );
    }
}
