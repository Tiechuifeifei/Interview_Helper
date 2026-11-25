# Interview Coach

Practice tool for one-way video interviews (the HireVue kind), built for Treetree Studio coaching.

Students practise with one of two AI partners. The AI comments only on **what they said**. Visible
and audible behaviour (eye contact, blinks, smiles, pauses, pitch) is **measured, never interpreted
as emotion**, and the detailed measurements go to a human coach, who decides what to tell the student.

```
student records → browser measures delivery + AI reads transcript → coach reviews → student gets feedback
```

## Two modes

| | Assessor (`expert.html`) | Friend (`peer.html`) |
|---|---|---|
| Feel | Formal, dark, timed. Recreates the pressure of the real thing. | Warm chat app with "Mia". Relaxed. |
| Camera | Required. Must stay inside the frame guide; leaving it is flagged. | Optional. Voice only is fine. |
| Timing | 30 s preparation, up to 2 min per answer, auto-start | No timer pressure (3 min cap) |
| Retakes | None | Unlimited |
| Feedback | At the end, strict assessor notes and 1–5 scores | After every answer, encouraging |
| Pauses | A deliberate wait between questions, like waiting on a real assessor | Typing indicator |

The two AI personas share one set of rules and differ only in voice and standards:
`supabase/functions/_shared/prompts.js`.

## Who sees what

| | Student | Coach |
|---|---|---|
| AI content notes (structure, STAR, relevance, specificity) | ✅ | ✅ (as a draft) |
| Length, pace, filler words, pauses, % looking at camera | ✅ (compared with their last session) | ✅ |
| Blinks, smiling, head movement, pitch and volume variation, in-frame % | ❌ | ✅ |
| Recording with a timeline of pauses / looking away / out of frame | own recordings | ✅ |
| Coach's written feedback | ✅ | writes it |

Nothing reaches a coach until the student presses **Submit to coach**.

### Design rules (keep these when changing the code)
- Content can be **judged**. Delivery can only be **measured**.
- No emotion words in the UI or prompts: never "nervous", "confident", "anxious", "sincere".
- No "normal ranges" for face measurements shown to students. Compare with their own previous
  session instead. Pace is the one exception, because interviewers do notice it.
- The AI evaluates the answer, never the person.

## Run it locally (demo mode)

No accounts needed. Everything stays in your browser (IndexedDB).

```bash
python3 -m http.server 8000
# open http://localhost:8000  (camera access needs localhost or https)
```

Use **Chrome or Edge** for live transcription. On the home page, **Settings** lets you:
- switch between the student and coach views on one device
- paste a Gemini API key for real AI feedback (stored only in that browser, for testing).
  Without a key you get clearly labelled sample feedback.

## Production setup (Supabase + GitHub Pages)

1. **Create a Supabase project** (free tier is fine to start).
2. **SQL Editor** → run `supabase/schema.sql`. It creates the tables, access rules and a private
   `recordings` bucket.
3. **Authentication → Providers**: Email is on by default (magic link).
   **Authentication → URL Configuration**: add your site URL, e.g. `https://<user>.github.io/<repo>/`.
4. **Deploy the AI function** (keeps the Gemini key off the website):
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase secrets set GEMINI_API_KEY=<your key>
   # optional: supabase secrets set GEMINI_MODEL=gemini-3.6-flash
   supabase functions deploy feedback
   ```
5. **Edit `js/config.js`**: set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Settings → API).
   The anon key is meant to be public; the access rules protect the data.
6. **Make yourself a coach**: sign in once on the site, then in the SQL Editor:
   ```sql
   update public.profiles set role = 'coach'
   where id = (select id from auth.users where email = 'you@example.com');
   ```
7. **GitHub Pages**: repo → Settings → Pages → Deploy from branch `main`, folder `/ (root)`.

## Costs (estimates, Nov 2026 prices)

- **AI feedback**: only transcript text is sent. Roughly $0.01–0.02 per answer with a Gemini Flash
  model, so about $0.05–0.10 for a five-answer session.
- **Transcription**: free (browser speech recognition).
- **Face tracking**: free (runs in the browser).
- **Storage**: recordings are 480p at 600 kbps, about 5 MB per minute. The Supabase free tier has
  1 GB of file storage; beyond that a paid plan is needed. Add the retention job below.

## Privacy notes

- **Video and audio recordings** go only to your Supabase storage, readable by the student and, after
  submission, by coaches. They are never sent to the AI.
- **Gemini** receives the question and the transcript text only. Use a paid-tier key in production;
  Google's free tier may use inputs to improve its products.
- **Live transcription**: Chrome's built-in speech recognition is processed by Google's servers.
  Tell students this in your consent notice.
- **Face tracking** (MediaPipe) runs entirely in the browser. The model file is downloaded from Google.
- **Retention**: decide how long recordings are kept (e.g. 90 days) and tell students. `schema.sql`
  includes a commented-out `pg_cron` job for database rows; recordings in storage also need deleting
  (Supabase → Storage lifecycle, or a scheduled function). Students can delete any session themselves.
- Under UK GDPR, face video is personal data. Get clear consent before students submit, and have the
  wording checked by someone qualified before commercial use.

## Known limitations

- Live transcription works in Chrome and Edge only. Safari and Firefox still record, but without
  a transcript. A server-side transcription step could be added later.
- Speech recognition often drops "um" and "uh", so filler counts are an underestimate.
- Measurements depend on lighting, glasses, camera angle and microphone quality. They are shown with
  that caveat.
- Pace is calculated from the transcript and the audio level; very quiet voices may be measured less
  accurately.

## Files

```
index.html, js/home.js        Home, sign-in, settings
expert.html, js/expert.js     Assessor mode
peer.html, js/peer.js         Friend mode
coach.html, js/coach.js       Coach dashboard (video + timeline + measurements + notes)
inbox.html, js/inbox.js       Student's sessions and coach feedback
js/capture.js                 Records one answer and computes metrics + timeline events
js/face.js                    MediaPipe face measurements (no emotion labels)
js/media.js                   Camera, mic, recorder, loudness and pitch
js/speech.js                  Live transcription and text-to-speech
js/ai.js                      Calls the feedback function (or a dev key, or sample feedback)
js/store.js                   Data layer: IndexedDB (demo) or Supabase
js/config.js                  Settings
data/questions.json           35 original HireVue-style questions
supabase/schema.sql           Tables, access rules, storage bucket
supabase/functions/feedback   Edge function that calls Gemini
supabase/functions/_shared    Prompts shared by the function and the browser
vendor/                       MediaPipe and supabase-js, copied from npm
```
