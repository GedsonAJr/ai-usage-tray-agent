// Camada de IPC unificada: dentro da webview do Tauri usa o `invoke` nativo; no
// navegador (servidor HTTP dos dashboards) faz `fetch` para `/api/invoke/<cmd>`,
// que o backend Rust (`http_server.rs`) expoe para um subconjunto READ-ONLY de
// comandos. Assim a MESMA SPA roda nos dois ambientes sem ramificacoes espalhadas
// pelas telas — elas so' importam `invoke` daqui.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/// `true` quando rodando dentro da webview do Tauri (IPC nativo disponivel);
/// `false` no navegador, onde caimos no transporte HTTP.
export const isTauri =
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
  "undefined";

/// Mesma assinatura do `invoke` do Tauri. No navegador, serializa os `args` como
/// JSON no corpo do POST; um 401 (sessao ausente/expirada) leva para a tela de
/// login do servidor.
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    return tauriInvoke<T>(cmd, args);
  }

  const response = await fetch(`/api/invoke/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
    credentials: "same-origin",
  });

  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Sessao expirada — redirecionando para o login.");
  }
  if (!response.ok) {
    throw new Error(`Falha na requisicao (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}
