import type { Reconciliation } from "../api";
import { formatKobo } from "../money";

export function ReconciliationPanel({ report }: { report: Reconciliation | null }) {
  if (!report) return <section className="panel"><h2>Reconciliation</h2><p className="hint">Checking…</p></section>;
  const mismatched = report.accounts.filter((a) => !a.matches);

  return (
    <section className="panel recon" aria-labelledby="recon-title">
      <h2 id="recon-title">Reconciliation</h2>
      <p className="hint">
        Balances are updated as each payment posts. This check recomputes every balance from the raw postings and
        confirms nothing drifted.
      </p>
      <dl className="recon-figures">
        <div>
          <dt>Trial balance</dt>
          <dd className={report.trial_balance === 0 ? "zero" : "nonzero"}>{formatKobo(report.trial_balance)}</dd>
        </div>
        <div>
          <dt>Accounts checked</dt>
          <dd>{report.accounts.length}</dd>
        </div>
        <div>
          <dt>Postings</dt>
          <dd>{report.accounts.reduce((n, a) => n + a.postings, 0)}</dd>
        </div>
      </dl>
      <p className={`verdict ${report.balanced ? "good" : "bad"}`}>
        {report.balanced
          ? "Books balance. Every stored balance matches its postings."
          : `${mismatched.length} account(s) don't match their postings: ${mismatched.map((a) => a.name).join(", ")}.`}
      </p>
    </section>
  );
}
