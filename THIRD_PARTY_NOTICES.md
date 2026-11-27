# Third-party notices

Several skills in this plugin, and two checks of `aria validate contracts`,
are adaptations of material from
[`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills),
commit `301b02b12bff98e4688e6984af6556802322bbde` (`main` on 2026-11-02),
distributed under the MIT License reproduced below. They reached this plugin
through bernardo-pet, where they were first adapted, and were rewritten
again here to be independent of any project's stack.

| Here | Adapted from | What was adapted |
|---|---|---|
| `skills/interview` | `skills/interview-me/SKILL.md`, `skills/idea-refine/SKILL.md` | one question per turn with a recommended guess; the restate with what is out of scope; variations |
| `skills/doubt-review` | `skills/doubt-driven-development/SKILL.md` | the adversarial review cycle and its stop conditions |
| `skills/source-grounding` | `skills/source-driven-development/SKILL.md` | the installed version decides; the source order; citing or marking unverified |
| `skills/debugging` | `skills/debugging-and-error-recovery/SKILL.md` | reproduce, localise, reduce, fix the cause, guard, verify |
| `skills/deprecation` | `skills/deprecation-and-migration/SKILL.md` | deciding, measuring usage, removing, expand and contract |
| `skills/pr-review` | `agents/code-reviewer.md` | the five review axes, the `Critical`/`Required`/`Optional`/`Nit` scale, the verdict |
| `skills/test` | `agents/test-engineer.md` | the Prove-It pattern: the new test fails before the change it proves |
| `lib/contracts.mjs` | `docs/skill-anatomy.md`, `scripts/validate-artifact-paths.js` | the skill anatomy checks (`name` matching the folder, a trigger in the description, the 1024-character cap) and the dead-path check; no code was copied |

## License

```text
MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
