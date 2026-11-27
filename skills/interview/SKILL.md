---
name: interview
effort: medium
description: >
  Turn a vague request ("a screen for X", "improve scheduling") into a
  confirmed statement of intent before any spec exists: one question per turn,
  as an AskUserQuestion menu with your guess as the recommended option, and,
  when the direction is still open, a few variations with a "not doing" list.
  Use when a request lacks who it is for, why now, what success looks like or
  the binding constraint, or when the owner asks to be interviewed.
  Interactive sessions only.
---

# Interview: intent before spec

Adapted from `interview-me` and `idea-refine` in `addyosmani/agent-skills`
(MIT); see `THIRD_PARTY_NOTICES.md` in the plugin.

What people ask for and what they want differ. The cheapest moment to find
the gap is before `requirements.md` exists; after that, the wrong thing gets
rationalised into "good enough". This skill sits before the `spec` skill and
produces the one thing a spec needs and cannot invent: confirmed intent.

## When to use

- The request is missing at least one of: **who** uses it, **why now**, what
  **success** looks like, the binding **constraint**.
- The request names a conventional artifact ("a dashboard", "a page") and
  you would have to guess what it is for.
- The owner asks to be interviewed, or to think it through.

**Not for:** clear, self-contained requests; questions about how the code
works; mechanical changes; an owner who asked for speed.

**Never in a non-interactive context**: `/loop`, `claude -p`, a subagent, a
workflow step. There, write the missing piece down as a blocker for the
owner instead of guessing.

## Language

Talk to the owner in English, explaining a technical term the first time it
appears. Use another language only when the owner asks for it, in the
conversation or by setting `locale` in `aria.config.json` (`pt-BR`).

## Process

### 1. Hypothesis with a number

Before the first question, write one sentence and a confidence you can
defend:

```text
HYPOTHESIS: you want to know which bookings were never confirmed, and "dashboard" was the first format that came to mind.
CONFIDENCE: ~30%. Missing: who looks at it, how often, what counts as success.
```

Below about 70%, the same line says what is missing.

Before asking, read what already exists (the specs directory for
precedent, the relevant pages or modules, the project's roadmap if it has
one) so the questions build on the repository instead of re-asking what it
answers.

### 2. One question per turn, as a menu

Use `AskUserQuestion` with **one** question per call:

- the first option is your guess, marked recommended, with the reasoning in
  its description;
- two or three real alternatives, including one you expect the owner to
  push back on; it keeps the guess honest;
- the tool adds "Other"; do not add your own.

Wait for the answer before the next question; the third question usually
depends on the first.

### 3. Listen for "should want"

Answers that sound like best practice ("scalable", "modern", "the industry
standard", "I guess it should…") are not goals. Ask: _"If you did not have
to justify it to anyone, what would you actually want?"_

### 4. Optional: variations

When intent is clear but the direction is not, offer 5 to 8 variations
(simpler, inverted, for a different user, combined with an existing
feature), cluster the ones the owner likes into 2 or 3 directions, and for
each name the bet, what would kill it and the hardest part in this codebase.
Be honest about weak ideas.

### 5. Restate

When you can predict the owner's answer to the next three questions, write
it back, one line each:

```text
- Outcome:      …
- Who uses it:  …
- Why now:      …
- Success:      …
- Constraint:   …
- Out of scope: …
```

"Out of scope" is mandatory: half of misalignment is silent disagreement
about what is not being built.

### 6. Confirm explicitly

Confirm with a menu ("Yes, that's it" / "Adjust"). "Whatever", "could be",
"whatever you think is best" are not a yes: ask again as a choice between
two concrete options. Fold corrections in and restate.

### 7. Stop

On an explicit yes: show the confirmed restate, offer the `spec` skill as
the next step (the restate becomes sections 1 to 3 of `requirements.md`),
and **end the turn**. No file is created and no spec number is reserved
until the owner chooses.

If several rounds go by and confidence is not rising, say so and ask
whether something foundational is missing, instead of grinding on.

## Red flags

- Two or more questions in one call.
- A question without your guess as the recommended option.
- Accepting "whatever" as an answer.
- Starting a spec, a plan or a file before the explicit yes.
- A restate without "Out of scope".
