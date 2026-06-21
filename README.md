# Family Calendar — deployment guide1

This is the real, database-backed version of the family calendar. Follow
these steps in order.

## 1. Database (if you haven't already)

In your Supabase project → SQL Editor, run `supabase-schema-v2.sql`
(included alongside this project, one folder up from where you got this
zip). At the bottom it prints each family member's private link — copy
those down, you'll need them in step 5.

## 2. Put this code on GitHub (no command line needed)

1. Unzip this project on your computer.
2. Go to github.com → click the **+** in the top right → **New repository**.
   Name it something like `family-calendar`, keep it Private, click
   **Create repository**.
3. On the new repo's page, click **uploading an existing file**.
4. Drag the *contents* of the unzipped folder in (the `app`, `lib`,
   `components` folders and the loose files like `package.json`) — not the
   zip itself, and not the outer folder, just what's inside it.
5. Scroll down, click **Commit changes**.

## 3. Import into Vercel

1. In Vercel, click **Add New… → Project**.
2. Find your `family-calendar` repo in the list and click **Import**.
3. Before clicking Deploy, open **Environment Variables** and add two:
   - `NEXT_PUBLIC_SUPABASE_URL` → your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → your Supabase anon/public key
4. Click **Deploy**. This takes about a minute.

## 4. Get your live URL

Once deployed, Vercel shows you a URL like
`https://family-calendar-yourname.vercel.app`. That's your app's address.

## 5. Share each person's link

Each family member's link is:

```
https://your-vercel-url.vercel.app/c/<their-link-token>
```

Using the tokens from step 1, text or AirDrop each person their own link.
Tell them to save it (e.g. add it to their phone's home screen) — that
link is how the app knows who they are every time they open it.

## Notes

- The free Supabase tier pauses your project after 7 days with no
  activity — if that happens, just click "Resume" in the Supabase
  dashboard.
- The "Soccer/Wife/Kids" text parser still matches a fixed set of
  keywords. If you rename family members or add more, the parser's
  keyword matching in `components/FamilyCalendar.jsx` needs a matching
  update — flag this if you want help with it.
