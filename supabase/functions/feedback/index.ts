// Supabase Edge Function: receives a transcript, asks Gemini for content
// feedback in the expert or peer persona, returns JSON.
// The Gemini key stays on the server: `supabase secrets set GEMINI_API_KEY=...`
// Only signed-in users can call this (Supabase checks the JWT by default).
import { PERSONAS, buildUserMessage, MAX_TRANSCRIPT_CHARS } from '../_shared/prompts.js';

const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.6-flash';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return json({ error: 'GEMINI_API_KEY is not set' }, 500);

  let p: Record<string, unknown>;
  try { p = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const mode = p.mode === 'peer' ? 'peer' : 'expert';
  const input = {
    question: String(p.question ?? '').slice(0, 500),
    category: String(p.category ?? '').slice(0, 60),
    transcript: String(p.transcript ?? '').slice(0, MAX_TRANSCRIPT_CHARS),
    answerSeconds: Number(p.answerSeconds) || null,
    durationSeconds: Number(p.durationSeconds) || 0,
  };
  if (!input.question) return json({ error: 'Missing question' }, 400);

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PERSONAS[mode] }] },
      contents: [{ role: 'user', parts: [{ text: buildUserMessage(input) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: mode === 'peer' ? 0.8 : 0.3 },
    }),
  });
  if (!res.ok) return json({ error: `Gemini ${res.status}`, detail: (await res.text()).slice(0, 300) }, 502);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((x: { text?: string }) => x.text ?? '').join('') ?? '{}';
  try { return json(JSON.parse(text)); }
  catch { return json({ error: 'Model returned invalid JSON' }, 502); }
});
