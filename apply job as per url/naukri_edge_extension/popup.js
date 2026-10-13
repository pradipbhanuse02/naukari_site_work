const URL_HEADERS = new Set(["joburl", "url", "joblink", "joblistingurl"]);
const state = { headers: [], jobs: [], run: null };
const fileInput = document.querySelector("#csv-file");
const startButton = document.querySelector("#start");
const nextButton = document.querySelector("#next");
const exportButton = document.querySelector("#export");
const stopButton = document.querySelector("#stop");
const statusNode = document.querySelector("#status");
const jobsNode = document.querySelector("#jobs");

function normalizeHeader(text) {
  return text.toLowerCase().replace(/[^a-z]/g, "");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("CSV must include a header and at least one job row.");

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  const urlIndex = headers.findIndex((header) => URL_HEADERS.has(normalizeHeader(header)));
  if (urlIndex < 0) throw new Error("Add a Job URL, URL, Job Link, or Job Listing URL column.");

  const jobs = rows.slice(1).map((cells, rowIndex) => {
    const job = {};
    headers.forEach((header, index) => {
      job[header] = cells[index] || "";
    });
    const url = (job[headers[urlIndex]] || "").trim();
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL on CSV row ${rowIndex + 2}: ${url}`);
    }
    if (!["naukri.com"].includes(parsed.hostname) && !parsed.hostname.endsWith(".naukri.com")) {
      throw new Error(`CSV row ${rowIndex + 2} is not a Naukri URL: ${url}`);
    }
    return { ...job, __urlHeader: headers[urlIndex], __url: url };
  }).filter(Boolean);

  if (!jobs.length) throw new Error("No Naukri job URLs found.");
  return { headers, jobs };
}

function serializeCsv(headers, jobs) {
  const escapeCell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    headers.map(escapeCell).join(","),
    ...jobs.map((job) => headers.map((header) => escapeCell(job[header])).join(",")),
  ].join("\r\n");
}

function questionColumns() {
  const pattern = /^Recruiter Question (\d+)$/;
  return state.headers.map((header) => {
    const match = pattern.exec(header);
    if (!match) return null;
    const number = match[1];
    return {
      number,
      question: header,
      options: `Recruiter Options ${number}`,
      answer: `Recruiter Answer ${number}`,
    };
  }).filter(Boolean);
}

function render() {
  jobsNode.replaceChildren();
  state.jobs.forEach((job, index) => {
    const card = document.createElement("article");
    card.className = "job";
    const title = document.createElement("div");
    title.className = "job-title";
    title.textContent = job["Job Title"] || `Job ${index + 1}`;
    const url = document.createElement("div");
    url.className = "job-url";
    url.textContent = job.__url;
    card.append(title, url);

    for (const columns of questionColumns()) {
      const question = (job[columns.question] || "").trim();
      if (!question) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "answer";
      const label = document.createElement("label");
      label.textContent = `Q${columns.number}: ${question}`;
      label.htmlFor = `answer-${index}-${columns.number}`;
      const input = document.createElement("input");
      input.id = label.htmlFor;
      input.value = job[columns.answer] || "";
      input.placeholder = "Enter your answer exactly as shown in choices";
      input.addEventListener("change", async () => {
        job[columns.answer] = input.value.trim();
        await persist();
      });
      const options = document.createElement("small");
      options.textContent = `Choices: ${job[columns.options] || "not recorded"}`;
      wrapper.append(label, input, options);
      card.append(wrapper);
    }
    jobsNode.append(card);
  });

  const canResume = state.run && ["awaiting_answer", "complete", "stopped", "error"].includes(state.run.phase);
  startButton.disabled = state.jobs.length === 0 || (state.run && !canResume);
  startButton.textContent = state.run?.phase === "awaiting_answer"
    ? "Use saved answers"
    : "Start / Resume";
  exportButton.disabled = state.jobs.length === 0;
  stopButton.disabled = !state.run || state.run.phase === "complete";
  nextButton.disabled = !state.run || state.run.phase !== "awaiting_next";
  if (state.run) {
    statusNode.textContent = state.run.status || `Run status: ${state.run.phase}`;
  } else if (state.jobs.length) {
    statusNode.textContent = `Loaded ${state.jobs.length} job(s).`;
  }
}

async function persist() {
  await chrome.storage.local.set({ csvHeaders: state.headers, csvJobs: state.jobs });
}

async function loadState() {
  const stored = await chrome.storage.local.get(["csvHeaders", "csvJobs", "runState"]);
  state.headers = stored.csvHeaders || [];
  state.jobs = stored.csvJobs || [];
  state.run = stored.runState || null;
  render();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  try {
    const parsed = parseCsv(await file.text());
    state.headers = parsed.headers;
    state.jobs = parsed.jobs;
    state.run = null;
    await chrome.storage.local.set({
      csvHeaders: state.headers,
      csvJobs: state.jobs,
      runState: null,
    });
    statusNode.textContent = `Imported ${state.jobs.length} job(s) from ${file.name}.`;
    render();
  } catch (error) {
    statusNode.textContent = error.message;
  }
});

startButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "START_RUN" });
  statusNode.textContent = result?.error || result?.status || "Starting...";
  await loadState();
});

nextButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "NEXT_JOB" });
  statusNode.textContent = result?.status || result?.error || "Continuing...";
  await loadState();
});

stopButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "STOP_RUN" });
  statusNode.textContent = result?.status || "Stopped.";
  await loadState();
});

exportButton.addEventListener("click", () => {
  const blob = new Blob([serializeCsv(state.headers, state.jobs)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "naukri_jobs_updated.csv";
  anchor.click();
  URL.revokeObjectURL(url);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.csvHeaders) state.headers = changes.csvHeaders.newValue || [];
  if (changes.csvJobs) state.jobs = changes.csvJobs.newValue || [];
  if (changes.runState) state.run = changes.runState.newValue || null;
  render();
});

loadState().catch((error) => {
  statusNode.textContent = `Could not load extension data: ${error.message}`;
});
