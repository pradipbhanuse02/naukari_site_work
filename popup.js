const searchForm = document.querySelector("#search-form");
const keywordInput = document.querySelector("#keyword");
const searchButton = searchForm.querySelector('button[type="submit"]');
const searchCountDisplay = document.querySelector("#search-count");
const jobPostCountDisplay = document.querySelector("#job-post-count");
const jobsAbove20CountDisplay = document.querySelector("#jobs-above-20-count");
const jobsThreeSkillsCountDisplay = document.querySelector("#jobs-three-skills-count");
const collectButton = document.querySelector("#collect");
const applyButton = document.querySelector("#apply");
const exportButton = document.querySelector("#export");
const status = document.querySelector("#status");
const jobResults = document.querySelector("#job-results");

let collectedJobs = [];
let csvJobs = [];
let applicationResultsByUrl = new Map();

function getLocalStorage() {
  const localStorage = chrome.storage?.local;
  if (!localStorage) {
    throw new Error("Extension storage is unavailable. Reload the extension at edge://extensions.");
  }
  return localStorage;
}

async function loadCounts() {
  try {
    const stored = await getLocalStorage().get([
      "searchesLaunched",
      "jobsFoundLastScan",
      "jobsAbove20LastScan",
      "jobsWithThreeSkillsLastScan",
      "applicationHistory"
    ]);
    const searchesLaunched = Number.isSafeInteger(stored.searchesLaunched) && stored.searchesLaunched >= 0
      ? stored.searchesLaunched
      : 0;
    const jobsFoundLastScan = Number.isSafeInteger(stored.jobsFoundLastScan) && stored.jobsFoundLastScan >= 0
      ? stored.jobsFoundLastScan
      : 0;
    const jobsAbove20LastScan = Number.isSafeInteger(stored.jobsAbove20LastScan) && stored.jobsAbove20LastScan >= 0
      ? stored.jobsAbove20LastScan
      : 0;
    const jobsWithThreeSkillsLastScan = Number.isSafeInteger(stored.jobsWithThreeSkillsLastScan) && stored.jobsWithThreeSkillsLastScan >= 0
      ? stored.jobsWithThreeSkillsLastScan
      : 0;
    searchCountDisplay.textContent = `1. Searches launched: ${searchesLaunched}`;
    jobPostCountDisplay.textContent = `2. Jobs found/scored (last scan): ${jobsFoundLastScan}`;
    jobsAbove20CountDisplay.textContent = `3. Jobs above 20% (last scan): ${jobsAbove20LastScan}`;
    jobsThreeSkillsCountDisplay.textContent = `4. Jobs with at least 3 matched keywords (last scan): ${jobsWithThreeSkillsLastScan}`;
    if (stored.applicationHistory && typeof stored.applicationHistory === "object") {
      applicationResultsByUrl = new Map(Object.entries(stored.applicationHistory));
    }
  } catch (error) {
    setStatus(`Could not load saved counts: ${error.message}`, true);
  }
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.error = String(isError);
}

function getSearchKeywords() {
  return NaukriKeywordMatcher.parse(keywordInput.value);
}

function renderJobs(jobs, keywords) {
  jobPostCountDisplay.textContent = `2. Jobs found/scored (last scan): ${jobs.length}`;
  const rankedJobs = NaukriKeywordMatcher.rankAndSelect(jobs, keywords)
    .map((job) => ({
      ...job,
      ...(applicationResultsByUrl.get(job.jobUrl) ?? {
        applyStatus: "Not attempted",
        applyReason: "Not applied: Quick Apply has not been run for this job.",
        applyQuestions: [],
        applyDestination: ""
      })
    }));
  const matchedJobs = rankedJobs
    .filter((job) => job.qualifies);
  collectedJobs = matchedJobs;
  const jobsAbove20 = rankedJobs.filter((job) =>
    job.totalSkills > 0 && job.matchedSkills * 100 > job.totalSkills * 20
  ).length;
  const jobsWithThreeSkills = rankedJobs.filter((job) => job.matchedSkills >= 3).length;
  jobsAbove20CountDisplay.textContent = `3. Jobs above 20% (last scan): ${jobsAbove20}`;
  jobsThreeSkillsCountDisplay.textContent = `4. Jobs with at least 3 matched keywords (last scan): ${jobsWithThreeSkills}`;
  csvJobs = rankedJobs.filter((job) => job.matchedSkills >= 1);
  exportButton.disabled = csvJobs.length === 0;
  applyButton.disabled = csvJobs.length === 0;
  jobResults.replaceChildren();

  for (const job of matchedJobs) {
    const item = document.createElement("li");
    item.className = "job-card";

    const title = document.createElement("a");
    title.className = "job-title";
    title.href = job.jobUrl;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.textContent = job.title || "Untitled job";
    item.append(title);

    const details = [job.company, job.location, job.experience, job.salary, job.posted]
      .filter(Boolean)
      .join(" · ");
    if (details) {
      const meta = document.createElement("p");
      meta.className = "job-meta";
      meta.textContent = details;
      item.append(meta);
    }

    const keywordMatches = document.createElement("p");
    keywordMatches.className = "job-meta";
    keywordMatches.textContent = `Skill match: ${job.percentage}% (${job.matchedSkills}/${job.totalSkills}) · Rank #${job.matchRank}`;
    item.append(keywordMatches);

    const applicationStatus = document.createElement("p");
    applicationStatus.className = "job-meta";
    applicationStatus.textContent = `Application: ${job.applyStatus} · ${getApplicationReason(job)}`;
    item.append(applicationStatus);
    if (job.applyQuestions?.length) {
      const questions = document.createElement("p");
      questions.className = "job-meta";
      questions.textContent = `Application form questions: ${job.applyQuestions.join("; ")}`;
      item.append(questions);
    }

    if (job.description) {
      const description = document.createElement("p");
      description.className = "job-description";
      description.textContent = job.description;
      item.append(description);
    }

    jobResults.append(item);
  }

  return { jobsAbove20, jobsWithThreeSkills };
}

async function collectJobsFromTab(tabId, keywords) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: "collect-naukri-jobs",
        keywords
      });
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
    }
  }
  throw lastError;
}

async function collectFromActiveTab(showEmptyMessage = true) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostname = tab?.url ? new URL(tab.url).hostname : "";
    if (!tab?.id || hostname !== "www.naukri.com") {
      return false;
    }

    const urlKeywords = new URL(tab.url).searchParams.get("k");
    if (urlKeywords) keywordInput.value = urlKeywords;
    const keywords = getSearchKeywords();
    if (keywords.length === 0) {
      collectedJobs = [];
      csvJobs = [];
      applyButton.disabled = true;
      jobPostCountDisplay.textContent = "2. Jobs found/scored (last scan): 0";
      jobsAbove20CountDisplay.textContent = "3. Jobs above 20% (last scan): 0";
      jobsThreeSkillsCountDisplay.textContent = "4. Jobs with at least 3 matched keywords (last scan): 0";
      exportButton.disabled = true;
      jobResults.replaceChildren();
      await getLocalStorage().set({
        jobsFoundLastScan: 0,
        jobsAbove20LastScan: 0,
        jobsWithThreeSkillsLastScan: 0
      });
      setStatus("Enter at least one comma-separated skill keyword to filter jobs.");
      return true;
    }

    const response = await collectJobsFromTab(tab.id, keywords);
    if (!response?.jobs) {
      setStatus("The Naukri page did not return job listings. Reload the page and try again.", true);
      return false;
    }

    const scanCounts = renderJobs(response.jobs, keywords);
    try {
      await getLocalStorage().set({
        jobsFoundLastScan: response.jobs.length,
        jobsAbove20LastScan: scanCounts.jobsAbove20,
        jobsWithThreeSkillsLastScan: scanCounts.jobsWithThreeSkills
      });
    } catch (error) {
      setStatus(`Jobs were collected, but the last-scan count could not be saved: ${error.message}`, true);
      return false;
    }
    setStatus(collectedJobs.length || !showEmptyMessage
      ? ""
      : "No job matched the highest-score or 3+ skills selection rule. Wait for results to finish loading, then collect again.");
    return true;
  } catch (error) {
    setStatus(`Could not collect jobs: ${error.message}. Reload the Naukri tab and try again.`, true);
    return false;
  }
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyword = keywordInput.value.trim();
  if (!keyword || getSearchKeywords().length === 0) {
    setStatus("Enter at least one comma-separated skill keyword.", true);
    return;
  }

  const slug = keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const searchUrl = `https://www.naukri.com/${slug}-jobs?k=${encodeURIComponent(keyword)}`;

  searchButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("Could not find the active tab.");
    }

    try {
      const storage = getLocalStorage();
      const stored = await storage.get("searchesLaunched");
      const previousCount = Number.isSafeInteger(stored.searchesLaunched) && stored.searchesLaunched >= 0
        ? stored.searchesLaunched
        : 0;
      const nextCount = previousCount + 1;
      await storage.set({
        searchesLaunched: nextCount,
        jobsFoundLastScan: 0,
        jobsAbove20LastScan: 0,
        jobsWithThreeSkillsLastScan: 0
      });
      searchCountDisplay.textContent = `1. Searches launched: ${nextCount}`;
      jobPostCountDisplay.textContent = "2. Jobs found/scored (last scan): 0";
      jobsAbove20CountDisplay.textContent = "3. Jobs above 20% (last scan): 0";
      jobsThreeSkillsCountDisplay.textContent = "4. Jobs with at least 3 matched keywords (last scan): 0";
      collectedJobs = [];
      csvJobs = [];
      applyButton.disabled = true;
      jobResults.replaceChildren();
      exportButton.disabled = true;
    } catch (error) {
      setStatus(`Search will continue, but its count could not be saved: ${error.message}`, true);
    }

    await chrome.tabs.update(tab.id, { url: searchUrl });
  } catch (error) {
    setStatus(`Could not open Naukri: ${error.message}`, true);
  } finally {
    searchButton.disabled = false;
  }
});

collectButton.addEventListener("click", async () => {
  setStatus("");
  const collected = await collectFromActiveTab();
  if (!collected) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostname = tab?.url ? new URL(tab.url).hostname : "";
    if (hostname !== "www.naukri.com") {
      setStatus("Open a Naukri job-results tab before collecting jobs.", true);
    }
  }
});

function escapeCsv(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function getApplicationReason(job) {
  if (job.applyReason && !["Not attempted yet.", "Not attempted."].includes(job.applyReason)) {
    return job.applyReason;
  }
  if (job.applyStatus === "Applied") return "Naukri confirmed the application was submitted.";
  if (job.applyStatus === "Not attempted") return "Not applied: Quick Apply has not been run for this job, or the run stopped before reaching it.";
  if (job.applyStatus === "Skipped") return "Not applied: skipped by the Quick Apply safety checks.";
  if (job.applyStatus === "Failed") return "Not applied: the Quick Apply attempt failed.";
  if (job.applyStatus === "Unconfirmed") return "Not applied: Naukri did not confirm whether the submission succeeded.";
  return `Not applied: no reason was returned for status "${job.applyStatus || "unknown"}".`;
}

function buildCsv() {
  const columns = [
    ["title", "Job Title"],
    ["company", "Company"],
    ["location", "Location"],
    ["experience", "Experience"],
    ["salary", "Salary"],
    ["skills", "Skills"],
    ["description", "Description"],
    ["posted", "Posted"],
    ["matchedSkills", "Matched Skills"],
    ["totalSkills", "Total Search Skills"],
    ["percentage", "Skill Match Percent"],
    ["matchRank", "Skill Match Rank"],
    ["qualificationReason", "Selection Reason"],
    ["applyStatus", "Application Status"],
    ["applyReason", "Why Not Applied / Application Outcome"],
    ["applyQuestions", "Application Form Questions"],
    ["applyDestination", "External Application URL"],
    ["jobUrl", "Job URL"]
  ];
  const rows = [
    columns.map(([, heading]) => escapeCsv(heading)).join(","),
    ...csvJobs.map((job) => columns.map(([key]) => escapeCsv(
      key === "applyReason"
        ? getApplicationReason(job)
        : key === "applyQuestions"
          ? (job.applyQuestions ?? []).join("; ")
          : job[key]
    )).join(","))
  ];
  return rows.join("\r\n");
}

applyButton.addEventListener("click", async () => {
  if (!csvJobs.length) {
    setStatus("Collect jobs with at least one matched skill before starting Quick Apply.", true);
    return;
  }
  const proceed = window.confirm(
    `Attempt Quick Apply for the ${csvJobs.length} jobs currently eligible for CSV export, in highest-match order? The extension stops after the first confirmed success. Jobs needing CAPTCHA, file upload, or manual fields will be skipped.`
  );
  if (!proceed) return;

  applyButton.disabled = true;
  exportButton.disabled = true;
  setStatus("Attempting Quick Apply in the background. Keep Edge open until the results appear.");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "apply-naukri-jobs",
      jobs: csvJobs.map((job) => ({ ...job }))
    });
    if (!response?.ok) {
      throw new Error(response?.error
        || "The extension background did not return application details. Reload the extension and inspect its service-worker errors at edge://extensions.");
    }
    for (const result of response.results) {
      applicationResultsByUrl.set(result.jobUrl, result);
    }
    csvJobs = csvJobs.map((job) => ({
      ...job,
      ...applicationResultsByUrl.get(job.jobUrl)
    }));
    collectedJobs = collectedJobs.map((job) => ({
      ...job,
      ...applicationResultsByUrl.get(job.jobUrl)
    }));
    const applied = response.results.find((job) => job.applyStatus === "Applied");
    const unconfirmed = response.results.find((job) => job.applyStatus === "Unconfirmed");
    const skipped = response.results.filter((job) => job.applyStatus === "Skipped").length;
    setStatus(applied
      ? `Application confirmed for ${applied.title}. Stopped after the first success. Download the CSV to view outcomes.`
      : unconfirmed
        ? `Application result for ${unconfirmed.title} is unconfirmed. The run stopped to avoid a duplicate application. Download the CSV to review.`
        : `No application was confirmed. ${skipped} job(s) were skipped; download the CSV for reasons.`);
  } catch (error) {
    let history = {};
    try {
      const stored = await getLocalStorage().get("applicationHistory");
      if (stored.applicationHistory && typeof stored.applicationHistory === "object") {
        history = stored.applicationHistory;
      }
    } catch (storageError) {
      setStatus(`Quick Apply run failed: ${error.message}; application results could not be read: ${storageError.message}`, true);
    }
    csvJobs = csvJobs.map((job) => {
      const previous = history[job.jobUrl];
      if (previous?.applyStatus && previous.applyStatus !== "Not attempted") {
        return { ...job, ...previous };
      }
      return {
        ...job,
        ...(previous ?? {}),
        applyStatus: "Not attempted",
        applyReason: `Not applied: the Quick Apply run stopped before this job could be checked (${error.message}).`,
        applyQuestions: previous?.applyQuestions ?? [],
        applyDestination: previous?.applyDestination ?? ""
      };
    });
    for (const job of csvJobs) {
      applicationResultsByUrl.set(job.jobUrl, job);
    }
    setStatus(`Quick Apply run failed: ${error.message}. Download the CSV to see why each job was not applied.`, true);
  } finally {
    applyButton.disabled = csvJobs.length === 0;
    exportButton.disabled = csvJobs.length === 0;
  }
});

exportButton.addEventListener("click", async () => {
  if (!csvJobs.length) {
    setStatus("No jobs with at least one matched skill are available for CSV export.", true);
    return;
  }

  exportButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "download-naukri-csv",
      csv: buildCsv()
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Edge did not start the download.");
    }
    setStatus(`CSV download started (${csvJobs.length} jobs with at least one matched skill). Check Edge Downloads.`);
  } catch (error) {
    setStatus(`Could not download the CSV: ${error.message}`, true);
  } finally {
    exportButton.disabled = false;
  }
});

loadCounts().then(() => collectFromActiveTab(false));
