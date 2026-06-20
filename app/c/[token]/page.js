import { getMemberByToken, getMembers, getSettings } from "../../../lib/calendarData";
import FamilyCalendar from "../../../components/FamilyCalendar";

export default async function PersonCalendarPage({ params }) {
  const { token } = await params;

  let currentUser = null;
  let members = [];
  let initialTitle = "Family Calendar";
  let loadError = null;

  try {
    currentUser = await getMemberByToken(token);
    if (currentUser) {
      [members, initialTitle] = await Promise.all([getMembers(), getSettings()]);
    }
  } catch (err) {
    loadError = err;
  }

  if (loadError) {
    return (
      <ErrorScreen
        heading="Couldn't connect"
        message="The calendar's database didn't respond. Double-check that the Supabase URL and key are set correctly in Vercel, then try again."
      />
    );
  }

  if (!currentUser) {
    return (
      <ErrorScreen
        heading="Link not recognized"
        message="This calendar link doesn't match anyone in the family. Double-check the link, or ask whoever set up the calendar to resend it."
      />
    );
  }

  return <FamilyCalendar currentUser={currentUser} members={members} initialTitle={initialTitle} />;
}

function ErrorScreen({ heading, message }) {
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
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>{heading}</h1>
        <p style={{ fontSize: 15, opacity: 0.7, lineHeight: 1.5 }}>{message}</p>
      </div>
    </main>
  );
}
