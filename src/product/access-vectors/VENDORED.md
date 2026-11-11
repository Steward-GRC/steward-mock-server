# decide.json

A byte-exact copy of `vectors/decide.json` from Bugs5382/node-raci-editor, branch
`feat/1-initial-build` (PR 10, not merged), commit `8cc36f6`
(`feat(core): add decide() and shared test vectors`; branch head `fde804a9bedc8bd811da8b462493b530028a2bc1`).
SHA-256 `7de0055e4188c6eb18ef788c16ca26ad93c3b669c8bf1ad6b553280dff0c944a`.
The format is described in `vectors/README.md` beside the original.

Refresh: copy the file over this one from the new commit, update the commit and hash above, then
run `npm run test:vectors-report` and commit the regenerated `REPORT.md` with it. Never edit the
copy by hand.

`access-vectors.test.ts` runs the vectors against the mock's current access rules and `REPORT.md`
is its output (report only; it never changes the mock).
