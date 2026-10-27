/* Ducelio service worker: activity reminders only (no offline caching).
 * A push carries privacy-safe text ("Your class starts in 15 minutes") and a
 * same-origin relative URL; anything else is ignored or replaced. */
const DEFAULT_URL = "/student/timetable";

function safePath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return DEFAULT_URL;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin
      ? url.pathname + url.search
      : DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title =
    typeof data.title === "string" ? data.title.slice(0, 60) : "Ducelio";
  const body =
    typeof data.body === "string"
      ? data.body.slice(0, 160)
      : "Your scheduled activity starts soon";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag:
        typeof data.tag === "string"
          ? data.tag.slice(0, 64)
          : "ducelio-reminder",
      icon: "/apple-icon.png",
      badge: "/apple-icon.png",
      data: { url: safePath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          const url = new URL(client.url);
          if (url.origin === self.location.origin && "focus" in client) {
            if ("navigate" in client) client.navigate(path);
            return client.focus();
          }
        }
        return self.clients.openWindow(path);
      }),
  );
});
