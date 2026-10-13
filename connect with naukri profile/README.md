# Naukri Job Search Assistant

A small Chrome/Edge Manifest V3 extension that searches Naukri by keyword and optional location, shows how many searched keywords appear in each listing, and lets you keep a local record of applications you have submitted.

## Install

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Sign in to Naukri in that browser if you are not already signed in.

## Use

1. Open the extension, enter a job title or keywords and optionally a location, then choose **Search jobs on Naukri**. The search replaces the active tab in the same browser window. The extension passes the keywords using Naukri's `k` search parameter and the location using `l`. Separate multiple scoring keywords with commas, for example `Java, Python, SQL`.
2. Each detected job listing shows a keyword percentage and count, such as `67% keyword match (2/3)`. Jobs qualify for the application-review queue when they score above 20% **or** match at least 3 keywords. The percentage is the share of your comma-separated keywords found in the visible job-card text; it is a text match, not a measure of job suitability. Naukri's **Location** section is a search filter, not a job post. The popup reports how many job posts the last page scan detected. If it says zero, reload the extension, refresh the Naukri results tab, and wait for job cards to load.
3. **Auto-apply until 1 success** starts a best-match-first run from the currently detected results. It attempts only an obvious one-step Naukri Apply control; it does not fill forms, answer screening questions, or submit multi-step forms. The run stops after one success that Naukri visibly confirms. If Naukri visibly reports a failure, it records the reason and moves to the next eligible job. If the result is unclear, no one-step control is found, or Naukri opens a form, the run pauses for manual attention rather than risking duplicate or unintended submission. The extension may submit an application when the one-step control is clicked, so check your profile and criteria before starting.
4. Each results scan saves a local snapshot. When the popup opens, it tries to rescan the active Naukri page and otherwise displays the saved snapshot. It shows searches launched, jobs scored in the latest scan, jobs above 20%, jobs with at least 3 matched keywords, detected or manually marked applications, run status, and per-job outcomes. **Download job report (CSV)** exports saved totals and the last-scan jobs, then clears only the last-scan snapshot; application history and saved match records remain. Search totals start counting after this update. Saved match records are limited to 500 jobs. Success/failure recognition depends on Naukri's visible page messages; site changes may cause the extension to pause and ask for manual review.

The extension does not collect or store your Naukri password, edit your profile, fill application forms, or answer screening questions. When you explicitly start an automatic run, it may click a clear one-step Apply control and records success only when a visible Naukri status indicates it. Search and application-review state are stored locally in the browser using `chrome.storage.local`. To remove them, remove this extension's data from your browser's extension storage.

## Limitations

Naukri controls its website, sign-in flow, job-search URLs, and application forms. The extension detects job-post links and known job-card containers, then scores text present in those cards; website changes may require an update. It does not score the location-filter sidebar, bypass sign-in, CAPTCHAs, application questions, or site controls.
