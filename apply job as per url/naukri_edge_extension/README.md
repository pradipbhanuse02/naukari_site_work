# Naukri CSV Apply Assistant for Edge

This extension runs in your existing Edge profile, so it uses the Naukri
session already signed in to that profile. It imports the job CSV, opens the
Naukri home page in a new tab, waits for a signed-in account indicator (with a
manual **Profile is ready - continue** fallback), then visits the CSV job URLs.

For each job, it clicks a standard **Apply** button if found. If a recruiter
radio-button question appears, it matches the question to the CSV's
`Recruiter Question N` column, selects that row's `Recruiter Answer N`, and
clicks a visible **Save** button if available. It does not click Submit or
complete the final application on your behalf.

The Apply-button matcher waits up to 20 seconds for an enabled, visible control
named exactly **Apply** or **Apply Now**. It intentionally does not match
controls such as **Apply on company site**.

If clicking Apply opens a separate Naukri tab or window, the extension tracks
that tab and runs recruiter-question detection there. The answer and exact
**Save** button are handled in the tab containing the application panel, not
the original job listing tab.

## Install in Microsoft Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `naukri_edge_extension` folder.
5. Pin **Naukri CSV Apply Assistant** if desired.

## Use

1. Click the extension icon and import `job_url.csv`.
2. Choose **Start / Resume**. A Naukri tab opens in the current Edge profile.
3. Sign in if necessary. The in-page message detects common signed-in account
   labels; if it cannot detect the session, click **Profile is ready - continue**
   in the page banner.
4. The extension visits each job and clicks its standard Apply button.
5. If a recruiter question is not in the CSV, the extension records its text
   and choices in the extension's local copy. Open the extension popup, fill in
   the answer, and choose **Start / Resume**.
6. If the question is already answered in the CSV, the extension selects that
   answer and clicks an exact **Save** button if present. Review and complete
   any remaining application steps yourself; choose **Next job** in the popup
   when ready.
7. Choose **Export CSV** to download the updated data, including questions
   discovered during the run. The extension cannot overwrite the original
   imported file automatically.

The extension stores the imported CSV rows and run state in Edge's local
extension storage. It does not access Google credentials or transmit CSV data
to an external service.

## CSV columns

Required: a Naukri URL column named `Job URL`, `URL`, `Job Link`, or
`Job Listing URL`. `Job Title` is optional. Saved answers use matching columns
such as `Recruiter Question 1`, `Recruiter Options 1`, and
`Recruiter Answer 1`. The answer must match one of the displayed choices.
