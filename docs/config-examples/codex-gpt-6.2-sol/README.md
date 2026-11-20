# GPT 6.2 Sol on Codex

These payloads reproduce a 9Router custom model and manual pricing override. The prices are operator settings in USD per million tokens, not an official provider rate card. Nothing is applied at startup or when this branch is merged.

On an authenticated 9Router admin session:

1. To register the model if it is not already listed, use `model.json` as the JSON body for `POST /api/models/custom`. Clients select `cx/gpt-6.2-sol`. A Codex account must already be configured and permitted to use the model.
2. In **Pricing**, find Codex → `gpt-6.2-sol` and enter the five rates from `pricing.json`, or use the file as the JSON body for `PATCH /api/pricing`. The pricing API uses the provider ID `codex`, not the client alias `cx`. Applying the file intentionally replaces all five rates for only this model.
3. Reload Pricing (or read `GET /api/pricing/editor`). Confirm the row for provider `codex` and model `gpt-6.2-sol` has source `manual` and matches the five values in `pricing.json`.

Resetting this model in Pricing removes its manual override and restores whatever default or imported pricing the instance has, if any.
