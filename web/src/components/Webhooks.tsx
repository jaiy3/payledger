import { useEffect, useState } from "react";
import { call, type Delivery, type Endpoint } from "../api";

const statusLabel: Record<Delivery["status"], string> = {
  pending: "Queued",
  sending: "Sending",
  retrying: "Retrying",
  succeeded: "Delivered",
  dead: "Gave up",
};

function retryIn(iso: string | null, now: number) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return s === 0 ? "due now" : `in ${s}s`;
}

export function Webhooks({
  deliveries,
  endpoint,
  onChange,
}: {
  deliveries: Delivery[];
  endpoint: Endpoint | null;
  onChange: () => Promise<void>;
}) {
  const [rate, setRate] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const currentRate = rate ?? Math.round((endpoint?.simulated_failure_rate ?? 0) * 100);

  const saveRate = async (value: number) => {
    if (!endpoint) return;
    await call("PATCH", `/v1/webhooks/endpoints/${endpoint.id}`, { body: { simulated_failure_rate: value / 100 } });
    setRate(null);
    await onChange();
  };

  const retry = async (id: string) => {
    await call("POST", `/v1/webhooks/deliveries/${id}/retry`);
    await onChange();
  };

  const counts = deliveries.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }), {});

  return (
    <section className="panel webhooks" aria-labelledby="webhooks-title">
      <h2 id="webhooks-title">Webhooks</h2>
      <p className="hint">
        Each payment queues a signed <code>transfer.completed</code> or <code>deposit.completed</code> event in the same
        database transaction. A built-in receiver checks the signature and fails on purpose some of the time, so you can
        watch retries back off.
      </p>
      <label className="slider">
        <span>
          Receiver failure rate <strong>{currentRate}%</strong>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={10}
          value={currentRate}
          onChange={(e) => setRate(Number(e.target.value))}
          onPointerUp={(e) => saveRate(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => saveRate(Number((e.target as HTMLInputElement).value))}
        />
      </label>
      <p className="counts">
        {(["succeeded", "retrying", "dead"] as const).map((s) => (
          <span key={s} className={`pill pill-${s}`}>
            {statusLabel[s]} {counts[s] ?? 0}
          </span>
        ))}
      </p>
      <div className="table-scroll">
        <table className="deliveries">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">Attempts</th>
              <th scope="col">Last response</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {deliveries.length === 0 && (
              <tr>
                <td colSpan={5} className="hint">No deliveries yet.</td>
              </tr>
            )}
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.event_type}</td>
                <td>
                  <span className={`pill pill-${d.status}`}>{statusLabel[d.status]}</span>{" "}
                  {d.status === "retrying" && <span className="muted">{retryIn(d.next_attempt_at, now)}</span>}
                </td>
                <td className="num">{d.attempts}</td>
                <td className="mono muted">{d.last_status_code ?? (d.last_error ? "error" : "")}</td>
                <td>
                  {(d.status === "dead" || d.status === "retrying") && (
                    <button className="link-btn" onClick={() => retry(d.id)}>
                      Retry now
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
