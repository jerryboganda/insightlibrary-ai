//! LLM gateway (Phase 5, Rig): one Provider trait over paid cloud providers
//! (Anthropic/Gemini/OpenAI, BYO keys). No local Ollama on this RAM-tight VPS;
//! routing, fallback, and structured output live here.
