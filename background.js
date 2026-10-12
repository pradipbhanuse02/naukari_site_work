async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Create a CSV download URL that remains available after the popup closes."
    });
  }
}

let applyRunInProgress = false;

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timeout);
    };
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      callback(value);
    };
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(resolve, tab);
      }
    };
    const timeout = setTimeout(() => finish(reject, new Error("Timed out loading the job page.")), timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish(resolve, tab);
    }, (error) => finish(reject, error));
  });
}

async function requestQuickApply(tabId, jobTitle) {
  return chrome.tabs.sendMessage(tabId, {
    type: "attempt-naukri-quick-apply",
    jobTitle
  });
}

async function saveApplyProgress(results, state) {
  const stored = await chrome.storage.local.get("applicationHistory");
  const history = stored.applicationHistory && typeof stored.applicationHistory === "object"
    ? { ...stored.applicationHistory }
    : {};
  for (const job of results) {
    if (job.jobUrl && !(history[job.jobUrl]?.applyStatus === "Applied" && job.applyStatus !== "Applied")) {
      history[job.jobUrl] = {
        jobUrl: job.jobUrl,
        title: job.title,
        applyStatus: job.applyStatus,
        applyReason: job.applyReason,
        applyQuestions: job.applyQuestions ?? [],
        applyDestination: job.applyDestination ?? ""
      };
    }
  }
  await chrome.storage.local.set({
    applicationHistory: history,
    applicationRunState: state
  });
}

async function performApplyToJobs(jobs) {
  const stored = await chrome.storage.local.get("applicationHistory");
  const previouslyApplied = new Set(
    stored.applicationHistory && typeof stored.applicationHistory === "object"
      ? Object.values(stored.applicationHistory)
        .filter((job) => job.applyStatus === "Applied")
        .map((job) => job.jobUrl)
      : []
  );
  const results = jobs.map((job) => ({
    ...job,
    applyStatus: previouslyApplied.has(job.jobUrl) ? "Skipped" : "Not attempted",
    applyReason: previouslyApplied.has(job.jobUrl)
      ? "Previously confirmed as applied; this job will not be submitted again."
      : "Not applied: this job has not been checked yet.",
    applyQuestions: [],
    applyDestination: ""
  }));
  let tabId;
  let stopReason = "";

  await saveApplyProgress(results, "running");
  try {
    for (let index = 0; index < results.length; index += 1) {
      const job = results[index];
      if (job.applyStatus !== "Not attempted") continue;
      let jobUrl;
      try {
        jobUrl = new URL(job.jobUrl);
      } catch {
        job.applyStatus = "Skipped";
        job.applyReason = "The job URL is missing or invalid.";
        await saveApplyProgress(results, "running");
        continue;
      }

      if (jobUrl.protocol !== "https:" || jobUrl.hostname !== "www.naukri.com") {
        job.applyStatus = "Skipped";
        job.applyReason = "Only Naukri job pages are supported for Quick Apply.";
        await saveApplyProgress(results, "running");
        continue;
      }

      try {
        const tab = tabId
          ? await chrome.tabs.update(tabId, { url: jobUrl.href, active: false })
          : await chrome.tabs.create({ url: jobUrl.href, active: false });
        tabId = tab.id;
        const loadedTab = await waitForTabComplete(tabId);
        if (!loadedTab.url || new URL(loadedTab.url).hostname !== "www.naukri.com") {
          job.applyStatus = "Skipped";
          job.applyReason = "The job opened outside Naukri; no application was submitted.";
        } else {
          const response = await requestQuickApply(tabId, job.title);
          job.applyStatus = response?.status || "Failed";
          job.applyReason = response?.reason || "Not applied: the Naukri page returned no application result.";
          job.applyQuestions = Array.isArray(response?.questions) ? response.questions : [];
          job.applyDestination = response?.destination || "";
        }
      } catch (error) {
        job.applyStatus = "Failed";
        job.applyReason = `Not applied: could not check or submit Quick Apply (${error?.message || String(error)}).`;
      }

      await saveApplyProgress(results, "running");
      if (job.applyStatus === "Applied") {
        stopReason = "Stopped after the first successful application.";
        break;
      }
      if (job.applyStatus === "Unconfirmed") {
        stopReason = "Stopped because the application result could not be confirmed; review it before continuing.";
        break;
      }
    }
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // The tab may already have been closed by the user.
      }
    }
  }

  if (stopReason) {
    const firstUnattempted = results.findIndex((job) => job.applyStatus === "Not attempted");
    for (let index = firstUnattempted; index >= 0 && index < results.length; index += 1) {
      results[index].applyReason = `Not applied: ${stopReason}`;
    }
  }
  await saveApplyProgress(results, "complete");
  return results;
}

async function applyToJobs(jobs) {
  if (applyRunInProgress) {
    throw new Error("A Quick Apply run is already in progress.");
  }
  applyRunInProgress = true;
  try {
    return await performApplyToJobs(jobs);
  } finally {
    applyRunInProgress = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "apply-naukri-jobs") {
    (async () => {
      if (!Array.isArray(message.jobs) || message.jobs.length === 0) {
        throw new Error("There are no jobs with matched skills to apply to.");
      }

      const jobs = message.jobs.filter((job) =>
        job && Number.isInteger(job.matchedSkills) && job.matchedSkills >= 1
      );
      if (jobs.length === 0) {
        throw new Error("No job has at least one matched skill.");
      }

      const results = await applyToJobs(jobs);
      return { results };
    })().then(
      (result) => sendResponse({ ok: true, ...result }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message.type !== "download-naukri-csv") {
    return;
  }

  (async () => {
    if (typeof message.csv !== "string") {
      throw new Error("The CSV download request is missing its file data.");
    }

    await ensureOffscreenDocument();
    const prepared = await chrome.runtime.sendMessage({
      type: "prepare-naukri-csv",
      csv: message.csv
    });
    if (!prepared?.url) {
      throw new Error("Could not prepare the CSV file for download.");
    }

    const downloadId = await chrome.downloads.download({
      url: prepared.url,
      filename: "naukri-jobs.csv",
      conflictAction: "uniquify",
      saveAs: false
    });
    return { downloadId };
  })().then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error.message })
  );

  return true;
});
