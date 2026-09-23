# Wild Hearts Health — Creative Direction

As of 2026-09-23. The living version is the [Creative Direction doc](https://claude.ai/code/artifact/7db5b1a4-b9f7-443a-a514-87c73c8c7514); this file is the repo copy the build follows.

## Direction: Nightlight

Nightlight is the Figure Eight layout set in the 2:14 a.m. palette: a soft cream orb glowing like a nightlight in a warm, dark room. The hero is an hourglass of two stacked orbs, with records from every clinic pouring into one record that has a face. It was chosen from seven prototypes; the palette comes from "2:14 a.m." and the layout from "Figure Eight".

Why it fits:

- **The audience works late.** Chronic and complex patients and self-advocates often sort their records alone, at night, and worried. The page meets them there with low light and one calm presence.
- **Baymax without Baymax.** The cues carry over (matte white vinyl, soft circles, a patient and literal voice) but the character is ours. See Signature motifs.
- **Dark, but warm.** Aubergine-black and cream read premium and quiet. That's the opposite of the slate-and-violet dark mode used by generic AI products.
- **The layout is the argument.** The lead promise is "one record, finally", and the hourglass shows fragmentation becoming one record before anyone reads a word.

## Positioning and voice

The page is written for one person: someone who sees more than one doctor and is tired of being the only one who holds the whole story.

| Element | Decision |
| --- | --- |
| Primary audience | Chronic and complex patients managing care across several health systems |
| Secondary audience | Health-engaged self-advocates who want their full record and arrive prepared |
| Lead promise | One record, finally: every MyChart they use, gathered into one timeline they own |
| Supporting promises | Understand it (plain answers with sources) and carry it (a clean summary for any new specialist) |
| Mechanism | SMART on FHIR connections to Epic MyChart, explained in the privacy section and never used as a headline |
| Stage | Product concept and patient research. The CTA opens an email to teo@wildheartsai.com |

Voice rules, taken from Baymax's temperament:

- **Patient and literal.** Say exactly what happens: "You sign in on your health system's own page", not "Seamless, secure connections".
- **Gentle, never peppy.** No exclamation marks, no "unlock", "supercharge" or "revolutionize".
- **Two speakers.** The page speaks as "we". The companion speaks in the first person, and only inside product moments such as the chat example.
- **Never reassure medically.** The companion points to questions for a doctor. It never tells someone they are fine or that something is nothing to worry about.
- **Plain and short.** Short sentences, everyday words, real numbers where they exist.

| Slot | Copy |
| --- | --- |
| Eyebrow pill | Product concept · patient research |
| Hero headline | Your care is scattered. Your story shouldn’t be. |
| Hero lede | Wild Hearts Health is in development. We’re designing it to bring records from the clinics you choose into one calm timeline and help you prepare for conversations with your care team. |
| How it works | Three rings, one you. |
| Understanding | Ask your record, not the internet. |
| Specialist | A better handoff is the goal. |
| Privacy | The standards we’re building toward. |
| Closing | Say hello. |
| CTA label | Share your interest (email subject: "Wild Hearts Health early access") |

## Color system

Three families: a warm night for the page, cream for anything that glows, and one raspberry accent. Every text pairing below passes WCAG AA; ratios were measured, not estimated. Tokens live in `src/app/globals.css`.

| Token | Hex | Role | Contrast |
| --- | --- | --- | --- |
| `night` | #1B1619 | Page background (warm aubergine-black) | base |
| `night-2` | #221C20 | Recessed chips inside surfaces | base |
| `surface` | #2B2428 | Cards, chat panel, trust cards | base |
| `surface-2` | #342C31 | Raised bubbles, hover, ghost buttons | base |
| `line` | #FFECF2 at 9% | Hairlines and dotted dividers | decorative |
| `text` | #F4EDEF | Headlines and primary text | 15.5 on night · 13.1 on surface |
| `text-2` | #CBBFC5 | Body copy, ledes | 10.0 on night · 8.5 on surface |
| `muted` | #A3969C | Captions, footer, meta | 6.3 on night · 5.3 on surface |
| `rasp` | #E4507F | Heart, graphics, large accent words | 4.9 on night (large text only) |
| `rasp-text` | #EC6E96 | Small accent text: eyebrows, pills, badges | 6.2 on night · 5.2 on surface |
| `rasp-btn` | #B8245A | Button and user-bubble fill | white text 6.1 |
| `rasp-press` | #9E1C4B | Button hover and pressed | white text 7.7 |
| `rasp-soft` | #E4507F at 14% | Pill and badge backgrounds | rasp-text on it: 5.3 |
| `cream` | #F7F1EC | Orbs, light panels (vinyl gradient #FFFDFB → #DCD1CA) | base |
| `cream-ink` | #221C20 | Text on cream | 14.9 |
| `cream-ink-2` | #5E5258 | Secondary text on cream | 6.6 (5.0 at the orb's darkest edge) |
| `rose` | #D79AAF | Big decorative numerals on cream only | 2.1, never for meaningful text |

Rules:

- **One accent.** Raspberry is the only hue. No second accent, no gradients between colors.
- **Glow, not neon.** Cream surfaces carry a warm halo of rgba(255, 214, 196) at 7 to 10% opacity, 90 to 160px wide. Never tint glows raspberry or violet.
- **Split raspberry by size.** `rasp` for shapes and text of 24px and up; `rasp-text` for anything smaller.
- **Light panels are rare.** Use at most two cream panels per page (the specialist summary and the closing moon), so they read as moments of clarity.
- **Dark only for now.** The landing page ships dark. The product dashboard may get a light theme later, and these tokens map onto one.

## Typography

One family does everything: **M PLUS Rounded 1c** (Google Fonts, weights 400, 500, 700, 800). Its rounded terminals echo the vinyl orbs, its Japanese origin nods to San Fransokyo, and it's rare on Western SaaS sites. Fallback stack: `ui-rounded, system-ui, sans-serif`.

| Role | Size | Weight | Line height | Tracking |
| --- | --- | --- | --- | --- |
| Hero headline | clamp(44px, 6vw, 84px) | 800 | 1.08 | -0.025em |
| Section headline | clamp(34px, 4.4vw, 58px) | 800 | 1.12 | -0.02em |
| Statement headline (specialist panel) | clamp(40px, 5.6vw, 76px) | 800 | 1.04 | -0.02em |
| Card and step title | 22 to 26px | 800 | 1.3 | -0.015em |
| Lede | clamp(17px, 1.5vw, 20px) | 400 | 1.75 | 0 |
| Body | 17px | 400 | 1.75 | 0 |
| Eyebrow | 13.5px, uppercase | 800 | 1.4 | +0.14em |
| Button | 15px, 16.5px large | 700 | 1 | 0 |
| Caption and meta | 12.5 to 14px | 400 to 500 | 1.5 | 0 |
| Ring numerals (decorative) | 92px, 48px on phones | 800 | 1 | -0.04em |

Rules:

- **No second typeface.** No serif accent words and no italics. An italic serif word inside a sans headline is one of the clearest AI-template tells.
- **One colored word, at most.** A headline may set one word in `rasp` ("story"). Everything else stays `text`.
- **Sentence case** for every headline, button and eyebrow source string. Eyebrows are uppercased with CSS only.
- **Measure.** Body copy caps at 34 to 38ch, ledes at 34ch, headlines at 17ch.
- **Load with `next/font/google`** so the font is self-hosted with no layout shift.

## Layout and composition

The page is a single column of seven sections on a 1160px container, and every edge is round. Big soft shapes carry the composition; there are no boxes-in-a-grid.

- **Container:** `min(1160px, 100% - 64px)`; on phones `100% - 32px`, a 16px gutter.
- **Breakpoint:** one, at 900px. Below it every split stacks to one column.
- **Vertical rhythm:** `clamp(80px, 10vw, 140px)` above each section; 120px below the last.
- **Radii:** pills 999px, cards 32px, panels 40 to 56px, orbs and rings 50%. No square corners.

| # | Section | Desktop | Phone |
| --- | --- | --- | --- |
| 1 | Nav | Brand left; How it works, Privacy, Contact us right | Brand and Contact us only |
| 2 | Hero | 1.1fr / 0.9fr split: copy, CTAs and a three-item proof row left; the figure-eight hourglass right | Copy first, hourglass below at 88% width |
| 3 | How it works | Centered headline over a chain of three overlapping cream rings; step text alternates right, left, right | Rings shrink to 112px on the left, text on the right, no overlap |
| 4 | Understanding | 0.9fr / 1.1fr split: copy left, chat panel right | Stacked |
| 5 | Specialist | Cream panel: statement left, five summary pills right | Stacked inside the panel |
| 6 | Privacy | Centered headline over three surface cards | One card per row |
| 7 | Closing | A 560px cream "moon" circle holding the CTA | Becomes a rounded rectangle so text never crowds |
| — | Footer | Dotted rule; copyright left, disclaimer right | Stacked |

The nav has a reserved slot for **Sign in**. When login ships it becomes a text link before Contact us, and Contact us stays the primary button. No other layout changes are needed.

## Signature motifs

Four motifs carry the brand: the orb, the figure eight, the face and the heart. Each has a job, and none is decoration.

**The orb (vinyl surfaces).** Cream circles lit from the upper left by a radial gradient (#FFFDFB at 0%, #F7F1EC at 45%, #E9E0DA at 80%, #DCD1CA at 100%). They carry a soft inner shade at the lower right, a warm outer glow and a long dark drop shadow, so they read as matte objects floating in a dim room. Orbs hold things (records, numerals, the CTA); they never hold paragraphs.

**The figure eight.** Two stacked orbs: a smaller "Every clinic" lobe on top and a larger lobe below with the face. Records fall through the waist and stack neatly in the lower lobe. It appears once, in the hero; the rings in How it works echo it without repeating it.

**The face mark.** Two dark dots on a cream circle, spaced like the centers of the heart logo's two circles. It means "the companion is here" and appears only where the product acts: the hero orb, the chat avatar and the closing moon.

- It has **no connecting line between the dots**. Two dots joined by a line is Baymax's face, a recognizable Disney character design. Keep that boundary in the logo, illustration and any future mascot work.
- No mouth, no cheeks, no expressions. It blinks, and that is all it does.

**The heart.** One shape, built from two 5px circles over a point on a 24px grid (SVG path `M12 21L4.27 12.33A5 5 0 1 1 12 6A5 5 0 1 1 19.73 12.33Z`). It is always `rasp` and appears as a shape in exactly two places, the nav logo and the favicon. Elsewhere it shows up only as its color: record pills get a raspberry dot once they join the record, meaning "yours now".

Never use hearts as bullets, icons, section dividers, containers or loading spinners. No pink, no hand-drawn hearts, no heartbeat lines.

## Motion

There is one story in motion, the pour, and everything else stays nearly still. Motion should feel like breathing, never like a slot machine.

| Moment | What happens | Timing |
| --- | --- | --- |
| Pour (hero) | Six record pills sit tilted in the top lobe, then fall one by one through the waist and stack in the lower lobe, their dots turning raspberry | 0.9s per pill, 380ms stagger, easing `cubic-bezier(.55, 0, .35, 1.3)` (a small landing bounce) |
| Blink | The face blinks once after the last pill lands | 0.4s, squash to 12% height |
| Hold and reset | The stack holds, fades out, reappears scattered, and pours again | 4.2s hold, 0.45s fade, ~8.5s loop |
| Pill dot | The "Early access" dot pulses softly | 2.4s ease-in-out loop, opacity 1 to 0.3 |
| Hover | Buttons lift 2px and darken to `rasp-press` | 200ms |

Rules:

- **Reduced motion is a first-class state.** Under `prefers-reduced-motion: reduce` the hourglass renders already poured, with no loop, pulse or lift.
- **Transform and opacity only.** No animating layout, shadows or filters, and no scroll-jacking.
- **Pause offscreen.** Stop the pour loop when the hero leaves the viewport or the tab is hidden.
- **No confetti, particles, typewriter text or parallax.**

## Copy and claims guardrails

The page may only claim what is documented, and the repo's `AGENTS.md` already sets that bar. Warmth comes from the voice, never from promises.

| Claim | Status |
| --- | --- |
| HIPAA compliant, HIPAA certified | Not allowed until an evidence-backed legal assessment exists |
| Epic approved, Epic partner, Epic logo | Not allowed until production approval exists |
| Clinically accurate, diagnoses, "you're fine" | Never allowed. The companion helps people ask better questions |
| Uses SMART on FHIR; you sign in on your health system's own page; we never see your MyChart password | Allowed: this is how the standard works |
| Only what's needed, with a list of what that is | Product commitment: must be true at launch or removed |
| Disconnect anytime | Product commitment: must be true at launch or removed |
| Duplicates merged; answers cite sources | Product commitment: must be true at launch or removed |
| Your data isn't for sale | Must also appear in the privacy policy before launch |

Required on the page:

- "Illustrative example. Not medical advice." under every piece of product UI.
- Footer: "Wild Hearts Health is not a medical provider and does not give medical advice."
- Footer trademark line: "MyChart is a registered trademark of Epic Systems Corporation." MyChart is used descriptively only.
- Example records use generic department labels (Cardiology, Primary care), never real hospitals, doctors or patients.
- Sample lab values stay clinically plausible (A1C 5.9 to 6.1%), and the companion only suggests raising them with a doctor.

## Anti-patterns

These are the tells that make a page read as AI-generated. Any of them is a reason to reject a design change.

- Indigo-to-violet mesh gradients, glow orbs in purple or cyan, and gradient text.
- Slate-950 dark mode with neon accents. Our dark is warm aubergine, lit by cream.
- Glassmorphism: frosted cards with 10%-white hairline borders.
- A bento grid of six feature cards, each with a line icon.
- Headlines like "Meet X, your AI-powered Y" or "Supercharge your health".
- An italic serif accent word inside a sans headline.
- Sparkle icons, magic-wand metaphors or the word "magic".
- Fake dashboards with generic line charts and made-up metrics.
- Logo walls of companies that are not customers, and invented testimonials or user counts.
- Stock photos of smiling patients holding phones.
- Geist or Inter as the brand face.

## Implementation

The landing page lives in `src/components/landing/` and is composed by `src/app/page.tsx`. It ships as static HTML and runs JavaScript only for the hourglass.

- One component per section: Nav, Hero, FigureEight, HowItWorks, Understanding, Specialist, Privacy, Closing, Footer.
- `FigureEight` is the only client component. It runs the pour loop and pauses it with IntersectionObserver and `visibilitychange`.
- Tokens are CSS custom properties in `src/app/globals.css`, mapped into Tailwind with `@theme inline` (`bg-night`, `text-rasp-text` and so on), ready for the dashboard.
- The contact address and email subject are defined once in `src/components/landing/contact.ts`.
- The favicon is `src/app/icon.svg` and the social card is `src/app/opengraph-image.tsx`.
