// Client metadata only: never use this value as an upstream output budget.
export function parseComboContext(draft) {
  const text = draft.trim();
  if (!text) return { value: null, error: "" };
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
    return { value: null, error: "Enter a positive safe integer token count, or leave blank for Auto." };
  }
  return { value, error: "" };
}
