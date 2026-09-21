import { redirect } from "next/navigation";

// The world is an overlay on the editor page, not a separate route: going from the world into a
// region is then a camera zoom over the same page instead of a page load. This route only exists so
// /world is a working address (bookmarks, the nav link, deep links).
export default function WorldPage() {
  redirect("/board2?world=1");
}
