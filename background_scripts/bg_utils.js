const TIME_DELTA = 500; // Milliseconds.

// TabRecency associates a logical timestamp with each tab id.  These are used to provide an initial
class TabRecency {

  constructor() {
    this.timestamp = 1;
    this.current = -1;
    this.cache = {};
    this.lastVisited = null;
    this.lastVisitedTime = null;

    chrome.tabs.onActivated.addListener(activeInfo => this.register(activeInfo.tabId));
    chrome.tabs.onRemoved.addListener(tabId => this.deregister(tabId));

    chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
      this.deregister(removedTabId);
      this.register(addedTabId);
    });

    if (chrome.windows != null) {
      chrome.windows.onFocusChanged.addListener(wnd => {
        if (wnd !== chrome.windows.WINDOW_ID_NONE) {
          chrome.tabs.query({windowId: wnd, active: true}, tabs => {
            if (tabs[0])
              this.register(tabs[0].id);
          });
        }
      });
    }
  }

  register(tabId) {
    const currentTime = new Date();
    // Register tabId if it has been visited for at least @timeDelta ms.  Tabs which are visited only for a
    // very-short time (e.g. those passed through with `5J`) aren't registered as visited at all.
    if ((this.lastVisitedTime != null) && (TIME_DELTA <= (currentTime - this.lastVisitedTime))) {
      this.cache[this.lastVisited] = ++this.timestamp;
    }

    this.current = (this.lastVisited = tabId);
    this.lastVisitedTime = currentTime;
  }

  deregister(tabId) {
    if (tabId === this.lastVisited) {
      // Ensure we don't register this tab, since it's going away.
      this.lastVisited = (this.lastVisitedTime = null);
    }
    delete this.cache[tabId];
  }

  // Recently-visited tabs get a higher score (except the current tab, which gets a low score).
  recencyScore(tabId) {
    if (!this.cache[tabId])
      this.cache[tabId] = 1;
    if (tabId === this.current)
      return 0.0;
    else
      return this.cache[tabId] / this.timestamp;
  }

  // Returns a list of tab Ids sorted by recency, most recent tab first.
  getTabsByRecency() {
    const tabIds = Object.keys(this.cache || {});
    tabIds.sort((a,b) => this.cache[b] - this.cache[a]);
    return tabIds.map(tId => parseInt(tId));
  }
}

var BgUtils = {
  tabRecency: new TabRecency(),

  // Remove comments and leading/trailing whitespace from a list of lines, and merge lines where the last
  // character on the preceding line is "\".
  parseLines(text) {
    return text.replace(/\\\n/g, "")
      .split("\n")
      .map(line => line.trim())
      .filter(line => (line.length > 0) && !(Array.from('#"').includes(line[0])));
  },

  escapedEntities: {
    '"': "&quots;",
    '&': "&amp;",
    "'": "&apos;",
    "<": "&lt;",
    ">": "&gt;"
  },

  escapeAttribute(string) {
    return string.replace(/["&'<>]/g, char => BgUtils.escapedEntities[char]);
  }
};

BgUtils.TIME_DELTA = TIME_DELTA; // Referenced by our tests.

window.BgUtils = BgUtils;
