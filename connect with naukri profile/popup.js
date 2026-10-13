const form = document.querySelector("#search-form");
const keywordInput = document.querySelector("#keyword");
const locationInput = document.querySelector("#location");
const status = document.querySelector("#status");
const scanSummary = document.querySelector("#scan-summary");
const activitySummary = document.querySelector("#activity-summary");
const activityJobs = document.querySelector("#activity-jobs");
const applicationList = document.querySelector("#application-list");
const applyTopMatchButton = document.querySelector("#apply-top-match");
const downloadReportButton = document.querySelector("#download-report");
const ELIGIBILITY_THRESHOLD = 20;
const MIN_MATCHED_KEYWORDS = 3;

function isEligibleMatch(job) {
  return Number(job.percentage) > ELIGIBILITY_THRESHOLD ||
    Number(job.matchedCount) >= MIN_MATCHED_KEYWORDS;
}

function jobKeyForUrl(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function mergeJobRecords(jobMatches, appliedJobs, applications) {
  const jobsByUrl = new Map();
  for (const [url, match] of Object.entries(jobMatches)) {
    jobsByUrl.set(jobKeyForUrl(url), { ...match });
  }
  for (const [url, application] of Object.entries(appliedJobs)) {
    const key = jobKeyForUrl(url);
    const existing = jobsByUrl.get(key) ?? {};
    jobsByUrl.set(key, { ...existing, application });
  }
  for (const [url, application] of Object.entries(applications)) {
    const key = jobKeyForUrl(url);
    const existing = jobsByUrl.get(key) ?? {};
    jobsByUrl.set(key, { ...existing, review: application });
  }

  return [...jobsByUrl.entries()]
    .map(([url, job]) => ({
      url,
      title: job.application?.title || job.title || "Naukri job",
      percentage: Number.isFinite(job.percentage) ? job.percentage : "",
      matchedCount: Number.isFinite(job.matchedCount) ? job.matchedCount : "",
      termCount: Number.isFinite(job.termCount) ? job.termCount : "",
      matchedKeywords: Array.isArray(job.matchedKeywords) ? job.matchedKeywords.join("; ") : "",
      searchedKeywords: Array.isArray(job.searchedKeywords) ? job.searchedKeywords.join("; ") : "",
      application: job.application,
      review: job.review,
    }))
    .sort((first, second) =>
      (Number(second.percentage) || 0) - (Number(first.percentage) || 0),
    );
}

function jobOutcome(job) {
  if (job.review?.status === "applied" && job.review.automatic) {
    return { status: "Applied (detected by extension)", reason: "" };
  }
  if (job.application || job.review?.status === "applied") {
    return { status: "Applied (marked by user)", reason: "" };
  }
  if (/^(error|failed)/i.test(job.review?.status ?? "")) {
    return {
      status: "Apply attempt failed",
      reason: job.review.reason || "Naukri reported that the application attempt failed.",
    };
  }
  if (job.review?.status === "needs_attention") {
    return { status: "Needs manual attention", reason: job.review.reason || "The outcome was unclear." };
  }
  if (job.review?.status === "attempting") {
    return { status: "Attempt in progress", reason: "Waiting for a clear Naukri outcome." };
  }
  if (job.review?.status === "stopped") {
    return { status: "Stopped by user", reason: job.review.reason || "Stopped by user." };
  }
  if (job.review?.status === "not_attempted") {
    return { status: "Not attempted", reason: job.review.reason || "The run stopped before reaching this job." };
  }
  if (job.review?.status === "skipped") {
    return {
      status: "Skipped by user",
      reason: job.review.reason || "Skipped by user; no reason provided.",
    };
  }
  if (job.review?.status === "pending") {
    return { status: "Awaiting application attempt", reason: "This job is queued." };
  }
  return {
    status: "No application recorded",
    reason: "No application outcome was detected or recorded.",
  };
}

function createReportCsv(appliedJobs, applications = {}, batchApplyRun, searchCount = 0, lastScanLog = null) {
  const lastScanJobs = lastScanLog?.jobs ?? [];
  const activityJobs = mergeJobRecords(
    Object.fromEntries(lastScanJobs.map((job) => [job.url, job])),
    appliedJobs,
    applications,
  );
  const activityOutcomes = activityJobs.map(jobOutcome);
  const appliedCount = activityOutcomes.filter((outcome) => outcome.status.startsWith("Applied ")).length;
  const skippedCount = activityOutcomes.filter((outcome) => outcome.status === "Skipped by user").length;
  const pendingCount = activityOutcomes.filter((outcome) => outcome.status === "Awaiting application attempt").length;
  const errorCount = activityOutcomes.filter((outcome) => outcome.status === "Apply attempt failed").length;
  const attentionCount = activityOutcomes.filter((outcome) => outcome.status === "Needs manual attention").length;
  const notAttemptedCount = activityOutcomes.filter((outcome) => outcome.status === "Not attempted").length;
  const aboveThresholdCount = lastScanJobs.filter((job) => job.percentage > ELIGIBILITY_THRESHOLD).length;
  const atLeastThreeMatchesCount = lastScanJobs.filter((job) => Number(job.matchedCount) >= MIN_MATCHED_KEYWORDS).length;
  const eligibleJobs = lastScanJobs.filter(isEligibleMatch);
  const topJob = [...activityJobs].sort(
    (first, second) => Number(second.percentage) - Number(first.percentage),
  )[0];
  const rows = [[
    "Record type",
    "Metric",
    "Value",
    "Job title",
    "Match %",
    "Matched keywords",
    "Total keywords",
    "Matched skills",
    "Searched skills",
    "Application status",
    "Applied at",
    "Job URL",
    "Not applied reason / error",
  ]];

  const summary = [
    ["Searches performed", searchCount],
    ["Jobs found/scored (last scan)", lastScanLog?.detectedCount ?? 0],
    [`Jobs above ${ELIGIBILITY_THRESHOLD}% (last scan)`, aboveThresholdCount],
    [`Jobs with at least ${MIN_MATCHED_KEYWORDS} matched keywords (last scan)`, atLeastThreeMatchesCount],
    ["Applied (detected or marked)", appliedCount],
    [
      "Application-review status",
      batchApplyRun
        ? `${batchApplyRun.status}; ${activityJobs.filter((job) => job.review?.runId === batchApplyRun.id && job.review.status === "applied").length} success, ${activityJobs.filter((job) => job.review?.runId === batchApplyRun.id && job.review.status === "failed").length} failed, ${activityJobs.filter((job) => job.review?.runId === batchApplyRun.id && job.review.status === "pending").length} awaiting attempt`
        : "No application review started",
    ],
    ["Not applied", `${skippedCount} skipped, ${pendingCount} awaiting attempt, ${errorCount} failed, ${attentionCount} need attention, ${notAttemptedCount} not attempted`],
    ["Jobs eligible by either rule (last scan)", eligibleJobs.length],
    ["Highest match", topJob ? `${topJob.percentage}%` : "No scored jobs"],
    ["Highest-match job", topJob?.title ?? "No scored jobs"],
    [
      "Highest-match application status",
      topJob ? jobOutcome(topJob).status : "N/A",
    ],
  ];
  for (const [metric, value] of summary) {
    rows.push(["Summary", metric, value, "", "", "", "", "", "", "", "", "", ""]);
  }

  const jobsByUrl = new Map(activityJobs.map((job) => [jobKeyForUrl(job.url), job]));
  for (const scanJob of lastScanJobs) {
    const savedJob = jobsByUrl.get(jobKeyForUrl(scanJob.url));
    const job = { ...(savedJob ?? {}), ...scanJob };
    const outcome = savedJob ? jobOutcome(savedJob) : { status: "No application recorded", reason: "" };
    rows.push([
      "Job",
      "",
      "",
      job.title || "Naukri job",
      job.percentage,
      job.matchedCount,
      job.termCount,
      Array.isArray(job.matchedKeywords) ? job.matchedKeywords.join("; ") : "",
      Array.isArray(job.searchedKeywords) ? job.searchedKeywords.join("; ") : "",
      outcome.status,
      savedJob?.application?.appliedAt ?? savedJob?.review?.reviewedAt ?? "",
      job.url,
      outcome.reason,
    ]);
  }

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function loadSavedData() {
  try {
    const {
      searchPreferences,
      appliedJobs = {},
    } = await chrome.storage.local.get([
      "searchPreferences",
      "appliedJobs",
    ]);
    if (searchPreferences) {
      keywordInput.value = searchPreferences.keyword ?? "";
      locationInput.value = searchPreferences.location ?? "";
    }

    const recentApplications = Object.entries(appliedJobs)
      .sort(([, first], [, second]) => second.appliedAt.localeCompare(first.appliedAt))
      .slice(0, 5);
    if (!recentApplications.length) {
      const emptyState = document.createElement("li");
      emptyState.textContent = "None recorded yet. Apply on Naukri, then mark it on the job page.";
      applicationList.append(emptyState);
      return;
    }

    for (const [jobUrl, application] of recentApplications) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const date = new Date(application.appliedAt);
      link.textContent = application.title || "Naukri job";
      link.href = jobUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      const safeNaukriLink = new URL(jobUrl).origin === "https://www.naukri.com";
      if (safeNaukriLink) item.append(link);
      else item.textContent = link.textContent;
      if (!Number.isNaN(date.getTime())) {
        item.append(document.createTextNode(` · ${date.toLocaleDateString()}`));
      }
      applicationList.append(item);
    }
  } catch (error) {
    status.textContent = "Could not load your saved data from this browser.";
    console.error("Saved Naukri assistant data could not be loaded:", error);
  }
}

function renderActivitySummary(searchCount, appliedJobs, applications, batchApplyRun, currentScan = null, savedScanLog = null) {
  const scanLog = currentScan ?? savedScanLog;
  const scanMatches = scanLog
    ? Object.fromEntries(scanLog.jobs.map((job) => [job.url, job]))
    : {};
  const jobs = mergeJobRecords(
    scanMatches,
    appliedJobs,
    applications,
  );
  const scanJobs = scanLog?.jobs ?? [];
  const outcomes = jobs.map(jobOutcome);
  const appliedCount = outcomes.filter((outcome) => outcome.status.startsWith("Applied ")).length;
  const skippedCount = outcomes.filter((outcome) => outcome.status === "Skipped by user").length;
  const pendingCount = outcomes.filter((outcome) => outcome.status === "Awaiting application attempt").length;
  const errorCount = outcomes.filter((outcome) => outcome.status === "Apply attempt failed").length;
  const attentionCount = outcomes.filter((outcome) => outcome.status === "Needs manual attention").length;
  const notAttemptedCount = outcomes.filter((outcome) => outcome.status === "Not attempted").length;
  const aboveThresholdCount = scanJobs.filter((job) => job.percentage > ELIGIBILITY_THRESHOLD).length;
  const atLeastThreeMatchesCount = scanJobs.filter(
    (job) => Number(job.matchedCount) >= MIN_MATCHED_KEYWORDS,
  ).length;
  const runStatus = batchApplyRun?.status ?? "not started";
  const currentRunJobs = batchApplyRun
    ? jobs.filter((job) => job.review?.runId === batchApplyRun.id)
    : [];
  const runAppliedCount = currentRunJobs.filter((job) => job.review?.status === "applied").length;
  const runSkippedCount = currentRunJobs.filter((job) => job.review?.status === "skipped").length;
  const runPendingCount = currentRunJobs.filter((job) => job.review?.status === "pending").length;
  const runFailedCount = currentRunJobs.filter((job) => job.review?.status === "failed").length;
  const runSummary = batchApplyRun
    ? `${runStatus}; ${runAppliedCount} success, ${runFailedCount} failed, ${runPendingCount} awaiting attempt`
    : "No application review started";
  const metrics = [
    `Searches launched: ${Number(searchCount) || 0}`,
    `Jobs found/scored (last scan): ${scanLog?.detectedCount ?? 0}`,
    `Jobs above ${ELIGIBILITY_THRESHOLD}% (last scan): ${aboveThresholdCount}`,
    `Jobs with at least ${MIN_MATCHED_KEYWORDS} matched keywords (last scan): ${atLeastThreeMatchesCount}`,
    `Jobs eligible by either rule (last scan): ${scanJobs.filter(isEligibleMatch).length}`,
    `Applied (detected or marked): ${appliedCount}`,
    `Application-review status: ${runSummary}`,
    `Not applied: ${skippedCount} skipped, ${pendingCount} awaiting attempt, ${errorCount} failed, ${attentionCount} need attention, ${notAttemptedCount} not attempted`,
  ];
  activitySummary.replaceChildren();
  for (const metric of metrics) {
    const item = document.createElement("li");
    item.textContent = metric;
    activitySummary.append(item);
  }

  activityJobs.replaceChildren();
  const displayJobs = [...jobs].sort((first, second) => {
    const firstApplied = jobOutcome(first).status.startsWith("Applied ");
    const secondApplied = jobOutcome(second).status.startsWith("Applied ");
    return Number(secondApplied) - Number(firstApplied);
  });
  for (const job of displayJobs) {
    const outcome = jobOutcome(job);
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const safeNaukriLink = new URL(job.url).origin === "https://www.naukri.com";
    if (safeNaukriLink) {
      const link = document.createElement("a");
      link.href = job.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = job.title;
      title.append(link);
    } else {
      title.textContent = job.title;
    }
    const score = job.percentage === ""
      ? "No saved keyword score"
      : `${job.percentage}% match (${job.matchedCount}/${job.termCount} keywords)`;
    item.append(title, document.createTextNode(` · ${score} · ${outcome.status}`));
    if (outcome.reason) {
      item.append(document.createElement("br"), document.createTextNode(`Reason/error: ${outcome.reason}`));
    }
    activityJobs.append(item);
  }
  if (!scanLog) {
    const item = document.createElement("li");
    item.textContent = "No saved last-scan log. Run a search on Naukri; the latest page scan will be saved here.";
    activityJobs.append(item);
  } else if (!scanLog.jobs.length) {
    const item = document.createElement("li");
    item.textContent = "The saved last scan found no job cards.";
    activityJobs.append(item);
  }
}

loadSavedData();

async function searchJobs(applyTopMatch) {
  const keyword = keywordInput.value.trim();
  const location = locationInput.value.trim();

  if (!keyword) {
    status.textContent = "Enter a job title or keyword to search.";
    return;
  }

  const slug = (value) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const searchTerms = keyword
    .split(/[,;\n]+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .join(" ");
  const searchPath = `${slug(searchTerms)}-jobs`;
  const searchUrl = new URL(`https://www.naukri.com/${searchPath}`);
  searchUrl.searchParams.set("k", searchTerms);
  if (location) searchUrl.searchParams.set("l", location);

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!activeTab?.id) {
      status.textContent = "Could not find the active tab. Open a normal browser tab and try again.";
      return;
    }
    const { searchCount = 0 } = await chrome.storage.local.get(["searchCount"]);
    await chrome.storage.local.set({
      searchPreferences: { keyword, location },
      searchCount: (Number(searchCount) || 0) + 1,
      ...(applyTopMatch
        ? {
            batchApplyRun: {
              id: crypto.randomUUID(),
              status: "scanning",
              startedAt: new Date().toISOString(),
              keyword,
            },
          }
        : {}),
    });
    if (applyTopMatch) searchUrl.searchParams.set("assistantApplyBatch", "1");
    await chrome.tabs.update(activeTab.id, { url: searchUrl.toString() });
    window.close();
  } catch (error) {
    status.textContent = "Could not navigate the current tab. Check the extension permissions and try again.";
    console.error("Naukri search could not open in the current tab:", error);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await searchJobs(false);
});

applyTopMatchButton.addEventListener("click", () => searchJobs(true));

async function requestPageScan(tabId) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "naukri-assistant-scan-current-page",
      });
      if (response?.error) throw new Error(response.error);
      if (!Array.isArray(response?.scan?.jobs)) {
        throw new Error("The Naukri page did not return scan results.");
      }
      if (response.scan.jobs.length || attempt === 2) return response.scan;
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw lastError ?? new Error("The Naukri page returned no scan results.");
}

async function refreshActivitySummary(rescanCurrentPage = false) {
  try {
    let currentScan = null;
    let scanError = null;
    if (rescanCurrentPage) {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab?.id && activeTab.url && new URL(activeTab.url).origin === "https://www.naukri.com") {
        try {
          currentScan = await requestPageScan(activeTab.id);
          currentScan.scoredCount = currentScan.jobs.length;
          await chrome.storage.local.set({
            lastScanLog: currentScan,
            jobScanStatus: {
              detectedCount: currentScan.detectedCount,
              scoredCount: currentScan.scoredCount,
              pageUrl: currentScan.pageUrl,
              keyword: currentScan.keyword,
              scannedAt: currentScan.scannedAt,
            },
          });
          status.textContent = "";
          scanSummary.textContent = currentScan.detectedCount
            ? `Current page scan: detected and scored ${currentScan.detectedCount} job posts.`
            : "The live scan found no recognized job posts. Wait for Naukri results to finish loading, then reopen the assistant.";
        } catch (error) {
          scanError = error;
          console.error("Could not rescan or save the active Naukri page:", error);
        }
      } else {
        scanError = new Error("Open a Naukri job-results tab to scan the listings.");
      }
    }
    const {
      searchCount = 0,
      appliedJobs = {},
      applications = {},
      batchApplyRun,
      lastScanLog,
    } = await chrome.storage.local.get([
      "searchCount",
      "appliedJobs",
      "batchApplyRun",
      "applications",
      "lastScanLog",
    ]);
    renderActivitySummary(searchCount, appliedJobs, applications, batchApplyRun, currentScan, lastScanLog);
    if (!currentScan && lastScanLog) {
      const scannedAt = new Date(lastScanLog.scannedAt);
      const timeLabel = Number.isNaN(scannedAt.getTime()) ? "" : ` at ${scannedAt.toLocaleTimeString()}`;
      scanSummary.textContent = `Using saved last scan${timeLabel}: ${lastScanLog.detectedCount} jobs from ${lastScanLog.pageUrl}.`;
    } else if (!currentScan && !lastScanLog) {
      status.textContent = scanError
        ? `Live scan failed: ${scanError.message} Refresh the Naukri tab to reconnect the extension, then reopen this panel.`
        : "No saved scan log yet. Open a Naukri results page and wait for jobs to load.";
      scanSummary.textContent = "No scan data is available yet.";
    }
  } catch (error) {
    status.textContent = "Could not load search and application activity.";
    console.error("Application review activity could not be loaded:", error);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    (changes.searchCount || changes.jobMatches || changes.jobScanStatus || changes.lastScanLog || changes.appliedJobs || changes.batchApplyRun || changes.applications)
  ) {
    refreshActivitySummary();
  }
});

refreshActivitySummary(true);

downloadReportButton.addEventListener("click", async () => {
  try {
    const {
      appliedJobs = {},
      applications = {},
      batchApplyRun,
      searchCount = 0,
      lastScanLog,
    } = await chrome.storage.local.get([
      "appliedJobs",
      "applications",
      "batchApplyRun",
      "searchCount",
      "lastScanLog",
    ]);
    if (!lastScanLog?.jobs) {
      status.textContent = "No saved scan is available for the CSV. Refresh Naukri results and reopen the popup to save a scan.";
      return;
    }
    const csv = createReportCsv(appliedJobs, applications, batchApplyRun, searchCount, lastScanLog);
    const blobUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const downloadLink = document.createElement("a");
    downloadLink.href = blobUrl;
    downloadLink.download = `naukri-job-report-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadLink.click();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    try {
      await chrome.storage.local.remove(["lastScanLog", "jobScanStatus", "jobMatches"]);
    } catch (error) {
      status.textContent = "CSV download started, but the saved last-scan log could not be cleared.";
      console.error("Saved last-scan data could not be cleared after CSV download:", error);
      return;
    }
    const scoredCount = lastScanLog.scoredCount;
    status.textContent = `CSV download started: ${searchCount} searches, ${scoredCount} jobs in the saved scan. The saved last-scan log was cleared; application history remains.`;
  } catch (error) {
    status.textContent = "Could not create the report. Try again after reopening the extension.";
    console.error("Naukri job report could not be created:", error);
  }
});
