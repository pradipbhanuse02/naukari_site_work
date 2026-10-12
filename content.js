const JOB_LINK_SELECTOR = 'a[href*="job-listings-"]';
const CARD_SELECTOR = 'article, [class*="jobTuple"], [class*="jobtuple"], [class*="srp-jobtuple"], [class*="cust-job-tuple"]';
const BADGE_CLASS = "naukri-keyword-match-badge";
const SUMMARY_ID = "naukri-keyword-match-summary";

function textFrom(card, selectors) {
  for (const selector of selectors) {
    const element = card.querySelector(selector);
    const text = element?.textContent?.trim();
    if (text) return text;
  }
  return "";
}

function getKeywordsFromUrl() {
  return NaukriKeywordMatcher.parse(new URL(window.location.href).searchParams.get("k"));
}

function collectJobCards() {
  const seen = new Set();
  const jobs = [];

  for (const link of document.querySelectorAll(JOB_LINK_SELECTOR)) {
    const title = link.textContent.trim();
    if (!title || !link.href || seen.has(link.href)) continue;

    const card = link.closest(CARD_SELECTOR) ?? link.parentElement?.parentElement;
    if (!card) continue;

    seen.add(link.href);
    jobs.push({
      title,
      company: textFrom(card, ['[class*="comp-name"]', '[class*="companyName"]', '[class*="company-name"]']),
      location: textFrom(card, ['[class*="locWdth"]', '[class*="location"]']),
      experience: textFrom(card, ['[class*="expwdth"]', '[class*="experience"]']),
      salary: textFrom(card, ['[class*="sal-wrap"]', '[class*="salary"]']),
      skills: Array.from(card.querySelectorAll('[class*="tag-li"], [class*="tags-gt"], [class*="skill"]'))
        .map((element) => element.textContent.trim())
        .filter(Boolean)
        .join("; "),
      description: textFrom(card, ['[class*="job-desc"]', '[class*="jobDescription"]', '[class*="job-description"]']),
      posted: textFrom(card, ['[class*="job-post-day"]', '[class*="posted"]']),
      jobUrl: link.href,
      card
    });
  }

  return jobs;
}

function updatePageAnnotations(keywords, jobs) {
  const matchedCount = jobs.filter((job) => job.qualifies).length;
  let summary = document.getElementById(SUMMARY_ID);
  if (!summary) {
    summary = document.createElement("div");
    summary.id = SUMMARY_ID;
    document.body.append(summary);
  }
  summary.textContent = `Extension scan: ${matchedCount} selected jobs (highest match or 3+ matched skills; ${jobs.length} scanned).`;

  for (const job of jobs) {
    let badge = job.card.querySelector(`.${BADGE_CLASS}`);
    if (!badge) {
      badge = document.createElement("div");
      badge.className = BADGE_CLASS;
      job.card.append(badge);
    }
    badge.textContent = `Skill match: ${job.percentage}% (${job.matchedSkills}/${job.totalSkills}) · Rank #${job.matchRank}`;
    badge.dataset.qualifies = String(job.qualifies);
    badge.dataset.reason = job.qualificationReason;
  }
}

function scan(keywords = getKeywordsFromUrl()) {
  const uniqueKeywords = [...new Set(keywords)];
  if (uniqueKeywords.length === 0) {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
    document.getElementById(SUMMARY_ID)?.remove();
    return [];
  }

  const jobs = NaukriKeywordMatcher.rankAndSelect(collectJobCards(), uniqueKeywords);
  updatePageAnnotations(uniqueKeywords, jobs);
  return jobs.map(({ card: _card, ...job }) => job);
}

function isVisible(element) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

function hasCaptcha(root = document) {
  return [...root.querySelectorAll('iframe, input, [class*="captcha" i], [id*="captcha" i]')]
    .some((element) => isVisible(element)
      && /captcha|recaptcha|hcaptcha/i.test([
        element.id,
        element.className,
        element.getAttribute("src"),
        element.getAttribute("name")
      ].join(" ")));
}

function hasApplicationSuccess() {
  const text = document.body.innerText;
  return /application (?:has been )?(?:successfully )?(?:submitted|sent)|successfully applied|you have applied|applied successfully/i
    .test(text);
}

function getFieldPrompt(field) {
  const labelledBy = (field.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.innerText.trim())
    .filter(Boolean);
  const labels = [
    ...Array.from(field.labels ?? []).map((label) => label.innerText.trim()),
    field.getAttribute("aria-label")?.trim(),
    ...labelledBy,
    field.closest("label")?.innerText.trim(),
    field.closest("fieldset")?.querySelector("legend")?.innerText.trim(),
    field.getAttribute("placeholder")?.trim()
  ].filter(Boolean);
  const prompt = labels.find(Boolean);
  if (prompt) return prompt.replace(/\s+/g, " ");

  const fallback = field.getAttribute("name") || field.id || field.type || field.tagName.toLocaleLowerCase();
  return fallback.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
}

function getVisibleFormFields(root) {
  return [...root.querySelectorAll("input, textarea, select, [contenteditable='true']")]
    .filter((field) => isVisible(field) && !field.disabled && field.type !== "hidden");
}

function getApplyChatContext() {
  const messageInput = [...document.querySelectorAll(
    'input[placeholder*="message" i], textarea[placeholder*="message" i], [contenteditable="true"][aria-label*="message" i]'
  )].find(isVisible);
  if (!messageInput) return { panel: null, prompts: [] };

  let panel = messageInput.parentElement;
  for (let depth = 0; panel && depth < 8; depth += 1, panel = panel.parentElement) {
    if (/(chat|conversation|apply|message|drawer|panel|modal)/i.test(
      `${panel.id} ${typeof panel.className === "string" ? panel.className : ""}`
    )) {
      break;
    }
  }
  panel ??= messageInput.parentElement;
  if (!panel) return { panel: null, prompts: [] };

  const ignored = /^(?:type message here|send|apply|close|cancel|back)$/i;
  const prompts = [];
  for (const element of panel.querySelectorAll("*")) {
    if (!isVisible(element) || element.children.length > 0) continue;
    const text = element.innerText?.trim().replace(/\s+/g, " ");
    if (!text || text.length > 240 || ignored.test(text)) continue;
    if (/^(hi\b|hello\b|dear\b|thank you for showing interest|kindly answer all)/i.test(text)) continue;
    if (element.matches("input, textarea, button, a, select, option")) continue;
    if (!prompts.includes(text)) prompts.push(text);
  }
  return { panel, prompts };
}

function isFieldAnswered(field) {
  if (field.type === "checkbox" || field.type === "radio") {
    if (field.type === "radio" && field.name) {
      return [...(field.form ?? document).querySelectorAll('input[type="radio"]')]
        .some((choice) => choice.name === field.name && choice.checked);
    }
    return field.checked;
  }
  return String(field.value ?? field.innerText ?? "").trim().length > 0;
}

function findExternalApplicationLink() {
  return [...document.querySelectorAll("a[href]")]
    .filter((link) => isVisible(link)
      && /^https?:$/.test(new URL(link.href).protocol)
      && new URL(link.href).hostname !== "www.naukri.com")
    .find((link) => /apply|career|employer|company website|company site/i.test(link.innerText.trim()));
}

function waitForApplicationResult(timeoutMs = 12000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (hasApplicationSuccess()) {
        resolve("Applied");
      } else if (Date.now() - startedAt >= timeoutMs) {
        resolve("Unconfirmed");
      } else {
        window.setTimeout(check, 400);
      }
    };
    check();
  });
}

async function waitForApplySurface(timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const dialog = [...document.querySelectorAll('dialog[open], [role="dialog"], [class*="modal" i]')]
      .find(isVisible);
    const chatContext = getApplyChatContext();
    if (dialog || chatContext.prompts.length) return { dialog, chatContext };
    if (hasApplicationSuccess()) return { dialog: null, chatContext, applied: true };
    await new Promise((resolve) => window.setTimeout(resolve, 300));
  }
  const dialog = [...document.querySelectorAll('dialog[open], [role="dialog"], [class*="modal" i]')]
    .find(isVisible);
  return { dialog, chatContext: getApplyChatContext(), applied: hasApplicationSuccess() };
}

async function attemptQuickApply(jobTitle) {
  if (hasCaptcha()) {
    return {
      status: "Skipped",
      reason: "Not applied: a CAPTCHA is present, so manual completion is required.",
      questions: []
    };
  }
  if (/job (?:is )?(?:no longer available|expired|closed)|position has been filled|this job is inactive/i
    .test(document.body.innerText)) {
    return {
      status: "Skipped",
      reason: "Not applied: Naukri indicates this job is closed, expired, inactive, or no longer available.",
      questions: [],
      destination: ""
    };
  }

  const normalizeTitle = (value) => String(value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  const expectedTitle = normalizeTitle(jobTitle);
  const heading = [...document.querySelectorAll("h1")]
    .find((element) => isVisible(element) && normalizeTitle(element.innerText));
  const pageTitle = normalizeTitle(heading?.innerText ?? "");
  if (!expectedTitle || !pageTitle
    || !(pageTitle === expectedTitle
      || (pageTitle.startsWith(expectedTitle) && expectedTitle.length / pageTitle.length >= 0.75)
      || (expectedTitle.startsWith(pageTitle) && pageTitle.length / expectedTitle.length >= 0.75))) {
    return {
      status: "Skipped",
      reason: `Not applied: could not verify the page title. Expected "${jobTitle}", found "${heading?.innerText.trim() || "no visible job title"}". No application was attempted.`,
      questions: []
    };
  }

  const actions = [...document.querySelectorAll("button, a, [role='button']")]
    .filter((element) => isVisible(element) && !element.disabled);
  const actionText = (element) => element.innerText.trim().replace(/\s+/g, " ");
  if (actions.some((element) => /^already applied$/i.test(actionText(element)))) {
    return {
      status: "Skipped",
      reason: "Not applied: Naukri indicates this job has already been applied to.",
      questions: []
    };
  }
  const headingRect = heading.getBoundingClientRect();
  const quickApply = actions
    .filter((element) => /^(?:quick\s*apply|apply)$/i.test(actionText(element)))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        element,
        distance: Math.hypot(
          rect.x + rect.width / 2 - (headingRect.x + headingRect.width / 2),
          rect.y + rect.height / 2 - (headingRect.y + headingRect.height / 2)
        )
      };
    })
    .sort((left, right) => left.distance - right.distance)[0];
  if (!quickApply || quickApply.distance > 900) {
    const externalLink = findExternalApplicationLink();
    const destination = externalLink?.href ?? "";
    return {
      status: "Skipped",
      reason: destination
        ? `Not applied: this listing has no Naukri Quick Apply button. Apply on the external employer site: ${destination}`
        : "Not applied: no Naukri Quick Apply button or visible external application link was found. The employer may require manual application, or this listing may be closed/unsupported.",
      destination,
      questions: []
    };
  }

  quickApply.element.click();
  const applySurface = await waitForApplySurface();
  if (applySurface.applied) {
    return { status: "Applied", reason: "Naukri confirmed the application was submitted." };
  }

  const { dialog, chatContext } = applySurface;
  const applyChatPrompts = chatContext.prompts;
  if (dialog || applyChatPrompts.length) {
    const formRoot = dialog ?? chatContext.panel;
    if (hasCaptcha(formRoot)) {
      return {
        status: "Skipped",
        reason: "Not applied: the Quick Apply form requires CAPTCHA completion.",
        questions: []
      };
    }
    if (formRoot.querySelector('input[type="file"]')) {
      return {
        status: "Skipped",
        reason: "Not applied: the Quick Apply form requires a file upload that needs manual selection.",
        questions: []
      };
    }
    const fields = getVisibleFormFields(formRoot)
      .filter((field) => !/message/i.test(field.getAttribute("placeholder") ?? ""));
    const questions = [...new Set([
      ...fields.map(getFieldPrompt).filter(Boolean),
      ...applyChatPrompts
    ])];
    const unanswered = fields.filter((field) =>
      (field.required || field.getAttribute("aria-required") === "true")
      && !isFieldAnswered(field)
    );
    const questionFields = fields.filter((field) =>
      field.tagName === "TEXTAREA"
      || /\?$/.test(getFieldPrompt(field))
      || /why|describe|explain|tell us|cover letter|motivat/i.test(getFieldPrompt(field))
    );
    const needsManualAnswers = unanswered.length > 0 || questionFields.length > 0 || applyChatPrompts.length > 0;
    if (needsManualAnswers) {
      const unansweredPrompts = unanswered.map(getFieldPrompt);
      const manualPrompts = applyChatPrompts.length
        ? applyChatPrompts
        : questionFields.map(getFieldPrompt);
      return {
        status: "Skipped",
        reason: unansweredPrompts.length
          ? `Not applied: required application responses need your input: ${unansweredPrompts.join("; ")}.`
          : `Not applied: the form asks for manual answers: ${manualPrompts.join("; ")}.`,
        questions,
        destination: ""
      };
    }
    const submit = [...formRoot.querySelectorAll("button, [role='button']")]
      .filter((element) => isVisible(element) && !element.disabled)
      .find((element) => /^(apply|submit|submit application)$/i.test(actionText(element)));
    if (submit) {
      submit.click();
      const status = await waitForApplicationResult();
      return status === "Applied"
        ? { status, reason: "Naukri confirmed the application was submitted.", questions, destination: "" }
        : {
          status,
          reason: "Not applied: the form was submitted but Naukri did not confirm the result; stopped to avoid a duplicate application.",
          questions,
          destination: ""
        };
    }
    return {
      status: "Skipped",
      reason: `Not applied: a Quick Apply dialog opened, but no supported submit action was found. Visible form fields: ${questions.join("; ") || "none"}.`,
      questions,
      destination: ""
    };
  }

  const status = await waitForApplicationResult();
  return status === "Applied"
    ? { status, reason: "Naukri confirmed the application was submitted.", questions: [], destination: "" }
    : {
      status,
      reason: applyChatPrompts.length
        ? `Not applied: Naukri requested an answer in its Apply chat. Prompts found: ${applyChatPrompts.join("; ")}. Manual answers are required.`
        : "Not applied: Quick Apply was clicked, but no confirmation or application form appeared. The result is uncertain; stopped to avoid a duplicate.",
      questions: applyChatPrompts,
      destination: ""
    };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "collect-naukri-jobs") {
    const keywords = Array.isArray(message.keywords)
      ? NaukriKeywordMatcher.parse(message.keywords.join(","))
      : getKeywordsFromUrl();
    sendResponse({ jobs: scan(keywords) });
  } else if (message.type === "attempt-naukri-quick-apply") {
    attemptQuickApply(message.jobTitle).then(
      (result) => sendResponse(result),
      (error) => sendResponse({
        status: "Failed",
        reason: `Not applied: Quick Apply inspection failed (${error?.message || String(error)}).`,
        questions: [],
        destination: ""
      })
    );
    return true;
  }
});

let scanTimer;
let lastSearch = window.location.search;
const observer = new MutationObserver((mutations) => {
  if (window.location.search !== lastSearch) {
    lastSearch = window.location.search;
    scanTimer = window.clearTimeout(scanTimer);
  } else if (mutations.every((mutation) => {
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return mutation.target.closest?.(`#${SUMMARY_ID}, .${BADGE_CLASS}`)
      || (changedNodes.length > 0 && changedNodes.every((node) =>
        node.nodeType === Node.ELEMENT_NODE
        && (node.id === SUMMARY_ID || node.classList?.contains(BADGE_CLASS))
      ));
  })) {
    return;
  }

  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    lastSearch = window.location.search;
    scan();
  }, 350);
});

observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", () => {
  lastSearch = window.location.search;
  scan();
});

window.setInterval(() => {
  if (window.location.search === lastSearch) return;
  lastSearch = window.location.search;
  scan();
}, 500);

scan();
