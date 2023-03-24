await browser.scripting.registerContentScripts([
  {
    id: "content-main",
    js: ["content_scripts/index.js"],
    matches: ["<all_urls>"],
  },
]);

let result = browser.windows.getAll();

console.log(result);
