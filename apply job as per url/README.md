# Interactive Naukri job application helper

Reads Naukri listing URLs from a CSV, opens the Naukri homepage first in an
automation-controlled Microsoft Edge window, then visits each CSV listing and
asks before clicking its standard **Apply** button. You review any follow-up
form or confirmation and complete it yourself. The app does not collect or
store your credentials.

## CSV format

The CSV must have a URL column named `Job URL`, `URL`, `Job Link`, or
`Job Listing URL`. A `Job Title` column is optional. Blank rows are ignored.
The included `job_url.csv` is used by default.

## Run on Windows

```powershell
python -m pip install -r requirements.txt
```

```powershell
python .\apply_jobs.py
```

To use a different CSV:

```powershell
python .\apply_jobs.py .\another_jobs.csv
```

The app first opens `https://www.naukri.com/mnjuser/homepage`, then watches the
page for a signed-in account indicator such as **My Naukri** or **View
profile**. If it is not already signed in, a popup waits while the app checks
for authentication. Sign in in the Edge window and it proceeds automatically
when detected. If the indicator is not detected but you can verify the profile
is ready, click **Profile is ready - continue** to proceed manually. Choose
**Cancel** to stop. It waits up to 10 minutes by default; override this with
`--login-timeout 900` (seconds).

The app uses a dedicated Edge profile under
`%LOCALAPPDATA%\NaukriJobApply\Edge User Data`, separate from your regular
Edge profile. Your regular Edge windows can remain open. Sign in to Naukri
once in the app's Edge window; that profile retains its Naukri session for
future runs. Edge opens maximized to the laptop's available screen size. The
app clicks the standard Apply button and pauses afterward so you can review
and finish any required form or confirmation.

When a recruiter question with radio-button, chat-style choices, or a
free-text response field appears
after Apply, the app adds `Recruiter Question N`, `Recruiter Options N`, and
`Recruiter Answer N` columns to the matching job row in the CSV, then
continues to the next job URL. Fill the answer column with one of the listed
choices exactly (for example, `Yes` or `No`), or enter the desired response
text for a free-text question, then save the CSV. On the next run, the app
waits up to 30
seconds for the question to appear and automatically selects the saved answer
when it matches one of the on-page choices. You must advance and submit any
application form yourself. After selecting an answer, the app clicks a
visible button labeled exactly **Save**, if present; it does not click broader
actions such as **Submit** or **Apply** from this question handler. If Apply
opens a separate Naukri tab or window, the app looks for the recruiter
question there and uses that same page to find and click **Save**. It scrolls
the Save control into view before clicking. In Naukri's chatbot panel, it
prioritizes the panel's `div.sendMsg[tabindex="0"]` control so it does not
mistake the listing's separate **Save** job button for the answer Save button.
After clicking the chatbot's **Save**, the app checks the visible Naukri page
for an explicit application confirmation and updates `Application Status` and
`Status Checked At` in the matching CSV row. It records **Applied** only when
Naukri displays an application confirmation; otherwise it records that the
recruiter questions are still in progress or that the application status could
not be confirmed. Failures are recorded in `Application Failure Reason`,
including missing Apply controls, answer-selection problems, or missing
recruiter-panel Save. The app continues to the next CSV job URL after a
job-level failure instead of stopping the entire run.
If a recruiter answer is blank in the CSV, the app uses a temporary fallback
(`...` for free-text questions, **Yes** for Yes/No questions when available,
or the first available choice otherwise). It does not click **Save** for a
fallback answer and moves on to the next job URL.
If a listing instead offers **Apply on company site**, the app records its
destination in the `Company URL` column on that job's CSV row and continues
without opening the external site.

Use `--edge-profile "Profile 1"` to select another profile folder, or
`--edge-user-data-dir "C:\path\to\Edge\User Data"` to override the app profile
directory.
