export default function HomePage() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#FBF9F4",
        color: "#2B2B33",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 360 }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Family Calendar</h1>
        <p style={{ fontSize: 15, opacity: 0.7, lineHeight: 1.5 }}>
          This calendar is accessed through each family member's own private
          link. If you don't have yours yet, ask whoever set this up to share
          it with you.
        </p>
      </div>
    </main>
  );
}
