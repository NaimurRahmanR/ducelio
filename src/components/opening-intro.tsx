"use client";

import { useLayoutEffect, useRef } from "react";

// The public homepage's one-off opening scene. It is purely presentational:
// it holds no state beyond a per-tab "seen" flag and never gates the page.
//
// Lifecycle, carried on the element's data-intro attribute (never rendered by
// React, so the DOM is the single source of truth):
//   (absent)  -> server default; CSS keeps the overlay display:none, so the
//                homepage is fully usable without JavaScript.
//   "play"    -> CSS timeline runs and dissolves itself to visibility:hidden,
//                even if React never hydrates.
//   "leaving" -> short fade after Skip intro / Escape / focus leaving it.
//   "skip" | "done" -> display:none.
// The decision runs in an inline script before first paint on full page
// loads, and in a layout effect (also before paint) on client navigations.
const ELEMENT_ID = "ducelio-opening";
const SEEN_KEY = "ducelio:opening-seen";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
// Matches the CSS timeline (2.75s dissolve delay + 0.5s dissolve = 3.25s)
// plus slack, so the overlay is always removed even if animationend never
// fires.
const SAFETY_MS = 3600;
const LEAVE_MS = 300;

const DECIDE_SCRIPT = `(function(){var e=document.getElementById(${JSON.stringify(ELEMENT_ID)});if(!e)return;var p="skip";try{if(!window.matchMedia(${JSON.stringify(REDUCED_MOTION)}).matches&&!window.sessionStorage.getItem(${JSON.stringify(SEEN_KEY)})){window.sessionStorage.setItem(${JSON.stringify(SEEN_KEY)},"1");p="play"}}catch(x){p="skip"}e.setAttribute("data-intro",p)})()`;

// Same rule as DECIDE_SCRIPT. Unavailable storage means no intro rather than
// an intro on every visit.
function decide(): "play" | "skip" {
  try {
    if (window.matchMedia(REDUCED_MOTION).matches) return "skip";
    if (window.sessionStorage.getItem(SEEN_KEY)) return "skip";
    window.sessionStorage.setItem(SEEN_KEY, "1");
    return "play";
  } catch {
    return "skip";
  }
}

// React warns when rendering <script> on the client; the client copy is inert
// text/plain and suppressHydrationWarning accepts the server's type.
function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function OpeningIntro() {
  const ref = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Hard loads were decided by the inline script; client navigations were
    // not. A Strict Mode re-run sees the attribute and does not decide twice.
    const current = el.dataset.intro;
    if (current === "leaving") el.dataset.intro = "done";
    else if (current !== "play" && current !== "skip" && current !== "done")
      el.dataset.intro = decide();
    if (el.dataset.intro !== "play") return;

    const timers: number[] = [];
    const teardown = () => {
      timers.forEach((id) => window.clearTimeout(id));
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("animationend", onAnimationEnd);
      el.removeEventListener("click", leave);
    };
    const finish = () => {
      el.dataset.intro = "done";
      teardown();
    };
    const leave = () => {
      if (el.dataset.intro !== "play") return;
      el.dataset.intro = "leaving";
      timers.push(window.setTimeout(finish, LEAVE_MS));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") leave();
    };
    // Keyboard users who tab past the intro are moving on: never hold focus.
    const onFocusIn = (event: FocusEvent) => {
      if (!el.contains(event.target as Node | null)) leave();
    };
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.target === el && event.animationName === "opening-dissolve")
        finish();
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    el.addEventListener("animationend", onAnimationEnd);
    // Skip intro's click bubbles here; a click anywhere on the scene skips.
    el.addEventListener("click", leave);
    timers.push(window.setTimeout(finish, SAFETY_MS));

    // Offer Skip intro to keyboard and screen-reader users, unless they have
    // already moved into the page before hydration.
    const active = document.activeElement;
    if (active && active !== document.body && !el.contains(active)) leave();
    else skipRef.current?.focus({ preventScroll: true });

    return teardown;
  }, []);

  return (
    <>
      <div
        id={ELEMENT_ID}
        ref={ref}
        className="opening"
        suppressHydrationWarning
      >
        <div className="opening-stage" aria-hidden="true">
          <span className="opening-light" />
          <span className="opening-mark">D</span>
          <span className="opening-wordmark">DUCELIO</span>
          <span className="opening-tagline">
            An intelligent academy{" "}
            <span className="opening-gold">designed for you.</span>
          </span>
          <span className="opening-accent" />
        </div>
        <button ref={skipRef} type="button" className="opening-skip">
          Skip intro
        </button>
      </div>
      <InlineScript html={DECIDE_SCRIPT} />
    </>
  );
}
