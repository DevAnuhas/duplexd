# Style lock — duplexd assistant workspace

Established: 2026-09-23. Sources: supplied Vapi screenshots, accepted assistant-page visual-craft artifact, and the existing workspace tokens.

## Visual system

- Palette: use the light and dark CSS variables in `apps/workspace/src/app/globals.css`. Neutral background and surface, mint primary, destructive red only for End. No new palette was introduced by this pass.
- Typography: the existing Plus Jakarta Sans app font. Headings stay compact; controls and status use direct text labels.
- Shape: hairline borders, 10px base radius, no decorative gradients. The floating call bar and right panel may use one stronger shadow to separate them from the workspace.
- Density: operational, not marketing. Compact header and tab row; 12–20px control padding; one primary action in the first viewport. Use a hairline divider between major regions.
- Navigation: retain sidebar and topbar. The assistant's active subpage has a mint underline, while the global Calls destination stays in the sidebar.
- Call presence: a static initial avatar, text connection state, elapsed time, persistent sample-data label, Mute and End. No invented pulse or waveform.
- Motion: restrained state transitions only; no continuous animation, and no motion that hides a connection failure.

## Reference intelligence

- Reference board: `.tastemaker/reference-board.md` (supplied screenshots viewed).
- Design read: builder app, Operate mode, quiet technical lane; variance 4, motion 2, density 7, art direction 5.
- Foundation: the repo's installed shadcn/Radix components and Phosphor icons.

## Taste memory

- Profile priors used: dark-first neutral base, restrained accent, hairline borders, no centered empty card as the main experience.
- Pending review: whether the current panel density and mint call-bar treatment should remain. Recorded in `.tastemaker/decisions.log`.
- Profile promotion: none.

## Do not

- Do not copy Vapi's waveform without a validated audio signal.
- Do not make sample tool delivery read as business success.
- Do not introduce warm/brown light surfaces or amber as the primary accent.
