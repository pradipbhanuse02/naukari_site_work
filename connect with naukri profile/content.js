const PANEL_ID = "naukri-job-assistant";
const BADGE_ATTRIBUTE = "data-naukri-assistant-badge";
const ELIGIBILITY_THRESHOLD = 20;
const MIN_MATCHED_KEYWORDS = 3;
const MAX_TRACKED_JOBS = 500;
const AUTO_APPLY_TIMEOUT_MS = 15000;
const BATCH_APPLY_REQUEST_PARAMETER = "assistantApplyBatch";
const TOP_APPLY_STATUS_ID = "naukri-assistant-top-apply-status";
let latestJobMatches = {};
let batchScanTimer;
let batchScanStarted = false;
let automaticAttemptStarted = false;
let automaticOutcomePending = false;

function isEligibleMatch(match) {
  return Number(match.percentage) > ELIGIBILITY_THRESHOLD ||
    Number(match.matchedCount) >= MIN_MATCHED_KEYWORDS;
}

function normalizedText(value) {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function currentJobKey() {
  return jobKeyForUrl(window.location.href);
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  return element.isConnected &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0;
}

function applicationNotice() {
  const notices = [...document.querySelectorAll(
    '[role="alert"], [role="status"], [aria-live], [class*="toast" i], [class*="notification" i]',
  )].filter(isVisible);
  for (const notice of notices) {
    const text = normalizedText(notice.innerText ?? notice.textContent ?? "");
    if (/already applied|application (?:submitted|sent) successfully|successfully applied|applied successfully/.test(text)) {
      return { status: "applied", reason: text.slice(0, 300) };
    }
    if (
      /application.{0,40}(?:fail|error|unable|could not|not successful|unsuccessful)|(?:fail|error|unable|could not|unsuccessful).{0,40}application|not eligible (?:to apply|for (?:this )?(?:job|position))|try again later/.test(text)
    ) {
      return { status: "failed", reason: text.slice(0, 300) };
    }
  }

  const appliedControl = [...document.querySelectorAll("button, [role='button']")]
    .filter(isVisible)
    .find((element) => /^(applied|already applied|application submitted)$/.test(
      normalizedText(element.innerText ?? element.textContent ?? ""),
    ));
  return appliedControl ? { status: "applied", reason: "Naukri shows this job as applied." } : null;
}

function applicationFormIsVisible() {
  const dialogs = [...document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="drawer" i]',
  )].filter(isVisible);
  return dialogs.some((dialog) =>
    dialog.querySelector("input:not([type='hidden']), textarea, select, [contenteditable='true']") ||
    /application form|screening question|additional information|upload (?:your )?resume|complete your application/i
      .test(dialog.innerText ?? ""),
  );
}

function findOneStepApplyButton() {
  const exactApplyLabel = /^(apply|apply now|quick apply|apply for this job)$/i;
  return [...document.querySelectorAll("button, [role='button']:not(a)")]
    .filter(isVisible)
    .find((button) => {
      const label = (button.innerText || button.getAttribute("aria-label") || button.title || "")
        .replace(/\s+/g, " ")
        .trim();
      return exactApplyLabel.test(label);
    });
}

function completeAutomaticAttempt(jobKey, status, reason) {
  if (automaticOutcomePending) return;
  automaticOutcomePending = true;
  chrome.storage.local.get(["batchApplyRun", "applications", "appliedJobs"], ({ batchApplyRun, applications = {}, appliedJobs = {} }) => {
    if (chrome.runtime.lastError) {
      console.error("Automatic application outcome could not be loaded:", chrome.runtime.lastError);
      showTopApplyStatus("Could not save the application outcome. Automatic review stopped.");
      return;
    }
    if (batchApplyRun?.status !== "running" || batchApplyRun.queue?.[batchApplyRun.index]?.url !== jobKey) return;

    const reviewedAt = new Date().toISOString();
    applications[jobKey] = {
      ...(applications[jobKey] ?? {}),
      ...batchApplyRun.queue[batchApplyRun.index],
      runId: batchApplyRun.id,
      status,
      reason,
      reviewedAt,
      ...(status === "applied" ? { appliedAt: reviewedAt } : {}),
    };
    if (status === "applied") {
      appliedJobs[jobKey] = {
        title: batchApplyRun.queue[batchApplyRun.index].title || document.title,
        appliedAt: reviewedAt,
      };
    }
    const trackedApplications = Object.fromEntries(Object.entries(appliedJobs).slice(-MAX_TRACKED_JOBS));

    const updatedRun = status === "applied"
      ? { ...batchApplyRun, status: "completed_applied", completedAt: reviewedAt, appliedUrl: jobKey }
      : status === "failed"
        ? batchApplyRun.stopAfterCurrentAttempt
          ? { ...batchApplyRun, status: "stopped_by_user", completedAt: reviewedAt }
          : batchApplyRun
        : { ...batchApplyRun, status: "paused_needs_attention", completedAt: reviewedAt };
    if (status === "applied" || status === "needs_attention" || updatedRun.status === "stopped_by_user") {
      const reason = status === "applied"
        ? "Not attempted because the run stopped after its first detected success."
        : "Not attempted because the run paused before reaching this job.";
      for (const queuedJob of batchApplyRun.queue.slice(batchApplyRun.index + 1)) {
        if (applications[queuedJob.url]?.status === "pending") {
          applications[queuedJob.url] = {
            ...applications[queuedJob.url],
            status: "not_attempted",
            reason,
          };
        }
      }
    }

    chrome.storage.local.set({ applications, appliedJobs: trackedApplications, batchApplyRun: updatedRun }, () => {
      if (chrome.runtime.lastError) {
        console.error("Automatic application outcome could not be saved:", chrome.runtime.lastError);
        showTopApplyStatus("Could not save the application outcome. Automatic review stopped.");
        return;
      }
      if (status === "applied") {
        showTopApplyStatus("Application marked successful by Naukri. Stopping after this one application.");
      } else if (status === "failed") {
        if (updatedRun.status === "stopped_by_user") {
          showTopApplyStatus("The current attempt failed. Stopped as requested; no next job was attempted.");
        } else {
          showTopApplyStatus("Naukri reported an application failure. Trying the next matching job.");
          processBatchQueue();
        }
      } else {
        showTopApplyStatus(`Automatic review paused: ${reason}`);
      }
    });
  });
}

function monitorAutomaticAttempt(jobKey, attemptedAt) {
  const elapsed = Date.now() - new Date(attemptedAt).getTime();
  if (elapsed >= AUTO_APPLY_TIMEOUT_MS) {
    completeAutomaticAttempt(jobKey, "needs_attention", "Naukri did not show a clear success or failure. Check the application manually.");
    return;
  }
  const notice = applicationNotice();
  if (notice) {
    completeAutomaticAttempt(jobKey, notice.status, notice.reason);
    return;
  }
  if (applicationFormIsVisible()) {
    completeAutomaticAttempt(jobKey, "needs_attention", "Naukri opened an application form. The extension stopped without filling or submitting it.");
    return;
  }
  window.setTimeout(() => monitorAutomaticAttempt(jobKey, attemptedAt), 700);
}

function startAutomaticApplication(jobKey) {
  if (automaticAttemptStarted) return;
  automaticAttemptStarted = true;
  chrome.storage.local.get(["batchApplyRun", "applications"], ({ batchApplyRun, applications = {} }) => {
    if (chrome.runtime.lastError) {
      console.error("Automatic application queue could not be loaded:", chrome.runtime.lastError);
      showTopApplyStatus("Could not load the automatic application queue. No Apply control was clicked.");
      return;
    }
    if (batchApplyRun?.status !== "running" || batchApplyRun.queue?.[batchApplyRun.index]?.url !== jobKey) return;

    const application = applications[jobKey];
    if (application?.status === "attempting") {
      monitorAutomaticAttempt(jobKey, application.attemptedAt);
      return;
    }
    if (application?.status !== "pending") return;

    const notice = applicationNotice();
    if (notice?.status === "applied") {
      completeAutomaticAttempt(jobKey, "applied", notice.reason);
      return;
    }
    if (notice?.status === "failed") {
      completeAutomaticAttempt(jobKey, "failed", notice.reason);
      return;
    }
    if (applicationFormIsVisible()) {
      completeAutomaticAttempt(jobKey, "needs_attention", "An application form is present. The extension stopped without filling or submitting it.");
      return;
    }

    const button = findOneStepApplyButton();
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
      completeAutomaticAttempt(
        jobKey,
        "needs_attention",
        button ? "The Apply control is disabled; manual review is needed." : "No clear one-step Apply control was found; manual review is needed.",
      );
      return;
    }
    const attemptedAt = new Date().toISOString();
    applications[jobKey] = {
      ...application,
      status: "attempting",
      attemptedAt,
      reason: "",
    };
    chrome.storage.local.set({ applications }, () => {
      if (chrome.runtime.lastError) {
        console.error("Automatic application attempt could not be recorded:", chrome.runtime.lastError);
        showTopApplyStatus("Could not record the attempt. The Apply control was not clicked.");
        return;
      }
      chrome.storage.local.get(["batchApplyRun", "applications"], ({ batchApplyRun: currentRun, applications: currentApplications = {} }) => {
        if (chrome.runtime.lastError) {
          console.error("Automatic application attempt could not be rechecked:", chrome.runtime.lastError);
          showTopApplyStatus("Could not verify the queue state. The Apply control was not clicked.");
          return;
        }
        if (
          currentRun?.status !== "running" ||
          currentRun.queue?.[currentRun.index]?.url !== jobKey ||
          currentApplications[jobKey]?.status !== "attempting"
        ) return;
        if (!button.isConnected || !isVisible(button)) {
          completeAutomaticAttempt(jobKey, "needs_attention", "The Apply control changed before it could be clicked. Manual review is needed.");
          return;
        }
        showTopApplyStatus("Trying the one-step Apply control. The queue stops after one success.");
        button.click();
        monitorAutomaticAttempt(jobKey, attemptedAt);
      });
    });
  });
}

function showTopApplyStatus(message) {
  let status = document.getElementById(TOP_APPLY_STATUS_ID);
  if (!status) {
    status = document.createElement("div");
    status.id = TOP_APPLY_STATUS_ID;
    status.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:460px;padding:12px 16px;border-radius:8px;background:#19232f;color:white;font:13px/1.4 'Segoe UI',Arial,sans-serif;box-shadow:0 4px 18px #16243a40;";
    document.documentElement.append(status);
  }
  status.textContent = message;
}

function jobKeyForUrl(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function addPanel() {
  if (document.getElementById(PANEL_ID)) return;

  const host = document.createElement("div");
  host.id = PANEL_ID;
  host.style.cssText = "all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    section {
      box-sizing: border-box; width: 290px; padding: 16px;
      border: 1px solid #e0e4ec; border-radius: 12px;
      background: #fff; box-shadow: 0 8px 30px #16243a26;
      color: #19232f; font: 13px/1.45 "Segoe UI", Arial, sans-serif;
    }
    strong { display: block; margin-bottom: 5px; font-size: 14px; }
    p { margin: 0 0 12px; color: #5c6877; }
    button {
      width: 100%; min-height: 36px; border: 0; border-radius: 7px;
      background: #5369dc; color: #fff; font: 700 12px "Segoe UI", Arial, sans-serif;
      cursor: pointer;
    }
    button[hidden] { display: none; }
    button:disabled { background: #e8ebf0; color: #53606d; cursor: default; }
    .dismiss {
      display: block; margin: 10px auto 0; padding: 0; width: auto; min-height: 0;
      background: transparent; color: #657180; font-weight: 400;
    }
  `;
  const section = document.createElement("section");
  const title = document.createElement("strong");
  title.textContent = "Naukri application assistant";
  const copy = document.createElement("p");
  copy.textContent = "Automatic application attempts run only when started from the extension popup. The extension does not fill forms or access your password.";
  const appliedButton = document.createElement("button");
  const skipButton = document.createElement("button");
  skipButton.className = "dismiss";
  skipButton.textContent = "Skip this job";
  const stopAutomaticButton = document.createElement("button");
  stopAutomaticButton.className = "dismiss";
  stopAutomaticButton.textContent = "Stop after current attempt";
  stopAutomaticButton.hidden = true;
  stopAutomaticButton.addEventListener("click", () => {
    chrome.storage.local.get(["batchApplyRun", "applications"], ({ batchApplyRun, applications = {} }) => {
      if (chrome.runtime.lastError) {
        copy.textContent = "Could not stop the automatic review.";
        console.error("Automatic review could not be stopped:", chrome.runtime.lastError);
        return;
      }
      if (batchApplyRun?.status !== "running" || batchApplyRun.queue?.[batchApplyRun.index]?.url !== jobKey) return;
      if (applications[jobKey]?.status === "attempting") {
        chrome.storage.local.set({
          batchApplyRun: { ...batchApplyRun, stopAfterCurrentAttempt: true },
        }, () => {
          if (chrome.runtime.lastError) {
            copy.textContent = "Could not save the stop request.";
            console.error("Automatic review stop request could not be saved:", chrome.runtime.lastError);
          } else {
            copy.textContent = "Will stop after the current Naukri attempt finishes; it cannot be cancelled once started.";
            stopAutomaticButton.disabled = true;
          }
        });
        return;
      }
      applications[jobKey] = {
        ...(applications[jobKey] ?? {}),
        status: "stopped",
        reason: "Stopped by user before an application outcome was confirmed.",
        reviewedAt: new Date().toISOString(),
      };
      for (const queuedJob of batchApplyRun.queue.slice(batchApplyRun.index + 1)) {
        if (applications[queuedJob.url]?.status === "pending") {
          applications[queuedJob.url] = {
            ...applications[queuedJob.url],
            status: "not_attempted",
            reason: "Not attempted because the run was stopped by the user.",
          };
        }
      }
      chrome.storage.local.set({
        applications,
        batchApplyRun: { ...batchApplyRun, status: "stopped_by_user", completedAt: new Date().toISOString() },
      }, () => {
        if (chrome.runtime.lastError) {
          copy.textContent = "Could not save the stop request.";
          console.error("Automatic review stop request could not be saved:", chrome.runtime.lastError);
        } else {
          copy.textContent = "Automatic attempts stopped.";
          stopAutomaticButton.disabled = true;
        }
      });
    });
  });
  const dismissButton = document.createElement("button");
  dismissButton.className = "dismiss";
  dismissButton.textContent = "Hide assistant";
  dismissButton.addEventListener("click", () => host.remove());

  const jobKey = currentJobKey();
  function finishQueuedJob(result, reason = "") {
    chrome.storage.local.get(["batchApplyRun", "applications"], ({ batchApplyRun, applications = {} }) => {
      if (chrome.runtime.lastError) {
        copy.textContent = "Could not load the application review. Please try again.";
        console.error("Application review could not be loaded:", chrome.runtime.lastError);
        return;
      }
      const queuedJob = batchApplyRun?.queue?.[batchApplyRun.index];
      if (batchApplyRun?.status !== "running" || queuedJob?.url !== jobKey) return;

      applications[jobKey] = {
        ...(applications[jobKey] ?? {}),
        ...queuedJob,
        runId: batchApplyRun.id,
        status: result,
        ...(reason ? { reason } : {}),
        reviewedAt: new Date().toISOString(),
      };
      chrome.storage.local.set({ applications }, () => {
        if (chrome.runtime.lastError) {
          copy.textContent = "Could not save the application result.";
          console.error("Application result could not be saved:", chrome.runtime.lastError);
          return;
        }
        appliedButton.disabled = true;
        skipButton.disabled = true;
        processBatchQueue();
      });
    });
  }

  chrome.storage.local.get(["appliedJobs", "jobMatches", "applications", "batchApplyRun"], ({ appliedJobs = {}, jobMatches = {}, applications = {}, batchApplyRun }) => {
    if (chrome.runtime.lastError) {
      copy.textContent = "Could not load the application status from this browser.";
      console.error("Application status could not be loaded:", chrome.runtime.lastError);
      return;
    }
    const match = jobMatches[jobKey];
    if (match) {
      const eligible = isEligibleMatch(match);
      const eligibility = eligible
        ? "Eligible for application review."
        : "Below the application-review criteria.";
      copy.textContent = `${match.percentage}% keyword match (${match.matchedCount}/${match.termCount}). ${eligibility} Apply manually or start an automatic run from the extension popup.`;
    } else {
      copy.textContent = "Automatic application attempts run only when started from the extension popup. The extension does not fill forms or access your password.";
    }
    const alreadyApplied = Boolean(appliedJobs[jobKey]);
    const activeQueueJob = batchApplyRun?.status === "running" &&
      batchApplyRun.queue?.[batchApplyRun.index]?.url === jobKey;
    const previousResult = applications[jobKey]?.status;
    if (activeQueueJob) {
      copy.textContent = "The extension will try one clear Apply control, stop for forms or unclear results, and stop after one confirmed success.";
      appliedButton.hidden = true;
      skipButton.hidden = true;
      stopAutomaticButton.hidden = false;
      startAutomaticApplication(jobKey);
    } else {
      stopAutomaticButton.hidden = true;
    }
    appliedButton.textContent = alreadyApplied || previousResult === "applied"
      ? "Already marked as applied"
      : "I applied on Naukri";
    appliedButton.hidden = activeQueueJob || alreadyApplied || previousResult === "applied";
    appliedButton.disabled = appliedButton.hidden;
    skipButton.hidden = true;
  });

  appliedButton.addEventListener("click", async () => {
    try {
      const { appliedJobs = {} } = await chrome.storage.local.get(["appliedJobs"]);
      appliedJobs[jobKey] = { title: document.title, appliedAt: new Date().toISOString() };
      const entries = Object.entries(appliedJobs).slice(-MAX_TRACKED_JOBS);
      await chrome.storage.local.set({ appliedJobs: Object.fromEntries(entries) });
      appliedButton.textContent = "Marked as applied";
      appliedButton.disabled = true;
      finishQueuedJob("applied");
    } catch (error) {
      copy.textContent = "Could not save the application status. Please try again.";
      console.error("Application status could not be saved:", error);
    }
  });

  skipButton.addEventListener("click", () => {
    const reason = window.prompt("Why are you skipping this job? (Optional)", "");
    if (reason === null) return;
    finishQueuedJob("skipped", reason.trim() || "Skipped by user; no reason provided.");
  });

  section.append(title, copy, appliedButton, skipButton, stopAutomaticButton, dismissButton);
  shadow.append(style, section);
  document.documentElement.append(host);
}

function findJobCard(anchor) {
  return (
    anchor.closest(
      '[data-job-id], [class*="jobTuple"], [class*="jobtuple"], [class*="job-tuple"], [class*="jobCard"], [class*="job-card"], [class*="srp-jobtuple"], [class*="cust-job-tuple"]',
    ) ??
    anchor.closest("article") ??
    anchor
  );
}

function isJobPostUrl(link) {
  const url = new URL(link.href);
  return (
    /job-listings|\/job\//i.test(url.pathname) ||
    /\/jobs\/.*-\d{5,}(?:\/|$)/i.test(url.pathname) ||
    [...url.searchParams.keys()].some((key) => /^(jobid|job_id)$/i.test(key))
  );
}

function getJobLinks() {
  const cardSelector =
    '[data-job-id], [class*="jobTuple"], [class*="jobtuple"], [class*="job-tuple"], [class*="jobCard"], [class*="job-card"], [class*="srp-jobtuple"], [class*="cust-job-tuple"]';
  const jobLinks = new Set();

  for (const link of document.querySelectorAll("a[href]")) {
    try {
      if (new URL(link.href).origin === "https://www.naukri.com" && isJobPostUrl(link)) {
        jobLinks.add(link);
      }
    } catch (error) {
      console.error("Skipping an invalid job link:", error);
    }
  }

  for (const card of document.querySelectorAll(cardSelector)) {
    const cardLinks = [...card.querySelectorAll("a[href]")];
    const jobLink = cardLinks.find((link) => {
      try {
        return isJobPostUrl(link);
      } catch (error) {
        console.error("Skipping an invalid job link:", error);
        return false;
      }
    }) ?? card.querySelector('h1 a[href], h2 a[href], h3 a[href], a[title][href], a[class*="title"][href]');
    if (jobLink) jobLinks.add(jobLink);
  }

  return [...jobLinks].filter((link) => {
    try {
      return (
        new URL(link.href).origin === "https://www.naukri.com" &&
        (isJobPostUrl(link) || Boolean(link.closest(cardSelector)))
      );
    } catch (error) {
      console.error("Skipping an invalid job link:", error);
      return false;
    }
  });
}

function annotateMatchingJobs(keyword) {
  const terms = [...new Set(keyword.split(/[,;\n]+/).map(normalizedText).filter(Boolean))];
  if (!terms.length) return;

  const seenCards = new Set();
  const jobMatches = {};
  const jobLinks = getJobLinks();
  for (const link of jobLinks) {
    const card = findJobCard(link);
    if (!card || seenCards.has(card)) continue;
    seenCards.add(card);

    let badge = card.querySelector(`[${BADGE_ATTRIBUTE}]`);
    const cardText = normalizedText(card.innerText ?? card.textContent ?? "");
    const existingBadgeText = badge ? normalizedText(badge.textContent) : "";
    const searchableText = existingBadgeText ? cardText.replace(existingBadgeText, " ") : cardText;
    const matchedKeywords = terms.filter((term) => searchableText.includes(term));
    const matchedCount = matchedKeywords.length;
    const percentage = Math.round((matchedCount / terms.length) * 100);
    const jobKey = jobKeyForUrl(link.href);
    const titleText = badge ? (link.innerText ?? "").replace(badge.textContent ?? "", "").trim() : link.innerText;
    jobMatches[jobKey] = {
      title: (link.title || titleText || "Naukri job").trim(),
      percentage,
      matchedCount,
      termCount: terms.length,
      matchedKeywords,
      searchedKeywords: terms,
    };
    if (!badge) {
      badge = document.createElement("span");
      badge.setAttribute(BADGE_ATTRIBUTE, "true");
    }
    const eligible = isEligibleMatch({ percentage, matchedCount });
    badge.style.cssText = eligible
      ? "display:inline-block;margin:4px 6px 4px 0;padding:3px 7px;border-radius:10px;background:#e5f6ed;color:#176b3a;font:600 11px/1.2 Arial,sans-serif;"
      : "display:inline-block;margin:4px 6px 4px 0;padding:3px 7px;border-radius:10px;background:#fff2df;color:#825100;font:600 11px/1.2 Arial,sans-serif;";
    const badgeLabel = `${eligible ? "Eligible to review · " : ""}${percentage}% keyword match (${matchedCount}/${terms.length})`;
    if (badge.textContent !== badgeLabel) badge.textContent = badgeLabel;
    badge.title = `${matchedCount} of ${terms.length} searched keywords appear in this job listing. Jobs qualify above ${ELIGIBILITY_THRESHOLD}% OR with at least ${MIN_MATCHED_KEYWORDS} matched keywords.`;
    if (!badge.isConnected) link.append(badge);
  }
  latestJobMatches = jobMatches;

  chrome.storage.local.get(["jobMatches"], ({ jobMatches: savedMatches = {} }) => {
    if (chrome.runtime.lastError) {
      console.error("Job match scores could not be loaded:", chrome.runtime.lastError);
      return;
    }
    const combinedMatches = { ...savedMatches, ...jobMatches };
    const entries = Object.entries(combinedMatches).slice(-MAX_TRACKED_JOBS);
    chrome.storage.local.set({ jobMatches: Object.fromEntries(entries) }, () => {
      if (chrome.runtime.lastError) {
        console.error("Job match scores could not be saved:", chrome.runtime.lastError);
      }
    });
  });

  chrome.storage.local.set({
    lastScanLog: {
      detectedCount: seenCards.size,
      scoredCount: Object.keys(jobMatches).length,
      pageUrl: window.location.href,
      keyword,
      scannedAt: new Date().toISOString(),
      jobs: Object.entries(jobMatches).map(([url, match]) => ({ url, ...match })),
    },
    jobScanStatus: {
      detectedCount: seenCards.size,
      scoredCount: Object.keys(jobMatches).length,
      pageUrl: window.location.href,
      keyword,
      scannedAt: new Date().toISOString(),
    },
  }, () => {
    if (chrome.runtime.lastError) {
      console.error("Job scan status could not be saved:", chrome.runtime.lastError);
    }
  });
}

function startBatchApplyReview() {
  if (batchScanStarted || new URL(window.location.href).searchParams.get(BATCH_APPLY_REQUEST_PARAMETER) !== "1") return;
  batchScanStarted = true;

  chrome.storage.local.get(["batchApplyRun", "appliedJobs", "applications"], ({ batchApplyRun, appliedJobs = {}, applications = {} }) => {
    if (chrome.runtime.lastError) {
      console.error("Application review request could not be loaded:", chrome.runtime.lastError);
      showTopApplyStatus("Could not load the application review. No job was opened.");
      return;
    }
    if (batchApplyRun?.status !== "scanning") return;

    const queue = Object.entries(latestJobMatches)
      .filter(([url]) => {
        const parsedUrl = new URL(url);
        return parsedUrl.origin === "https://www.naukri.com" && isJobPostUrl({ href: url });
      })
      .filter(([, match]) =>
        isEligibleMatch(match)
      )
      .filter(([url]) =>
        !appliedJobs[url] &&
        applications[url]?.status !== "applied"
      )
      .sort(([, first], [, second]) =>
        second.percentage - first.percentage || second.matchedCount - first.matchedCount,
      )
      .map(([url, match]) => ({
        url,
        title: match.title,
        percentage: match.percentage,
        matchedCount: match.matchedCount,
        termCount: match.termCount,
      }));

    if (!queue.length) {
      chrome.storage.local.set({
        batchApplyRun: {
          ...batchApplyRun,
          status: "no_eligible_jobs",
          queue: [],
          index: 0,
          completedAt: new Date().toISOString(),
        },
      });
      showTopApplyStatus(`No unapplied jobs matched either rule: above ${ELIGIBILITY_THRESHOLD}% or at least ${MIN_MATCHED_KEYWORDS} matched keywords.`);
      return;
    }

    const run = { ...batchApplyRun, status: "running", queue, index: 0 };
    const pendingApplications = { ...applications };
    for (const job of queue) {
      pendingApplications[job.url] = {
        ...job,
        runId: run.id,
        status: "pending",
        automatic: true,
      };
    }
    chrome.storage.local.set({ batchApplyRun: run, applications: pendingApplications }, () => {
      if (chrome.runtime.lastError) {
        console.error("Application review queue could not be saved:", chrome.runtime.lastError);
        showTopApplyStatus("Could not save the application review queue. No job was opened.");
        return;
      }
      showTopApplyStatus(`${queue.length} jobs qualify. Trying the highest match first; stopping after one confirmed application.`);
      window.location.assign(queue[0].url);
    });
  });
}

function processBatchQueue() {
  chrome.storage.local.get(["batchApplyRun", "applications", "appliedJobs"], ({ batchApplyRun, applications = {}, appliedJobs = {} }) => {
    if (chrome.runtime.lastError) {
      console.error("Application review queue could not be loaded:", chrome.runtime.lastError);
      showTopApplyStatus("Could not load the application review queue.");
      return;
    }
    if (batchApplyRun?.status !== "running") return;

    const successfulJob = batchApplyRun.queue.find((job) =>
      applications[job.url]?.status === "applied" || appliedJobs[job.url],
    );
    if (successfulJob) {
      applications[successfulJob.url] = {
        ...applications[successfulJob.url],
        ...successfulJob,
        runId: batchApplyRun.id,
        status: "applied",
        appliedAt: applications[successfulJob.url]?.appliedAt ?? appliedJobs[successfulJob.url]?.appliedAt,
      };
      for (const queuedJob of batchApplyRun.queue) {
        if (queuedJob.url !== successfulJob.url && applications[queuedJob.url]?.status === "pending") {
          applications[queuedJob.url] = {
            ...applications[queuedJob.url],
            status: "not_attempted",
            reason: "Not attempted because the run stopped after its first detected success.",
          };
        }
      }
      chrome.storage.local.set({
        applications,
        batchApplyRun: {
          ...batchApplyRun,
          status: "completed_applied",
          completedAt: new Date().toISOString(),
          appliedUrl: successfulJob.url,
        },
      }, () => {
        if (chrome.runtime.lastError) {
          console.error("Successful application status could not be saved:", chrome.runtime.lastError);
          showTopApplyStatus("An applied job was detected, but the run status could not be saved.");
        } else {
          showTopApplyStatus("An applied job was detected. Stopping after this one application.");
        }
      });
      return;
    }

    let index = batchApplyRun.index;
    const current = batchApplyRun.queue[index];
    if (current && !["applied", "skipped", "failed"].includes(applications[current.url]?.status)) return;
    if (current?.status === "applied" || appliedJobs[current?.url]) {
      applications[current.url] = {
        ...current,
        runId: batchApplyRun.id,
        status: "applied",
        appliedAt: applications[current.url]?.appliedAt ?? appliedJobs[current.url]?.appliedAt,
      };
    }
    if (current) index++;
    while (index < batchApplyRun.queue.length) {
      const candidate = batchApplyRun.queue[index];
      if (appliedJobs[candidate.url] || ["applied", "skipped", "failed"].includes(applications[candidate.url]?.status)) {
        if (appliedJobs[candidate.url]) {
          applications[candidate.url] = {
            ...candidate,
            runId: batchApplyRun.id,
            status: "applied",
            appliedAt: appliedJobs[candidate.url].appliedAt,
          };
        }
        index++;
      } else {
        break;
      }
    }

    const complete = index >= batchApplyRun.queue.length;
    const updatedRun = {
      ...batchApplyRun,
      index,
      status: complete ? "completed_no_application" : "running",
      ...(complete ? { completedAt: new Date().toISOString() } : {}),
    };
    chrome.storage.local.set({ batchApplyRun: updatedRun, applications }, () => {
      if (chrome.runtime.lastError) {
        console.error("Application review progress could not be saved:", chrome.runtime.lastError);
        showTopApplyStatus("Could not save application-review progress.");
        return;
      }
      if (complete) {
        showTopApplyStatus("No application was confirmed. All clear failures were tried; check the extension popup for details.");
      } else {
        const nextUrl = batchApplyRun.queue[index].url;
        if (new URL(nextUrl).origin !== "https://www.naukri.com" || !isJobPostUrl({ href: nextUrl })) {
          showTopApplyStatus("The next queue item is not a recognized Naukri job page. Review queue stopped.");
          chrome.storage.local.set({
            batchApplyRun: { ...updatedRun, status: "stopped_invalid_job_url" },
          });
          return;
        }
        showTopApplyStatus(`Trying eligible job ${index + 1} of ${batchApplyRun.queue.length}.`);
        window.location.assign(nextUrl);
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "naukri-assistant-scan-current-page") return false;
  if (sender.tab?.url && new URL(sender.tab.url).origin !== "https://www.naukri.com") {
    sendResponse({ error: "The active tab is not a Naukri page." });
    return false;
  }

  chrome.storage.local.get(["searchPreferences"], ({ searchPreferences }) => {
    if (chrome.runtime.lastError) {
      console.error("Search preferences could not be loaded for the popup scan:", chrome.runtime.lastError);
      sendResponse({ error: "Could not load your saved search keywords." });
      return;
    }
    if (!searchPreferences?.keyword) {
      sendResponse({ error: "Enter and search keywords from the extension before scanning job matches." });
      return;
    }

    annotateMatchingJobs(searchPreferences.keyword);
    sendResponse({
      scan: {
        detectedCount: Object.keys(latestJobMatches).length,
        pageUrl: window.location.href,
        scannedAt: new Date().toISOString(),
        keyword: searchPreferences.keyword,
        jobs: Object.entries(latestJobMatches).map(([url, match]) => ({ url, ...match })),
      },
    });
  });
  return true;
});

chrome.storage.local.get(["searchPreferences"], ({ searchPreferences }) => {
  if (isJobPostUrl({ href: window.location.href })) addPanel();
  if (!searchPreferences?.keyword) return;

  function handleTopApply() {
    if (isJobPostUrl({ href: window.location.href })) addPanel();
  }

  annotateMatchingJobs(searchPreferences.keyword);
  handleTopApply();
  processBatchQueue();
  batchScanTimer = window.setTimeout(startBatchApplyReview, 1800);

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const onJobPage = isJobPostUrl({ href: window.location.href });
      if (onJobPage) addPanel();
      annotateMatchingJobs(searchPreferences.keyword);
      handleTopApply();
      window.clearTimeout(batchScanTimer);
      batchScanTimer = window.setTimeout(startBatchApplyReview, 900);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 60_000);
});
