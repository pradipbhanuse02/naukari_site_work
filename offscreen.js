chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "prepare-naukri-csv" || typeof message.csv !== "string") {
    return;
  }

  const blob = new Blob(["\uFEFF", message.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  sendResponse({ url });
});
