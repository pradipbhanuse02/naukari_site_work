import argparse
from datetime import datetime
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import pandas as pd
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


URL_HEADERS = {"joburl", "url", "joblink", "joblistingurl"}
NAUKRI_HOME_URL = "https://www.naukri.com/mnjuser/homepage"
APPLY_TEXT = re.compile(r"^\s*apply(?:\s+now)?\s*$", re.IGNORECASE)
APPLIED_TEXT = re.compile(
    r"\b(you have already applied|already applied|application submitted|"
    r"application sent|successfully applied)\b",
    re.IGNORECASE,
)
APPLIED_LABEL = re.compile(
    r"^\s*(applied|application submitted|application sent)\s*$",
    re.IGNORECASE,
)
LOGIN_TEXT = re.compile(r"\b(login|log in|sign in)\b", re.IGNORECASE)
SIGNED_IN_TEXT = re.compile(
    r"^(my naukri|my profile|view profile|edit profile|candidate profile|"
    r"log out|logout|sign out)$",
    re.IGNORECASE,
)
EDGE_USER_DATA_DIR = Path(
    os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")
) / "NaukriJobApply" / "Edge User Data"


def is_naukri_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").lower()
    return hostname == "naukri.com" or hostname.endswith(".naukri.com")


def read_jobs(csv_path: Path) -> list[dict[str, str]]:
    try:
        dataframe = pd.read_csv(
            csv_path, dtype=str, keep_default_na=False, encoding="utf-8-sig"
        )
    except (OSError, pd.errors.EmptyDataError, pd.errors.ParserError) as error:
        raise ValueError(f"Could not read CSV file '{csv_path}': {error}") from error

    url_header = next(
        (
            header
            for header in dataframe.columns
            if re.sub(r"[^a-z]", "", header.lower()) in URL_HEADERS
        ),
        None,
    )
    if url_header is None:
        raise ValueError(
            "CSV needs a job URL column named Job URL, URL, Job Link, "
            "or Job Listing URL."
        )

    jobs = []
    for row_number, row in enumerate(dataframe.to_dict(orient="records"), start=2):
        url = row[url_header].strip()
        if not url:
            continue
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"Invalid URL on CSV row {row_number}: {url}")
        if not is_naukri_url(url):
            raise ValueError(f"CSV row {row_number} is not a Naukri URL: {url}")
        jobs.append(
            {
                "title": row.get("Job Title", "").strip(),
                "url": url,
            }
        )

    if not jobs:
        raise ValueError(f"No job URLs found in '{csv_path}'.")
    return jobs


def find_edge_executable() -> str:
    executable = shutil.which("msedge")
    if executable:
        return executable

    install_paths = [
        Path(os.environ.get("PROGRAMFILES(X86)", ""))
        / "Microsoft"
        / "Edge"
        / "Application"
        / "msedge.exe",
        Path(os.environ.get("PROGRAMFILES", ""))
        / "Microsoft"
        / "Edge"
        / "Application"
        / "msedge.exe",
        Path(os.environ.get("LOCALAPPDATA", ""))
        / "Microsoft"
        / "Edge"
        / "Application"
        / "msedge.exe",
    ]
    for path in install_paths:
        if path.is_file():
            return str(path)

    if sys.platform == "win32":
        import winreg

        for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(
                    root,
                    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
                ) as key:
                    executable, _ = winreg.QueryValueEx(key, None)
                    if Path(executable).is_file():
                        return executable
            except OSError:
                continue

    raise FileNotFoundError(
        "Microsoft Edge executable was not found. Install Edge or add msedge.exe "
        "to PATH."
    )


def visible_apply_control(page):
    for role in ("button", "link"):
        controls = page.get_by_role(role, name=APPLY_TEXT)
        for index in range(controls.count()):
            control = controls.nth(index)
            try:
                if control.is_visible():
                    return control
            except PlaywrightTimeoutError:
                continue
    return None


def company_site_url(page) -> str:
    for frame in page.frames:
        try:
            destination = frame.evaluate(
                """() => {
                    const visible = element => {
                        const style = getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        return style.display !== "none" &&
                            style.visibility !== "hidden" &&
                            Number(style.opacity) !== 0 &&
                            rect.width > 0 && rect.height > 0;
                    };
                    const controls = Array.from(document.querySelectorAll(
                        "a, button, [role='button'], [tabindex]"
                    ));
                    for (const element of controls) {
                        if (!visible(element)) continue;
                        const label = (element.innerText ||
                            element.getAttribute("aria-label") ||
                            element.getAttribute("title") || "")
                            .replace(/\\s+/g, " ").trim();
                        if (!/^apply on company site$/i.test(label)) continue;
                        const control = element.closest(
                            "a, button, [role='button'], [tabindex]"
                        ) || element;
                        const rawUrl = control.href ||
                            control.getAttribute("data-url") ||
                            control.getAttribute("data-href") ||
                            control.getAttribute("data-redirect-url") ||
                            control.getAttribute("data-target-url");
                        if (rawUrl) return new URL(rawUrl, document.baseURI).href;
                    }
                    return "";
                }"""
            )
        except PlaywrightError:
            continue
        if destination:
            return urljoin(frame.url, destination)
    return ""


def record_company_url(csv_path: Path, job_url: str, company_url: str) -> None:
    try:
        dataframe = pd.read_csv(
            csv_path, dtype=str, keep_default_na=False, encoding="utf-8-sig"
        )
    except (OSError, pd.errors.EmptyDataError, pd.errors.ParserError) as error:
        raise ValueError(f"Could not read CSV file '{csv_path}': {error}") from error

    url_header = next(
        (
            header
            for header in dataframe.columns
            if re.sub(r"[^a-z]", "", header.lower()) in URL_HEADERS
        ),
        None,
    )
    if url_header is None:
        raise ValueError("Could not find a job URL column while saving Company URL.")

    matching_rows = dataframe.index[dataframe[url_header].str.strip() == job_url]
    if matching_rows.empty:
        raise ValueError(
            f"Could not find the job URL in '{csv_path}' to save Company URL."
        )
    if "Company URL" not in dataframe.columns:
        dataframe["Company URL"] = ""
    dataframe.at[matching_rows[0], "Company URL"] = company_url

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8-sig",
            newline="",
            dir=csv_path.parent,
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
        dataframe.to_csv(temp_path, index=False, encoding="utf-8-sig")
        temp_path.replace(csv_path)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()


def visible_save_control(page):
    frames = page.frames
    chat_panel_found = False
    for frame in frames:
        try:
            panels = frame.locator(".chatbot_Drawer, .chatbotContainer")
            for panel_index in range(panels.count()):
                panel = panels.nth(panel_index)
                if not panel.is_visible():
                    continue
                chat_panel_found = True
                controls = panel.locator("div.sendMsg[tabindex='0']")
                for control_index in range(controls.count()):
                    control = controls.nth(control_index)
                    if not control.is_visible() or not control.evaluate(
                        """el => !el.hasAttribute("disabled") &&
                            el.getAttribute("aria-disabled") !== "true" &&
                            !/(^|\\s)disabled(\\s|$)/i.test(el.className || "")"""
                    ):
                        continue
                    if re.fullmatch(
                        r"\s*save\s*",
                        control.inner_text(timeout=1000),
                        re.IGNORECASE,
                    ):
                        return control
        except PlaywrightTimeoutError:
            continue

    # Do not mistake the job listing's own Save button for the chatbot's Save.
    if chat_panel_found:
        return None

    for frame in frames:
        controls = frame.locator(
            "button, a, [role='button'], input[type='button'], "
            "input[type='submit'], div.sendMsg[tabindex='0']"
        )
        for index in range(controls.count()):
            control = controls.nth(index)
            try:
                if not control.is_visible():
                    continue
                labels = [
                    control.inner_text(timeout=1000).strip(),
                    (control.get_attribute("aria-label") or "").strip(),
                    (control.get_attribute("title") or "").strip(),
                    (control.get_attribute("value") or "").strip(),
                ]
                if any(
                    re.fullmatch(r"\s*save\s*", label, re.IGNORECASE)
                    for label in labels
                ):
                    return control
            except PlaywrightTimeoutError:
                continue
    return None


def wait_for_save_control(page, timeout_ms: int = 10000):
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        control = visible_save_control(page)
        if control is not None:
            return control
        page.wait_for_timeout(250)
    return None


def application_page_after_apply(context, source_page, existing_pages):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        for candidate in reversed(context.pages):
            if candidate not in existing_pages and is_naukri_url(candidate.url):
                return candidate
        source_page.wait_for_timeout(250)
    return source_page


def normalize_text(text: str) -> str:
    return " ".join(text.split()).casefold()


def visible_recruiter_questions(page) -> list[dict]:
    radios = page.locator('input[type="radio"]:visible, [role="radio"]:visible')
    groups = {}
    for index in range(radios.count()):
        radio = radios.nth(index)
        details = radio.evaluate(
            """el => {
                const labels = el.labels
                    ? Array.from(el.labels, label => label.innerText.trim()).filter(Boolean)
                    : [];
                const associatedLabel = el.labels && el.labels.length
                    ? el.labels[0]
                    : el.closest("label");
                const option = labels.join(" ") ||
                    el.getAttribute("aria-label") || el.value || "";
                let node = el.closest("label") || el.parentElement;
                for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
                    const lines = (node.innerText || "")
                        .split(/\\r?\\n/)
                        .map(line => line.trim())
                        .filter(Boolean);
                    const question = lines.find(line => line.includes("?"));
                    if (question && question.length <= 500) {
                        return {
                            question,
                            option,
                            labelIndex: associatedLabel
                                ? Array.from(document.querySelectorAll("label"))
                                    .indexOf(associatedLabel)
                                : -1,
                            checked: el.checked ||
                                el.getAttribute("aria-checked") === "true"
                        };
                    }
                }
                return null;
            }"""
        )
        if not details:
            continue
        question = details["question"]
        key = normalize_text(question)
        group = groups.setdefault(
            key,
            {
                "question": question,
                "options": [],
                "controls": [],
                "checked_option": None,
            },
        )
        if details["option"] and details["option"] not in group["options"]:
            group["options"].append(details["option"])
        group["controls"].append(
            (radio, details["option"], details["labelIndex"])
        )
        if details["checked"]:
            group["checked_option"] = details["option"]

    custom_options = page.evaluate(
        """() => {
            const visible = element => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== "none" &&
                    style.visibility !== "hidden" &&
                    Number(style.opacity) !== 0 &&
                    rect.width > 0 && rect.height > 0;
            };
            const normalize = text => (text || "").replace(/\\s+/g, " ").trim();
            const isOption = element =>
                /^(yes|no)$/i.test(normalize(element.innerText));
            const selectorFor = element => {
                if (element.id) return `#${CSS.escape(element.id)}`;
                const parts = [];
                for (let node = element; node && node.nodeType === 1;
                    node = node.parentElement) {
                    let part = node.localName;
                    if (node.classList.length) {
                        part += "." + Array.from(node.classList)
                            .map(name => CSS.escape(name)).join(".");
                    }
                    if (node.parentElement) {
                        const siblings = Array.from(node.parentElement.children)
                            .filter(sibling => sibling.localName === node.localName);
                        if (siblings.length > 1) {
                            part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
                        }
                    }
                    parts.unshift(part);
                    if (node.id) break;
                }
                return parts.join(" > ");
            };
            const optionElements = Array.from(document.querySelectorAll(
                "button, [role='button'], [role='radio'], label, [tabindex], div, span"
            )).filter(element =>
                visible(element) &&
                isOption(element) &&
                !Array.from(element.querySelectorAll(
                    "button, [role='button'], [role='radio'], label, [tabindex], div, span"
                )).some(isOption)
            );
            const results = new Map();
            for (const optionElement of optionElements) {
                const control = optionElement.closest(
                    "button, [role='button'], [role='radio'], label, [tabindex]"
                ) || optionElement;
                if (!visible(control)) continue;
                let container = control.parentElement;
                let question = "";
                let options = [];
                for (let depth = 0; container && depth < 10;
                    depth++, container = container.parentElement) {
                    const lines = (container.innerText || "")
                        .split(/\\r?\\n/)
                        .map(normalize)
                        .filter(Boolean);
                    const candidate = lines.find(line =>
                        line.includes("?") && line.length <= 500
                    );
                    if (!candidate) continue;
                    const found = new Map();
                    for (const element of container.querySelectorAll(
                        "button, [role='button'], [role='radio'], label, [tabindex], div, span"
                    )) {
                        if (!visible(element) || !isOption(element)) continue;
                        if (Array.from(element.querySelectorAll(
                            "button, [role='button'], [role='radio'], label, [tabindex], div, span"
                        )).some(isOption)) continue;
                        const target = element.closest(
                            "button, [role='button'], [role='radio'], label, [tabindex]"
                        ) || element;
                        if (visible(target)) found.set(normalize(element.innerText).toLowerCase(), target);
                    }
                    if (found.size >= 2) {
                        question = candidate;
                        options = Array.from(found, ([option, target]) => ({
                            option,
                            selector: selectorFor(target),
                            checked: Boolean(
                                target.matches(":checked, [aria-checked='true'], [aria-pressed='true']") ||
                                target.querySelector(":checked, [aria-checked='true'], [aria-pressed='true']") ||
                                /(^|\\s)(selected|active|checked)(\\s|$)/i.test(target.className || "")
                            )
                        }));
                        break;
                    }
                }
                if (question) {
                    const key = question.toLowerCase();
                    if (!results.has(key)) results.set(key, { question, options });
                }
            }
            return Array.from(results.values());
        }"""
    )
    for item in custom_options:
        key = normalize_text(item["question"])
        group = groups.setdefault(
            key,
            {
                "question": item["question"],
                "options": [],
                "controls": [],
                "checked_option": None,
            },
        )
        for option in item["options"]:
            if option["option"] not in group["options"]:
                group["options"].append(option["option"])
            if not any(
                normalize_text(existing_option) == normalize_text(option["option"])
                for _, existing_option, _ in group["controls"]
            ):
                group["controls"].append(
                    (page.locator(option["selector"]), option["option"], -1)
                )
            if option["checked"]:
                group["checked_option"] = option["option"]

    custom_text_questions = page.evaluate(
        """() => {
            const visible = element => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== "none" &&
                    style.visibility !== "hidden" &&
                    Number(style.opacity) !== 0 &&
                    rect.width > 0 && rect.height > 0;
            };
            const normalize = text => (text || "").replace(/\\s+/g, " ").trim();
            const selectorFor = element => {
                if (element.id) return `#${CSS.escape(element.id)}`;
                const parts = [];
                for (let node = element; node && node.nodeType === 1;
                    node = node.parentElement) {
                    let part = node.localName;
                    if (node.classList.length) {
                        part += "." + Array.from(node.classList)
                            .map(name => CSS.escape(name)).join(".");
                    }
                    if (node.parentElement) {
                        const siblings = Array.from(node.parentElement.children)
                            .filter(sibling => sibling.localName === node.localName);
                        if (siblings.length > 1) {
                            part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
                        }
                    }
                    parts.unshift(part);
                    if (node.id) break;
                }
                return parts.join(" > ");
            };
            const results = [];
            const panels = Array.from(document.querySelectorAll(
                ".chatbot_Drawer, .chatbotContainer"
            )).filter(visible);
            for (const panel of panels) {
                const input = Array.from(panel.querySelectorAll(
                    "input:not([type='radio']):not([type='checkbox']):not([type='button']):not([type='submit']), textarea, [contenteditable='true']"
                )).find(element => visible(element) && !element.disabled);
                if (!input) continue;
                const lines = (panel.innerText || "")
                    .split(/\\r?\\n/)
                    .map(normalize)
                    .filter(line => line && !/^save$/i.test(line));
                const question = [...lines].reverse().find(line =>
                    line.includes("?") && line.length <= 500
                );
                if (!question) continue;
                results.push({
                    question,
                    inputSelector: selectorFor(input),
                    currentValue: input.isContentEditable
                        ? input.innerText
                        : input.value
                });
            }
            return results;
        }"""
    )
    for item in custom_text_questions:
        key = normalize_text(item["question"])
        groups.setdefault(
            key,
            {
                "question": item["question"],
                "options": [],
                "controls": [],
                "checked_option": item["currentValue"],
                "type": "text",
                "text_selector": item["inputSelector"],
                "text_frame_index": 0,
            },
        )
    return list(groups.values())


def question_column_names(fieldnames: list[str]) -> list[tuple[int, str, str, str]]:
    question_columns = {}
    pattern = re.compile(r"^Recruiter Question (\d+)$")
    for name in fieldnames:
        match = pattern.fullmatch(name)
        if match:
            number = int(match.group(1))
            question_columns[number] = (
                name,
                f"Recruiter Options {number}",
                f"Recruiter Answer {number}",
            )
    return [
        (number, *question_columns[number])
        for number in sorted(question_columns)
    ]


def record_recruiter_question(
    csv_path: Path, job_url: str, question: str, options: list[str]
) -> int:
    try:
        dataframe = pd.read_csv(
            csv_path, dtype=str, keep_default_na=False, encoding="utf-8-sig"
        )
    except (OSError, pd.errors.EmptyDataError, pd.errors.ParserError) as error:
        raise ValueError(f"Could not read CSV file '{csv_path}': {error}") from error

    url_header = next(
        (
            header
            for header in dataframe.columns
            if re.sub(r"[^a-z]", "", header.lower()) in URL_HEADERS
        ),
        None,
    )
    if url_header is None:
        raise ValueError("Could not find a job URL column while saving the question.")

    matching_rows = dataframe.index[
        dataframe[url_header].str.strip() == job_url
    ]
    if matching_rows.empty:
        raise ValueError(f"Could not find the job URL in '{csv_path}' to save its question.")
    row_index = matching_rows[0]

    columns = question_column_names(list(dataframe.columns))
    target = next(
        (
            (number, question_header, options_header, answer_header)
            for number, question_header, options_header, answer_header in columns
            if normalize_text(dataframe.at[row_index, question_header])
            == normalize_text(question)
        ),
        None,
    )
    if target is None:
        target = next(
            (
                column
                for column in columns
                if not dataframe.at[row_index, column[1]].strip()
            ),
            None,
        )

    if target is None:
        number = max((column[0] for column in columns), default=0) + 1
        target = (
            number,
            f"Recruiter Question {number}",
            f"Recruiter Options {number}",
            f"Recruiter Answer {number}",
        )
        for header in target[1:]:
            dataframe[header] = ""

    number, question_header, options_header, answer_header = target
    for header in (question_header, options_header, answer_header):
        if header not in dataframe.columns:
            dataframe[header] = ""
    dataframe.at[row_index, question_header] = question
    dataframe.at[row_index, options_header] = " | ".join(options)

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8-sig",
            newline="",
            dir=csv_path.parent,
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
        dataframe.to_csv(temp_path, index=False, encoding="utf-8-sig")
        temp_path.replace(csv_path)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()
    return number


def saved_recruiter_answer(
    csv_path: Path, job_url: str, question: str
) -> tuple[str, list[str]] | None:
    try:
        dataframe = pd.read_csv(
            csv_path, dtype=str, keep_default_na=False, encoding="utf-8-sig"
        )
    except (OSError, pd.errors.EmptyDataError, pd.errors.ParserError) as error:
        raise ValueError(f"Could not read CSV file '{csv_path}': {error}") from error

    url_header = next(
        (
            header
            for header in dataframe.columns
            if re.sub(r"[^a-z]", "", header.lower()) in URL_HEADERS
        ),
        None,
    )
    if url_header is None:
        return None
    matching_rows = dataframe.index[
        dataframe[url_header].str.strip() == job_url
    ]
    if matching_rows.empty:
        return None

    fieldnames = list(dataframe.columns)
    row = dataframe.loc[matching_rows[0]]
    for _, question_header, options_header, answer_header in question_column_names(
        fieldnames
    ):
        if normalize_text(row.get(question_header, "")) == normalize_text(question):
            answer = row.get(answer_header, "").strip()
            options = [
                option.strip()
                for option in row.get(options_header, "").split("|")
                if option.strip()
            ]
            return answer, options
    return None


def fallback_recruiter_answer(question: dict) -> str:
    if question.get("type") == "text":
        return "..."

    yes_option = next(
        (
            option
            for option in question["options"]
            if normalize_text(option) == "yes"
        ),
        None,
    )
    if yes_option:
        return yes_option
    if question["options"]:
        return question["options"][0]
    return "..."


def check_naukri_application_status(page) -> str:
    visible_text = []
    for frame in page.frames:
        try:
            visible_text.append(frame.locator("body").inner_text(timeout=2000))
        except PlaywrightError:
            continue

    combined_text = "\n".join(visible_text)
    if APPLIED_TEXT.search(combined_text) or any(
        APPLIED_LABEL.fullmatch(line)
        for line in combined_text.splitlines()
    ):
        return "Applied"
    if visible_recruiter_questions(page):
        return "Recruiter questions in progress"
    return "Saved recruiter answers; application status not confirmed"


def is_already_applied(page) -> bool:
    for frame in page.frames:
        try:
            body_text = frame.locator("body").inner_text(timeout=2000)
            if APPLIED_TEXT.search(body_text) or any(
                APPLIED_LABEL.fullmatch(line.strip())
                for line in body_text.splitlines()
            ):
                return True

            status_controls = frame.locator(
                "button, a, [role='button'], [aria-label], [title]"
            )
            for index in range(status_controls.count()):
                control = status_controls.nth(index)
                if not control.is_visible():
                    continue
                labels = [
                    control.inner_text(timeout=1000).strip(),
                    (control.get_attribute("aria-label") or "").strip(),
                    (control.get_attribute("title") or "").strip(),
                ]
                if any(APPLIED_LABEL.fullmatch(label) for label in labels):
                    return True
        except PlaywrightTimeoutError:
            continue
    return False


def record_application_status(
    csv_path: Path,
    job_url: str,
    status: str,
    failure_reason: str = "",
) -> None:
    try:
        dataframe = pd.read_csv(
            csv_path, dtype=str, keep_default_na=False, encoding="utf-8-sig"
        )
    except (OSError, pd.errors.EmptyDataError, pd.errors.ParserError) as error:
        raise ValueError(f"Could not read CSV file '{csv_path}': {error}") from error

    url_header = next(
        (
            header
            for header in dataframe.columns
            if re.sub(r"[^a-z]", "", header.lower()) in URL_HEADERS
        ),
        None,
    )
    if url_header is None:
        raise ValueError("Could not find a job URL column while saving application status.")

    matching_rows = dataframe.index[
        dataframe[url_header].str.strip() == job_url
    ]
    if matching_rows.empty:
        raise ValueError(
            f"Could not find the job URL in '{csv_path}' to save application status."
        )

    for column in (
        "Application Status",
        "Application Failure Reason",
        "Status Checked At",
        "Date Applied",
    ):
        if column not in dataframe.columns:
            dataframe[column] = ""
    row_index = matching_rows[0]
    dataframe.at[row_index, "Application Status"] = status
    dataframe.at[row_index, "Application Failure Reason"] = failure_reason
    dataframe.at[row_index, "Status Checked At"] = datetime.now().astimezone().isoformat(
        timespec="seconds"
    )
    if status == "Applied" and not dataframe.at[row_index, "Date Applied"].strip():
        dataframe.at[row_index, "Date Applied"] = (
            datetime.now().astimezone().date().isoformat()
        )

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8-sig",
            newline="",
            dir=csv_path.parent,
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
        dataframe.to_csv(temp_path, index=False, encoding="utf-8-sig")
        temp_path.replace(csv_path)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()


def handle_recruiter_questions(page, csv_path: Path, job_url: str) -> bool:
    questions = visible_recruiter_questions(page)
    deadline = time.monotonic() + 30
    while not questions and time.monotonic() < deadline:
        page.wait_for_timeout(750)
        questions = visible_recruiter_questions(page)
    if not questions:
        print(
            "No supported recruiter question controls detected. Review the "
            "application in Edge and complete any required form yourself."
        )
        status = check_naukri_application_status(page)
        reason = ""
        if status != "Applied":
            reason = (
                "No final application confirmation was visible. Review and "
                "complete any remaining steps in Edge."
            )
        record_application_status(
            csv_path, job_url, status, reason
        )
        print("Continuing with the next job URL.")
        return True

    selected_answers = {}
    while questions:
        question = next(
            (
                item
                for item in questions
                if normalize_text(item["question"]) not in selected_answers
                or normalize_text(
                    selected_answers[normalize_text(item["question"])]
                )
                != normalize_text(item["checked_option"] or "")
            ),
            None,
        )
        if question is None:
            print(
                "The selected answer is still displayed. Continue or complete "
                "the form in Edge, then press Enter to check it again."
            )
            input("Press Enter when the page has advanced...")
            questions = visible_recruiter_questions(page)
            continue

        saved = saved_recruiter_answer(csv_path, job_url, question["question"])
        answer_from_csv = saved is not None and bool(saved[0])
        if saved is None or not saved[0]:
            number = record_recruiter_question(
                csv_path,
                job_url,
                question["question"],
                question["options"],
            )
            print(
                f"Saved recruiter question {number} to {csv_path.name}:\n"
                f"  {question['question']}\n"
                f"  Choices: {' | '.join(question['options'])}\n"
                f"'Recruiter Answer {number}' was left blank in the CSV."
            )
            answer = fallback_recruiter_answer(question)
            print(
                f"No CSV answer found. Using temporary fallback answer "
                f"'{answer}' for this run only."
            )
        else:
            answer, _stored_options = saved
            print(
                f"Using saved CSV answer '{answer}' for recruiter question:\n"
                f"  {question['question']}"
            )

        if question.get("type") == "text":
            text_frame_index = question.get("text_frame_index", 0)
            if text_frame_index >= len(page.frames):
                record_application_status(
                    csv_path,
                    job_url,
                    "Failed",
                    "The recruiter answer field's frame is no longer available.",
                )
                return True
            selected = (
                page.frames[text_frame_index].locator(question["text_selector"]),
                answer,
                -1,
            )
        else:
            selected = next(
                (
                    (control, option, label_index)
                    for control, option, label_index in question["controls"]
                    if normalize_text(option) == normalize_text(answer)
                ),
                None,
            )
        if selected is None:
            record_recruiter_question(
                csv_path,
                job_url,
                question["question"],
                question["options"],
            )
            print(
                f"Answer '{answer}' does not match the current choices for:\n"
                f"  {question['question']}\n"
                f"Update 'Recruiter Answer' in {csv_path.name} to one of: "
                f"{' | '.join(question['options'])}"
            )
            record_application_status(
                csv_path,
                job_url,
                "Failed",
                f"Saved answer '{answer}' does not match current choices: "
                f"{' | '.join(question['options'])}",
            )
            return True

        control, answer_label, label_index = selected
        try:
            if question.get("type") == "text":
                control.fill(answer, timeout=10000)
            elif label_index >= 0:
                label = page.locator("label").nth(label_index)
                if label.is_visible():
                    label.click(timeout=10000)
                else:
                    control.scroll_into_view_if_needed(timeout=10000)
                    control.click(timeout=10000)
            else:
                control.scroll_into_view_if_needed(timeout=10000)
                control.click(timeout=10000)
        except PlaywrightError as error:
            print(f"Could not select recruiter answer '{answer}': {error}")
            record_application_status(
                csv_path, job_url, "Failed", f"Could not select answer: {error}"
            )
            return True

        if question.get("type") == "text":
            print(f"Entered '{answer_label}' for: {question['question']}")
        else:
            print(f"Selected '{answer_label}' for: {question['question']}")

        if not answer_from_csv:
            reason = (
                "A temporary fallback answer was entered but not saved or "
                "submitted because no answer was provided in the CSV."
            )
            record_application_status(
                csv_path, job_url, "Fallback answer entered; not saved", reason
            )
            print(
                "Skipping the recruiter Save button because this answer did "
                "not come from the CSV. Continuing with the next job URL."
            )
            return True

        save_control = wait_for_save_control(page)
        if save_control is not None:
            try:
                save_control.scroll_into_view_if_needed(timeout=10000)
                save_control.click(timeout=10000)
            except PlaywrightError as error:
                print(
                    f"Could not click Save after selecting '{answer_label}': {error}"
                )
                record_application_status(
                    csv_path, job_url, "Failed", f"Could not click recruiter Save: {error}"
                )
                return True
            print("Clicked the visible Save button for the selected answer.")
            page.wait_for_timeout(2000)
            status = check_naukri_application_status(page)
            reason = ""
            if status != "Applied":
                reason = (
                    "Recruiter answer was saved, but Naukri did not show a final "
                    "application confirmation. Complete remaining steps manually."
                )
            record_application_status(csv_path, job_url, status, reason)
            print(
                f"Naukri application status: {status}. "
                "Updated the Application Status column in the CSV."
            )
        else:
            failure_reason = (
                "Could not find the recruiter panel's exact Save control. "
                "The listing's Save button was not clicked."
            )
            print(
                "Could not find the recruiter panel's exact Save control. "
                "The job listing also has its own Save button, which was "
                "intentionally not clicked. Review the recruiter panel in Edge."
            )
            record_application_status(
                csv_path, job_url, "Failed", failure_reason
            )
        selected_answers[normalize_text(question["question"])] = answer_label
        input(
            "Review the answer and form in Edge. Continue manually, then "
            "press Enter to check for another recruiter question..."
        )
        questions = visible_recruiter_questions(page)
    return True


def is_naukri_profile_ready(page) -> bool:
    if not is_naukri_url(page.url):
        return False

    body_text = page.locator("body").inner_text(timeout=5000)
    if any(SIGNED_IN_TEXT.fullmatch(line.strip()) for line in body_text.splitlines()):
        return True

    account_links = page.locator("a, button, [role='button']")
    for index in range(account_links.count()):
        element = account_links.nth(index)
        if not element.is_visible():
            continue
        label = " ".join(
            filter(
                None,
                [
                    element.inner_text(timeout=1000).strip(),
                    (element.get_attribute("aria-label") or "").strip(),
                    (element.get_attribute("title") or "").strip(),
                ],
            )
        )
        if SIGNED_IN_TEXT.fullmatch(label.strip()):
            return True
    return False


def wait_for_login_confirmation(page, login_timeout: int) -> str:
    try:
        import tkinter as tk
    except ImportError as error:
        raise RuntimeError(
            "The sign-in confirmation window requires Python's Tkinter. "
            "Install a Python build that includes Tkinter."
        ) from error

    outcome = None
    deadline = time.monotonic() + login_timeout
    dialog = tk.Tk()
    dialog.title("Waiting for Naukri sign-in")
    dialog.resizable(False, False)
    dialog.protocol("WM_DELETE_WINDOW", dialog.destroy)

    message = tk.Label(
        dialog,
        text=(
            "Sign in to Naukri in the Edge window. This app is checking for "
            "a signed-in profile automatically. If your profile is ready but "
            "isn't detected, use the confirmation button."
        ),
        wraplength=420,
        justify="left",
        padx=16,
        pady=12,
    )
    message.pack(fill="x")
    status = tk.Label(
        dialog,
        text="Waiting for a signed-in profile indicator...",
        anchor="w",
        padx=16,
        pady=6,
    )
    status.pack(fill="x")

    def confirm_ready() -> None:
        nonlocal outcome
        outcome = "manual"
        dialog.destroy()

    buttons = tk.Frame(dialog, padx=12, pady=8)
    buttons.pack(fill="x")
    tk.Button(
        buttons,
        text="Profile is ready - continue",
        command=confirm_ready,
    ).pack(side="left")
    tk.Button(
        buttons,
        text="Cancel",
        command=dialog.destroy,
    ).pack(side="right")

    def check_profile() -> None:
        nonlocal outcome
        if is_naukri_profile_ready(page):
            outcome = "detected"
            dialog.destroy()
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            outcome = "timeout"
            status.config(
                text=(
                    "Timed out waiting for sign-in. Confirm the Edge session "
                    "or close this window to stop."
                )
            )
            dialog.destroy()
            return
        status.config(
            text=f"Not signed in yet. Waiting... ({int(remaining)} seconds left)"
        )
        dialog.after(1000, check_profile)

    dialog.after(0, check_profile)
    dialog.mainloop()
    return outcome or "cancel"


def open_naukri_homepage(page, login_timeout: int) -> None:
    print(f"Opening Naukri homepage: {NAUKRI_HOME_URL}")
    page.goto(NAUKRI_HOME_URL, wait_until="domcontentloaded", timeout=60000)
    print(f"Opened Naukri at: {page.url}")
    if not is_naukri_url(page.url):
        raise PlaywrightError(
            f"Naukri homepage redirected outside Naukri: {page.url}"
        )

    if is_naukri_profile_ready(page):
        print("Signed-in Naukri profile detected.")
        return

    print(
        "Naukri is not signed in yet. Sign in in Edge; the popup will continue "
        "automatically when authentication is detected."
    )
    outcome = wait_for_login_confirmation(page, login_timeout)
    if outcome == "detected":
        print("Signed-in Naukri profile detected.")
    elif outcome == "manual":
        print("Continuing because you confirmed the profile is ready.")
    elif outcome == "timeout":
        raise RuntimeError(
            f"Naukri sign-in was not detected within {login_timeout} seconds."
        )
    else:
        raise UserCancelled("Sign-in was cancelled before opening CSV jobs.")


class UserCancelled(Exception):
    pass


def process_job(
    page, csv_path: Path, job: dict[str, str], index: int, total: int
) -> bool:
    title = job["title"] or "Untitled listing"
    print(f"\n[{index}/{total}] {title}\n{job['url']}")
    page.goto(job["url"], wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)

    if not is_naukri_url(page.url):
        reason = f"The listing redirected outside Naukri: {page.url}"
        print(f"Skipped: {reason}.")
        record_application_status(csv_path, job["url"], "Failed", reason)
        return True

    body = page.locator("body").inner_text(timeout=10000)
    if LOGIN_TEXT.search(page.url) or (
        LOGIN_TEXT.search(body[:3000]) and not visible_apply_control(page)
    ):
        print(
            "In Edge, choose Naukri's Google sign-in option and select your "
            "saved Google account. Complete any Google prompts yourself."
        )
        input("After Naukri is signed in, press Enter here to retry...")
        page.goto(job["url"], wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        body = page.locator("body").inner_text(timeout=10000)

    if is_already_applied(page):
        print("Skipped: this listing appears to be already applied for.")
        record_application_status(
            csv_path,
            job["url"],
            "Already applied",
            "Naukri shows an existing application; Apply was not clicked.",
        )
        return True

    company_url = company_site_url(page)
    if company_url:
        record_company_url(csv_path, job["url"], company_url)
        print(f"Recorded Apply on company site destination in Company URL: {company_url}")

    control = visible_apply_control(page)
    if control is None:
        if company_url:
            reason = (
                "This listing directs applications to the company website; "
                "the destination was recorded in Company URL and was not opened."
            )
            print(reason)
            record_application_status(
                csv_path, job["url"], "Company site URL recorded", reason
            )
            print("Continuing with the next job URL.")
            return True
        reason = "No standard Apply button was found on the listing."
        print(f"{reason} Review the open page manually.")
        record_application_status(csv_path, job["url"], "Failed", reason)
        input("Press Enter to continue to the next listing...")
        return True

    #answer = input("Click this listing's Apply button? [y/N] ").strip().lower()

    answer = "y"
    if answer not in {"y", "yes"}:
        print("Skipped by user.")
        return True

    existing_pages = set(page.context.pages)
    try:
        control.click(timeout=10000)
    except PlaywrightError as error:
        reason = f"Could not click Apply: {error}"
        print(reason)
        record_application_status(csv_path, job["url"], "Failed", reason)
        input("Review the open page, then press Enter to continue...")
        return True

    page.wait_for_timeout(2000)
    application_page = application_page_after_apply(
        page.context, page, existing_pages
    )
    if application_page is not page:
        application_page.bring_to_front()
    return handle_recruiter_questions(application_page, csv_path, job["url"])


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Review Naukri jobs from a CSV and click Apply interactively."
    )
    parser.add_argument(
        "csv_file",
        nargs="?",
        default=str(Path(__file__).with_name("job_url.csv")),
        help="CSV path (default: job_url.csv beside this script)",
    )
    parser.add_argument(
        "--edge-user-data-dir",
        default=str(EDGE_USER_DATA_DIR),
        help="App-specific Edge user data directory",
    )
    parser.add_argument(
        "--edge-profile",
        default="Default",
        help="Profile folder inside the app's isolated Edge data directory",
    )
    parser.add_argument(
        "--login-timeout",
        type=int,
        default=600,
        help="Seconds to wait for Naukri sign-in detection (default: 600)",
    )
    args = parser.parse_args()
    if args.login_timeout <= 0:
        parser.error("--login-timeout must be greater than zero")

    try:
        csv_path = Path(args.csv_file)
        #csv_path = "C:\Users\pradi\Downloads\naukri-jobs (20).csv"
        jobs = read_jobs(csv_path)
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    try:
        edge_executable = find_edge_executable()
        print(
            f"Loaded {len(jobs)} job URL(s). Microsoft Edge will open "
            "maximized on the laptop display."
        )
        print(
            "The app uses a separate local Edge profile; your regular Edge "
            "windows can remain open."
        )
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=args.edge_user_data_dir,
                executable_path=edge_executable,
                args=[
                    f"--profile-directory={args.edge_profile}",
                    "--start-maximized",
                ],
                headless=False,
                no_viewport=True,
            )
            page = context.pages[0] if context.pages else context.new_page()
            try:
                open_naukri_homepage(page, args.login_timeout)
            except UserCancelled as error:
                print(error)
                context.close()
                return 0
            for index, job in enumerate(jobs, start=1):
                try:
                    process_job(page, csv_path, job, index, len(jobs))
                except (PlaywrightError, OSError, ValueError) as error:
                    reason = f"Job processing failed: {error}"
                    print(f"{reason} Continuing with the next job URL.")
                    record_application_status(
                        csv_path, job["url"], "Failed", reason
                    )
            context.close()
    except FileNotFoundError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except RuntimeError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except PlaywrightError as error:
        print(
            f"Could not start or control Edge: {error}\n"
            "The app uses its own local Edge profile. If this profile is "
            "already in use, close other Naukri Job Apply app instances. "
            "Sign in to Naukri in this app's Edge window if needed.",
            file=sys.stderr,
        )
        return 1

    print("\nFinished reviewing all job URLs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
