import { redirect } from "next/navigation";
// PR13 section 12: the public journey starts at the course catalogue, not
// a bare sign-in wall.
export default function Home() {
  redirect("/courses");
}
