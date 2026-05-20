import LegalFooter from "../components/LegalFooter";

export const metadata = { title: "Refund Policy — Neural Board" };

export default function RefundPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#f5f1e8", fontFamily: "'Courier New', monospace", display: "flex", flexDirection: "column" }}>
      <main style={{ maxWidth: 720, width: "100%", margin: "0 auto", padding: "48px 32px 64px", flex: 1 }}>

        <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 42, color: "#2a2a2a", marginBottom: 4 }}>
          Refund Policy
        </h1>
        <p style={{ fontSize: 11, color: "#6a6a6a", marginBottom: 8, letterSpacing: 0.5 }}>
          NEURAL BOARD
        </p>
        <p style={{ fontSize: 11, color: "#6a6a6a", marginBottom: 40, letterSpacing: 0.5 }}>
          Effective Date: May 19, 2026
        </p>

        <div style={{ background: "white", border: "1.5px solid #2a2a2a", padding: 32, marginBottom: 32, boxShadow: "4px 4px 0 #2a2a2a" }}>
          <p style={{ fontSize: 13, color: "#2a2a2a", lineHeight: 1.8, margin: 0 }}>
            Neural Board is a <strong>$10/month subscription</strong>, billed in advance at the start of each billing period.
          </p>
        </div>

        <Section title="Cancellation">
          <p>You can cancel your subscription at any time — no questions asked.</p>
          <p style={{ marginTop: 12 }}>To cancel, go to your account settings and click &quot;Manage subscription,&quot; or email us at <a href="mailto:bbtvhq@gmail.com" style={{ color: "#2a2a2a" }}>bbtvhq@gmail.com</a> and we&apos;ll take care of it.</p>
          <p style={{ marginTop: 12 }}>When you cancel, your access continues through the end of the billing period you&apos;ve already paid for. After that, your subscription ends and you won&apos;t be charged again.</p>
        </Section>

        <Section title="Refunds">
          <p>Because subscriptions are billed in advance, <strong>we don&apos;t issue refunds for charges that have already been made</strong>. Cancelling stops future charges; it doesn&apos;t refund the current period.</p>
          <p style={{ marginTop: 12 }}>We may issue refunds at our discretion in exceptional circumstances — for example, if there was a billing error or a significant service outage. If you think you have a case, email us at <a href="mailto:bbtvhq@gmail.com" style={{ color: "#2a2a2a" }}>bbtvhq@gmail.com</a> and we&apos;ll look into it.</p>
        </Section>

        <Section title="Questions">
          <p>If anything about your billing looks wrong, reach out and we&apos;ll sort it out. We&apos;d rather fix a problem than leave a customer with a bad experience.</p>
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
