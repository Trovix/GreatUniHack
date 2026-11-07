# Local demonstration

This demonstration is a prototype walkthrough. Live image-to-explanation quality and real Moodle capture remain blocked; the mock path must be identified aloud.

1. Follow README setup, load `dist/extension`, start the loopback service in mock mode with the exact extension Origin and pair its private local token.
2. Start `npm run fixture`, enter the synthetic course at 127.0.0.1:4318, and click the extension action. In Find, bind the course tab, select Week 1 and preview it. Only that visible section appears; unrelated/private/form/hidden content is excluded. Import a selected direct PDF or VTT using that browser's existing authenticated context. This is a fixture, not actual Moodle.
3. For a short offline walkthrough, import `fixtures/F3/source.wav`, `captions.vtt` and `V1.png`, then Review & prepare. Add an interval from 0 to 10 seconds, confirm the timeline and save. The static image has two options and no pointer.
4. Consent to Prepare labelled mock transcript. Point out the explicit unresolved visual limitation. Review the descriptive transcript and ledger, separately consent to local mock speech, then choose Listen and Play. Local speech is not ElevenLabs.
5. Pause to ask a question, type a space normally in the question field, and resume the saved explanation segment/offset. Escape stops audio. Edit a source to show stale output and labelled archived revisions; old audio cannot become current.
6. Queue more than one prepared lecture and explicitly start Play ready lectures. Completion in the background does not add an item to an existing playback snapshot.

For live ElevenLabs evidence, play `verification/live-speech/F1-reference.wav` and `F2-change-reference.wav`. They are developer-authored synthetic references, not visual-language compiler output. The first covers axes, initial/new equilibria, fixed supply, buyer change, demand shift versus movement, fraction grouping/restriction and the return to the original slide. The second changes the source meaning to fewer buyers and equilibrium 3/£3. `QA-reference.wav` checks grouped algebra speech. Human listening review has not been completed; browser fetch/decode/playback is recorded separately.

Do not present fixture/software success, a model audit, or reference narration as accessibility certification or target-user validation. Do not submit, publish or upload private course material as part of this demo.
