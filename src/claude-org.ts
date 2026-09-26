// Escolha da organização do Claude, mostrada como modal na PRÓPRIA janela de login
// (o backend navega a janela para cá quando a conta tem mais de uma org com "chat").
// Lista as orgs do login pendente com o uso atual de cada uma (`claude_login_orgs`)
// e grava a escolhida (`claude_select_org`, que fecha a janela e conclui o
// "Conectar" que a aba Claude das Configurações está aguardando). Fechar ou
// cancelar sem escolher desiste do login.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { barColor, escapeHtml, pctText } from "./usage-format";

interface OrgCandidate {
  uuid: string;
  name: string | null;
  utilization: number | null;
}
interface LoginOrgs {
  email: string | null;
  organizations: OrgCandidate[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const confirmBtn = $<HTMLButtonElement>("corg-confirm");

function showError(msg: string): void {
  const el = $("corg-err");
  el.textContent = msg;
  el.hidden = false;
}

function selected(): string | undefined {
  return document.querySelector<HTMLInputElement>('input[name="corg"]:checked')?.value;
}

function render(data: LoginOrgs): void {
  if (data.email) {
    $("corg-sub").textContent =
      `A conta ${data.email} tem mais de uma organização. Selecione a que você realmente usa — o uso é medido por organização.`;
  }
  $("corg-list").innerHTML = data.organizations
    .map((org) => {
      const uso = org.utilization;
      const meta =
        uso != null
          ? `<span class="corg-pct" style="color:${barColor(uso)}">${pctText(uso)}%</span><span class="corg-k">da sessão</span>`
          : `<span class="corg-k">uso indisponível</span>`;
      return `<label class="corg-opt">
        <input type="radio" name="corg" value="${escapeHtml(org.uuid)}">
        <span class="corg-name">${escapeHtml(org.name ?? org.uuid)}</span>
        <span class="corg-meta">${meta}</span>
      </label>`;
    })
    .join("");
}

async function load(): Promise<void> {
  try {
    render(await invoke<LoginOrgs>("claude_login_orgs"));
  } catch (e) {
    $("corg-list").innerHTML = "";
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function confirm(): Promise<void> {
  const organizationId = selected();
  if (!organizationId) return;
  confirmBtn.disabled = true;
  $("corg-err").hidden = true;
  try {
    // Sucesso fecha a janela pelo backend; nada mais a fazer aqui.
    await invoke("claude_select_org", { organizationId });
  } catch (e) {
    showError("Falha ao selecionar a organização: " + (e instanceof Error ? e.message : String(e)));
    confirmBtn.disabled = false;
  }
}

$("corg-list").addEventListener("change", () => {
  confirmBtn.disabled = !selected();
});
// Duplo clique numa org confirma direto.
$("corg-list").addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest(".corg-opt")) void confirm();
});
confirmBtn.addEventListener("click", () => void confirm());
$("corg-cancel").addEventListener("click", () => void getCurrentWindow().close());

void load();
