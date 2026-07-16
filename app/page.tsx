import { Search, ShieldCheck } from "lucide-react";
import { PlaceResearch } from "@/components/PlaceResearch";

export default function ResearchHomePage() {
  return (
    <main className="research-shell">
      <nav className="site-nav">
        <div className="brand" aria-label="TripTrace Research">
          <span className="brand-mark">T</span>
          <span>TripTrace Research</span>
        </div>
        <div className="nav-evidence"><ShieldCheck size={14} /><span>Travel-video evidence only</span></div>
      </nav>
      <PlaceResearch />
      <footer className="landing-footer">
        <span><Search size={12} /> On-demand YouTube research · local cache</span>
        <span>Local beta · no database</span>
      </footer>
    </main>
  );
}
