// Which LLM provider /api/bills/extract and the follow-up chat use.
// Default gemini; EXTRACTION_PROVIDER=groq switches both to the original path.
export const USE_GROQ = process.env.EXTRACTION_PROVIDER === "groq";
