import { invoke } from "@tauri-apps/api/core";

type Settings = {
  baseUrl: string;
  hasToken: boolean;
  launchAtLogin: boolean;
};

const baseUrl = document.querySelector<HTMLInputElement>("#base-url");
const token = document.querySelector<HTMLInputElement>("#token");
const tokenHint = document.querySelector<HTMLParagraphElement>("#token-hint");
const status = document.querySelector<HTMLParagraphElement>("#settings-status");
const autostart = document.querySelector<HTMLInputElement>("#autostart");

if (!baseUrl || !token || !tokenHint || !status || !autostart) {
  throw new Error("settings form is incomplete");
}

const baseUrlEl = baseUrl;
const tokenEl = token;
const tokenHintEl = tokenHint;
const statusEl = status;
const autostartEl = autostart;

async function loadSettings() {
  const settings = await invoke<Settings>("get_settings");
  baseUrlEl.value = settings.baseUrl;
  tokenEl.value = "";
  tokenHintEl.textContent = settings.hasToken
    ? "A token is saved on this Mac."
    : "No token saved.";
  autostartEl.checked = settings.launchAtLogin;
  statusEl.textContent = "";
}

document.querySelector("#save-settings")?.addEventListener("click", () => {
  void (async () => {
    statusEl.textContent = "";
    try {
      const typed = tokenEl.value.trim();
      await invoke("save_settings", {
        baseUrl: baseUrlEl.value.trim(),
        token: typed === "" ? null : typed,
      });
      tokenEl.value = "";
      await loadSettings();
      statusEl.textContent = "Saved.";
    } catch (error) {
      statusEl.textContent = String(error);
    }
  })();
});

document.querySelector("#test-connection")?.addEventListener("click", () => {
  void (async () => {
    statusEl.textContent = "Testing…";
    try {
      const typed = tokenEl.value.trim();
      if (baseUrlEl.value.trim() !== "" || typed !== "") {
        await invoke("save_settings", {
          baseUrl: baseUrlEl.value.trim(),
          token: typed === "" ? null : typed,
        });
      }
      const flavor = await invoke<string>("test_memos");
      statusEl.textContent = `Connected (${flavor}).`;
      await loadSettings();
    } catch (error) {
      statusEl.textContent = String(error);
    }
  })();
});

document.querySelector("#clear-memos")?.addEventListener("click", () => {
  void (async () => {
    try {
      await invoke("clear_memos");
      await loadSettings();
      statusEl.textContent = "Disconnected.";
    } catch (error) {
      statusEl.textContent = String(error);
    }
  })();
});

autostartEl.addEventListener("change", () => {
  void (async () => {
    try {
      await invoke("set_autostart", { enabled: autostartEl.checked });
    } catch (error) {
      statusEl.textContent = String(error);
      autostartEl.checked = !autostartEl.checked;
    }
  })();
});

void loadSettings().catch((error: unknown) => {
  statusEl.textContent = String(error);
});
