# Assistant workspace reference board

Created: 2026-09-23. Mode: Operate.
Design read: a production voice-assistant workspace for builders, using a quiet dark-neutral and mint visual lane. Variance 4, motion 2, density 7, art direction 5.

## Viewed references

- The ten screenshots supplied in `/Users/mac/Desktop/Vapi_Assistant_UI` (viewed 2026-09-23). The assistant action header uses compact controls, restrained borders, and one strong accent. The call detail uses speaker-aligned turns and a separate technical area.
- The accepted Traycer assistant-page visual-craft artifact records the selected call bar and right panel shape. Its wireframes are the layout reference; the app's tokens remain the color source.
- Existing `apps/workspace/src/app/globals.css`: neutral surfaces, hairline borders, mint primary, paired light/dark tokens.

## Direction contract

- Thesis: configuring an assistant, practicing, and reviewing its calls are three clear jobs.
- First viewport: assistant name, compact Configure / Practice / Calls navigation, one primary Practice action; detailed sample settings are expandable.
- System: existing shadcn primitives, Phosphor icons, Plus Jakarta Sans, mint for active state, neutral cards and dividers.
- Risk: technical state copy can crowd the caller; keep truthful errors but move diagnostics behind a disclosure.
- Avoid: a fake live waveform, countdown clocks during connection, unlabeled sample results, global Calls disguised as an assistant tab.
