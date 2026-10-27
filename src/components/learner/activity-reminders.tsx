"use client";
import { useEffect, useState } from "react";
import type { ActivityKind } from "@/domain/learner-contract";
import { KIND_LABEL, formatDateTime } from "./learner-format";

// Activity reminders (docs/61 §4): browser push 15 minutes before each
// scheduled activity, with the same reminders listed in-app whether or not
// push is enabled or delivered. Push is offered only when the server holds
// a VAPID key pair; live delivery is unverified until tested on a device.
export type UpcomingReminder = {
  itemId: string;
  courseTitle: string;
  kind: ActivityKind;
  part: number;
  parts: number;
  startsAt: string;
  remindAt: string;
  dueNow: boolean;
};

type PushState =
  "checking" | "unsupported" | "blocked" | "off" | "on" | "unconfigured";

const SW_PATH = "/sw.js";

function applicationServerKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
  return registration ? registration.pushManager.getSubscription() : null;
}

export function ActivityReminders({
  publicKey,
  upcoming,
  timeZone = "UTC",
  subscribeAction,
  unsubscribeAction,
}: {
  publicKey: string | null; // null when push is not configured on the server
  upcoming: UpcomingReminder[] | null; // null when the list could not load
  timeZone?: string;
  subscribeAction: (
    subscription: unknown,
  ) => Promise<{ ok: boolean; code?: string; remindersScheduled?: number }>;
  unsubscribeAction: (
    endpoint: unknown,
  ) => Promise<{ ok: boolean; removed?: boolean }>;
}) {
  const [state, setState] = useState<PushState>(
    publicKey ? "checking" : "unconfigured",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey) return;
    let live = true;
    const supported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    const settle = (next: PushState) => {
      if (live) setState(next);
    };
    if (!supported) {
      queueMicrotask(() => settle("unsupported"));
    } else if (Notification.permission === "denied") {
      queueMicrotask(() => settle("blocked"));
    } else {
      currentSubscription().then(
        (subscription) => settle(subscription ? "on" : "off"),
        () => settle("off"),
      );
    }
    return () => {
      live = false;
    };
  }, [publicKey]);

  const turnOn = async () => {
    if (!publicKey) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        setError("Notifications were not allowed in this browser.");
        return;
      }
      const registration = await navigator.serviceWorker.register(SW_PATH, {
        scope: "/",
      });
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        }));
      const result = await subscribeAction(subscription.toJSON());
      if (!result.ok) {
        await subscription.unsubscribe().catch(() => undefined);
        setState("off");
        setError("Reminders could not be turned on. Try again later.");
        return;
      }
      setState("on");
      setMessage(
        `Reminders are on for this browser (${result.remindersScheduled ?? 0} scheduled).`,
      );
    } catch {
      setError("Reminders could not be turned on in this browser.");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const subscription = await currentSubscription();
      if (subscription) {
        await unsubscribeAction(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("off");
      setMessage("Reminders are off for this browser.");
    } catch {
      setError("Reminders could not be turned off. Try again later.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ln-panel" aria-labelledby="ln-reminders-heading">
      <h2 id="ln-reminders-heading">Activity reminders</h2>
      <p className="ln-muted">
        A reminder is sent 15 minutes before each scheduled class, practical,
        revision session and assessment.
      </p>
      {state === "unconfigured" && (
        <p>
          Browser notifications are not set up on this server yet. Your upcoming
          reminders are listed below.
        </p>
      )}
      {state === "unsupported" && (
        <p>
          This browser does not support notifications. Your upcoming reminders
          are listed below.
        </p>
      )}
      {state === "blocked" && (
        <p>
          Notifications are blocked for this site. Allow them in your browser
          settings to receive reminders.
        </p>
      )}
      {state === "off" && (
        <button className="button" onClick={turnOn} disabled={busy}>
          Turn on browser reminders
        </button>
      )}
      {state === "on" && (
        <button className="button secondary" onClick={turnOff} disabled={busy}>
          Turn off browser reminders
        </button>
      )}
      <div aria-live="polite">
        {error && (
          <p className="ln-feedback is-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="ln-feedback" role="status">
            {message}
          </p>
        )}
      </div>
      <h3>Upcoming reminders</h3>
      {upcoming === null ? (
        <p role="status">Your reminders could not be loaded.</p>
      ) : upcoming.length === 0 ? (
        <p className="ln-empty-line">No activities in the next 7 days.</p>
      ) : (
        <ul className="ln-reminder-list">
          {upcoming.map((r) => (
            <li key={r.itemId}>
              <strong>{r.courseTitle}</strong> · {KIND_LABEL[r.kind]}
              {r.parts > 1 ? ` (part ${r.part} of ${r.parts})` : ""} · starts{" "}
              {formatDateTime(r.startsAt, timeZone)}
              {r.dueNow && <span className="ln-muted"> · starting soon</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
