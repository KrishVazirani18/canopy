---
name: design
description: Design judgment and a final visual check, for any work someone will look at - a web page, app screen, component, dashboard, deck, PDF, poster or image. Load before designing or changing anything visual, and before calling that work done.
---

# Designing well

An aid, not a house style. It helps where the user and the project are silent and never argues with what they asked for.

## Who decides

1. What the user says in this chat, including a named style ("like National Geographic", "match Codex", "brutalist"). Follow it exactly.
2. The project's existing design: brand kit, design system, existing pages and components. New work must look native to it.
3. This skill, and canopy-kit:design-taste for style choices, only for what 1 and 2 leave open.

If the user says to skip design opinions, skip them. The craft floor below still applies, because it is about things working, not about taste.

## Read the brief first

- Brand kit, design system or existing design to match: follow it and build. Use this skill only for craft and the final check.
- A named style with room to read it ("like National Geographic", "Apple-style"): there are several ways to read it. Show two or three distinct takes on that style as references (below), each a real example of it, and let the user pick before building.

The pick is not optional on these two kinds of brief, however well defined the style seems to you and even though it costs a turn: users have said they want to choose the direction first, and building straight away is the most common way this goes wrong.
- Open brief with nothing to match (no named style, no brand, no existing design, as in "make a landing page for X"): don't build yet. Category words are not a named style: "startup", "series B", "modern", "clean", "minimal", "professional" still make it an open brief. Let the user choose a direction from real references first (below). This takes a minute and is what separates a page with its own look from the default one.
- The user said "just build it", or it is a small piece inside something that already exists: skip the references and build.
- "Quick", "rough", "just a mockup": build it fast and skip polish.

## Research before you build

Generic work comes from building before knowing the subject. On a fresh piece of work, before the first line of code, run real web searches with the WebSearch tool (if it is listed as deferred, load it with ToolSearch first). Thinking about the subject is not research.

- The subject itself, when it is real: what it does, who it serves, its real name, people, numbers, logo and photos. Use what you find.
- References: three to five of the best real examples to learn from, in its category or outside it (the strongest sites in the field, a magazine, a brand, a product the audience admires). Look at them and note what makes each one distinct.
- A made-up company still has a real field: research the problem, the users and the products it would compete with, so the copy and the product shots are specific and believable.

On an open brief, show the references before building:

1. Pick three that differ from each other in feel (not three of the same look), real and well regarded.
2. Screenshot each with the look tool at desktop width, at the part that shows its style (usually the top of the page).
3. Show all three in one <canopy-pick> (read the widget guide's pick module first): each option a <canopy-shot> of one reference, its name, and one line on what you'd take from it for this work. Ask which direction to go.
4. End your turn there. Build after the user picks, in that direction.

Then give the work a visual style of its own, drawn from the references and the subject, and commit to it: a type choice with character, a color and material world, an imagery approach, a signature layout move. Name it in a line before building. "Clean", "modern", "minimal" and "startup" are not styles. Someone should recognize the page from a thumbnail with the logo covered.

Find one idea that only fits this subject and let it shape the layout. A page that would work as well for any other company with the words swapped has no idea yet.

Real photography when the subject has people, places or physical things in it: find real, high-resolution photos that fit the style. A product about people should show people.

Never invent proof. No made-up customer logos, funding rounds, press quotes, testimonials or metrics presented as real. If the real ones don't exist, leave the section out or build it from what is true (what the product does, shown working).

## What people notice, most to least

1. Composition and scale. Is everything the right size, does it fill the space, is it balanced. Most "this looks wrong" reactions are here, not in small details.
2. Behavior. How it opens, closes, loads, scrolls, and works on a phone. Picture it moving, not just the still frame.
3. Richness. Minimal is not empty. Real images, real logos and real data make it feel finished. Stock or default-looking pieces (a plain toggle, an unstyled menu or dialog) read as unfinished.
4. Consistency with what already exists.
5. Small details: caps, spacing nudges, grey text.

## Craft floor

- Nothing jumps, shifts or flashes on load, tab switch, expand or hover. Space is reserved for what loads in.
- Edges line up, centered things are centered, siblings share size, nothing is clipped, overlapping or hidden under a sticky header.
- No dead space and nothing cramped. If an area is empty, enlarge the main content or put something useful there.
- Text is readable: enough contrast and size.
- Real assets. Never a broken image, placeholder box or generic icon where a real logo or photo exists.
- Every wait has a loading state (skeleton, shimmer or spinner). Nothing sits blank or stuck.
- Motion is smooth and quick, plays once, and never replays on reload.
- Anything people open on a phone works there, with no sideways scroll.
- Copy is short and plain. No filler text under every heading. Labels say what things are.

## Build from the content, not a template

There is no standard landing page. Do not default to the same hero, stats row, card grid and footer every time. Let the subject, the audience and the material decide the layout. If two of your recent builds would look alike with the words swapped, change the structure.

## Instant rejections

These read as generated at a glance. Don't ship them unless the user asks:

- A strip of invented logos ("Trusted by Northwind, Halcyon, Orbit"), invented funding pills, invented quotes or stats.
- An abstract hero effect standing in for an idea: particle fields, gradient blobs, glowing orbs, dot grids.
- The template run: big headline, two buttons, logo strip, three icon cards, stats row, testimonial, closing banner.
- Filler subtext under every heading; ALL CAPS eyebrow labels; em dashes; decorative emoji; glow.
- Grey placeholder boxes, stock icons where a real logo or photo exists, low-res images.
- Cards of different sizes within one set; sideways scroll on a phone.

## Scope

Change only what was asked. Never remove or move existing elements unasked; suggest it instead. When asked to undo something, undo exactly that.

## Reading feedback

A short reaction plus a screenshot ("off", "weird", "this sucks") means a specific defect exists. Find it before changing anything: scale, alignment, spacing, consistency, motion, contrast, richness. "Make it better" usually asks for a rethink, not a nudge. When the user approves something, keep it.

## Before you call it done

Look at the real thing, as a user would.

1. Run it: open the page or app, or render the deck, PDF or image.
2. Screenshot it at desktop width and at phone width (when people will use it on a phone).
3. Scroll top to bottom, then fast back up. Jump to any in-page links.
4. Open and close every menu, drawer, modal and expandable part. Reload once cold.
5. Compare against what the user asked for first, then any reference they named, then the neighboring pages.
6. Check the craft floor, the instant rejections, and that nothing changed that wasn't asked.
7. Check every name, number, logo, quote and photo: each is real, from your research, or plainly the product's own demo data.
8. Ask whether it could pass as a template with the words swapped, or whether it looks like the default for its category. If so, the style and the idea aren't on the page yet: rethink the structure and the style, not the colors.
9. Fix what you found, then look again.

For decks, PDFs and images: look at every page. Text over a photo sits on a calm part of it. Photos in a set share a similar color grade.

Report briefly: what you checked, what you fixed, what is still open. Skip long pass/fail tables unless asked.
