const STORAGE_KEY = "naukriCollection";
const PAGE_DELAY_MS = 1200;

function isNaukriUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "naukri.com" || url.hostname.endsWith(".naukri.com"));
  } catch {
    return false;
  }
}

function normalizedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

async function getState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {
    active: false,
    jobs: [],
    visitedPages: [],
    status: "No collection started."
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function startCollection(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !isNaukriUrl(tab.url)) {
    return { ok: false, error: "Open a Naukri search-results page first." };
  }

  const state = {
    active: true,
    tabId,
    jobs: [],
    visitedPages: [],
    status: "Starting collection on the open page."
  };
  await saveState(state);

  try {
    await chrome.tabs.sendMessage(tabId, { type: "COLLECT_PAGE" });
  } catch {
    state.active = false;
    state.status = "Could not reach the Naukri page. Reload it and try again.";
    await saveState(state);
    return { ok: false, error: state.status };
  }

  return { ok: true };
}

async function collectPage(message, sender) {
  const state = await getState();
  const tabId = sender.tab && sender.tab.id;
  if (!state.active || tabId !== state.tabId) {
    return;
  }

  const pageUrl = normalizedUrl(message.pageUrl);
  if (state.visitedPages.includes(pageUrl)) {
    state.active = false;
    state.status = "Stopped because a result page repeated. Check the site's pagination.";
    await saveState(state);
    return;
  }

  state.visitedPages.push(pageUrl);
  const knownJobs = new Set(state.jobs.map((job) => job.url));
  for (const job of message.jobs) {
    if (job.url && !knownJobs.has(job.url)) {
      state.jobs.push(job);
      knownJobs.add(job.url);
    }
  }

  if (message.jobs.length === 0) {
    state.active = false;
    state.status = `Stopped: no supported job cards were found on page ${state.visitedPages.length}. Collected ${state.jobs.length} jobs from earlier pages.`;
    await saveState(state);
    return;
  }

  if (!message.nextUrl) {
    state.active = false;
    state.status = `Finished: no next-page link was detected after ${state.visitedPages.length} page(s). Collected ${state.jobs.length} unique jobs.`;
    await saveState(state);
    return;
  }

  if (!isNaukriUrl(message.nextUrl) || state.visitedPages.includes(normalizedUrl(message.nextUrl))) {
    state.active = false;
    state.status = "Stopped: the next-page link was invalid or led to a page already visited.";
    await saveState(state);
    return;
  }

  state.status = `Collected ${state.jobs.length} unique jobs from ${state.visitedPages.length} page(s). Opening the next page...`;
  await saveState(state);

  await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
  const currentState = await getState();
  if (!currentState.active || currentState.tabId !== tabId) {
    return;
  }

  try {
    await chrome.tabs.update(tabId, { url: message.nextUrl });
  } catch {
    currentState.active = false;
    currentState.status = "Could not open the next result page. The collected jobs are still saved.";
    await saveState(currentState);
  }
}

async function handleMessage(message, sender) {
  if (message.type === "START_COLLECTION") {
    if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(""))) {
      return { ok: false, error: "Start collection from the extension popup." };
    }
    return startCollection(message.tabId);
  }

  if (message.type === "STOP_COLLECTION") {
    if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(""))) {
      return { ok: false, error: "Stop collection from the extension popup." };
    }
    const state = await getState();
    state.active = false;
    state.status = `Stopped by you. Saved ${state.jobs.length} unique jobs from ${state.visitedPages.length} page(s).`;
    await saveState(state);
    return { ok: true };
  }

  if (message.type === "PAGE_READY") {
    const state = await getState();
    if (state.active && sender.tab && sender.tab.id === state.tabId) {
      try {
        await chrome.tabs.sendMessage(state.tabId, { type: "COLLECT_PAGE" });
      } catch {
        state.active = false;
        state.status = "Could not read the next result page. The collected jobs are still saved.";
        await saveState(state);
      }
    }
    return { ok: true };
  }

  if (message.type === "PAGE_COLLECTED") {
    await collectPage(message, sender);
    return { ok: true };
  }

  return { ok: false, error: "Unknown extension message." };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(
    (response) => sendResponse(response),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "An unexpected extension error occurred."
    })
  );
  return true;
});
