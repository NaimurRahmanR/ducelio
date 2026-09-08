"use client";
export default function ErrorPage({ reset }: { reset: () => void }) { return <main id="main" className="foundation"><h1>We couldn’t open this page.</h1><p>Your records have not been changed. Please try again.</p><button className="button" onClick={reset}>Try again</button></main>; }
