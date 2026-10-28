# Experiences Caribbean — Feedback & Incident Register

Live at https://reports.experiencescaribbean.com

A single page (`index.html`) for guests and staff to report complaints, compliments, accidents, near misses and concerns, plus a post-trip survey. Staff sign in to work cases through to closure. Built to meet the Travelife Certified Standard 2025 (criteria 1.19, 1.21, 1.23, 2.16, 2.19, 10.28–10.30 and others).

- Data is stored in the Supabase project **TravelLife**. All access rules are enforced in the database; the publishable key in the page is meant to be public.
- Hosted with GitHub Pages; `CNAME` sets the custom domain.

Link parameters: `#report`, `#survey`, `#register`, `#dashboard`; `as=staff`; `tour=` or `booking=`; `date=YYYY-MM-DD`.
