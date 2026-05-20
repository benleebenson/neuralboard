export default function LegalFooter() {
  return (
    <footer style={{
      borderTop: "1px solid #d0c9b8",
      padding: "10px 32px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      fontSize: 10,
      color: "#6a6a6a",
      fontFamily: "'Courier New', monospace",
      letterSpacing: 0.5,
      flexWrap: "wrap",
    }}>
      <a href="/terms" style={{ color: "#6a6a6a", textDecoration: "underline" }}>Terms</a>
      <span style={{ margin: "0 4px" }}>·</span>
      <a href="/privacy" style={{ color: "#6a6a6a", textDecoration: "underline" }}>Privacy</a>
      <span style={{ margin: "0 4px" }}>·</span>
      <a href="/refund" style={{ color: "#6a6a6a", textDecoration: "underline" }}>Refunds</a>
      <span style={{ margin: "0 4px" }}>·</span>
      <span>Contact: <a href="mailto:bbtvhq@gmail.com" style={{ color: "#6a6a6a", textDecoration: "underline" }}>bbtvhq@gmail.com</a></span>
    </footer>
  );
}
