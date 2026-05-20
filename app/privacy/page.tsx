import LegalFooter from "../components/LegalFooter";

export const metadata = { title: "Privacy Policy — Neural Board" };

export default function PrivacyPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#f5f1e8", fontFamily: "'Courier New', monospace", display: "flex", flexDirection: "column" }}>
      <main style={{ maxWidth: 720, width: "100%", margin: "0 auto", padding: "48px 32px 64px", flex: 1 }}>

        <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 42, color: "#2a2a2a", marginBottom: 4 }}>
          Privacy Policy
        </h1>
        <p style={{ fontSize: 11, color: "#6a6a6a", marginBottom: 8, letterSpacing: 0.5 }}>
          NEURAL BOARD
        </p>
        <p style={{ fontSize: 11, color: "#6a6a6a", marginBottom: 40, letterSpacing: 0.5 }}>
          Effective Date: May 19, 2026
        </p>

        <p style={{ fontSize: 13, color: "#2a2a2a", lineHeight: 1.7, marginBottom: 32 }}>
          Neural Board is operated by Ben Benson as a sole proprietorship. This policy explains what data we collect, how we use it, and your rights.
        </p>

        <Section title="What We Collect">
          <p>When you sign in with Google OAuth, we receive your <strong>email address and basic Google profile</strong> (name, profile photo). We store your email to identify your account.</p>
          <p style={{ marginTop: 12 }}>When you use the service, we store:</p>
          <ul style={{ marginTop: 8, paddingLeft: 20, lineHeight: 2 }}>
            <li><strong>Audio recordings</strong> you upload for narration</li>
            <li><strong>Images</strong> you add to your projects</li>
            <li>Your subscription status and billing period (but not your payment card — Stripe handles that)</li>
            <li>Basic usage logs (feature activity, error logs) to keep the service running</li>
          </ul>
          <p style={{ marginTop: 12 }}>We never see or store your credit card number or full payment details.</p>
        </Section>

        <Section title="How We Use Your Data">
          <p>Your data is used to provide the service: authenticate your account, process your audio into video, store your projects, and manage your subscription. We don&apos;t sell your data or use it for advertising.</p>
        </Section>

        <Section title="Third-Party Services">
          <p>We rely on the following third parties to operate Neural Board:</p>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={thStyle}>Service</th>
                <th style={thStyle}>What they do</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Google OAuth", "Handles sign-in — we receive your email and basic profile."],
                ["Stripe", "Processes payments. They store your card; we never see it."],
                ["OpenAI", "Transcribes your audio via Whisper and processes narration. Your audio recordings are sent to OpenAI for transcription."],
                ["Supabase", "Hosts our database — stores your account info and subscription state."],
                ["Vercel", "Hosts the Neural Board application and serves the website."],
              ].map(([name, desc]) => (
                <tr key={name}>
                  <td style={tdStyle}><strong>{name}</strong></td>
                  <td style={tdStyle}>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: 12 }}>Each of these services has their own privacy policy governing how they handle data.</p>
        </Section>

        <Section title="Cookies">
          <p>We use session cookies and authentication tokens to keep you signed in. We don&apos;t use third-party tracking or advertising cookies.</p>
        </Section>

        <Section title="Your Rights">
          <p>You can request deletion of your account and data at any time by emailing <a href="mailto:bbtvhq@gmail.com" style={{ color: "#2a2a2a" }}>bbtvhq@gmail.com</a>. You can also request an export of the data we hold about you by emailing the same address.</p>
          <p style={{ marginTop: 12 }}>We&apos;ll respond to these requests within 30 days.</p>
        </Section>

        <Section title="Data Retention">
          <p>We keep your data for as long as your account is active. When you request account deletion, we remove your data from our systems. Some data may remain in backups for a short period before being purged.</p>
        </Section>

        <Section title="Children">
          <p>Neural Board is not intended for children under 13. We don&apos;t knowingly collect personal information from anyone under 13. If you believe a child has created an account, contact us and we&apos;ll remove it promptly.</p>
        </Section>

        <Section title="Changes to This Policy">
          <p>If we make material changes to this policy, we&apos;ll notify you by email before the changes take effect.</p>
        </Section>

        <p style={{ fontSize: 11, color: "#6a6a6a", marginTop: 48, letterSpacing: 0.5 }}>
          Questions? Email <a href="mailto:bbtvhq@gmail.com" style={{ color: "#6a6a6a" }}>bbtvhq@gmail.com</a>
        </p>
      </main>
      <LegalFooter />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontFamily: "'Caveat', cursive", fontSize: 22, color: "#2a2a2a", marginBottom: 10 }}>
        {title}
      </h2>
      <div style={{ fontSize: 13, color: "#2a2a2a", lineHeight: 1.7 }}>
        {children}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "8px 12px", background: "#ede8dc",
  border: "1px solid #d0c9b8", fontFamily: "'Courier New', monospace",
  fontSize: 11, letterSpacing: 0.5, fontWeight: 700,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px", border: "1px solid #d0c9b8",
  verticalAlign: "top", lineHeight: 1.6,
};
