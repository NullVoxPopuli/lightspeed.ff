/**
 * Content
 */

console.log("content script");
console.log(document.readyState);
document.addEventListener("DOMContentLoaded", () => {
  console.log(document.readyState);
});
chrome.action.onClicked.addListener(() => console.log("click here"));

window.addEventListener("keypress", () => {
  console.log("hi");
  chrome.runtime.sendMessage(null, keyvalue, (response) => {
    console.log("Sent key value" + response);
  });
});
