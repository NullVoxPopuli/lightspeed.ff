/**
 * lightspeed.ff — keyboard access to every interactable element on a page.
 *
 * Press `f` to label each visible interactable with a short hint, then type the
 * hint to activate it. Escape cancels, Backspace un-types a character.
 *
 * `gg` and `G` jump to the top and bottom of the page, as in vim. Every command
 * flashes its name in a badge at the bottom-right corner of the viewport.
 *
 * Everything here runs in the content script. The extension holds no
 * permissions, has no background page, and never calls an extension API — so
 * nothing about the page ever leaves the tab.
 */

/**
 * Dvorak key-order
 * - home-row outer
 * - home-row inner
 * - top row left-to-right
 * - bottom row left-to-right
 */
const HINT_CHARS = "aoeuhtnsid',.pyfgcrl;qjkxbmwvz";

// Rects thinner than this in either dimension aren't worth hinting; they're
// almost always spacers or collapsed containers rather than real targets.
const MIN_RECT_SIZE = 3;

// ARIA roles that mean "the user is meant to activate this".
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
  "textbox",
]);

// <input> types that behave like buttons rather than text fields, and so should
// be clicked instead of focused.
const BUTTON_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * Is this element one the user is meant to interact with?
 *
 * Only standards-based signals are used here — native tags, ARIA roles,
 * contenteditable, inline handlers, tabindex. Framework-specific heuristics
 * (ng-click, jsaction, "does the class name contain 'button'") are deliberately
 * left out: they need a false-positive pass to stay usable, and they go stale.
 */
function isInteractive(element) {
  // Explicitly inert or disabled subtrees are never targets.
  if (element.disabled) return false;
  if (element.closest("[inert]")) return false;

  const ariaDisabled = element.getAttribute("aria-disabled");
  if (ariaDisabled === "" || ariaDisabled === "true") return false;

  const role = element.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role.trim().toLowerCase())) return true;

  if (element.isContentEditable) return true;
  if (element.hasAttribute("onclick")) return true;

  switch (element.tagName.toLowerCase()) {
    case "a":
      // A bare <a> with no href is just styled text.
      return element.hasAttribute("href");
    case "button":
    case "select":
    case "summary":
      return true;
    case "textarea":
      return !element.readOnly;
    case "input":
      return element.type !== "hidden" && !element.readOnly;
    case "label":
      // Only hint a label when its control isn't separately hintable, otherwise
      // the same target gets two hints stacked on top of each other.
      return element.control != null && !isInteractive(element.control);
    case "audio":
    case "video":
      return element.hasAttribute("controls");
  }

  // Anything explicitly placed in the tab order is, by definition, meant to be
  // reachable from the keyboard.
  const tabIndex = Number.parseInt(element.getAttribute("tabindex"), 10);
  return Number.isInteger(tabIndex) && tabIndex >= 0;
}

/**
 * Clip a rect to the viewport, returning null if nothing meaningful is left.
 */
function cropToViewport(rect) {
  const top = Math.max(rect.top, 0);
  const left = Math.max(rect.left, 0);
  const bottom = Math.min(rect.bottom, window.innerHeight);
  const right = Math.min(rect.right, window.innerWidth);

  if (right - left < MIN_RECT_SIZE || bottom - top < MIN_RECT_SIZE) return null;

  return {
    top,
    left,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * The on-screen rect for an element, or null if it isn't visible.
 *
 * Rects are viewport-relative, which is what hint markers are positioned
 * against, so there's no scroll-offset bookkeeping to get wrong.
 */
function getVisibleRect(element) {
  const style = window.getComputedStyle(element);
  if (style.visibility !== "visible" || style.display === "none") return null;
  if (style.opacity === "0") return null;

  for (const clientRect of element.getClientRects()) {
    const rect = cropToViewport(clientRect);
    if (rect) return rect;
  }

  // An element can have no box of its own but still be visible through a child
  // that was floated or positioned out of it — e.g. an <a> wrapping only a
  // floated <img>. Those children don't contribute to the parent's client rects.
  for (const child of element.children) {
    const childStyle = window.getComputedStyle(child);
    const escapesParent =
      childStyle.float !== "none" ||
      childStyle.position === "absolute" ||
      childStyle.position === "fixed";
    if (!escapesParent) continue;

    const rect = getVisibleRect(child);
    if (rect) return rect;
  }

  return null;
}

/**
 * The topmost element at a point, descending through open shadow roots.
 */
function elementFromPoint(x, y, root = document, seen = []) {
  const element = root.elementFromPoint(x, y);
  if (!element || seen.includes(element)) return element;

  seen.push(element);

  if (element.shadowRoot) {
    return elementFromPoint(x, y, element.shadowRoot, seen);
  }
  return element;
}

/**
 * Is any part of the element actually hittable, or is it covered up?
 *
 * Checks the centre first (most likely to succeed), then the corners. Corners
 * are nudged inward by a tenth of a pixel so that adjacent elements sharing an
 * edge don't claim each other's hit test.
 */
function isReachable(element, rect) {
  const points = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + 0.1, rect.top + 0.1],
    [rect.right - 0.1, rect.top + 0.1],
    [rect.left + 0.1, rect.bottom - 0.1],
    [rect.right - 0.1, rect.bottom - 0.1],
  ];

  for (const [x, y] of points) {
    const hit = elementFromPoint(x, y);
    // `hit` may be a descendant painted over the element, or an ancestor when
    // the element itself doesn't paint. Both mean the target is reachable.
    if (hit && (element.contains(hit) || hit.contains(element))) return true;
  }
  return false;
}

/**
 * Every element in the document, descending through open shadow roots.
 */
function getAllElements(root, collected = []) {
  for (const element of root.querySelectorAll("*")) {
    collected.push(element);
    if (element.shadowRoot) getAllElements(element.shadowRoot, collected);
  }
  return collected;
}

/**
 * Every visible, reachable, interactive element, in document order.
 */
function findTargets() {
  const targets = [];

  for (const element of getAllElements(document.documentElement)) {
    if (!isInteractive(element)) continue;

    const rect = getVisibleRect(element);
    if (!rect) continue;
    if (!isReachable(element, rect)) continue;

    targets.push({ element, rect });
  }

  return targets;
}

/**
 * Generate `count` unique hint strings, shortest first.
 *
 * Hints are built back-to-front so that appending a character extends a hint
 * without invalidating the prefixes already assigned. Sorting the reversed
 * forms before flipping them scatters same-prefix hints across the page, so
 * neighbouring links rarely share a first keystroke.
 */
function hintStrings(count) {
  const hints = [""];
  let offset = 0;

  while (hints.length - offset < count || hints.length === 1) {
    const hint = hints[offset++];
    for (const char of HINT_CHARS) hints.push(char + hint);
  }

  return hints
    .slice(offset, offset + count)
    .sort()
    .map((hint) => [...hint].reverse().join(""));
}

/**
 * Does this element take text input? Those get focused rather than clicked, so
 * the user can start typing immediately.
 */
function isTextEntry(element) {
  if (element.isContentEditable) return true;

  switch (element.tagName.toLowerCase()) {
    case "textarea":
      return true;
    case "input":
      return !BUTTON_INPUT_TYPES.has(element.type);
    default:
      return false;
  }
}

/**
 * Act on the chosen element.
 *
 * Text fields and <select> are focused — a synthetic click can't open a native
 * dropdown, and focusing a text field is what the user wanted anyway. Everything
 * else gets a full mouse event sequence rather than `.click()`, because plenty
 * of sites bind their handlers to mousedown/mouseup and never see a bare click.
 */
function activate(element) {
  if (isTextEntry(element)) {
    element.focus();
    element.select?.();
    return;
  }

  if (element.tagName.toLowerCase() === "select") {
    element.focus();
    return;
  }

  element.focus?.();

  const options = { bubbles: true, cancelable: true, view: window };
  for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
    element.dispatchEvent(new MouseEvent(type, options));
  }
}

const MARKER_STYLES = `
  :host {
    all: initial;
  }
  .marker {
    position: fixed;
    background: linear-gradient(to bottom, #4c00ba 0%, #8300a8 100%);
    border: 1px solid #8200b1;
    border-radius: 3px;
    box-shadow: 0 3px 4px 0 rgba(0, 0, 0, 0.9);
    box-sizing: border-box;
    color: #fbfbfb;
    font: bold 11px/1 "Helvetica Neue", Helvetica, Arial, sans-serif;
    letter-spacing: 0.5px;
    padding: 3px 4px 2px;
    text-transform: uppercase;
    white-space: nowrap;
    z-index: 10;
  }
  .typed {
    color: #ebebff;
  }
`;

const BADGE_STYLES = `
  :host {
    all: initial;
  }
  .badge {
    position: fixed;
    right: 12px;
    bottom: 12px;
    background: linear-gradient(to bottom, #4c00ba 0%, #8300a8 100%);
    border: 1px solid #8200b1;
    border-radius: 4px;
    box-shadow: 0 3px 4px 0 rgba(0, 0, 0, 0.9);
    box-sizing: border-box;
    color: #fbfbfb;
    font: bold 12px/1 "Helvetica Neue", Helvetica, Arial, sans-serif;
    letter-spacing: 0.5px;
    padding: 6px 8px 5px;
    pointer-events: none;
    text-transform: uppercase;
    white-space: nowrap;
    z-index: 2147483647;
  }
`;

// How long a command's badge stays on screen once the command has finished.
const BADGE_DURATION = 1000;

/**
 * Badge: names the command just run, in the bottom-right corner.
 *
 * Same closed-shadow-root isolation as the hint markers.
 */
const Badge = {
  host: null,
  label: null,
  timer: null,

  /**
   * Show `text`. With `hold`, it stays until `hide()` is called; otherwise it
   * fades after `BADGE_DURATION`.
   */
  show(text, { hold = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;

    if (!this.host) {
      this.host = document.createElement("div");
      this.host.style.cssText = "all: initial; position: static;";
      const shadow = this.host.attachShadow({ mode: "closed" });

      const style = document.createElement("style");
      style.textContent = BADGE_STYLES;

      this.label = document.createElement("div");
      this.label.className = "badge";

      shadow.append(style, this.label);
    }

    this.label.textContent = text;
    // Re-append so the badge sits above anything the page added since.
    document.documentElement.append(this.host);

    if (!hold) {
      this.timer = setTimeout(() => this.hide(), BADGE_DURATION);
    }
  },

  hide() {
    clearTimeout(this.timer);
    this.timer = null;
    this.host?.remove();
  },
};

/**
 * Hint mode: renders markers, consumes keystrokes, activates the match.
 *
 * Markers live in a closed shadow root so the page's stylesheets can't restyle
 * them and the page's scripts can't read them.
 */
const HintMode = {
  active: false,
  host: null,
  markers: [],
  typed: "",

  /**
   * Returns whether hint mode actually started; a page with nothing to
   * activate has nothing to show.
   */
  enter() {
    const targets = findTargets();
    if (targets.length === 0) return false;

    this.active = true;
    this.typed = "";

    this.host = document.createElement("div");
    // The host itself must not intercept clicks or shift layout.
    this.host.style.cssText = "all: initial; position: static;";
    const shadow = this.host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = MARKER_STYLES;
    shadow.append(style);

    const hints = hintStrings(targets.length);

    this.markers = targets.map(({ element, rect }, index) => {
      const marker = document.createElement("div");
      marker.className = "marker";
      marker.style.left = `${rect.left}px`;
      marker.style.top = `${rect.top}px`;
      shadow.append(marker);

      const hint = { element, hint: hints[index], marker };
      this.render(hint);
      return hint;
    });

    document.documentElement.append(this.host);

    window.addEventListener("keydown", onHintKeyDown, true);
    // Markers are positioned against the viewport, so any scroll or resize
    // strands them over the wrong elements. Bail rather than show a lie.
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange, true);

    return true;
  },

  exit() {
    if (!this.active) return;

    Badge.hide();

    window.removeEventListener("keydown", onHintKeyDown, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange, true);

    this.host?.remove();
    this.host = null;
    this.markers = [];
    this.typed = "";
    this.active = false;
  },

  /**
   * Draw a hint, dimming the characters already typed.
   */
  render({ hint, marker }) {
    marker.replaceChildren();

    for (const [index, char] of [...hint].entries()) {
      const span = document.createElement("span");
      span.textContent = char;
      if (index < this.typed.length) span.className = "typed";
      marker.append(span);
    }
  },

  /**
   * Fold a character into the typed prefix, activating or exiting as needed.
   */
  push(char) {
    const typed = this.typed + char;
    const matches = this.markers.filter((hint) => hint.hint.startsWith(typed));

    if (matches.length === 0) {
      // A wrong key means the user has lost the thread; get out of their way
      // rather than leaving stale markers over the page.
      this.exit();
      return;
    }

    this.typed = typed;

    if (matches.length === 1 && matches[0].hint === typed) {
      const { element } = matches[0];
      this.exit();
      activate(element);
      return;
    }

    this.update(matches);
  },

  pop() {
    if (this.typed.length === 0) {
      this.exit();
      return;
    }

    this.typed = this.typed.slice(0, -1);
    this.update(
      this.markers.filter((hint) => hint.hint.startsWith(this.typed)),
    );
  },

  /**
   * Show only the hints still in the running.
   */
  update(matches) {
    const visible = new Set(matches);

    for (const hint of this.markers) {
      if (visible.has(hint)) {
        hint.marker.style.display = "";
        this.render(hint);
      } else {
        hint.marker.style.display = "none";
      }
    }
  },
};

function onViewportChange() {
  HintMode.exit();
}

function onHintKeyDown(event) {
  if (event.repeat) return;

  // Let the user escape to a modifier-based browser shortcut mid-hint.
  if (event.ctrlKey || event.altKey || event.metaKey) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  if (event.key === "Escape") {
    HintMode.exit();
  } else if (event.key === "Backspace") {
    HintMode.pop();
  } else if (HINT_CHARS.includes(event.key.toLowerCase())) {
    HintMode.push(event.key.toLowerCase());
  }
}

// ARIA roles for widgets that handle typing themselves, even when the element
// isn't a native text field or contenteditable (custom editors, comboboxes).
const TYPING_ROLES = new Set(["combobox", "searchbox", "textbox"]);

/**
 * Does keyboard input belong to this element rather than to the page?
 */
function consumesTyping(element) {
  if (!(element instanceof Element)) return false;
  if (isTextEntry(element)) return true;
  if (element.tagName.toLowerCase() === "select") return true;

  const role = element.getAttribute("role");
  if (role && TYPING_ROLES.has(role)) return true;

  // Custom editors often keep focus on a wrapper and mark the editable
  // surface on an ancestor.
  return element.closest("[contenteditable], [role='textbox']") !== null;
}

/**
 * The focused element, descending through open shadow roots.
 *
 * `document.activeElement` stops at a shadow host, so an <input> inside a web
 * component would otherwise look like a plain custom element.
 */
function deepActiveElement() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * Is the user typing into something, rather than at the page?
 */
function isTyping(event) {
  // Mid-IME composition, every key belongs to the input method.
  if (event.isComposing) return true;

  // The event target is the most direct signal; the deep active element
  // covers the cases where the target got retargeted to a shadow host.
  const target = event.composedPath()[0];
  return consumesTyping(target) || consumesTyping(deepActiveElement());
}

/**
 * Scroll the document to its top or bottom edge, instantly, as vim does.
 */
function scrollToEdge(edge) {
  const scroller = document.scrollingElement ?? document.documentElement;
  const top = edge === "top" ? 0 : scroller.scrollHeight;
  window.scrollTo({ top, left: window.scrollX, behavior: "instant" });
}

/**
 * Page-level commands, keyed by the key sequence that triggers them (as
 * reported by `event.key`, so `G` means shift+g).
 *
 * `run` returns false when the command had nothing to do, in which case no
 * badge is shown.
 */
const COMMANDS = {
  f: {
    label: "Jump",
    hold: true,
    run: () => HintMode.enter(),
  },
  gg: {
    label: "Top of Page",
    run: () => scrollToEdge("top"),
  },
  G: {
    label: "Bottom of Page",
    run: () => scrollToEdge("bottom"),
  },
};

// A multi-key sequence must be completed within this window, like vim's
// `timeoutlen`.
const SEQUENCE_TIMEOUT = 1000;

/**
 * Key-sequence dispatcher: buffers prefix keys (`g` of `gg`) and runs a
 * command once its full sequence has been typed.
 *
 * Prefix keys are left for the page to see — plenty of sites bind their own
 * `g`-prefixed shortcuts — and only a completed command is swallowed.
 */
const Sequence = {
  pending: "",
  timer: null,

  reset() {
    clearTimeout(this.timer);
    this.timer = null;
    this.pending = "";
  },

  /**
   * Feed one key. Returns the matched command, or null.
   */
  feed(key) {
    const sequence = this.pending + key;
    this.reset();

    if (sequence in COMMANDS) return COMMANDS[sequence];

    const isPrefix = Object.keys(COMMANDS).some(
      (name) => name.length > sequence.length && name.startsWith(sequence),
    );
    if (isPrefix) {
      this.pending = sequence;
      this.timer = setTimeout(() => this.reset(), SEQUENCE_TIMEOUT);
    }

    return null;
  },
};

function onKeyDown(event) {
  if (HintMode.active) return;
  if (event.repeat) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  // Modifier and navigation keys aren't part of any sequence; ignore them
  // without disturbing a pending prefix (shift is pressed on the way to `G`).
  if (event.key.length !== 1) return;

  if (isTyping(event)) {
    Sequence.reset();
    return;
  }

  const command = Sequence.feed(event.key);
  if (!command) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  if (command.run() === false) return;
  Badge.show(command.label, { hold: command.hold });
}

window.addEventListener("keydown", onKeyDown, true);
