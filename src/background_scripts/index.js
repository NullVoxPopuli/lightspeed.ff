chrome.runtime.onInstalled.addListener(function ({ reason }) {
  console.log("lightspeed installed");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("listener", request.type, request.status);
  console.log("sender", sender);
});

document.addEventListener("DOMContentLoaded", () => {
  console.log("2", document.readyState);

  window.addEventListener("keydown", keyHandler);
  window.addEventListener("keypress", keyHandler);
});

function keyHandler(event) {
  console.log({ event });
  chrome.runtime.sendMessage({
    type: "click_event",
  });
}
