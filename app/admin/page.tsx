import { getServerSession } from "next-auth";
import { authOptions, ADMIN_EMAIL } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getAllUsers, getRecentEvents } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  if (session?.user?.email !== ADMIN_EMAIL) {
    redirect("/");
  }

  const [users, events] = await Promise.all([getAllUsers(), getRecentEvents(300)]);

  const renderCountByEmail: Record<string, number> = {};
  for (const e of events) {
    if (e.event === "render") {
      renderCountByEmail[e.email] = (renderCountByEmail[e.email] ?? 0) + 1;
    }
  }

  const eventBadge: Record<string, string> = {
    login: "🔑",
    transcribe: "🎙️",
    render: "🎬",
    download: "⬇️",
  };

  return (
    <main style={{ padding: 32, fontFamily: "'Courier New', monospace", background: "#f5f1e8", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 32 }}>
        <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 36, margin: 0, color: "#2a2a2a" }}>Neural Board</h1>
        <span style={{ fontSize: 12, color: "#6a6a6a", letterSpacing: 1 }}>/ ADMIN</span>
      </div>

      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1, marginBottom: 12, color: "#2a2a2a" }}>
          USERS ({users.length})
        </h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: "white", border: "1.5px solid #2a2a2a" }}>
            <thead>
              <tr style={{ background: "#2a2a2a", color: "white" }}>
                <Th>Email</Th>
                <Th>Name</Th>
                <Th>First Seen</Th>
                <Th>Last Seen</Th>
                <Th>Renders</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const renders = renderCountByEmail[u.email] ?? 0;
                return (
                  <tr key={u.email} style={{ borderBottom: "1px solid #eee" }}>
                    <Td>{u.email}</Td>
                    <Td>{u.name ?? "—"}</Td>
                    <Td>{fmtDate(u.first_seen)}</Td>
                    <Td>{fmtDate(u.last_seen)}</Td>
                    <Td>{renders}</Td>
                    <Td>
                      <span style={{
                        padding: "2px 8px",
                        fontSize: 10,
                        fontWeight: 700,
                        background: renders > 0 ? "#ffd6d6" : "#d6ffd6",
                        border: "1px solid #2a2a2a",
                        letterSpacing: 0.5,
                      }}>
                        {renders > 0 ? "USED" : "FREE"}
                      </span>
                    </Td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={6} style={tdStyle}>No users yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1, marginBottom: 12, color: "#2a2a2a" }}>
          RECENT EVENTS ({events.length})
        </h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: "white", border: "1.5px solid #2a2a2a" }}>
            <thead>
              <tr style={{ background: "#2a2a2a", color: "white" }}>
                <Th>Time</Th>
                <Th>Email</Th>
                <Th>Event</Th>
                <Th>Duration</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} style={{ borderBottom: "1px solid #eee" }}>
                  <Td>{fmtDate(e.created_at)}</Td>
                  <Td>{e.email}</Td>
                  <Td>{eventBadge[e.event] ?? ""} {e.event}</Td>
                  <Td>{e.duration_seconds != null ? `${Number(e.duration_seconds).toFixed(1)}s` : "—"}</Td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr><td colSpan={4} style={tdStyle}>No events yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "8px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, whiteSpace: "nowrap" }}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={tdStyle}>{children}</td>;
}

const tdStyle: React.CSSProperties = { padding: "8px 14px", fontSize: 12 };

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
