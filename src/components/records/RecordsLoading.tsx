import { FaceMark } from "@/components/landing/marks";

// Shown while records are fetched live from each health system.
export function RecordsLoading() {
  return (
    <div className="records-loading" aria-busy="true">
      <div className="loading-orb">
        <FaceMark />
      </div>
      <p className="lede">Gathering your record from each health system.</p>
    </div>
  );
}
