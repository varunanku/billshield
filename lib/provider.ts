// Which LLM provider /api/bills/extract and the follow-up chat use.
// Default openrouter; EXTRACTION_PROVIDER=groq switches both to the
// original direct-Groq path.
export const USE_GROQ = process.env.EXTRACTION_PROVIDER === "groq";
