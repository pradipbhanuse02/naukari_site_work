# Naukri Job Exporter for Microsoft Edge

This unpacked Edge extension searches Naukri by keyword, collects job details from the results page, and downloads them as a CSV file.

## Install in Edge

1. Open `edge://extensions` in Microsoft Edge.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose this project folder (the folder containing `manifest.json`).
4. Pin **Naukri Job Exporter** from the Extensions menu to keep its toolbar button visible.

After updating an existing installation, select **Reload** for the extension on `edge://extensions` so Edge applies its download and offscreen-document permissions.

## Use

1. Select the extension's toolbar button to show its popup.
2. Enter comma-separated skill keywords (for example, `python,powerbi,machine learning`) and select **Search**. Naukri results load in the current tab and window.
3. Wait for the Naukri results to load, then open the extension popup while viewing that results tab. The popup automatically collects and displays the job listings.
4. If results are still loading, select **Collect jobs from this tab** to try again.
5. Optionally select **Apply to CSV jobs (Quick Apply only)** and confirm. This attempts the same jobs eligible for CSV export (at least one matched skill), in descending skill-match order in an inactive tab. Jobs needing a CAPTCHA, upload, manual fields, or non-Quick-Apply flow are skipped; the run stops after the first confirmed application. If a submission is clicked but Naukri's confirmation is unclear, it stops to avoid applying twice. Review the outcomes shown in the popup.
6. Select **Download CSV**. The extension saves `naukri-jobs.csv` to Edge's default Downloads location. The **Why Not Applied / Application Outcome** column explains why each job was skipped, failed, left unattempted, or had an unconfirmed result; successful applications include the confirmation outcome. Check Edge Downloads for completion or any browser download errors.

The popup shows **Jobs found/scored (last scan)** and **Jobs selected (highest % or 3+ matched skills, last scan)**. A keyword counts only when it appears in the job's skills field. The popup and Naukri page display all jobs tied for the highest skill-match percentage plus any job matching at least three skills. The CSV includes every job with at least one matched skill, sorted from highest match percentage to lowest. The CSV includes matched skill count, search-skill count, percentage, rank, selection reason, application status, and application result/failure reason.

The CSV includes job title, company, location, experience, salary, skills, description, posted date, and job URL. It contains listings found on the currently loaded results page; collect again after navigating to another results page.
