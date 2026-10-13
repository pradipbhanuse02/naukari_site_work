const STORAGE_KEY = "naukriCollection";
const statusElement = document.getElementById("status");
const countElement = document.getElementById("count");
const jobsElement = document.getElementById("jobs");
const emptyElement = document.getElementById("empty");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const exportButton = document.getElementById("export");

function isNaukriUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "naukri.com" || url.hostname.endsWith(".naukri.com"));
  } catch {
    return false;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render() {
  const [tab, result] = await Promise.all([
    activeTab(),
    chrome.storage.local.get(STORAGE_KEY)
  ]);
  const state = result[STORAGE_KEY] || {
    active: false,
    jobs: [],
    status: "No collection started."
  };

  statusElement.textContent = !tab || !isNaukriUrl(tab.url || "")
    ? "Open a Naukri search-results page to collect jobs."
    : state.status;
  countElement.textContent = `${state.jobs.length} unique job${state.jobs.length === 1 ? "" : "s"} collected`;
  startButton.disabled = !tab || !isNaukriUrl(tab.url || "") || state.active;
  stopButton.disabled = !state.active;
  exportButton.disabled = state.jobs.length === 0;
  jobsElement.replaceChildren();
  emptyElement.hidden = state.jobs.length > 0;

  for (const job of state.jobs.slice(0, 40)) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = job.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = job.title;
    item.append(link);

    const details = [job.company, job.location, job.experience, job.salary]
      .filter(Boolean)
      .join(" · ");
    if (details) {
      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = details;
      item.append(detail);
    }
    jobsElement.append(item);
  }

  if (state.jobs.length > 40) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `Showing 40 of ${state.jobs.length}.`;
    jobsElement.append(note);
  }
}

function csvValue(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

exportButton.addEventListener("click", async () => {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const jobs = result[STORAGE_KEY]?.jobs || [];
    if (!jobs.length) {
      statusElement.textContent = "There are no collected jobs to export.";
      return;
    }

    const columns = ["title", "company", "location", "experience", "salary", "posted", "url"];
    const rows = [columns.join(",")];
    for (const job of jobs) {
      rows.push(columns.map((column) => csvValue(job[column])).join(","));
    }
    const blob = new Blob(["\uFEFF", rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "naukri-jobs.csv";
    link.click();
    URL.revokeObjectURL(downloadUrl);
  } catch {
    statusElement.textContent = "Could not export the collected jobs.";
  }
});

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  statusElement.textContent = "Starting...";
  try {
    const tab = await activeTab();
    const response = await chrome.runtime.sendMessage({
      type: "START_COLLECTION",
      tabId: tab && tab.id
    });
    if (!response.ok) {
      statusElement.textContent = response.error;
    }
  } catch {
    statusElement.textContent = "Could not start. Reload the Naukri page and try again.";
  }
  await render();
});

stopButton.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "STOP_COLLECTION" });
  } catch {
    statusElement.textContent = "Could not stop collection. Try again.";
  }
  await render();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    render().catch(() => {
      statusElement.textContent = "Could not refresh the collection status.";
    });
  }
});

render().catch(() => {
  statusElement.textContent = "Could not load extension data.";
});
