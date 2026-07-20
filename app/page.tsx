import { Search, ShieldCheck } from "lucide-react";
import { PlaceResearch } from "@/components/PlaceResearch";
import { getVerifiedSnapshot } from "@/lib/snapshots";

export default function ResearchHomePage() {
  const initialSnapshot = getVerifiedSnapshot("Taipei 101", "Taipei");
  return (
    <main className="research-shell">
      <nav className="site-nav">
        <div className="brand" aria-label="TripTrace Research">
          <span className="brand-mark">T</span>
          <span>TripTrace Research</span>
        </div>
        <div className="nav-evidence"><ShieldCheck size={14} /><span>Travel-video evidence only</span></div>
      </nav>
      <PlaceResearch initialResult={initialSnapshot} />
      <footer className="landing-footer">
        <span><Search size={12} /> Verified snapshots · seven-day cache</span>
        <span>Evidence-first demo · no database</span>
      </footer>
    </main>
  );
}
