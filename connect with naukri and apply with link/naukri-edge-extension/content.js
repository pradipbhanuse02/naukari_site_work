const JOB_CARD_SELECTORS = [
  ".srp-jobtuple-wrapper",
  ".jobTuple",
  "article[data-job-id]"
];

const JOB_LINK_SELECTORS = [
  "a.title[href]",
  "a[href*='job-listings']",
  "a[href*='/jobs/']"
];

function firstText(element, selectors) {
  for (const selector of selectors) {
    const candidate = element.querySelector(selector);
    const value = candidate && candidate.textContent.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function findJobCards() {
  for (const selector of JOB_CARD_SELECTORS) {
    const cards = Array.from(document.querySelectorAll(selector));
    if (cards.length) {
      return cards;
    }
  }

  return Array.from(document.querySelectorAll("[data-job-id]"))
    .filter((element) => element.querySelector(JOB_LINK_SELECTORS.join(",")));
}

function extractJobs() {
  const jobs = new Map();
  for (const card of findJobCards()) {
    const link = card.querySelector(JOB_LINK_SELECTORS.join(","));
    if (!link || !link.href) {
      continue;
    }

    const url = new URL(link.href);
    url.hash = "";
    const jobUrl = url.href;
    const title = link.textContent.trim() || link.getAttribute("title") || "";
    if (!title || jobs.has(jobUrl)) {
      continue;
    }

    jobs.set(jobUrl, {
      title,
      company: firstText(card, [".comp-name", "[class*='companyName']", "[class*='comp-name']"]),
      location: firstText(card, [".locWdth", "[class*='location']"]),
      experience: firstText(card, [".expwdth", "[class*='experience']"]),
      salary: firstText(card, [".sal", "[class*='salary']"]),
      posted: firstText(card, [".job-post-day", "[class*='date']"]),
      url: jobUrl
    });
  }
  return Array.from(jobs.values());
}

function isVisible(element) {
  return element.getClientRects().length > 0;
}

function findNextPageUrl() {
  const anchors = Array.from(document.querySelectorAll("a[href]")).filter(isVisible);
  const next = anchors.find((anchor) => {
    const label = `${anchor.getAttribute("aria-label") || ""} ${anchor.title || ""} ${anchor.textContent || ""}`
      .trim()
      .toLowerCase();
    return anchor.rel.toLowerCase().split(/\s+/).includes("next") ||
      /\bnext(?:\s+page)?\b/.test(label) ||
      ["›", "»", "→"].includes(label);
  });

  if (!next) {
    return "";
  }

  try {
    const url = new URL(next.href);
    return url.origin === location.origin ? url.href : "";
  } catch {
    return "";
  }
}

async function sendToExtension(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    const result = await chrome.storage.local.get("naukriCollection");
    const state = result.naukriCollection;
    if (state && state.active) {
      state.active = false;
      state.status = "Could not communicate with the extension. Reload the page and try again.";
      await chrome.storage.local.set({ naukriCollection: state });
    }
  }
}

let collecting = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "COLLECT_PAGE") {
    return;
  }

  if (collecting) {
    sendResponse({ ok: true });
    return;
  }

  collecting = true;
  const result = {
    type: "PAGE_COLLECTED",
    pageUrl: location.href,
    jobs: extractJobs(),
    nextUrl: findNextPageUrl()
  };

  setTimeout(() => {
    sendToExtension(result);
    collecting = false;
  }, 500);
  sendResponse({ ok: true });
});

sendToExtension({ type: "PAGE_READY" });
