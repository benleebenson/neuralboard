import { notFound } from "next/navigation";
import { WorldBench } from "./WorldBench";

// Dev-only harness for measuring the world view against a synthetic fixture (see the header of WorldBench.tsx for how to run it).
export default function WorldBenchPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <WorldBench />;
}
