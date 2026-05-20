import LegalFooter from "../components/LegalFooter";

export const metadata = { title: "Terms of Service — Neural Board" };

export default function TermsPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#f5f1e8", fontFamily: "'Courier New', monospace", display: "flex", flexDirection: "column" }}>
      <main style={{ maxWidth: 720, width: "100%", margin: "0 auto", padding: "48px 32px 64px", flex: 1 }}>

        <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 42, color: "#2a2a2a", marginBottom: 4 }}>
          Terms of Service
        </h1>
        <p style={{ fontSize: 11, color: "#6a6a6a", marginBottom: 8, letterSpacing: 0.5 }}>
          NEURAL BOARD
        </p>
        <p style={{ fontSize: 11, color: "#6a6a6a", marginBottom: 40, letterSpacing: 0.5 }}>
          Effective Date: May 19, 2026
        </p>

        <p style={{ fontSize: 13, color: "#2a2a2a", lineHeight: 1.7, marginBottom: 32 }}>
          These Terms of Service govern your use of Neural Board, a service operated by Ben Benson as a sole proprietorship. By creating an account or using the service, you agree to these terms.
        </p>

        <Section title="1. The Service">
          <p>Neural Board lets you generate short videos from your voice narration. You record audio, and we transcribe it, process it with AI, and produce a video you can download.</p>
          <p style={{ marginTop: 12 }}>We reserve the right to modify, suspend, or discontinue any part of the service at any time. We&apos;ll give you reasonable notice when possible.</p>
        </Section>

        <Section title="2. Account Creation">
          <p>You sign in with Google OAuth. You must be at least 13 years old to create an account. You&apos;re responsible for all activity that occurs under your account. If you suspect unauthorized use, contact us immediately at bbtvhq@gmail.com.</p>
        </Section>

        <Section title="3. Subscription and Billing">
          <p>Neural Board costs <strong>$10 per month</strong>, billed in advance on a recurring basis. Your subscription renews automatically each month until you cancel.</p>
          <p style={{ marginTop: 12 }}>You can cancel at any time from your account settings or by emailing bbtvhq@gmail.com. Cancellation stops future charges and takes effect at the end of your current billing period — you retain access through that date. We do not issue refunds for charges already made. See our <a href="/refund" style={{ color: "#2a2a2a" }}>Refund Policy</a> for details.</p>
          <p style={{ marginTop: 12 }}>Payments are processed by Stripe. We never see or store your card number.</p>
        </Section>

        <Section title="4. Acceptable Use">
          <p>You agree not to use Neural Board to:</p>
          <ul style={{ marginTop: 8, paddingLeft: 20, lineHeight: 2 }}>
            <li>Upload or generate illegal content of any kind</li>
            <li>Upload audio or images you don&apos;t have the rights to use</li>
            <li>Create content that harasses, threatens, or targets individuals</li>
            <li>Create hate speech or content that discriminates based on protected characteristics</li>
            <li>Create sexual content involving minors — this is strictly prohibited</li>
            <li>Attempt to reverse-engineer, scrape, or abuse the service infrastructure</li>
          </ul>
          <p style={{ marginTop: 12 }}>We may suspend or terminate accounts that violate these rules without prior notice.</p>
        </Section>

        <Section title="5. Your Content">
          <p>You own the content you upload (audio recordings, images). By using Neural Board, you grant us a limited license to process your content solely to provide the service — transcribing audio, generating your video, and storing your files while your account is active.</p>
          <p style={{ marginTop: 12 }}>We don&apos;t claim ownership of your content and won&apos;t use it for any purpose beyond running the service for you.</p>
          <p style={{ marginTop: 12 }}>You&apos;re responsible for the content you upload. We are not liable for user-generated content and we don&apos;t review it proactively.</p>
        </Section>

        <Section title="6. Termination">
          <p>You can close your account at any time by contacting bbtvhq@gmail.com. We may terminate or suspend your account if you violate these terms, engage in fraudulent activity, or if we discontinue the service.</p>
          <p style={{ marginTop: 12 }}>On termination, your access ends and your data will be deleted in accordance with our <a href="/privacy" style={{ color: "#2a2a2a" }}>Privacy Policy</a>.</p>
        </Section>

        <Section title="7. Disclaimer of Warranties">
          <p>Neural Board is provided <strong>&quot;as is&quot;</strong> without warranties of any kind, express or implied. We don&apos;t guarantee that the service will be uninterrupted, error-free, or that the outputs will meet your expectations. Use the service at your own risk.</p>
        </Section>

        <Section title="8. Limitation of Liability">
          <p>To the maximum extent permitted by law, Ben Benson and Neural Board will not be liable for indirect, incidental, special, or consequential damages. Our total liability to you for any claim arising out of your use of the service is capped at the fees you paid to Neural Board in the <strong>12 months preceding the claim</strong>.</p>
        </Section>

        <Section title="9. Changes to These Terms">
          <p>We may update these terms from time to time. If we make material changes, we&apos;ll notify you by email at least 14 days before the changes take effect. Your continued use of the service after that date means you accept the updated terms.</p>
        </Section>

        <Section title="10. Governing Law and Venue">
          <p>These terms are governed by the laws of the <strong>Commonwealth of Virginia, United States</strong>, without regard to conflict-of-law principles. Any disputes will be resolved in the courts of Virginia.</p>
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
