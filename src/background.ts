async function main() {
  await browser.scripting.registerContentScripts([
    {
      id: "content-main",
      js: ["content_scripts/index.js"],
      matches: ["<all_urls>"],
    },
  ]);
}

main();
