// CP2 exam-engine acceptance: a minimal, dependency-free Chrome DevTools
// Protocol driver (Node's built-in WebSocket and fetch only; no browser
// automation package is added to the project). It launches the operator's
// installed Chrome headless with a throwaway profile on loopback, drives the
// REAL Ducelio UI with real input events, and reads the live DOM.
//
// It never reads cookies, tokens or storage for output, never logs page
// text, and the throwaway profile (which holds the signed-in session) is
// deleted on close.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";

export function verifiedBrowserProfilePath(profile, temporaryRoot = tmpdir()) {
  const target = resolve(profile);
  if (
    dirname(target) !== resolve(temporaryRoot) ||
    !/^ducelio-cp2-chrome-[A-Za-z0-9]+$/.test(basename(target))
  )
    throw new Error(
      "Refusing browser-profile cleanup outside its temporary directory.",
    );
  return target;
}
function removeBrowserProfile(profile) {
  const target = verifiedBrowserProfilePath(profile);
  if (lstatSync(target).isSymbolicLink())
    throw new Error("Refusing browser-profile symlink cleanup.");
  rmSync(target, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = {
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
};

export async function launchBrowser({
  chromePath,
  width = 1280,
  height = 1000,
  port = 9300 + Math.floor(Math.random() * 600),
} = {}) {
  if (!chromePath) throw new Error("A Chrome executable path is required.");
  const profile = mkdtempSync(join(tmpdir(), "ducelio-cp2-chrome-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const consoleErrors = [];
  let ws;
  let id = 0;
  const pending = new Map();
  for (let i = 0; i < 150 && !ws; i++) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const target = targets.find((t) => t.type === "page");
      if (target) {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.onopen = resolve;
          socket.onerror = reject;
        });
        socket.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
          if (msg.method === "Runtime.exceptionThrown")
            consoleErrors.push(msg.params.exceptionDetails.text);
          if (
            msg.method === "Runtime.consoleAPICalled" &&
            msg.params.type === "error"
          )
            consoleErrors.push("console.error");
        };
        ws = socket;
      }
    } catch {
      // Chrome is still starting.
    }
    if (!ws) await sleep(100);
  }
  if (!ws) {
    chrome.kill();
    removeBrowserProfile(profile);
    throw new Error("Chrome did not start.");
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  // Headless Chrome on Windows imposes a minimum outer window width. Set
  // the actual CSS viewport independently so a 390px check is really 390px.
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails)
      throw new Error(
        `Page evaluation failed: ${r.result.exceptionDetails.text}`,
      );
    return r.result?.result?.value;
  };
  const waitFor = async (expression, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        // Mid-navigation: the context is being replaced.
      }
      await sleep(100);
    }
    return false;
  };
  const page = {
    consoleErrors,
    evaluate,
    waitFor,
    async goto(url, readyExpression = "document.readyState === 'complete'") {
      await send("Page.navigate", { url });
      await sleep(300);
      return waitFor(readyExpression, 30000);
    },
    async reload(readyExpression = "document.readyState === 'complete'") {
      await send("Page.reload", { ignoreCache: true });
      await sleep(300);
      return waitFor(readyExpression, 30000);
    },
    url: () => evaluate("location.pathname + location.search"),
    text: () => evaluate("document.body ? document.body.innerText : ''"),
    html: () => evaluate("document.documentElement.outerHTML"),
    async press(name) {
      const k = KEYS[name];
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        ...k,
        text: undefined,
      });
      await sleep(40);
    },
    async insertText(text) {
      await send("Input.insertText", { text });
      await sleep(40);
    },
    // Focus `selectorExpr` (a JS expression yielding an element) and type.
    async typeInto(elementExpression, text) {
      const ok = await evaluate(
        `(() => { const el = ${elementExpression}; if (!el) return false; el.focus(); if ('value' in el) el.select?.(); return document.activeElement === el; })()`,
      );
      if (!ok) throw new Error("Field not found or not focusable.");
      await this.insertText(text);
    },
    // Click an element via real mouse events at its centre.
    async click(elementExpression) {
      const box = await evaluate(
        `(() => { const el = ${elementExpression}; if (!el || el.disabled) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (!box) throw new Error("Element not found or disabled.");
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          x: box.x,
          y: box.y,
          button: "left",
          clickCount: 1,
        });
      await sleep(60);
    },
    // A native <select>: focus it and choose by value through the keyboard
    // path React observes (value setter + input/change events, exactly what a
    // keyboard selection dispatches).
    async select(elementExpression, value) {
      const ok = await evaluate(
        `(() => { const el = ${elementExpression}; if (!el || el.disabled) return false; el.focus();
          const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
          set.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return el.value === ${JSON.stringify(value)}; })()`,
      );
      if (!ok) throw new Error("Select not found or value unavailable.");
      await sleep(60);
    },
    async screenshot(path) {
      const r = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      writeFileSync(path, Buffer.from(r.result.data, "base64"));
    },
    async uploadFile(selector, filePath) {
      const doc = await send("DOM.getDocument");
      const found = await send("DOM.querySelector", {
        nodeId: doc.result.root.nodeId,
        selector,
      });
      if (!found.result?.nodeId) throw new Error("File input not found.");
      await send("DOM.setFileInputFiles", {
        nodeId: found.result.nodeId,
        files: [resolve(filePath)],
      });
    },
  };
  const close = async () => {
    try {
      ws.close();
    } catch {
      // already closed
    }
    chrome.kill();
    await sleep(300);
    removeBrowserProfile(profile);
  };
  return { page, close };
}

// ---------------------------------------------------------------------------
// Ducelio UI steps (selectors are the real components' DOM contract).
// ---------------------------------------------------------------------------
const js = JSON.stringify;
export const byButtonText = (label) =>
  `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${js(label)})`;
const byLabelText = (scope, label) =>
  `(() => { const l = [...${scope}.querySelectorAll('label')].find((x) => x.textContent.trim() === ${js(label)}); return l && document.getElementById(l.htmlFor); })()`;
const PANEL = "document.querySelector('.exam-main')";

// Bind the browser to the exact assessment in the new run. A title alone
// cannot distinguish the main course from the review course or older runs.
export function assessmentCardSelector(assessmentId, title) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(assessmentId))
    throw new Error("Invalid synthetic assessment ID.");
  return `[...document.querySelectorAll('.support-record')].find((c) => c.querySelector('input[name="assessmentId"]')?.value === ${js(assessmentId)} && c.querySelector('h3')?.textContent.trim() === ${js(title)})`;
}

// Real sign-in through the app's own /login page (Supabase Auth). The
// password is typed into the field and never logged.
export async function signInThroughUi(page, baseUrl, email, password) {
  await page.goto(
    `${baseUrl}/login`,
    "!!document.querySelector('input[type=email], input[name=email]')",
  );
  // SSR fields can be visible before their React actions have hydrated,
  // especially on the first development compilation. Wait for the actual
  // client binding before typing so hydration cannot discard the input.
  if (
    !(await page.waitFor(
      "Object.keys(document.querySelector('input[name=email]') ?? {}).some(k => k.startsWith('__reactProps$'))",
      30000,
    ))
  )
    throw new Error("Sign-in form did not hydrate.");
  await page.typeInto(
    "document.querySelector('input[type=email], input[name=email]')",
    email,
  );
  await page.typeInto(
    "document.querySelector('input[type=password], input[name=password]')",
    password,
  );
  if (
    !(await page.evaluate(
      `document.querySelector('input[name=email]').value === ${js(email)} && document.querySelector('input[name=password]').value.length === ${password.length}`,
    ))
  )
    throw new Error("Sign-in inputs were not retained.");
  await page.click(
    "document.querySelector('input[name=email]')?.form?.querySelector('button[type=submit]')",
  );
  await page.waitFor(
    "!location.pathname.startsWith('/login') || !!document.querySelector('.auth-feedback [role=alert]')",
    30000,
  );
  const signedIn = await page.evaluate(
    "!location.pathname.startsWith('/login')",
  );
  if (!signedIn) {
    const category = await page.evaluate(
      "(() => { const text=document.querySelector('.auth-feedback')?.textContent??''; return text.includes('Enter a valid email')?'INVALID_FORM':text.includes('Unable to sign in')?'AUTH_DENIED':text.includes('verify your email')?'UNVERIFIED':text.includes('awaiting academy')?'NOT_CONFIGURED':'NO_FEEDBACK'; })()",
    );
    throw new Error(`UI sign-in did not complete: ${category}`);
  }
  return true;
}

export async function openQuestion(page, position) {
  await page.click(
    `[...document.querySelectorAll('.exam-nav-item')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Question ${position}:'))`,
  );
  return page.waitFor(
    `(document.querySelector('.exam-nav-item[aria-current=step]')?.getAttribute('aria-label') || '').startsWith('Question ${position}:')`,
  );
}

export async function navStatus(page, position) {
  return page.evaluate(
    `(() => { const b = [...document.querySelectorAll('.exam-nav-item')].find((x) => (x.getAttribute('aria-label') || '').startsWith('Question ${position}:')); return b ? [...b.classList].find((c) => c !== 'exam-nav-item') ?? null : null; })()`,
  );
}

// Enter `response` for `question` (plan shape) in the open question panel.
export async function enterAnswer(page, question, response) {
  const interaction = question.interaction;
  switch (question.questionType) {
    case "SINGLE_SELECT":
      return page.click(
        `${PANEL}.querySelector('input[type=radio][value=${js(response.optionId)}]')`,
      );
    case "MULTIPLE_SELECT":
      for (const option of interaction.options) {
        const want = response.optionIds.includes(option.id);
        const has = await page.evaluate(
          `${PANEL}.querySelector('input[type=checkbox][value=${js(option.id)}]').checked`,
        );
        if (want !== has)
          await page.click(
            `${PANEL}.querySelector('input[type=checkbox][value=${js(option.id)}]')`,
          );
      }
      return;
    case "PBQ_MATCHING":
      for (const item of interaction.items)
        await page.select(
          byLabelText(PANEL, item.label),
          response.matches[item.id],
        );
      return;
    case "PBQ_CONFIGURATION":
      for (const field of interaction.fields)
        await page.select(
          byLabelText(PANEL, field.label),
          response.values[field.id],
        );
      return;
    case "PBQ_ORDERING": {
      const label = (id) => interaction.steps.find((s) => s.id === id).label;
      // Bubble each target step up into place with the real buttons.
      for (let target = 0; target < response.order.length; target++) {
        const wanted = label(response.order[target]);
        for (let guard = 0; guard < 20; guard++) {
          const at = await page.evaluate(
            `[...${PANEL}.querySelectorAll('.exam-order li')].findIndex((li) => li.textContent.includes(${js(wanted)}))`,
          );
          if (at <= target) break;
          await page.click(
            `[...${PANEL}.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${js(`Move "${wanted}" up`)})`,
          );
        }
      }
      return;
    }
    case "FREE_TEXT":
      return page.typeInto(`${PANEL}.querySelector('textarea')`, response);
  }
  throw new Error(`Unknown question type ${question.questionType}`);
}

export async function saveOpenQuestion(page, position) {
  await page.click(`${PANEL}.querySelector('form.exam-actions button')`);
  return page.waitFor(
    `(() => { const b = [...document.querySelectorAll('.exam-nav-item')].find((x) => (x.getAttribute('aria-label') || '').startsWith('Question ${position}:')); return !!b && b.classList.contains('saved'); })()`,
    20000,
  );
}

export async function submitFinalAnswers(page) {
  await page.click(byButtonText("Review and submit"));
  await page.waitFor(`!!${byButtonText("Submit final answers")}`);
  await page.click(byButtonText("Submit final answers"));
  return page.waitFor("!document.querySelector('.exam')", 60000);
}
