# Naukri Search Collector

This Edge Manifest V3 extension collects job details visible in Naukri search-result cards, follows same-site next-page links, and saves unique job URLs in local extension storage. It only reads page content; it does not submit applications or call private Naukri APIs.

For a file-by-file explanation, including every JavaScript function and the message flow, see [FILE_GUIDE.txt](./FILE_GUIDE.txt).

## Load it in Edge

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `naukri-edge-extension` folder.
4. Open a Naukri search-results page and click the extension icon.
5. Choose **Collect all result pages**. The extension will navigate through detected next-page links; choose **Stop** to end early. Use **Download CSV** to export collected job details.

Collected results remain in this browser's extension storage. The popup shows up to 40 job links.

## Notes

- Check Naukri's current terms and policies before using the extension. Use it only for permitted, personal use.
- The extension reads rendered job cards and visible pagination links, not hidden APIs.
- Naukri can change its page markup. If no supported job cards or next-page link is detected, collection stops and reports that status; update the selectors in `content.js` for the current page structure.
