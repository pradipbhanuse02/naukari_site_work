const HOME_URL = "https://www.naukri.com/mnjuser/homepage";

async function readStoredState() {
  return chrome.storage.local.get(["csvHeaders", "csvJobs", "runState"]);
}

async function writeRun(run) {
  await chrome.storage.local.set({ runState: run });
}

async function sendToRunTab(message) {
  const { runState } = await readStoredState();
  const targetTabId = runState?.applicationTabId ?? runState?.tabId;
  if (targetTabId == null) throw new Error("The Naukri tab is not available.");
  await chrome.tabs.sendMessage(targetTabId, message);
}

async function openCurrentJob(run) {
  const { csvJobs } = await readStoredState();
  const job = csvJobs?.[run.index];
  if (!job) {
    run.phase = "complete";
    run.status = "All CSV jobs have been reviewed.";
    await writeRun(run);
    return;
  }
  run.phase = "processing";
  run.sourceTabId = run.tabId;
  run.applicationTabId = run.tabId;
  run.status = `Opening job ${run.index + 1} of ${csvJobs.length}: ${job["Job Title"] || job.__url}`;
  await writeRun(run);
  await chrome.tabs.update(run.tabId, { url: job.__url, active: true });
}

async function startRun() {
  const { csvJobs } = await readStoredState();
  if (!csvJobs?.length) return { error: "Import a CSV with Naukri job URLs first." };

  const tab = await chrome.tabs.create({ url: HOME_URL, active: true });
  const run = {
    tabId: tab.id,
    index: 0,
    phase: "login",
    status: "Opened Naukri in your current Edge profile; waiting for sign-in.",
  };
  await writeRun(run);
  return { status: run.status };
}

async function handleReady(tabId) {
  const { runState, csvJobs } = await readStoredState();
  if (!runState) return;
  if (
    ["login", "login_checking"].includes(runState.phase) &&
    runState.tabId === tabId
  ) {
    await chrome.tabs.sendMessage(tabId, { type: "CHECK_LOGIN" });
  } else if (
    runState.phase === "processing" &&
    runState.tabId === tabId
  ) {
    const job = csvJobs?.[runState.index];
    if (!job) {
      runState.phase = "complete";
      runState.status = "All CSV jobs have been reviewed.";
      await writeRun(runState);
      return;
    }
    runState.phase = "processing_dispatched";
    await writeRun(runState);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "PROCESS_JOB",
        job,
        index: runState.index,
        total: csvJobs.length,
      });
    } catch (error) {
      runState.phase = "processing";
      await writeRun(runState);
      throw error;
    }
    runState.phase = "processing_dispatched";
    await writeRun(runState);
  } else if (
    runState.phase === "applying" &&
    runState.applicationTabId === tabId
  ) {
    await dispatchApplicationTab(runState, csvJobs);
  }
}

async function dispatchApplicationTab(run, csvJobs) {
  const job = csvJobs?.[run.index];
  if (!job) return;
  await chrome.tabs.sendMessage(run.applicationTabId, {
    type: "PROCESS_APPLICATION",
    job,
  });
  run.phase = "processing_questions";
  run.status = "Checking the application panel for recruiter questions.";
  await writeRun(run);
}

async function claimApplicationTab(tab) {
  if (tab.openerTabId == null) return;
  let host = "";
  try {
    host = new URL(tab.url || "").hostname.toLowerCase();
  } catch {
    return;
  }
  if (host !== "naukri.com" && !host.endsWith(".naukri.com")) return;

  const { runState } = await readStoredState();
  if (
    !runState ||
    runState.phase !== "applying" ||
    tab.openerTabId !== runState.sourceTabId
  ) return;
  runState.applicationTabId = tab.id;
  runState.status = "Apply opened another Naukri tab; routing recruiter answers there.";
  await writeRun(runState);
}

function belongsToRun(run, tabId) {
  return run && (
    tabId === run.tabId ||
    tabId === run.sourceTabId ||
    tabId === run.applicationTabId
  );
}

async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;
  const { runState, csvHeaders = [], csvJobs = [] } = await readStoredState();

  if (message.type === "START_RUN") {
    if (runState?.phase === "awaiting_answer") {
      runState.phase = "processing_questions";
      runState.status = "Applying saved recruiter answers.";
      await writeRun(runState);
      await sendToRunTab({
        type: "RESUME_QUESTIONS",
        job: csvJobs[runState.index],
      });
      return { status: runState.status };
    }
    return startRun();
  }

  if (message.type === "NEXT_JOB") {
    if (!runState || runState.phase !== "awaiting_next") {
      return { error: "There is no reviewed job waiting to advance." };
    }
    runState.index += 1;
    await openCurrentJob(runState);
    return { status: runState.status };
  }

  if (message.type === "STOP_RUN") {
    if (runState) {
      runState.phase = "stopped";
      runState.status = "Run stopped. The Edge tab remains open.";
      await writeRun(runState);
    }
    return { status: runState?.status || "No active run." };
  }

  if (!runState) return {};

  if (message.type === "CONTENT_READY") {
    if (runState.tabId === tabId) {
      await handleReady(tabId);
    } else if (
      runState.phase === "applying" &&
      runState.applicationTabId === tabId
    ) {
      await dispatchApplicationTab(runState, csvJobs);
    }
    return {};
  }

  if (message.type === "LOGIN_CONFIRMED") {
    if (runState.tabId !== tabId) return {};
    runState.phase = "processing";
    runState.status = message.manual
      ? "Continuing after manual profile confirmation."
      : "Naukri sign-in detected.";
    await writeRun(runState);
    await openCurrentJob(runState);
    return {};
  }

  if (message.type === "APPLY_STARTED") {
    if (runState.tabId !== tabId) return {};
    runState.sourceTabId = tabId;
    runState.applicationTabId = tabId;
    runState.phase = "applying";
    runState.status = "Apply clicked; waiting for the application form.";
    await writeRun(runState);
    return {};
  }

  if (!belongsToRun(runState, tabId)) return {};

  if (message.type === "QUESTION_FOUND") {
    const job = csvJobs[runState.index];
    if (!job) return {};
    const existing = csvHeaders.find((header) => {
      const match = /^Recruiter Question (\d+)$/.exec(header);
      return match && job[header]?.trim().toLowerCase() === message.question.trim().toLowerCase();
    });
    let number = existing
      ? /^Recruiter Question (\d+)$/.exec(existing)[1]
      : null;
    if (!number) {
      const used = csvHeaders
        .map((header) => /^Recruiter Question (\d+)$/.exec(header))
        .filter(Boolean)
        .map((match) => Number(match[1]));
      number = String(Math.max(0, ...used) + 1);
      csvHeaders.push(
        `Recruiter Question ${number}`,
        `Recruiter Options ${number}`,
        `Recruiter Answer ${number}`,
      );
    }
    job[`Recruiter Question ${number}`] = message.question;
    job[`Recruiter Options ${number}`] = message.options.join(" | ");
    if (!(job[`Recruiter Answer ${number}`] || "").trim()) {
      job[`Recruiter Answer ${number}`] = "";
    }
    runState.phase = "awaiting_answer";
    runState.status = `Question saved for job ${runState.index + 1}. Fill in its answer below, then choose Start / Resume.`;
    await chrome.storage.local.set({ csvHeaders, csvJobs, runState });
    return {};
  }

  if (message.type === "JOB_REVIEW") {
    if (
      runState.applicationTabId !== runState.sourceTabId &&
      tabId === runState.sourceTabId
    ) {
      return {};
    }
    runState.applicationTabId = tabId;
    runState.phase = "awaiting_next";
    runState.status = message.status || "Review the job/application in Edge, then choose Next job.";
    await writeRun(runState);
    return {};
  }

  if (message.type === "JOB_ERROR") {
    runState.phase = "error";
    runState.status = message.error || "The extension encountered an error.";
    await writeRun(runState);
  }
  return {};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    chrome.tabs.get(tabId)
      .then((tab) => claimApplicationTab(tab))
      .catch((error) => reportTabError(tabId, error));
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  claimApplicationTab(tab).catch((error) => reportTabError(tab.id, error));
});

async function reportTabError(tabId, error) {
  const { runState } = await readStoredState();
  if (!belongsToRun(runState, tabId)) return;
  runState.phase = "error";
  runState.status = `Extension could not control this Naukri tab: ${error.message}`;
  await writeRun(runState);
}
