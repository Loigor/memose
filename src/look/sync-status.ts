export function syncIcon(state: string, visibility?: string | null): { svg: string; label: string } {
  if (visibility === "OFFLINE_PRIVATE") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 1.5A2.75 2.75 0 0 0 5.25 4.25V5.5h-.75A1.75 1.75 0 0 0 2.75 7.25v5A1.75 1.75 0 0 0 4.5 14h7a1.75 1.75 0 0 0 1.75-1.75v-5A1.75 1.75 0 0 0 11.5 5.5h-.75V4.25A2.75 2.75 0 0 0 8 1.5zm1.25 4V4.25a1.25 1.25 0 1 0-2.5 0V5.5h2.5z"/></svg>`,
      label: "Offline on this computer",
    };
  }
  if (state === "synced") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6.2 11.3 3.3 8.4l1.1-1.1 1.8 1.8 4.5-4.5 1.1 1.1z"/></svg>`,
      label: "Synced",
    };
  }
  if (state === "pending") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>`,
      label: "Waiting to sync",
    };
  }
  if (state === "conflict") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M7.2 3h1.6v6.2H7.2zM7.2 11h1.6V12.6H7.2z"/></svg>`,
      label: "Choose a version",
    };
  }
  if (state === "remote") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
      label: "On server",
    };
  }
  if (state === "error") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M7.2 3h1.6v6.2H7.2zM7.2 11h1.6V12.6H7.2z"/></svg>`,
      label: "Sync failed",
    };
  }
  return {
    svg: `<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
    label: "Local",
  };
}
