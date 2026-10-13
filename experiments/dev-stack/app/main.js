for (const button of document.querySelectorAll("button[data-backend]")) {
  button.addEventListener("click", async () => {
    const output = button.parentElement.querySelector("pre");
    button.disabled = true;
    output.textContent = "Loading…";
    try {
      const response = await fetch(`/api/${button.dataset.backend}/info`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      output.textContent = JSON.stringify(await response.json(), null, 2);
    } catch (error) {
      output.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
