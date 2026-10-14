import { ButtonLink } from "@/components/ui";
export default function NotFound() {
  return (
    <main id="main" tabIndex={-1} className="foundation">
      <h1>That page isn’t here.</h1>
      <p>Return to your academy to find your next step.</p>
      <ButtonLink href="/">Back to Ducelio</ButtonLink>
    </main>
  );
}
