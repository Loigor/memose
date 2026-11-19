/** Runs a settings action and shows its result, or its error, in the status line. */
export function statusRunner(status: HTMLElement) {
  return (work: () => Promise<string>, busy = "") => {
    status.textContent = busy;
    void work().then(
      (done) => {
        status.textContent = done;
      },
      (error: unknown) => {
        status.textContent = String(error);
      },
    );
  };
}
