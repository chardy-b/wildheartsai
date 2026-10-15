import Link from "next/link";
import { requireSession } from "@/lib/session";
import { Benchmark } from "./Benchmark";
import "../wildcards.css";

export default async function BenchmarkPage(){
  await requireSession();
  return <section className="app-page wildcards"><Link href="/app/wildcards">← Documents</Link><h1>Extraction benchmark and quality report</h1><p className="lede">Private operational metrics, explicit accuracy limits, and a path to better extraction.</p><p><Link href="/app/wildcards/progress">Processing progress</Link> · <Link href="/app/wildcards/workbench">Visual debugger and experiment history</Link></p><Benchmark /></section>;
}
