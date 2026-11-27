import { useState, type ReactNode } from 'react';
import { Button } from './ui';

/**
 * Step-by-step guide for making the Google OAuth client the YouTube page needs. The screenshots are
 * real Google Cloud console pages (Nov 2026) with the account's email, avatar, project ID and client
 * values blurred. Google moves things around now and then; the words in each step still apply.
 */
const gc = (path: string) => `https://console.cloud.google.com/${path}`;
const ext = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer" className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-300">{text}</a>;

interface Step { title: string; shot: string; alt: string; body: ReactNode }

const STEPS: Step[] = [
  {
    title: 'Create a Google Cloud project',
    shot: '01-new-project.webp',
    alt: 'Google Cloud project picker with the New project button',
    body: <>Open {ext(gc('projectcreate'), 'Google Cloud console')} and sign in with the Google account that owns your YouTube channel. Click the project picker at the top, then <b>New project</b>. It's free; no billing account is needed.</>,
  },
  {
    title: 'Name it and create it',
    shot: '02-name-project.webp',
    alt: 'New Project form with the name Spikecut',
    body: <>Call it <b>Spikecut</b> (any name works), leave <b>No organization</b>, and click <b>Create</b>. When it's ready, check the picker at the top shows your new project.</>,
  },
  {
    title: 'Turn on the YouTube Data API v3',
    shot: '03-enable-api.webp',
    alt: 'YouTube Data API v3 page with the Enable button',
    body: <>Open the {ext(gc('apis/library/youtube.googleapis.com'), 'YouTube Data API v3')} page (or search for it under APIs &amp; Services → Library) and click <b>Enable</b>.</>,
  },
  {
    title: 'Open the Google Auth Platform',
    shot: '04-get-started.webp',
    alt: 'Google Auth Platform overview with the Get started button',
    body: <>Go to {ext(gc('auth/overview'), 'Google Auth Platform')} (this is what Google used to call the OAuth consent screen) and click <b>Get started</b>.</>,
  },
  {
    title: 'App information',
    shot: '05-app-info.webp',
    alt: 'App Information step with the app name and support email',
    body: <>App name: <b>Spikecut</b>. User support email: pick your own email. Click <b>Next</b>.</>,
  },
  {
    title: 'Audience: External',
    shot: '06-audience.webp',
    alt: 'Audience step with External selected',
    body: <>Choose <b>External</b> and click <b>Next</b>. (Internal only exists for Google Workspace organisations.) Your app stays private: only the test users you add can sign in.</>,
  },
  {
    title: 'Contact information',
    shot: '07-contact.webp',
    alt: 'Contact Information step with an email address',
    body: <>Type your email so Google can tell you about changes to the project, then click <b>Next</b>.</>,
  },
  {
    title: 'Agree and create',
    shot: '08-finish.webp',
    alt: 'Finish step with the User Data Policy box ticked',
    body: <>Tick <b>I agree to the Google API Services: User Data Policy</b>, click <b>Continue</b>, then <b>Create</b>.</>,
  },
  {
    title: 'Add yourself as a test user',
    shot: '09-test-user.webp',
    alt: 'Add users panel with an email address',
    body: <>Open {ext(gc('auth/audience'), 'Audience')}, scroll to <b>Test users</b>, click <b>Add users</b>, type the Google account that owns your channel, and click <b>Save</b>. Google blocks every account that isn't on this list.</>,
  },
  {
    title: 'Create a Desktop app client',
    shot: '10-create-client.webp',
    alt: 'Create OAuth client ID form with Desktop app selected',
    body: <>Open {ext(gc('auth/clients/create'), 'Clients → Create client')}. Application type: <b>Desktop app</b>. Name: anything, e.g. <b>Spikecut desktop</b>. Click <b>Create</b>. No redirect address is needed; Spikecut signs in through your browser on this PC.</>,
  },
  {
    title: 'Copy the client ID and secret into Spikecut',
    shot: '11-client-created.webp',
    alt: 'OAuth client created pop-up with the client ID and secret blurred',
    body: <>Google shows the <b>Client ID</b> and <b>Client secret</b> once. Copy both into the boxes below (or click <b>Download JSON</b> to keep a copy, and keep it private), click <b>Save client</b>, then <b>Connect Google account</b>.</>,
  },
];

export function OAuthGuide() {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  return (
    <section aria-label="How to get a client ID" className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <ol className="flex flex-wrap gap-1.5" aria-label="Steps">
        {STEPS.map((s, n) => (
          <li key={s.shot}>
            <button
              type="button"
              aria-label={s.title}
              aria-current={n === i ? 'step' : undefined}
              title={s.title}
              onClick={() => setI(n)}
              className={`h-7 w-7 rounded-full text-xs font-semibold transition-colors ${n === i ? 'bg-indigo-600 text-white' : n < i ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'}`}
            >{n + 1}</button>
          </li>
        ))}
      </ol>
      <div>
        <div className="text-xs text-zinc-500">Step {i + 1} of {STEPS.length}</div>
        <h3 className="font-semibold">{step.title}</h3>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{step.body}</p>
      </div>
      <img src={`guide/oauth/${step.shot}`} alt={step.alt} width={1024} height={640} className="h-auto w-full rounded-md border border-zinc-200 dark:border-zinc-800" />
      <div className="flex items-center justify-between gap-2">
        <Button onClick={() => setI(i - 1)} disabled={i === 0}>Back</Button>
        <Button variant="primary" onClick={() => setI(i + 1)} disabled={i === STEPS.length - 1}>Next</Button>
      </div>
      <div className="rounded-md bg-sky-50 p-3 text-xs text-sky-900 dark:bg-sky-950/50 dark:text-sky-200">
        <b>When you connect:</b> Google says <i>"Google hasn't verified this app"</i>. That's expected: it's your own app. Click <b>Continue</b>. While the app is in <i>Testing</i>, Google ends the sign-in after 7 days; when this page says <i>reconnect needed</i>, press <b>Connect Google account</b> again.
      </div>
    </section>
  );
}
