(() => {
  if (window.__naukriCsvAssistantLoaded) return;
  window.__naukriCsvAssistantLoaded = true;

  const APPLY_RE = /^\s*apply(?:\s+now)?\s*$/i;
  const SAVE_RE = /^\s*save\s*$/i;
  const SIGNED_IN_RE = /^(my naukri|my profile|view profile|edit profile|candidate profile|log out|logout|sign out)$/i;
  const APPLIED_RE = /\b(you have already applied|already applied|application submitted|successfully applied)\b/i;
  const selectedQuestions = new Map();
  let loginBanner = null;
  let loginPoll = null;

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isSignedIn() {
    const lines = (document.body?.innerText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.some((line) => SIGNED_IN_RE.test(line))) return true;
    return [...document.querySelectorAll("a, button, [role='button']")].some((element) => {
      const label = [
        element.innerText,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
      ].filter(Boolean).join(" ");
      return SIGNED_IN_RE.test(label.trim());
    });
  }

  function showLoginBanner() {
    if (loginBanner?.isConnected) return;
    loginBanner = document.createElement("aside");
    loginBanner.style.cssText = [
      "position:fixed", "z-index:2147483647", "top:12px", "right:12px",
      "width:340px", "padding:14px", "background:#fff", "color:#202124",
      "border:1px solid #dadce0", "border-radius:8px",
      "box-shadow:0 4px 18px #0003", "font:14px/1.4 Arial,sans-serif",
    ].join(";");
    const text = document.createElement("div");
    text.textContent = "Sign in to Naukri in this Edge tab. The extension is checking your profile and will continue automatically when signed in.";
    const continueButton = document.createElement("button");
    continueButton.textContent = "Profile is ready - continue";
    continueButton.style.cssText = "margin:12px 8px 0 0;padding:7px 10px;cursor:pointer";
    continueButton.addEventListener("click", () => finishLogin(true));
    const cancelButton = document.createElement("button");
    cancelButton.textContent = "Cancel";
    cancelButton.style.cssText = "margin-top:12px;padding:7px 10px;cursor:pointer";
    cancelButton.addEventListener("click", () => {
      clearInterval(loginPoll);
      loginBanner.remove();
      loginBanner = null;
      chrome.runtime.sendMessage({ type: "STOP_RUN" });
    });
    loginBanner.append(text, continueButton, cancelButton);
    document.documentElement.append(loginBanner);
  }

  function finishLogin(manual) {
    clearInterval(loginPoll);
    loginBanner?.remove();
    loginBanner = null;
    chrome.runtime.sendMessage({ type: "LOGIN_CONFIRMED", manual });
  }

  function beginLoginCheck() {
    if (isSignedIn()) {
      finishLogin(false);
      return;
    }
    showLoginBanner();
    loginPoll = setInterval(() => {
      if (isSignedIn()) finishLogin(false);
    }, 1500);
  }

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
  }

  function getQuestionGroups() {
    const radios = [...document.querySelectorAll('input[type="radio"], [role="radio"]')]
      .filter(visible);
    const groups = new Map();
    for (const radio of radios) {
      const labels = radio.labels ? [...radio.labels] : [];
      const wrappingLabel = radio.closest("label");
      const associatedLabel = labels[0] || wrappingLabel;
      const option = (labels.map((label) => label.innerText.trim()).filter(Boolean).join(" ") ||
        radio.getAttribute("aria-label") || radio.value || "").trim();
      let node = wrappingLabel || radio.parentElement;
      let question = "";
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        const lines = (node.innerText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        question = lines.find((line) => line.includes("?") && line.length <= 500) || "";
        if (question) break;
      }
      if (!question || !option) continue;
      const key = normalize(question);
      if (!groups.has(key)) {
        groups.set(key, { question, options: [], controls: [], checkedOption: "" });
      }
      const group = groups.get(key);
      if (!group.options.includes(option)) group.options.push(option);
      group.controls.push({ radio, label: associatedLabel, option });
      if (radio.checked || radio.getAttribute("aria-checked") === "true") {
        group.checkedOption = option;
      }
    }
    return [...groups.values()];
  }

  function questionAnswer(job, question) {
    const pattern = /^Recruiter Question (\d+)$/;
    for (const [header, value] of Object.entries(job)) {
      const match = pattern.exec(header);
      if (!match || normalize(value) !== normalize(question)) continue;
      const number = match[1];
      return String(job[`Recruiter Answer ${number}`] || "").trim();
    }
    return "";
  }

  function saveButton() {
    return [...document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")]
      .find((element) => {
        if (!visible(element) || element.disabled) return false;
        const label = element.innerText?.trim() ||
          element.getAttribute("aria-label")?.trim() ||
          element.getAttribute("title")?.trim() ||
          element.value?.trim() || "";
        return SAVE_RE.test(label);
      });
  }

  function addReviewBanner(text) {
    const banner = document.createElement("div");
    banner.style.cssText = "position:fixed;z-index:2147483647;bottom:12px;right:12px;max-width:420px;padding:12px;background:#fff;border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 18px #0003;font:14px/1.4 Arial,sans-serif;color:#202124";
    banner.textContent = text;
    document.documentElement.append(banner);
  }

  async function findApplyButton(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const apply = [...document.querySelectorAll(
        "button, a, [role='button'], [onclick], [class*='apply' i], input[type='button'], input[type='submit']",
      )].find((element) => {
        if (!visible(element) || element.disabled) return false;
        const labels = [
          element.innerText,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.value,
        ];
        return labels.some((label) => APPLY_RE.test(label?.trim() || ""));
      });
      if (apply) return apply;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  async function processQuestions(job) {
    let groups = [];
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      groups = getQuestionGroups();
      if (groups.length) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!groups.length) {
      addReviewBanner("Apply was clicked. Review the application and continue manually. Use the extension popup to move to the next job.");
      chrome.runtime.sendMessage({
        type: "JOB_REVIEW",
        status: "No recruiter radio question detected. Review/complete the form in Edge, then choose Next job.",
      });
      return;
    }

    while (groups.length) {
      const group = groups.find((candidate) =>
        !selectedQuestions.has(normalize(candidate.question)) ||
        normalize(selectedQuestions.get(normalize(candidate.question))) !== normalize(candidate.checkedOption),
      );
      if (!group) break;

      const answer = questionAnswer(job, group.question);
      if (!answer) {
        chrome.runtime.sendMessage({
          type: "QUESTION_FOUND",
          question: group.question,
          options: group.options,
        });
        addReviewBanner(`Recruiter question saved to the extension. Open its popup, enter an answer, then choose Start / Resume. Question: ${group.question}`);
        return;
      }

      const selected = group.controls.find((control) => normalize(control.option) === normalize(answer));
      if (!selected) {
        chrome.runtime.sendMessage({
          type: "QUESTION_FOUND",
          question: group.question,
          options: group.options,
        });
        addReviewBanner(`Saved answer "${answer}" does not match the page choices. Update the answer in the extension popup.`);
        return;
      }

      try {
        if (selected.label && visible(selected.label)) {
          clickElement(selected.label);
        } else if (selected.radio.getAttribute("role") === "radio") {
          clickElement(selected.radio);
        } else {
          selected.radio.scrollIntoView({ block: "center" });
          selected.radio.click({ force: true });
        }
      } catch (error) {
        chrome.runtime.sendMessage({ type: "JOB_ERROR", error: `Could not select "${answer}": ${error.message}` });
        return;
      }
      if (!selected.radio.checked && selected.radio.getAttribute("aria-checked") !== "true") {
        chrome.runtime.sendMessage({ type: "JOB_ERROR", error: `The page did not confirm that "${answer}" was selected.` });
        return;
      }
      selectedQuestions.set(normalize(group.question), selected.option);

      const save = saveButton();
      if (save) {
        clickElement(save);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      groups = getQuestionGroups();
    }

    addReviewBanner("Saved recruiter answer selected. Review the page and complete any remaining form steps yourself. Use the extension popup to move to the next job.");
    chrome.runtime.sendMessage({
      type: "JOB_REVIEW",
      status: "Saved recruiter answers were selected. Complete remaining form steps in Edge, then choose Next job.",
    });
  }

  async function processJob(job) {
    if (APPLIED_RE.test(document.body?.innerText || "")) {
      chrome.runtime.sendMessage({
        type: "JOB_REVIEW",
        status: "This listing appears to be already applied for. Review it and choose Next job.",
      });
      return;
    }
    const apply = await findApplyButton();
    if (!apply) {
      chrome.runtime.sendMessage({
        type: "JOB_REVIEW",
        status: "No exact Apply or Apply Now button appeared within 20 seconds. Review this listing and choose Next job.",
      });
      return;
    }
    const started = await chrome.runtime.sendMessage({ type: "APPLY_STARTED" });
    if (started?.error) throw new Error(started.error);
    try {
      clickElement(apply);
    } catch (error) {
      chrome.runtime.sendMessage({
        type: "JOB_ERROR",
        error: `Found the Apply button but could not click it: ${error.message}`,
      });
      return;
    }
    addReviewBanner("Clicked the standard Apply button. Review any follow-up form in Edge.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await processQuestions(job);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "CHECK_LOGIN") beginLoginCheck();
    if (message.type === "PROCESS_JOB") {
      processJob(message.job).catch((error) => {
        chrome.runtime.sendMessage({ type: "JOB_ERROR", error: error.message });
      });
    }
    if (message.type === "PROCESS_APPLICATION") {
      processQuestions(message.job).catch((error) => {
        chrome.runtime.sendMessage({ type: "JOB_ERROR", error: error.message });
      });
    }
    if (message.type === "RESUME_QUESTIONS") {
      processQuestions(message.job).catch((error) => {
        chrome.runtime.sendMessage({ type: "JOB_ERROR", error: error.message });
      });
    }
    sendResponse({ ok: true });
    return false;
  });

  chrome.runtime.sendMessage({ type: "CONTENT_READY" });
})();
